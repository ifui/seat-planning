<script setup lang="ts">
/**
 * 会场布局：Excel 式工作表工作台。
 * 数据模型：行列 → 单元格（座位 / 主席台 / 特殊块），排号与座号由格子决定。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BorderSide, CellStyle, ElementKind, LayoutElement, LayoutPackage, Sheet, SheetCell } from '../types'
import type { CellRange } from '../engine/sheet'
import {
  addMerge,
  anchorOf,
  blockRoleLabel,
  cellAt,
  clampSeats,
  cloneCell,
  createBlankLayout,
  eachCell,
  fillSeats,
  insertCols,
  insertRows,
  isCovered,
  keyOf,
  mergeAt,
  normalizeRange,
  normalizeSheet,
  nowISO,
  removeMerge,
  seatsOfSheet,
  setCell,
  uid
} from '../engine/sheet'
import { deleteRows, deleteCols } from '../engine/sheet'
import { loadAll, removeLayout, rosterOf, saveLayout, saveProject, state } from '../store'
import { useLayoutHistory } from '../composables/useLayoutHistory'
import SheetToolbar from '../components/sheet/SheetToolbar.vue'
import SheetGrid from '../components/sheet/SheetGrid.vue'
import SheetInspector from '../components/sheet/SheetInspector.vue'
import ElementInspector from '../components/sheet/ElementInspector.vue'
import {
  anchorToCell,
  anchorToFree,
  applyLayerAction,
  createElement,
  elementLabel,
  maxZ,
  normalizeElements,
  shiftElementAnchors
} from '../engine/elements'
import type { LayerAction } from '../engine/elements'
import FillDialog from '../components/sheet/FillDialog.vue'
import SheetSetupDialog from '../components/sheet/SheetSetupDialog.vue'
import UiContextMenu from '../ui/components/UiContextMenu.vue'
import UiMenuItem from '../ui/components/UiMenuItem.vue'
import UiButton from '../ui/components/UiButton.vue'
import UiDropdown from '../ui/components/UiDropdown.vue'
import UiIconButton from '../ui/components/UiIconButton.vue'
import UiModal from '../ui/components/UiModal.vue'
import UiNumberInput from '../ui/components/UiNumberInput.vue'

const current = ref<LayoutPackage | null>(null)
const selection = ref<CellRange>({ r1: 0, c1: 0, r2: 0, c2: 0 })
const active = ref({ row: 0, col: 0 })
const dirty = ref(false)
const toastMsg = ref('')
let toastTimer = 0

const { canUndo, canRedo, resetHistory, historyPush, undo, redo } = useLayoutHistory(current)

const sheet = computed(() => current.value!.sheet)

const layouts = computed(() =>
  [...state.layouts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
)

function toast(msg: string): void {
  toastMsg.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastMsg.value = ''), 2600)
}

function commit(): void {
  historyPush()
  markDirty()
}

// ---- 自动保存：停止编辑 900ms 后落盘，切换/关闭前兜底 ----
let autosaveTimer = 0
let autosaveSeq = 0

function scheduleAutosave(): void {
  autosaveSeq++
  const seq = autosaveSeq
  window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(async () => {
    if (seq !== autosaveSeq || !dirty.value || !current.value) return
    await saveLayout(current.value)
    if (seq === autosaveSeq) dirty.value = false
  }, 900)
}

function markDirty(): void {
  dirty.value = true
  scheduleAutosave()
}

async function flushAutosave(): Promise<void> {
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  if (!dirty.value || !current.value) return
  await saveLayout(current.value)
  dirty.value = false
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

async function selectLayout(id: string): Promise<void> {
  if (dirty.value && current.value && current.value.id !== id) await flushAutosave()
  const found = state.layouts.find((l) => l.id === id)
  if (!found) return
  const next = JSON.parse(JSON.stringify(found)) as LayoutPackage
  next.sheet = normalizeSheet(next.sheet)
  next.elements = normalizeElements(next.elements, next.sheet)
  current.value = next
  selection.value = { r1: 0, c1: 0, r2: 0, c2: 0 }
  active.value = { row: 0, col: 0 }
  dirty.value = false
  resetHistory()
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('keydown', onGlobalKey, true)
  if (!state.ready) await loadAll()
  if (state.layouts.length) await selectLayout(state.layouts[0].id)
  else await createLayout()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('keydown', onGlobalKey, true)
  window.clearTimeout(autosaveTimer)
  void flushAutosave()
})

async function createLayout(): Promise<void> {
  const layout = createBlankLayout(`会场布局 ${state.layouts.length + 1}`)
  await saveLayout(layout)
  await selectLayout(layout.id)
  toast('已新建空白表格')
}

async function reloadCurrent(): Promise<void> {
  if (!current.value) return
  if (dirty.value && !window.confirm('放弃未保存的修改，重新载入？')) return
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  dirty.value = false
  await selectLayout(current.value.id)
  toast('已重新载入')
}

async function save(): Promise<void> {
  if (!current.value) return
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  await saveLayout(current.value)
  dirty.value = false
  toast('已保存到本地')
}

function exportJson(): void {
  if (!current.value) return
  const blob = new Blob([JSON.stringify(current.value, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${current.value.name}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

// ---------- 布局切换与编辑 ----------

const renameOpen = ref(false)
const renameName = ref('')
const deleteOpen = ref(false)
const gridRef = ref<InstanceType<typeof SheetGrid> | null>(null)

function openRename(): void {
  if (!current.value) return
  renameName.value = current.value.name
  renameOpen.value = true
}

async function confirmRename(): Promise<void> {
  if (!current.value) return
  const name = renameName.value.trim()
  if (!name) {
    toast('请填写布局名称')
    return
  }
  current.value.name = name
  current.value.updatedAt = nowISO()
  await saveLayout(current.value)
  renameOpen.value = false
  dirty.value = false
  toast('已重命名')
}

async function duplicateLayout(): Promise<void> {
  if (!current.value) return
  await flushAutosave()
  const copy = JSON.parse(JSON.stringify(current.value)) as LayoutPackage
  copy.id = uid('layout')
  copy.name = `${current.value.name} 副本`
  copy.createdAt = nowISO()
  copy.updatedAt = nowISO()
  copy.sheet = normalizeSheet(copy.sheet)
  await saveLayout(copy)
  await selectLayout(copy.id)
  toast('已复制为新布局')
}

function openDelete(): void {
  if (!current.value) return
  deleteOpen.value = true
}

async function confirmDelete(): Promise<void> {
  if (!current.value) return
  deleteOpen.value = false
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  dirty.value = false
  await removeLayout(current.value.id)
  if (state.layouts.length) await selectLayout(state.layouts[0].id)
  else await createLayout()
  toast('已删除当前布局')
}

/** Ctrl/⌘ + 滚轮只缩放画布；面板、工具栏等固定界面不参与缩放 */
function onRootWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  if ((e.target as HTMLElement | null)?.closest('.sg-scroll')) return
  e.preventDefault()
  gridRef.value?.zoomBy(e.deltaY > 0 ? -1 : 1)
}

