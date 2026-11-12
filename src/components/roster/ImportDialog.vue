<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FieldMap, ParsedPerson, RawTable } from '../../engine/rosterImport'
import { buildRows, readRosterFile, suggestMapping } from '../../engine/rosterImport'
import { UiButton, UiCheckbox, UiIcon, UiModal, UiSelect } from '../../ui'

interface EditRow extends ParsedPerson {
  ignore: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    unitOptions: { value: string; label: string }[]
    unitNames: string[]
    rankNames: string[]
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
const newUnits = computed(() => {
  const known = new Set(props.unitNames)
  return [...new Set(pending.value.map((r) => r.unit.trim()).filter((u) => u && !known.has(u)))]
})
const newRanks = computed(() => {
  const known = new Set(props.rankNames)
  return [...new Set(pending.value.map((r) => r.rank.trim()).filter((u) => u && !known.has(u)))]
})

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
  if (!pending.value.length) return
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
    width="940px"
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
            <col style="width: 46px" />
            <col style="width: 116px" />
            <col />
            <col />
            <col />
            <col />
            <col style="width: 78px" />
            <col style="width: 58px" />
          </colgroup>
          <thead>
            <tr>
              <th>行</th>
              <th>姓名</th>
              <th>单位</th>
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
              <td><input v-model="r.rank" class="insp-input imp-cell-input" list="imp-ranks" placeholder="未填写" /></td>
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
              <td colspan="8" class="imp-empty">没有解析出人员行，请检查「姓名」列是否选对。</td>
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
      </div>

      <datalist id="imp-units">
        <option v-for="u in unitNames" :key="u" :value="u" />
      </datalist>
      <datalist id="imp-ranks">
        <option v-for="u in rankNames" :key="u" :value="u" />
      </datalist>
    </template>

    <template #footer>
      <UiButton variant="ghost" @click="open = false">取消</UiButton>
      <UiButton variant="primary" :disabled="!pending.length" @click="submit">
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
