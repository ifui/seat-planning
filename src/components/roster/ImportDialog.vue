<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RankDef, UnitNode } from '../../types'
import type { FieldMap, ParsedPerson, RawTable } from '../../engine/rosterImport'
import { buildRows, readRosterFile, suggestMapping } from '../../engine/rosterImport'
import {
  planRankInputs,
  planUnitInputs,
  unitPathOf,
  type UnitResolution
} from '../../engine/unitMatch'
import { UiButton, UiCheckbox, UiIcon, UiModal, UiSelect } from '../../ui'

interface EditRow extends ParsedPerson {
  ignore: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    unitOptions: { value: string; label: string }[]
    /** 当前名册（或项目快照）的单位树，用于逐行解析预览 */
    units: UnitNode[]
    /** 当前名册（或项目快照）的职级，用于逐行解析预览 */
    ranks: RankDef[]
    defaultUnitId?: string
  }>(),
  { defaultUnitId: '' }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (
    e: 'import',
    payload: {
      rows: { name: string; unit: string; rank: string; duty: string; note: string }[]
      targetUnitId: string
      allowDuplicate: boolean
    }
  ): void
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const table = ref<RawTable | null>(null)
const mapping = ref<FieldMap>({ name: 0, unit: -1, rank: -1, duty: -1, note: -1 })
const rows = ref<EditRow[]>([])
const fileName = ref('')
const error = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const targetUnitId = ref('')
/** 默认拒绝重名：同姓名 + 同单位视为重复录入 */
const allowDuplicate = ref(false)

const MAP_FIELDS: { key: keyof FieldMap; label: string; required?: boolean }[] = [
  { key: 'name', label: '姓名', required: true },
  { key: 'unit', label: '单位 / 部门' },
  { key: 'rank', label: '职级' },
  { key: 'duty', label: '职务' },
  { key: 'note', label: '备注 / 电话' }
]

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      reset()
      targetUnitId.value = props.defaultUnitId || props.unitOptions[0]?.value || ''
    }
  }
)

function reset(): void {
  table.value = null
  rows.value = []
  fileName.value = ''
  error.value = ''
  busy.value = false
  if (fileInput.value) fileInput.value.value = ''
  allowDuplicate.value = false
}

async function loadFile(file: File | null | undefined): Promise<void> {
  if (!file || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const t = await readRosterFile(file)
    table.value = t
    fileName.value = file.name
    mapping.value = suggestMapping(t)
    rebuild()
    if (!rows.value.length) error.value = '已读取文件，但没有识别到人员行，请检查字段映射'
  } catch (e: any) {
    table.value = null
    error.value = e?.message || '文件解析失败'
  } finally {
    busy.value = false
  }
}

function onPick(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0]
  void loadFile(f)
}

function onDrop(e: DragEvent): void {
  void loadFile(e.dataTransfer?.files?.[0])
}

function rebuild(): void {
  if (!table.value) return
  rows.value = buildRows(table.value, mapping.value).map((r) => ({ ...r, ignore: !r.name }))
}

/** 列选项：-1 = 不导入，其余为原始列下标 */
const columnOptions = computed(() => [
  { value: -1, label: '不导入' },
  ...(table.value?.columns ?? []).map((c, i) => ({ value: i, label: c }))
])

function setMapping(key: keyof FieldMap, v: string | number | null): void {
  mapping.value[key] = typeof v === 'number' ? v : Number(v ?? -1)
  rebuild()
}

const pending = computed(() => rows.value.filter((r) => !r.ignore && r.name.trim()))
const missing = computed(() => rows.value.filter((r) => !r.ignore && !r.name.trim()).length)
const ignored = computed(() => rows.value.filter((r) => r.ignore).length)
const issueRows = computed(() => rows.value.filter((r) => !r.ignore && r.name.trim() && r.issues.length).length)

/**
 * 逐行解析预览与实际导入共用同一套 plan：
 * 预览显示什么（命中哪条路径 / 将新建在哪一级下 / 冲突），导入就按什么执行。
 */