const fileInput = ref<HTMLInputElement | null>(null)

function onImportClick(): void {
  fileInput.value?.click()
}

async function onImportFile(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    if (Array.isArray(parsed?.layouts)) {
      const items = parsed.layouts.filter((l: LayoutPackage) => l && l.sheet && l.schemaVersion === '2.0')
      if (!items.length) {
        toast('布局包中没有可导入的布局')
        return
      }
      let last: LayoutPackage | null = null
      for (const item of items) {
        const layout = JSON.parse(JSON.stringify(item)) as LayoutPackage
        layout.id = uid('layout')
        layout.name = `${layout.name || '导入的布局'}`
        layout.createdAt = nowISO()
        layout.updatedAt = nowISO()
        await saveLayout(layout)
        last = layout
      }
      if (last) await selectLayout(last.id)
      toast(`已导入 ${items.length} 个布局`)
      return
    }
    const single = parsed as LayoutPackage
    if (single.schemaVersion !== '2.0' || !single.sheet) {
      toast('只支持 2.0 表格布局文件或布局包')
      return
    }
    single.id = uid('layout')
    single.name = `${single.name || '导入的布局'}`
    await saveLayout(single)
    await selectLayout(single.id)
    toast('导入成功')
  } catch {
    toast('文件解析失败')
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

// ---------- 选区信息 ----------

/** 选区若碰到合并区，自动扩展到合并区完整边界，保证复制/样式/操作与所见一致 */
function expandRangeToMerges(s: { merges: { row: number; col: number; rowSpan: number; colSpan: number }[] }, input: CellRange): CellRange {
  let { r1, c1, r2, c2 } = input
  for (let guard = 0; guard < 8; guard++) {
    let changed = false
    for (const m of s.merges) {
      const hit = m.row <= r2 && m.row + m.rowSpan - 1 >= r1 && m.col <= c2 && m.col + m.colSpan - 1 >= c1
      if (!hit) continue
      const nr1 = Math.min(r1, m.row)
      const nc1 = Math.min(c1, m.col)
      const nr2 = Math.max(r2, m.row + m.rowSpan - 1)
      const nc2 = Math.max(c2, m.col + m.colSpan - 1)
      if (nr1 !== r1 || nc1 !== c1 || nr2 !== r2 || nc2 !== c2) {
        r1 = nr1
        c1 = nc1
        r2 = nr2
        c2 = nc2
        changed = true
      }
    }
    if (!changed) break
  }
  return { r1, c1, r2, c2 }
}

const range = computed<CellRange>(() => {
  const base = {
    r1: Math.min(selection.value.r1, selection.value.r2),
    c1: Math.min(selection.value.c1, selection.value.c2),
    r2: Math.max(selection.value.r1, selection.value.r2),
    c2: Math.max(selection.value.c1, selection.value.c2)
  }
  return current.value ? expandRangeToMerges(current.value.sheet, base) : base
})

const selectionLabel = computed(() => {
  const r = range.value
  const a = `${r.c1 + 1} 列 ${r.r1 + 1} 行`
  const b = `${r.c2 + 1} 列 ${r.r2 + 1} 行`
  return a === b ? a : `${a} – ${b}`
})

const cellCount = computed(() => (range.value.r2 - range.value.r1 + 1) * (range.value.c2 - range.value.c1 + 1))

const activeCell = computed(() => {
  if (!current.value) return undefined
  const m = mergeAt(current.value.sheet, active.value.row, active.value.col)
  return cellAt(current.value.sheet, m ? m.row : active.value.row, m ? m.col : active.value.col)
})

// ---------- 边框 ----------

const borderStyle = ref<'solid' | 'dashed' | 'dotted'>('solid')
const borderWidth = ref(1)
const borderColor = ref('#333333')

/**
 * 快捷边框：一次点击把选区整体加上对应边；若选区内这些边都已存在，则再点一次取消。
 * 只写数据层（style.borders），渲染与导出都按这份数据画线。
 */
function applyBorder(kind: 'outer' | 'all' | 'left' | 'right' | 'top' | 'bottom' | 'none'): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  const targets: { row: number; col: number; cell: SheetCell; sides: BorderSide[] }[] = []

  eachCell(s, r, (row, col, cell) => {
    if (!cell) return
    const m = mergeAt(s, row, col)
    if (m && (m.row !== row || m.col !== col)) return
    const rowSpan = m?.rowSpan ?? 1
    const colSpan = m?.colSpan ?? 1
    let sides: BorderSide[]
    if (kind === 'none' || kind === 'all') {
      sides = ['top', 'right', 'bottom', 'left']
    } else if (kind === 'outer') {
      sides = []
      if (row === r.r1) sides.push('top')
      if (col === r.c1) sides.push('left')
      if (row + rowSpan - 1 === r.r2) sides.push('bottom')
      if (col + colSpan - 1 === r.c2) sides.push('right')
    } else {
      sides = [kind]
    }
    if (sides.length) targets.push({ row, col, cell, sides })
  })
  if (!targets.length) return

  const has = (c: SheetCell, side: BorderSide): boolean => !!c.style?.borders?.includes(side)
  const allSet = targets.every((t) => t.sides.every((side) => has(t.cell, side)))

  for (const t of targets) {
    const next = new Set<BorderSide>(t.cell.style?.borders ?? [])
    for (const side of t.sides) {
      if (allSet || kind === 'none') next.delete(side)
      else next.add(side)
    }
    const borders = (['top', 'right', 'bottom', 'left'] as BorderSide[]).filter((side) => next.has(side))
    setCell(s, t.row, t.col, {
      ...t.cell,
      style: {
        ...(t.cell.style ?? {}),
        strokeStyle: borderStyle.value,
        strokeWidth: borderWidth.value,
        stroke: borderColor.value,
        // 空数组表示「显式清除」，与未设置（默认黑框）区分
        borders
      }
    })
  }
  commit()
}

