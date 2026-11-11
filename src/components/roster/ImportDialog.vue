<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FieldMap, ParsedPerson, RawTable } from '../../engine/rosterImport'
import { buildRows, readRosterFile, suggestMapping } from '../../engine/rosterImport'
import UiModal from '../../ui/components/UiModal.vue'
import UiIcon from '../../ui/components/UiIcon.vue'

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
      rows: { name: string; gender: '' | 'M' | 'F'; unit: string; rank: string; duty: string; note: string }[]
      targetUnitId: string
    }
  ): void
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const table = ref<RawTable | null>(null)
const mapping = ref<FieldMap>({ name: 0, gender: -1, unit: -1, rank: -1, duty: -1, note: -1 })
const rows = ref<EditRow[]>([])
const fileName = ref('')
const error = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const targetUnitId = ref('')

const MAP_FIELDS: { key: keyof FieldMap; label: string; required?: boolean }[] = [
  { key: 'name', label: '姓名', required: true },
  { key: 'gender', label: '性别' },
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
      gender: r.gender,
      unit: r.unit.trim(),
      rank: r.rank.trim(),
      duty: r.duty.trim(),
      note: r.note.trim()
    })),
    targetUnitId: targetUnitId.value
  })
  open.value = false
}
</script>

<template>
  <UiModal
    v-model="open"
    title="批量导入人员"
    width="920px"
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
        <UiIcon name="import" :size="22" />
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
      <ul class="imp-tips">
        <li>旧版 .doc 请先另存为 .docx；CSV 支持 UTF-8 与 GBK 编码。</li>
        <li>自动识别的列可在预览里改选。</li>
      </ul>
    </div>

    <template v-else>
      <div class="imp-meta">
        <span class="imp-meta-name">{{ fileName }}</span>
        <span class="imp-meta-sep" />
        <span>{{ table.rows.length }} 行数据</span>
        <span class="imp-meta-sep" />
        <span>{{ table.columns.length }} 列</span>
        <span class="grow" />
        <button type="button" class="imp-reselect" @click="fileInput?.click()">重新选择</button>
        <input
          ref="fileInput"
          type="file"
          class="imp-file"
          accept=".xlsx,.xls,.xlsm,.docx,.csv,.txt,.tsv"
          @change="onPick"
        />
      </div>
      <div v-if="table.warnings.length" class="imp-alert note">{{ table.warnings.join('；') }}</div>

      <div class="imp-map">
        <label v-for="f in MAP_FIELDS" :key="f.key" class="imp-map-item">
          <span class="imp-map-label">{{ f.label }}<i v-if="f.required">*</i></span>
          <select v-model.number="mapping[f.key]" class="imp-select" @change="rebuild">
            <option :value="-1">不导入</option>
            <option v-for="(c, i) in table.columns" :key="f.key + i" :value="i">{{ c }}</option>
          </select>
        </label>
        <label class="imp-map-item">
          <span class="imp-map-label">空单位归入</span>
          <select v-model="targetUnitId" class="imp-select">
            <option v-for="o in unitOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </label>
      </div>

      <div class="imp-alert error" v-if="error">{{ error }}</div>

      <div class="imp-table-wrap">
        <table class="imp-table">
          <colgroup>
            <col style="width: 52px" />
            <col style="width: 116px" />
            <col style="width: 70px" />
            <col />
            <col />
            <col />
            <col />
            <col style="width: 86px" />
            <col style="width: 54px" />
          </colgroup>
          <thead>
            <tr>
              <th>行</th>
              <th>姓名</th>
              <th>性别</th>
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
              <td><input v-model="r.name" class="imp-input" placeholder="姓名" /></td>
              <td>
                <select v-model="r.gender" class="imp-select small">
                  <option value="">—</option>
                  <option value="M">男</option>
                  <option value="F">女</option>
                </select>
              </td>
              <td><input v-model="r.unit" class="imp-input" list="imp-units" placeholder="未填写" /></td>
              <td><input v-model="r.rank" class="imp-input" list="imp-ranks" placeholder="未填写" /></td>
              <td><input v-model="r.duty" class="imp-input" placeholder="如主任" /></td>
              <td><input v-model="r.note" class="imp-input" placeholder="—" /></td>
              <td>
                <span
                  class="imp-state"
                  :class="rowStatus(r)"
                  :title="rowIssues(r)"
                >{{ rowStatus(r) === 'ok' ? '正常' : rowStatus(r) === 'warn' ? '提示' : rowStatus(r) === 'error' ? '缺姓名' : '已忽略' }}</span>
              </td>
              <td>
                <button type="button" class="imp-row-btn" @click="toggleRow(r)">
                  {{ r.ignore ? '恢复' : '忽略' }}
                </button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="9" class="imp-empty">没有解析出人员行，请检查“姓名”列是否选对。</td>
            </tr>
          </tbody>
        </table>
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
      <button class="btn" @click="open = false">取消</button>
      <button class="btn primary" :disabled="!pending.length" @click="submit">
        导入 {{ pending.length }} 人
      </button>
    </template>
  </UiModal>