const unitPlan = computed(() =>
  planUnitInputs(
    props.units,
    pending.value.map((r) => r.unit),
    targetUnitId.value || props.defaultUnitId || ''
  )
)
const rankPlan = computed(() =>
  planRankInputs(props.ranks, pending.value.map((r) => r.rank))
)
/** 行对象 → 解析结果：被忽略的行不参与解析，因此按 pending 顺序建映射 */
const unitOfRow = computed(() => {
  const map = new Map<EditRow, UnitResolution>()
  pending.value.forEach((r, i) => {
    const item = unitPlan.value.items[i]
    if (item) map.set(r, item)
  })
  return map
})
const rankOfRow = computed(() => {
  const map = new Map<EditRow, ReturnType<typeof planRankInputs>['items'][number]>()
  pending.value.forEach((r, i) => {
    const item = rankPlan.value.items[i]
    if (item) map.set(r, item)
  })
  return map
})
const newUnits = computed(() => unitPlan.value.newUnits)
const newRanks = computed(() => rankPlan.value.newRanks)
const conflictCount = computed(() => unitPlan.value.conflicts + rankPlan.value.conflicts)
const targetPath = computed(() => unitPathOf(props.units, targetUnitId.value))

/** 单位输入建议：给出全路径，便于直接按路径命中 */
const unitPathOptions = computed(() => {
  const paths = props.units.map((u) => unitPathOf(props.units, u.id))
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})
const rankNameOptions = computed(() => [
  ...new Set(props.ranks.map((r) => r.name))
])

function unitHint(r: EditRow): string {
  const it = unitOfRow.value.get(r)
  if (!it) return ''
  if (it.kind === 'empty')
    return targetPath.value ? `空 → 归入 ${targetPath.value}` : '空 → 未指定归入单位'
  if (it.kind === 'existing')
    return `${it.via === 'path' ? '命中路径' : '命中名称'}：${it.path}`
  if (it.kind === 'new')
    return `新建 → ${it.parentPath ? `挂在 ${it.parentPath} 下` : '根级'}`
  return `冲突：已有 ${it.candidates?.length ?? 0} 个同名单位`
}

function unitTone(r: EditRow): string {
  const it = unitOfRow.value.get(r)
  if (!it) return 'muted'
  if (it.kind === 'empty') return 'muted'
  if (it.kind === 'existing') return 'ok'
  if (it.kind === 'new') return 'new'
  return 'conflict'
}

function rankHint(r: EditRow): string {
  const it = rankOfRow.value.get(r)
  if (!it) return ''
  if (it.kind === 'new') return `将新建职级「${it.name}」`
  if (it.kind === 'conflict') return `职级「${it.name}」存在重名，请先处理`
  return ''
}

function rowStatus(r: EditRow): 'ignored' | 'error' | 'warn' | 'ok' {
  if (r.ignore) return 'ignored'
  if (!r.name.trim()) return 'error'
  if (r.issues.length) return 'warn'
  return 'ok'
}

function rowIssues(r: EditRow): string {
  if (!r.name.trim()) return '未识别到姓名，请手动填写或忽略此行'
  return r.issues.join('；')
}

function toggleRow(r: EditRow): void {
  r.ignore = !r.ignore
}

function submit(): void {
  if (!pending.value.length || conflictCount.value) return
  emit('import', {
    rows: pending.value.map((r) => ({
      name: r.name.trim(),
      unit: r.unit.trim(),
      rank: r.rank.trim(),
      duty: r.duty.trim(),
      note: r.note.trim()
    })),
    targetUnitId: targetUnitId.value,
    allowDuplicate: allowDuplicate.value
  })
  open.value = false
}
</script>