/** 线型/粗细/线色立即作用于选区里已有边框的格子 */
function patchBorderStyle(patch: Pick<CellStyle, 'strokeStyle' | 'strokeWidth' | 'stroke'>): void {
  if (!current.value) return
  const s = current.value.sheet
  let touched = false
  eachCell(s, range.value, (row, col, cell) => {
    if (!cell?.style?.borders?.length) return
    setCell(s, row, col, { ...cell, style: { ...cell.style, ...patch } })
    touched = true
  })
  if (touched) commit()
}

function setBorderStyle(v: 'solid' | 'dashed' | 'dotted'): void {
  borderStyle.value = v
  patchBorderStyle({ strokeStyle: v })
}
function setBorderWidth(v: number): void {
  borderWidth.value = v
  patchBorderStyle({ strokeWidth: v })
}
function setBorderColor(v: string): void {
  borderColor.value = v
  patchBorderStyle({ stroke: v })
}

// 切换选区时让下拉回显当前格子的边框样式
watch(activeCell, (c) => {
  const st = c?.style
  borderStyle.value = st?.strokeStyle === 'dashed' || st?.strokeStyle === 'dotted' ? st.strokeStyle : 'solid'
  borderWidth.value = Math.max(1, Math.min(3, Math.round(st?.strokeWidth ?? 1)))
  borderColor.value = st?.stroke ?? '#333333'
})

// ---------- 单元格操作 ----------

function setType(kind: 'seat' | 'podium' | 'block', role?: 'aisle'): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    const base: SheetCell = cell ? { ...cell } : { kind }
    if (kind === 'block') {
      base.kind = 'block'
      if (role) base.role = role
      else delete base.role
      delete base.seats
      delete base.seatIds
      if (!base.text) base.text = blockRoleLabel(base.role)
    } else {
      base.kind = kind
      base.seats = clampSeats(base.seats ?? 1)
      delete base.role
      delete base.text
      ensureIds(base)
    }
    setCell(s, row, col, base)
  })
  commit()
}