</template>

<style scoped>
.imp-start { display: flex; flex-direction: column; gap: 12px; }
.imp-drop {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  height: 148px; border: 1px dashed var(--border-strong); border-radius: 10px;
  background: var(--bg-subtle); color: var(--text-secondary);
  font-family: inherit; cursor: pointer; transition: border-color .15s, background .15s;
}
.imp-drop:hover { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary); }
.imp-drop.busy { pointer-events: none; color: var(--text-muted); }
.imp-drop-title { font-size: 13px; }
.imp-drop-hint { font-size: 11px; color: var(--text-muted); }
.imp-file { display: none; }
.imp-tips { margin: 0; padding-left: 16px; font-size: 11px; line-height: 1.9; color: var(--text-muted); }
.imp-alert { padding: 7px 10px; border-radius: 6px; font-size: 11px; line-height: 1.6; }
.imp-alert.error { background: var(--danger-soft, #fbf0ee); color: var(--danger, #b4574e); border: 1px solid var(--danger-line, #ead4cf); }
.imp-alert.note { background: var(--bg-subtle); color: var(--text-muted); border: 1px solid var(--border-soft); }
.imp-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-muted); margin-bottom: 8px; }
.imp-meta-name { color: var(--text-secondary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imp-meta-sep { width: 1px; height: 10px; background: var(--border); }
.imp-reselect {
  height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg); color: var(--text-secondary); font-family: inherit; font-size: 11px; cursor: pointer;
}
.imp-reselect:hover { border-color: var(--primary-line); color: var(--primary); }
.imp-map {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;
  padding: 10px; margin-bottom: 8px; border: 1px solid var(--border-soft); border-radius: 8px; background: var(--bg-subtle);
}
.imp-map-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.imp-map-label { font-size: 10px; color: var(--text-muted); }
.imp-map-label i { color: var(--danger, #b4574e); font-style: normal; margin-left: 1px; }
.imp-select {
  height: 28px; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg); color: var(--text-primary); font-family: inherit; font-size: 11px; outline: none;
  min-width: 0; text-overflow: ellipsis;
}
.imp-select:focus { border-color: var(--primary-line); box-shadow: 0 0 0 2px var(--primary-soft); }
.imp-select.small { padding: 0 4px; }
.imp-table-wrap { max-height: 306px; overflow: auto; border: 1px solid var(--border-soft); border-radius: 8px; }
.imp-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 11px; }
.imp-table th {
  position: sticky; top: 0; z-index: 1;
  padding: 7px 6px; text-align: left; font-weight: 500; color: var(--text-muted);
  background: var(--bg-subtle); border-bottom: 1px solid var(--border);
}
.imp-table td { padding: 3px 5px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
.imp-table tr.ignored td { opacity: .45; }
.imp-table tr.ignored .imp-row-btn { opacity: 1; }
.imp-line { color: var(--text-disabled); font-variant-numeric: tabular-nums; text-align: center; }
.imp-input {
  width: 100%; height: 26px; padding: 0 6px; border: 1px solid transparent; border-radius: 4px;
  background: transparent; color: var(--text-primary); font-family: inherit; font-size: 11px; outline: none;
}
.imp-input:hover { border-color: var(--border-soft); }
.imp-input:focus { border-color: var(--primary-line); background: var(--bg); box-shadow: 0 0 0 2px var(--primary-soft); }
.imp-state {
  display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; white-space: nowrap;
}
.imp-state.ok { color: var(--success); background: var(--success-soft, #eef6f1); }
.imp-state.warn { color: var(--warning); background: var(--warning-soft, #fbf6ec); }
.imp-state.error { color: var(--danger, #b4574e); background: var(--danger-soft, #fbf0ee); }
.imp-state.ignored { color: var(--text-disabled); background: var(--bg-hover); }
.imp-row-btn {
  height: 22px; padding: 0 6px; border: 1px solid transparent; border-radius: 4px;
  background: none; color: var(--text-muted); font-family: inherit; font-size: 10px; cursor: pointer;
}
.imp-row-btn:hover { border-color: var(--border); color: var(--primary); }
.imp-empty { padding: 24px 0; text-align: center; color: var(--text-muted); }
.imp-summary {
  display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
  margin-top: 8px; font-size: 11px; color: var(--text-muted);
}
.imp-summary b { font-weight: 500; color: var(--text-primary); }
.imp-summary .warn { color: var(--warning); }
.imp-summary .hint { color: var(--primary); }
</style>