<template>
  <UiModal
    v-model="open"
    title="批量导入人员"
    description="Excel / Word / CSV 均可；识别错误的列可在下方改选。"
    icon="import"
    width="1080px"
  >
    <div v-if="!table" class="imp-start">
      <button
        type="button"
        class="imp-drop"
        :class="{ busy }"
        @click="fileInput?.click()"
        @dragover.prevent
        @drop.prevent="onDrop"
      >
        <span class="imp-drop-art insp-head-art"><UiIcon name="import" :size="24" /></span>
        <span class="imp-drop-title">{{ busy ? '正在解析…' : '选择文件，或把文件拖到这里' }}</span>
        <span class="imp-drop-hint">.xlsx / .xls / .docx / .csv / .txt</span>
      </button>
      <input
        ref="fileInput"
        type="file"
        class="imp-file"
        accept=".xlsx,.xls,.xlsm,.docx,.csv,.txt,.tsv"
        @change="onPick"
      />
      <div v-if="error" class="imp-alert error">{{ error }}</div>
      <div class="imp-tips insp-sec">
        <div class="insp-title">导入说明</div>
        <ul>
          <li>旧版 .doc 请先另存为 .docx；CSV 支持 UTF-8 与 GBK 编码。</li>
          <li>「姓名」列会自动识别人名与括号内的单位、职级、电话。</li>
          <li>列名不含「姓名」时，会按内容特征自动挑选最像人名的列。</li>
          <li>单位支持全路径，用 / \ &gt; ＞ 分隔，如「局机关 / 办公室」；写短名也行。</li>
          <li>单位名称全树唯一：填了不存在的路径时按路径前缀新建，未填的归入指定单位。</li>
          <li>导入前会逐行显示解析结果，重名冲突会拦下并说明原因。</li>
        </ul>
      </div>
    </div>

    <template v-else>
      <div class="imp-meta">
        <span class="imp-meta-name">{{ fileName }}</span>
        <span class="imp-meta-sep" />
        <span>{{ table.rows.length }} 行数据</span>
        <span class="imp-meta-sep" />
        <span>{{ table.columns.length }} 列</span>
        <span class="grow" />
        <UiButton size="xs" icon="rotate" @click="fileInput?.click()">重新选择</UiButton>
        <input
          ref="fileInput"
          type="file"
          class="imp-file"
          accept=".xlsx,.xls,.xlsm,.docx,.csv,.txt,.tsv"
          @change="onPick"
        />
      </div>
      <div v-if="table.warnings.length" class="imp-alert note">{{ table.warnings.join('；') }}</div>

      <section class="imp-map insp-sec">
        <div class="imp-map-head">
          <div class="insp-title">字段映射 <b>1</b></div>
          <span class="imp-map-hint">自动匹配表头，可手动改选</span>
        </div>
        <div class="imp-map-grid">
          <div v-for="f in MAP_FIELDS" :key="f.key" class="imp-map-item">
            <span class="insp-label">{{ f.label }}<i v-if="f.required">*</i></span>
            <UiSelect
              :model-value="mapping[f.key]"
              :options="columnOptions"
              size="sm"
              @update:model-value="setMapping(f.key, $event)"
            />
          </div>
          <div class="imp-map-item">
            <span class="insp-label">空单位归入</span>
            <UiSelect v-model="targetUnitId" :options="unitOptions" size="sm" placeholder="选择单位" />
          </div>
        </div>
      </section>

      <div class="imp-alert error" v-if="error">{{ error }}</div>

      <div class="imp-table-wrap">
        <table class="imp-table">
          <colgroup>
            <col style="width: 42px" />
            <col style="width: 104px" />
            <col style="width: 168px" />
            <col style="width: 208px" />
            <col style="width: 104px" />
            <col style="width: 92px" />
            <col style="width: 92px" />
            <col style="width: 66px" />
            <col style="width: 56px" />
          </colgroup>
          <thead>
            <tr>
              <th>行</th>
              <th>姓名</th>
              <th>单位</th>
              <th>单位解析</th>
              <th>职级</th>
              <th>职务</th>
              <th>备注</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.line + r.name" :class="{ ignored: r.ignore }">
              <td class="imp-line">{{ r.line }}</td>
              <td><input v-model="r.name" class="insp-input imp-cell-input" placeholder="姓名" /></td>
              <td><input v-model="r.unit" class="insp-input imp-cell-input" list="imp-units" placeholder="未填写" /></td>
              <td>
                <span
                  class="imp-res"
                  :class="unitTone(r)"
                  :title="unitHint(r)"
                >{{ r.ignore ? '—' : unitHint(r) || '—' }}</span>
              </td>
              <td>
                <input
                  v-model="r.rank"
                  class="insp-input imp-cell-input"
                  list="imp-ranks"
                  placeholder="未填写"
                  :title="rankHint(r)"
                />
              </td>
              <td><input v-model="r.duty" class="insp-input imp-cell-input" placeholder="如主任" /></td>
              <td><input v-model="r.note" class="insp-input imp-cell-input" placeholder="—" /></td>
              <td>
                <span
                  class="imp-state"
                  :class="rowStatus(r)"
                  :title="rowIssues(r)"
                >{{ rowStatus(r) === 'ok' ? '正常' : rowStatus(r) === 'warn' ? '提示' : rowStatus(r) === 'error' ? '缺姓名' : '已忽略' }}</span>
              </td>
              <td>
                <UiButton variant="ghost" size="xs" @click="toggleRow(r)">
                  {{ r.ignore ? '恢复' : '忽略' }}
                </UiButton>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="9" class="imp-empty">没有解析出人员行，请检查「姓名」列是否选对。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="imp-dup">
        <UiCheckbox
          v-model="allowDuplicate"
          label="允许重名：同姓名且同单位的记录也写入（默认关闭，重名条目会跳过）"
        />
        <p class="imp-dup-hint">
          重名口径：姓名完全一致且归属同一单位。跳过的人员不会静默丢弃，导入结果里可查看名单。
        </p>
      </div>

      <div class="imp-summary">
        <span>待导入 <b>{{ pending.length }}</b> 人</span>
        <span v-if="ignored">· 已忽略 {{ ignored }} 行</span>
        <span v-if="missing" class="warn">· {{ missing }} 行缺少姓名</span>
        <span v-if="issueRows" class="warn">· {{ issueRows }} 行有提示</span>
        <span v-if="newUnits.length" class="hint">· 将新建单位 {{ newUnits.length }} 个</span>
        <span v-if="newRanks.length" class="hint">· 将新建职级 {{ newRanks.length }} 个</span>
        <span v-if="conflictCount" class="warn">· {{ conflictCount }} 行单位/职级重名，需先处理</span>
      </div>

      <div v-if="conflictCount" class="imp-alert error" style="margin-top: 8px">
        存在重名冲突：单位名称必须全树唯一。请按「单位解析」列提示修改对应行，或先到单位编制序列里改名/合并同名单位。
      </div>

      <div v-if="newUnits.length || newRanks.length" class="imp-summary" style="margin-top: 4px">
        <span v-if="newUnits.length" class="hint">
          新建单位：
          {{ newUnits.map((u) => `${u.name}${u.parentPath ? `（挂在 ${u.parentPath} 下）` : '（根级）'}`).join('、') }}
        </span>
        <span v-if="newRanks.length" class="hint">
          新建职级：{{ newRanks.map((r) => r.name).join('、') }}
        </span>
      </div>

      <datalist id="imp-units">
        <option v-for="u in unitPathOptions" :key="u" :value="u" />
      </datalist>
      <datalist id="imp-ranks">
        <option v-for="u in rankNameOptions" :key="u" :value="u" />
      </datalist>
    </template>

    <template #footer>
      <UiButton variant="ghost" @click="open = false">取消</UiButton>
      <UiButton variant="primary" :disabled="!pending.length || !!conflictCount" @click="submit">
        导入 {{ pending.length }} 人
      </UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.imp-start { display: flex; flex-direction: column; gap: 12px; }