function ensureIds(cell: SheetCell): void {
  const n = clampSeats(cell.seats ?? 1)
  const ids = cell.seatIds ? [...cell.seatIds] : []
  while (ids.length < n) ids.push(`seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
  ids.length = n
  cell.seatIds = ids
}

/**
 * 遍历选区内真正可写的锚点格：点到合并块内部格时也归到锚点，
 * 否则属性面板的区域/座位数等修改会被静默丢弃（合并块只有锚点存了内容）。
 */
function eachSelectedCell(
  s: Sheet,
  range: CellRange,
  fn: (row: number, col: number, cell: SheetCell) => void
): void {
  const r = normalizeRange(range)
  const seen = new Set<string>()
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      const a = anchorOf(s, row, col)
      const key = keyOf(a.row, a.col)
      if (seen.has(key)) continue
      seen.add(key)
      const cell = cellAt(s, a.row, a.col)
      if (cell) fn(a.row, a.col, cell)
    }
  }
}

function patchCell(patch: Partial<SheetCell>): void {
  if (!current.value) return
  const s = current.value.sheet
  eachSelectedCell(s, range.value, (row, col, cell) => {
    const next: SheetCell = { ...cell, ...patch }
    setCell(s, row, col, next)
  })
  commit()
}

/**
 * 样式修改：preview 用于取色器拖动中的实时预览，只刷新画布不写撤销历史；
 * commit 在取色结束时落一次历史，整次调色只占一步。
 */
function patchStyle(patch: CellStyle, preview = false): void {
  if (!current.value) return
  const s = current.value.sheet
  eachSelectedCell(s, range.value, (row, col, cell) => {
    setCell(s, row, col, { ...cell, style: { ...(cell.style ?? {}), ...patch } })
  })
  if (preview) {
    markDirty()
    return
  }
  commit()
}

function mergeSelection(): void {
  if (!current.value) return
  const err = addMerge(current.value.sheet, range.value)
  if (err) {
    toast(err)
    return
  }
  commit()
  toast('已合并单元格')
}

function unmergeSelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  let changed = false
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      const m = mergeAt(s, row, col)
      if (m) {
        removeMerge(s, m.row, m.col)
        changed = true
        row = Math.max(row, m.row + m.rowSpan - 1)
      }
    }
  }
  if (!changed) {
    toast('选区内没有合并单元格')
    return
  }
  commit()
}

function insertRow(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.r2 - range.value.r1 + 1
  insertRows(s, range.value.r1, n)
  shiftElementAnchors(current.value.elements, s, { axis: 'row', at: range.value.r1, count: n, remove: false })
  commit()
}

function removeRows(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.r2 - range.value.r1 + 1
  if (s.rows - n < 1) {
    toast('至少要保留一行')
    return
  }
  deleteRows(s, range.value.r1, n)
  shiftElementAnchors(current.value.elements, s, { axis: 'row', at: range.value.r1, count: n, remove: true })
  selection.value = { r1: Math.min(range.value.r1, s.rows - 1), c1: range.value.c1, r2: Math.min(range.value.r1, s.rows - 1), c2: range.value.c2 }
  commit()
}

function insertCol(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.c2 - range.value.c1 + 1
  insertCols(s, range.value.c1, n)
  shiftElementAnchors(current.value.elements, s, { axis: 'col', at: range.value.c1, count: n, remove: false })
  commit()
}

function removeCols(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.c2 - range.value.c1 + 1
  if (s.cols - n < 1) {
    toast('至少要保留一列')
    return
  }
  deleteCols(s, range.value.c1, n)
  shiftElementAnchors(current.value.elements, s, { axis: 'col', at: range.value.c1, count: n, remove: true })
  selection.value = { r1: range.value.r1, c1: Math.min(range.value.c1, s.cols - 1), r2: range.value.r2, c2: Math.min(range.value.c1, s.cols - 1) }
  commit()
}

// ---------- 行号 / 列标右键：按表头坐标插入、删除 ----------

const hctx = ref<{ open: boolean; x: number; y: number; axis: 'row' | 'col'; index: number }>({
  open: false, x: 0, y: 0, axis: 'row', index: 0
})

function onHeaderContext(p: { x: number; y: number; axis: 'row' | 'col'; index: number }): void {
  hctx.value = { ...p, open: true }
}

function headerRun(fn: () => void): void {
  hctx.value.open = false
  fn()
}

const nDialog = ref<{ axis: 'row' | 'col'; side: 'before' | 'after'; index: number } | null>(null)
const nCount = ref(2)
const nDialogOpen = computed({
  get: () => !!nDialog.value,
  set: (v: boolean) => { if (!v) nDialog.value = null }
})
const nDialogTitle = computed(() => {
  const d = nDialog.value
  if (!d) return '插入'
  const side = d.side === 'before'
    ? (d.axis === 'row' ? '上方' : '左侧')
    : (d.axis === 'row' ? '下方' : '右侧')
  return `在${side}插入${d.axis === 'row' ? '行' : '列'}`
})

function openInsertN(axis: 'row' | 'col', side: 'before' | 'after', index: number): void {
  nCount.value = 2
  nDialog.value = { axis, side, index }
}

/** 在第 index 行/列的前（before）或后（after）插入 count 条；插入后选中新插入的整行/整列 */
function insertAt(axis: 'row' | 'col', index: number, side: 'before' | 'after', count: number): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = Math.max(1, Math.min(50, Math.round(count) || 1))
  const at = side === 'before' ? index : index + 1
  if (axis === 'row') {
    insertRows(s, at, n)
    shiftElementAnchors(current.value.elements, s, { axis: 'row', at, count: n, remove: false })
    selection.value = { r1: at, c1: 0, r2: Math.min(at + n - 1, s.rows - 1), c2: s.cols - 1 }
    active.value = { row: at, col: 0 }
  } else {
    insertCols(s, at, n)
    shiftElementAnchors(current.value.elements, s, { axis: 'col', at, count: n, remove: false })
    selection.value = { r1: 0, c1: at, r2: s.rows - 1, c2: Math.min(at + n - 1, s.cols - 1) }
    active.value = { row: 0, col: at }
  }
  commit()
}

function confirmInsertN(): void {
  const d = nDialog.value
  if (!d) return
  insertAt(d.axis, d.index, d.side, nCount.value)
  nDialog.value = null
}

function deleteHeaderLine(axis: 'row' | 'col', index: number): void {
  if (!current.value) return
  const s = current.value.sheet
  if (axis === 'row') {
    if (s.rows <= 1) { toast('至少要保留一行'); return }
    deleteRows(s, index, 1)
    shiftElementAnchors(current.value.elements, s, { axis: 'row', at: index, count: 1, remove: true })
    const r = Math.min(index, s.rows - 1)
    selection.value = { r1: r, c1: 0, r2: r, c2: s.cols - 1 }
    active.value = { row: r, col: 0 }
  } else {
    if (s.cols <= 1) { toast('至少要保留一列'); return }
    deleteCols(s, index, 1)
    shiftElementAnchors(current.value.elements, s, { axis: 'col', at: index, count: 1, remove: true })
    const c = Math.min(index, s.cols - 1)
    selection.value = { r1: 0, c1: c, r2: s.rows - 1, c2: c }
    active.value = { row: 0, col: c }
  }
  commit()
}

interface DeleteImpact {
  projectId: string
  projectName: string
  memberIds: string[]
  names: string[]
}

const delDialog = ref<{
  axis: 'row' | 'col'
  index: number
  seats: number
  impacts: DeleteImpact[]
} | null>(null)
const delDialogOpen = computed({
  get: () => !!delDialog.value,
  set: (v: boolean) => { if (!v) delDialog.value = null }
})
const delDialogTitle = computed(() => {
  const d = delDialog.value
  if (!d) return '删除'
  return d.axis === 'row' ? `删除第 ${d.index + 1} 行` : `删除第 ${d.index + 1} 列`
})
/** 删除会失去座位的已排人员总数 */
const delPeopleCount = computed(() =>
  (delDialog.value?.impacts ?? []).reduce((n, x) => n + x.memberIds.length, 0)
)

/** 删除前的二次确认：布局本身的删除可用撤销恢复，但已排人员的座位被移除后无法自动还原 */
function askDeleteHeaderLine(axis: 'row' | 'col', index: number): void {
  if (!current.value) return
  const s = current.value.sheet
  if (axis === 'row' && s.rows <= 1) { toast('至少要保留一行'); return }
  if (axis === 'col' && s.cols <= 1) { toast('至少要保留一列'); return }
  const seats = seatsOfSheet(s).filter((x) => (axis === 'row' ? x.row === index : x.col === index))
  const seatIds = new Set(seats.map((x) => x.seatId))
  const impacts: DeleteImpact[] = []
  for (const p of state.projects) {
    if (p.layoutPackageId !== current.value.id) continue
    const hit = p.assignments.filter((a) => seatIds.has(a.seatId))
    if (!hit.length) continue
    const roster = rosterOf(p)
    const nameOf = new Map((roster?.members ?? []).map((m) => [m.id, m.name]))
    impacts.push({
      projectId: p.id,
      projectName: p.name,
      memberIds: hit.map((a) => a.memberId),
      names: hit.map((a) => nameOf.get(a.memberId) ?? '未知')
    })
  }
  delDialog.value = { axis, index, seats: seatIds.size, impacts }
}

/** 确认删除：先清理受影响项目里指向被删座位的分配，再执行结构删除 */
async function confirmDeleteHeaderLine(): Promise<void> {
  const d = delDialog.value
  if (!d || !current.value) return
  delDialog.value = null
  const s = current.value.sheet
  const seatIds = new Set(
    seatsOfSheet(s)
      .filter((x) => (d.axis === 'row' ? x.row === d.index : x.col === d.index))
      .map((x) => x.seatId)
  )
  const notes: string[] = []
  for (const impact of d.impacts) {
    const p = state.projects.find((x) => x.id === impact.projectId)
    if (!p) continue
    p.assignments = p.assignments.filter((a) => !seatIds.has(a.seatId))
    p.unassigned = [...new Set([...p.unassigned, ...impact.memberIds])]
    await saveProject(p)
    const shown = impact.names.slice(0, 3).join('、') + (impact.names.length > 3 ? ' 等' : '')
    notes.push(`${impact.projectName} ${impact.names.length} 人（${shown}）`)
  }
  deleteHeaderLine(d.axis, d.index)
  if (notes.length) toast(`已删除，${notes.join('；')} 被移出座位`)
}

function clearSelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (cell?.locked) return
    setCell(s, row, col, undefined)
  })
  commit()
}

// ---------- 自由元素 ----------

const selectedElementId = ref<string | null>(null)

const selectedElement = computed<LayoutElement | null>(
  () => current.value?.elements.find((e) => e.id === selectedElementId.value) ?? null
)

const selectedIsTop = computed(() => {
  const list = current.value?.elements ?? []
  const el = selectedElement.value
  if (!el) return false
  return el.zIndex >= Math.max(...list.map((e) => e.zIndex))
})

const selectedIsBottom = computed(() => {
  const list = current.value?.elements ?? []
  const el = selectedElement.value
  if (!el) return false
  return el.zIndex <= Math.min(...list.map((e) => e.zIndex))
})

function selectElement(id: string): void {
  selectedElementId.value = id
}

function onSelectionChange(v: CellRange): void {
  selection.value = v
  selectedElementId.value = null
}

/** 拖动/缩放过程中只改数据不压历史，松手后才 commit */
let reanchorPending: string | null = null

function patchElement(id: string, patch: Partial<LayoutElement>, commitNow = false): void {
  if (!current.value) return
  const el = current.value.elements.find((e) => e.id === id)
  if (!el) return
  const changesGeometry = 'x' in patch || 'y' in patch || 'w' in patch || 'h' in patch
  // 固定单元格的元素拖动时先固化几何，松手再重新锚定，视觉不跳
  if (changesGeometry && el.anchor.mode === 'cell') {
    anchorToFree(el, current.value.sheet)
    reanchorPending = id
  }
  Object.assign(el, patch)
  current.value.updatedAt = nowISO()
  if (commitNow) finishCommit()
  else markDirty()
}

/** 手势结束：把临时改为绝对坐标的元素按落点重新锚定回单元格 */
function finishCommit(): void {
  if (current.value && reanchorPending) {
    const el = current.value.elements.find((e) => e.id === reanchorPending)
    if (el) anchorToCell(el, current.value.sheet)
  }
  reanchorPending = null
  commit()
}

function onElementCommit(): void {
  finishCommit()
}

function addElement(kind: ElementKind): void {
  if (!current.value) return
  const el = createElement(kind, current.value.sheet, current.value.elements, { range: range.value })
  current.value.elements.push(el)
  selectedElementId.value = el.id
  commit()
  toast(`已添加${elementLabel(kind)}`)
}

function duplicateElement(): void {
  if (!current.value || !selectedElement.value) return
  const source = selectedElement.value
  const copy = JSON.parse(JSON.stringify(source)) as LayoutElement
  const wasCell = copy.anchor.mode === 'cell'
  anchorToFree(copy, current.value.sheet)
  copy.x += 16
  copy.y += 16
  if (wasCell) anchorToCell(copy, current.value.sheet)
  copy.id = `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  copy.zIndex = maxZ(current.value.elements) + 1
  current.value.elements.push(copy)
  selectedElementId.value = copy.id
  commit()
  toast('已复制元素')
}

function removeElement(): void {
  if (!current.value || !selectedElementId.value) return
  current.value.elements = current.value.elements.filter((e) => e.id !== selectedElementId.value)
  selectedElementId.value = null
  commit()
}

function layerElement(action: LayerAction): void {
  if (!current.value || !selectedElementId.value) return
  applyLayerAction(current.value.elements, selectedElementId.value, action)
  commit()
}

// ---------- 复制粘贴 / 填充 ----------

interface Clip {
  cells: { dr: number; dc: number; cell: SheetCell }[]
  merges: { dr: number; dc: number; rowSpan: number; colSpan: number }[]
  w: number
  h: number
}

let clip: Clip | null = null

function copySelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  const data: Clip = { cells: [], merges: [], w: r.c2 - r.c1 + 1, h: r.r2 - r.r1 + 1 }
  eachCell(s, r, (row, col, cell) => {
    if (cell) data.cells.push({ dr: row - r.r1, dc: col - r.c1, cell: JSON.parse(JSON.stringify(cell)) })
  })
  for (const m of s.merges) {
    if (m.row >= r.r1 && m.col >= r.c1 && m.row + m.rowSpan - 1 <= r.r2 && m.col + m.colSpan - 1 <= r.c2) {
      data.merges.push({ dr: m.row - r.r1, dc: m.col - r.c1, rowSpan: m.rowSpan, colSpan: m.colSpan })
    }
  }
  clip = data
  toast(`已复制 ${data.cells.length} 个单元格`)
}

function pasteClipboard(): void {
  if (!current.value) return
  if (!clip) {
    toast('剪贴板为空')
    return
  }
  const s = current.value.sheet
  const baseRow = active.value.row
  const baseCol = active.value.col
  const dstR2 = Math.min(s.rows - 1, baseRow + clip.h - 1)
  const dstC2 = Math.min(s.cols - 1, baseCol + clip.w - 1)
  // 先清掉目标区域内的旧合并，避免新旧合并重叠产生幽灵边框
  s.merges = s.merges.filter(
    (m) => !(m.row <= dstR2 && m.row + m.rowSpan - 1 >= baseRow && m.col <= dstC2 && m.col + m.colSpan - 1 >= baseCol)
  )
  for (const item of clip.cells) {
    const row = baseRow + item.dr
    const col = baseCol + item.dc
    if (row >= s.rows || col >= s.cols) continue
    const next = cloneCell(item.cell, true)
    setCell(s, row, col, next)
  }
  for (const m of clip.merges) {
    const row = baseRow + m.dr
    const col = baseCol + m.dc
    if (row + m.rowSpan > s.rows || col + m.colSpan > s.cols) continue
    if (mergeAt(s, row, col)) continue
    s.merges.push({ row, col, rowSpan: m.rowSpan, colSpan: m.colSpan })
  }
  selection.value = {
    r1: baseRow,
    c1: baseCol,
    r2: dstR2,
    c2: dstC2
  }
  commit()
}