.imp-drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  height: 156px; border: 1px dashed var(--border-strong); border-radius: var(--radius-md);
  background: var(--bg-subtle); color: var(--text-secondary);
  font-family: inherit; cursor: pointer; transition: border-color var(--motion-fast) ease, background var(--motion-fast) ease;
}
.imp-drop:hover { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary); }
.imp-drop.busy { pointer-events: none; color: var(--text-muted); }
.imp-drop-art { display: inline-flex; align-items: center; justify-content: center; }
.imp-drop-title { font-size: var(--fs-sm); }
.imp-drop-hint { font-size: var(--fs-xs); color: var(--text-muted); }
.imp-file { display: none; }
.imp-tips { padding-top: 12px; }
.imp-tips ul { margin: 0; padding-left: 16px; font-size: var(--fs-xs); line-height: 1.9; color: var(--text-muted); }
.imp-alert { padding: 7px 10px; border-radius: var(--radius-xs); font-size: var(--fs-xs); line-height: 1.6; }
.imp-alert.error { background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger-line); }
.imp-alert.note { background: var(--bg-subtle); color: var(--text-muted); border: 1px solid var(--border-soft); margin-bottom: 8px; }
.imp-meta { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: 8px; }
.imp-meta-name { color: var(--text-secondary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-meta-sep { width: 1px; height: 10px; background: var(--border); }
.imp-map { padding-top: 0; }
.imp-map-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.imp-map-hint { font-size: var(--fs-xs); color: var(--text-muted); }
.imp-map-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; }
.imp-map-item { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.imp-map-item .insp-label i { color: var(--danger); font-style: normal; margin-left: 1px; }
.imp-table-wrap { max-height: 300px; overflow: auto; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); }
.imp-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: var(--fs-xs); }
.imp-table th {
  position: sticky; top: 0; z-index: 1;
  padding: 7px 6px; text-align: left; font-weight: 500; color: var(--text-muted);
  background: var(--bg-subtle); border-bottom: 1px solid var(--border);
}
.imp-table td { padding: 3px 5px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.imp-table tr.ignored td { opacity: .45; }
.imp-table tr.ignored .btn { opacity: 1; }
.imp-line { color: var(--text-disabled); font-variant-numeric: tabular-nums; text-align: center; }
.imp-res {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; line-height: 1.5;
  padding: 0 2px;
}
.imp-res.muted { color: var(--text-disabled); }
.imp-res.ok { color: var(--text-muted); }
.imp-res.new { color: var(--primary); }
.imp-res.conflict { color: var(--danger); }
.imp-cell-input {
  height: 26px; padding: 0 6px; border-color: transparent; background: transparent;
  font-size: var(--fs-xs); border-radius: var(--radius-xs);
}
.imp-cell-input:hover { border-color: var(--border-soft); }
.imp-cell-input:focus { border-color: var(--primary); background: var(--bg-panel); }
.imp-state {
  display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; white-space: nowrap;
}
.imp-state.ok { color: var(--success); background: var(--success-soft); }
.imp-state.warn { color: var(--warning); background: var(--warning-soft); }
.imp-state.error { color: var(--danger); background: var(--danger-soft); }
.imp-state.ignored { color: var(--text-disabled); background: var(--bg-hover); }
.imp-empty { padding: 24px 0; text-align: center; color: var(--text-muted); }
.imp-dup {
  margin-top: 10px; padding: 8px 10px;
  border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--bg-subtle);
}
.imp-dup-hint { margin: 4px 0 0; font-size: 11px; line-height: 1.6; color: var(--text-muted); }
.imp-summary {
  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  margin-top: 8px; font-size: var(--fs-xs); color: var(--text-muted);
}
.imp-summary b { font-weight: 500; color: var(--text-primary); }
.imp-summary .warn { color: var(--warning); }
.imp-summary .hint { color: var(--primary); }
</style>