function fillDown(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  if (r.r2 <= r.r1) {
    toast('请先选中多行再向下填充')
    return
  }
  for (let col = r.c1; col <= r.c2; col++) {
    if (isCovered(s, r.r1, col)) continue
    const src = cellAt(s, r.r1, col)
    if (!src) continue
    for (let row = r.r1 + 1; row <= r.r2; row++) {
      if (isCovered(s, row, col)) continue
      setCell(s, row, col, cloneCell(src, true))
    }
  }
  commit()
}

function fillRight(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  if (r.c2 <= r.c1) {
    toast('请先选中多列再向右填充')
    return
  }
  for (let row = r.r1; row <= r.r2; row++) {
    if (isCovered(s, row, r.c1)) continue
    const src = cellAt(s, row, r.c1)
    if (!src) continue
    for (let col = r.c1 + 1; col <= r.c2; col++) {
      if (isCovered(s, row, col)) continue
      setCell(s, row, col, cloneCell(src, true))
    }
  }
  commit()
}

// ---------- 编辑 / 批量填充 / 表格设置 ----------

const fillOpen = ref(false)
const setupOpen = ref(false)

function onEdit(p: { row: number; col: number; text: string }): void {
  if (!current.value) return
  const s = current.value.sheet
  const m = mergeAt(s, p.row, p.col)
  const row = m ? m.row : p.row
  const col = m ? m.col : p.col
  const cell = cellAt(s, row, col)
  const text = p.text.trim()
  if (!cell) {
    if (!text) return
    setCell(s, row, col, { kind: 'block', text })
  } else if (cell.kind === 'seat' || cell.kind === 'podium') {
    const next: SheetCell = { ...cell }
    if (text) next.tableLabel = text
    else delete next.tableLabel
    setCell(s, row, col, next)
  } else {
    setCell(s, row, col, { ...cell, text })
  }
  commit()
}

function onFill(payload: { kind: 'seat' | 'podium'; seats: number; tablePerRow: boolean; tableLabel: string }): void {
  if (!current.value) return
  const n = fillSeats(current.value.sheet, range.value, payload)
  commit()
  toast(`已填充 ${n} 个座位格`)
}

function applySetup(v: { rows: number; cols: number; colWidth: number; rowHeight: number; frozenRows: number; frozenCols: number }): void {
  if (!current.value) return
  const s = current.value.sheet
  const next = normalizeSheet({
    ...s,
    rows: v.rows,
    cols: v.cols,
    defaultColWidth: v.colWidth,
    defaultRowHeight: v.rowHeight,
    colWidths: s.colWidths,
    rowHeights: s.rowHeights,
    frozenRows: v.frozenRows,
    frozenCols: v.frozenCols
  })
  // 新增行列时用默认宽高补齐
  for (let c = s.cols; c < v.cols; c++) next.colWidths[c] = v.colWidth
  for (let r = s.rows; r < v.rows; r++) next.rowHeights[r] = v.rowHeight
  current.value.sheet = next
  selection.value = { r1: 0, c1: 0, r2: 0, c2: 0 }
  active.value = { row: 0, col: 0 }
  commit()
  toast('表格尺寸已更新')
}

function onGlobalKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const typing = !!target && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
  if (!typing && selectedElementId.value) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      removeElement()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      e.stopPropagation()
      duplicateElement()
      return
    }
  }
}

// ---------- 右键菜单 ----------

const ctx = ref({ open: false, x: 0, y: 0 })

function onContext(p: { x: number; y: number }): void {
  ctx.value = { open: true, x: p.x, y: p.y }
}

function ctxRun(fn: () => void): void {
  ctx.value.open = false
  fn()
}

function onCommand(cmd: string): void {
  switch (cmd) {
    case 'copy':
      copySelection()
      return
    case 'paste':
      pasteClipboard()
      return
    case 'clear':
      clearSelection()
      return
    case 'undo':
      undo()
      markDirty()
      return
    case 'redo':
      redo()
      markDirty()
      return
    case 'fill-down':
      fillDown()
      return
    case 'fill-right':
      fillRight()
      return
  }
}
</script>

<template>
  <div class="layout-view" @wheel="onRootWheel">
    <div class="lv-topbar">
      <div class="lv-current">
        <span class="lv-current-label">当前布局</span>
        <span class="lv-current-name" :title="current?.name">{{ current?.name || '—' }}</span>
      </div>
      <div class="lv-top-actions">
        <UiDropdown align="right" :width="260">
          <template #trigger>
            <UiButton variant="ghost" size="sm" icon="layers">切换</UiButton>
          </template>
          <template #default="{ close }">
            <div class="lv-menu-title">切换布局</div>
            <UiMenuItem
              v-for="l in layouts"
              :key="l.id"
              :icon="current?.id === l.id ? 'check' : 'grid'"
              :label="`${l.name} · ${l.sheet.rows}×${l.sheet.cols}`"
              :checked="current?.id === l.id"
              @click="close(); selectLayout(l.id)"
            />
            <div v-if="!layouts.length" class="lv-menu-empty">还没有布局</div>
          </template>
        </UiDropdown>
        <UiButton variant="ghost" size="sm" icon="plus" @click="createLayout">新建</UiButton>
        <UiDropdown align="right" :width="190">
          <template #trigger>
            <UiIconButton icon="settings" title="管理布局" />
          </template>
          <template #default="{ close }">
            <UiMenuItem icon="edit" label="重命名" @click="close(); openRename()" />
            <UiMenuItem icon="copy" label="复制为新布局" @click="close(); duplicateLayout()" />
            <div class="ctx-sep" />
            <UiMenuItem icon="trash" label="删除当前布局" danger @click="close(); openDelete()" />
          </template>
        </UiDropdown>
      </div>
    </div>

    <div v-if="current" class="lv-main">
      <SheetToolbar
        :can-undo="canUndo"
        :can-redo="canRedo"
        :selection-label="selectionLabel"
        :cell-count="cellCount"
        :border-style="borderStyle"
        :border-width="borderWidth"
        :border-color="borderColor"
        @border="applyBorder"
        @update:border-style="setBorderStyle"
        @update:border-width="setBorderWidth"
        @update:border-color="setBorderColor"
        @back="reloadCurrent"
        @setup="setupOpen = true"
        @save="save"
        @export="exportJson"
        @import="onImportClick"
        @undo="onCommand('undo')"
        @redo="onCommand('redo')"
        @merge="mergeSelection"
        @unmerge="unmergeSelection"
        @type="setType"
        @element-add="addElement"
        @fill="fillOpen = true"
        @clear="clearSelection"
      />

      <div class="lv-work">
        <SheetGrid
          ref="gridRef"
          :sheet="sheet"
          :selection="selection"
          :active="active"
          :elements="current.elements"
          :selected-element-id="selectedElementId"
          @update:selection="onSelectionChange"
          @update:active="active = $event"
          @commit="commit"
          @context="onContext"
          @header-context="onHeaderContext"
          @edit="onEdit"
          @command="onCommand"
          @element-select="selectElement"
          @element-change="patchElement"
          @element-commit="onElementCommit"
        />
        <ElementInspector
          v-if="selectedElement"
          :element="selectedElement"
          :sheet="sheet"
          :is-top="selectedIsTop"
          :is-bottom="selectedIsBottom"
          @update="(p, c) => patchElement(selectedElement!.id, p, c)"
          @layer="layerElement"
          @duplicate="duplicateElement"
          @remove="removeElement"
        />
        <SheetInspector
          v-else
          :sheet="sheet"
          :selection="selection"
          :active="active"
          @patch="patchCell"
          @style="patchStyle"
          @preview-style="(p) => patchStyle(p, true)"
        />
      </div>
    </div>

    <div v-else class="lv-empty">正在加载布局…</div>

    <FillDialog v-model="fillOpen" :range-label="selectionLabel" @fill="onFill" />
    <SheetSetupDialog v-if="current" v-model="setupOpen" :sheet="sheet" @apply="applySetup" />

    <UiModal
      v-model="renameOpen"
      title="重命名布局"
      width="420px"
    >
      <label class="lv-field">
        <span>布局名称</span>
        <input v-model="renameName" class="lv-input" maxlength="40" placeholder="例如：第一会议室布局" @keyup.enter="confirmRename" />
      </label>
      <template #footer>
        <UiButton variant="ghost" size="sm" @click="renameOpen = false">取消</UiButton>
        <UiButton variant="primary" size="sm" @click="confirmRename">保存</UiButton>
      </template>
    </UiModal>

    <UiModal
      v-model="deleteOpen"
      title="删除当前布局"
      description="删除后不可恢复，请确认。"
      width="420px"
    >
      <p class="lv-confirm-text">确定删除布局「{{ current?.name }}」？</p>
      <template #footer>
        <UiButton variant="ghost" size="sm" @click="deleteOpen = false">取消</UiButton>
        <UiButton variant="primary" size="sm" class="lv-danger-btn" @click="confirmDelete">删除</UiButton>
      </template>
    </UiModal>

    <!-- 行号 / 列标右键：行列结构操作 -->
    <UiContextMenu :open="hctx.open" :x="hctx.x" :y="hctx.y" @close="hctx.open = false">
      <div class="ctx-label">{{ hctx.axis === 'row' ? `第 ${hctx.index + 1} 行` : `第 ${hctx.index + 1} 列` }}</div>
      <template v-if="hctx.axis === 'row'">
        <UiMenuItem icon="plus" label="在上方插入 1 行" @click="headerRun(() => insertAt('row', hctx.index, 'before', 1))" />
        <UiMenuItem icon="plus" label="在下方插入 1 行" @click="headerRun(() => insertAt('row', hctx.index, 'after', 1))" />
        <UiMenuItem icon="plus" label="在上方插入 N 行…" @click="headerRun(() => openInsertN('row', 'before', hctx.index))" />
        <UiMenuItem icon="plus" label="在下方插入 N 行…" @click="headerRun(() => openInsertN('row', 'after', hctx.index))" />
        <div class="ctx-sep" />
        <UiMenuItem
          icon="minus"
          label="删除当前行"
          danger
          :disabled="!current || current.sheet.rows <= 1"
          @click="headerRun(() => askDeleteHeaderLine('row', hctx.index))"
        />
      </template>
      <template v-else>
        <UiMenuItem icon="plus" label="在左侧插入 1 列" @click="headerRun(() => insertAt('col', hctx.index, 'before', 1))" />
        <UiMenuItem icon="plus" label="在右侧插入 1 列" @click="headerRun(() => insertAt('col', hctx.index, 'after', 1))" />
        <UiMenuItem icon="plus" label="在左侧插入 N 列…" @click="headerRun(() => openInsertN('col', 'before', hctx.index))" />
        <UiMenuItem icon="plus" label="在右侧插入 N 列…" @click="headerRun(() => openInsertN('col', 'after', hctx.index))" />
        <div class="ctx-sep" />
        <UiMenuItem
          icon="minus"
          label="删除当前列"
          danger
          :disabled="!current || current.sheet.cols <= 1"
          @click="headerRun(() => askDeleteHeaderLine('col', hctx.index))"
        />
      </template>
    </UiContextMenu>

    <UiModal
      v-model="nDialogOpen"
      :title="nDialogTitle"
      description="输入要插入的数量，必须是 1–50 的整数。"
      width="360px"
    >
      <label class="lv-field">
        <span>数量</span>
        <UiNumberInput v-model="nCount" width="100%" :min="1" :max="50" unit="条" :label="nDialogTitle" />
      </label>
      <template #footer>
        <UiButton variant="ghost" size="sm" @click="nDialogOpen = false">取消</UiButton>
        <UiButton variant="primary" size="sm" @click="confirmInsertN">插入</UiButton>
      </template>
    </UiModal>

    <UiModal
      v-model="delDialogOpen"
      :title="delDialogTitle"
      width="420px"
    >
      <div class="lv-fields">
        <p class="del-warn">
          删除会移除该{{ delDialog?.axis === 'row' ? '行' : '列' }}的 {{ delDialog?.seats ?? 0 }} 个座位，已排人员不会自动还原。
        </p>
        <template v-if="delPeopleCount">
          <p class="del-warn del-warn-strong">
            以下 {{ delPeopleCount }} 位已排座人员将被移出座位：
          </p>
          <ul class="del-list">
            <li v-for="x in delDialog?.impacts ?? []" :key="x.projectId">
              {{ x.projectName }}：{{ x.names.slice(0, 6).join('、') }}<template v-if="x.names.length > 6"> 等 {{ x.names.length }} 人</template>
            </li>
          </ul>
        </template>
      </div>
      <template #footer>
        <UiButton variant="ghost" size="sm" @click="delDialogOpen = false">取消</UiButton>
        <UiButton variant="danger" size="sm" @click="confirmDeleteHeaderLine">确认删除</UiButton>
      </template>
    </UiModal>

    <UiContextMenu :open="ctx.open" :x="ctx.x" :y="ctx.y" @close="ctx.open = false">
      <UiMenuItem icon="copy" label="复制" shortcut="Ctrl+C" @click="ctxRun(copySelection)" />
      <UiMenuItem icon="paste" label="粘贴" shortcut="Ctrl+V" @click="ctxRun(pasteClipboard)" />
      <UiMenuItem icon="trash" label="清空内容" shortcut="Del" danger @click="ctxRun(clearSelection)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="square" label="合并单元格" @click="ctxRun(mergeSelection)" />
      <UiMenuItem icon="expand" label="拆分单元格" @click="ctxRun(unmergeSelection)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="plus" label="在上方插入行" @click="ctxRun(insertRow)" />
      <UiMenuItem icon="minus" label="删除选中行" @click="ctxRun(removeRows)" />
      <UiMenuItem icon="plus" label="在左侧插入列" @click="ctxRun(insertCol)" />
      <UiMenuItem icon="minus" label="删除选中列" @click="ctxRun(removeCols)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="seat" label="设为座位" @click="ctxRun(() => setType('seat'))" />
      <UiMenuItem icon="podium" label="设为主席台" @click="ctxRun(() => setType('podium'))" />
      <UiMenuItem icon="aisle" label="设为过道（不坐人）" @click="ctxRun(() => setType('block', 'aisle'))" />
    </UiContextMenu>

    <input ref="fileInput" type="file" accept="application/json,.json" class="lv-file" @change="onImportFile" />

    <Transition name="toast">
      <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
    </Transition>

    <div v-if="dirty" class="lv-dirty">未保存</div>
  </div>
</template>

<style scoped>
.layout-view { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; padding: 10px; }
.lv-topbar {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 5px 8px 5px 12px;
  background: var(--bg-sunken);
  border-radius: var(--radius-md);
}
.lv-current { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.lv-current-label { flex: none; font-size: 11px; color: var(--text-muted); }
.lv-current-name {
  font-size: 13px; font-weight: 500; color: var(--text-primary);
  max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.lv-top-actions { flex: none; display: flex; align-items: center; gap: 4px; }
.lv-menu-title { padding: 6px 10px 4px; font-size: 10.5px; color: var(--text-disabled); }
.lv-menu-empty { padding: 10px; text-align: center; font-size: 11.5px; color: var(--text-muted); }

.lv-main { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.lv-work { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; gap: 8px; }
/* 右侧属性面板常驻固定宽度；左侧画布吃掉剩余空间，窗口变窄时只压缩画布 */
.lv-work > :deep(.sheet-grid) { flex: 1 1 auto; width: 0; min-width: 0; }
.lv-work > :deep(.insp-panel) { flex: 0 0 244px; width: 244px; min-width: 244px; }
.lv-empty { flex: 1; display: grid; place-items: center; color: var(--text-muted); font-size: 12px; }

.lv-file { display: none; }
.ctx-sep { height: 1px; background: var(--border-soft); margin: 4px 8px; }
.ctx-label { padding: 5px 10px 3px; font-size: 10.5px; color: var(--text-disabled); }

/* 区域管理已整体迁移到排座项目，布局页不再提供区域入口 */

.lv-fields { display: flex; flex-direction: column; gap: 14px; }
.del-warn { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text-secondary); }
.del-warn-strong { color: var(--danger, #c0392b); font-weight: 600; }
.del-list { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.8; color: var(--text-secondary); }
.lv-field { display: flex; flex-direction: column; gap: 6px; }
.lv-field > span { font-size: 11px; color: var(--text-muted); }
.lv-input {
  height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text-primary); font-family: inherit; font-size: 12px; outline: none;
}
.lv-input:focus { border-color: var(--primary-line); box-shadow: 0 0 0 2px var(--primary-soft); }
.lv-confirm-text { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }
.lv-danger-btn { background: var(--danger, #b4574e); border-color: var(--danger, #b4574e); color: #fff; }
.lv-dirty {
  position: fixed; right: 18px; bottom: 18px; z-index: 60;
  font-size: 11px; color: var(--warning); background: var(--warning-soft);
  padding: 4px 10px; border-radius: 12px;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 6px); }
</style>
