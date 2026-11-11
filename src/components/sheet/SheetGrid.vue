<script setup lang="ts">
/**
 * Excel 式工作表：冻结行列号、单元格选区、拖动行列尺寸、双击编辑。
 * 只做交互与渲染；数据修改通过事件抛给 LayoutView，便于统一进撤销栈。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LayoutElement, MergeRange, Sheet, SheetCell } from '../../types'
import { cellAt, cellRect, collectBorderLines, colWidthAt, isCovered, mergeAt, rowHeightAt, seatsInRow, sheetSize } from '../../engine/sheet'
import type { CellRange } from '../../engine/sheet'
import SheetCellBox from './SheetCellBox.vue'
import SheetElementLayer from './SheetElementLayer.vue'
import type { CellView } from './cellView'

const props = defineProps<{
  sheet: Sheet
  selection: CellRange
  active: { row: number; col: number }
  /** 区域管理里点选区域后的画布高亮 */
  zoneHighlight?: { id: string; color: string } | null
  /** 只读展示（排座图）：隐藏选区/编辑/辅助网格，保留网格几何与行列头 */
  readonly?: boolean
  /** 自由元素（讲台、人形、箭头等） */
  elements?: LayoutElement[]
  /** 当前选中的元素 id */
  selectedElementId?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:selection', v: CellRange): void
  (e: 'update:active', v: { row: number; col: number }): void
  (e: 'commit'): void
  (e: 'context', p: { x: number; y: number; row: number; col: number }): void
  /** 在行号 / 列标上右键：axis 指明方向，index 为被点的行/列下标 */
  (e: 'header-context', p: { x: number; y: number; axis: 'row' | 'col'; index: number }): void
  (e: 'edit', p: { row: number; col: number; text: string }): void
  (e: 'command', cmd: 'copy' | 'paste' | 'clear' | 'undo' | 'redo' | 'fill-down' | 'fill-right'): void
  (e: 'element-select', id: string): void
  (e: 'element-change', id: string, patch: Partial<LayoutElement>): void
  (e: 'element-commit'): void
  /** 点击表体以外的画布空白：用于取消区域临时高亮，不参与选区与历史 */
  (e: 'blank'): void
}>()

const scrollEl = ref<HTMLElement | null>(null)
const colHeadEl = ref<HTMLElement | null>(null)
const rowHeadEl = ref<HTMLElement | null>(null)
const editEl = ref<HTMLInputElement | null>(null)

const HEAD_W = 44
const HEAD_H = 32

const size = computed(() => sheetSize(props.sheet))
const totalW = computed(() => size.value.w + props.sheet.originX)
const totalH = computed(() => size.value.h + props.sheet.originY)

const colXs = computed(() => {
  const out: number[] = []
  let x = props.sheet.originX
  for (let c = 0; c < props.sheet.cols; c++) {
    out.push(x)
    x += colWidthAt(props.sheet, c)
  }
  return out
})

const rowYs = computed(() => {
  const out: number[] = []
  let y = props.sheet.originY
  for (let r = 0; r < props.sheet.rows; r++) {
    out.push(y)
    y += rowHeightAt(props.sheet, r)
  }
  return out
})

function viewOf(row: number, col: number, cell: SheetCell, merge?: MergeRange): CellView {
  const rect = cellRect(props.sheet, row, col, merge?.rowSpan ?? 1, merge?.colSpan ?? 1)
  return {
    key: `${row}:${col}`,
    row,
    col,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    text: cell.text ?? '',
    label: cell.tableLabel ?? '',
    seats: cell.kind === 'seat' || cell.kind === 'podium' ? (cell.seats ?? 1) : 0,
    // 只有过道保留纹理；旧数据的讲台/背景板/标签按普通文字块渲染
    tone: cell.kind === 'podium' ? 'podium' : cell.kind === 'block' ? (cell.role === 'aisle' ? 'block is-aisle' : 'block') : 'seat',
    disabled: !!cell.disabled,
    fill: cell.style?.fill,
    stroke: cell.style?.stroke,
    strokeStyle: cell.style?.strokeStyle,
    strokeWidth: cell.style?.strokeWidth,
    borders: cell.style?.borders,
    zoneId: cell.zoneId,
    textColor: cell.style?.textColor,
    align: cell.style?.textAlign
  }
}

const blockViews = computed<CellView[]>(() => {
  const out: CellView[] = []
  const covered = new Set<string>()
  for (const m of props.sheet.merges) {
    const cell = cellAt(props.sheet, m.row, m.col)
    if (cell && cell.kind === 'block') out.push(viewOf(m.row, m.col, cell, m))
    if (cell) {
      for (let r = m.row; r < m.row + m.rowSpan; r++) {
        for (let c = m.col; c < m.col + m.colSpan; c++) covered.add(`${r}:${c}`)
      }
    }
  }
  for (const [k, cell] of Object.entries(props.sheet.cells)) {
    if (cell.kind !== 'block' || covered.has(k)) continue
    const [r, c] = k.split(':').map(Number)
    out.push(viewOf(r, c, cell))
  }
  return out
})

/** 同一排同名桌带只显示一次桌名，避免整行重复文字 */
function showLabel(v: CellView): boolean {
  if (!v.label) return false
  return !seatViews.value.some((o) => o !== v && o.row === v.row && o.col < v.col && o.label === v.label)
}

const seatViews = computed<CellView[]>(() => {
  const out: CellView[] = []
  const covered = new Set<string>()
  for (const m of props.sheet.merges) {
    const cell = cellAt(props.sheet, m.row, m.col)
    if (cell && (cell.kind === 'seat' || cell.kind === 'podium')) out.push(viewOf(m.row, m.col, cell, m))
    if (cell) {
      for (let r = m.row; r < m.row + m.rowSpan; r++) {
        for (let c = m.col; c < m.col + m.colSpan; c++) covered.add(`${r}:${c}`)
      }
    }
  }
  for (const [k, cell] of Object.entries(props.sheet.cells)) {
    if (covered.has(k)) continue
    if (cell.kind !== 'seat' && cell.kind !== 'podium') continue
    const [r, c] = k.split(':').map(Number)
    out.push(viewOf(r, c, cell))
  }
  return out
})

/** 供只读排座图叠加姓名等信息：座位槽与网格共用同一套几何 */
const seatSlots = computed(() => {
  const out: {
    seatId: string
    row: number
    col: number
    index: number
    seatNo: number
    x: number
    y: number
    w: number
    h: number
    stage: boolean
    disabled: boolean
    zoneId?: string
    tableLabel?: string
  }[] = []
  for (let row = 0; row < props.sheet.rows; row++) out.push(...seatsInRow(props.sheet, row))
  return out
})

/** 线型 → SVG dasharray；实线返回 undefined */
function dashArray(style?: 'solid' | 'dashed' | 'dotted' | 'none'): string | undefined {
  if (style === 'dashed') return '6 4'
  if (style === 'dotted') return '2 3'
  return undefined
}

// ---------- 冻结窗格 ----------

const scrollLeft = ref(0)
const scrollTop = ref(0)
const scrollbar = ref({ w: 0, h: 0 })

const frozenRows = computed(() => Math.min(props.sheet.frozenRows ?? 0, props.sheet.rows))
const frozenCols = computed(() => Math.min(props.sheet.frozenCols ?? 0, props.sheet.cols))

const frozenH = computed(() => {
  let h = props.sheet.originY
  for (let r = 0; r < frozenRows.value; r++) h += rowHeightAt(props.sheet, r)
  return h
})

const frozenW = computed(() => {
  let w = props.sheet.originX
  for (let c = 0; c < frozenCols.value; c++) w += colWidthAt(props.sheet, c)
  return w
})

// ---------- 缩放 ----------

const MIN_SCALE = 0.35
const MAX_SCALE = 2.5
const scale = ref(1)
const scaledW = computed(() => totalW.value * scale.value)
const scaledH = computed(() => totalH.value * scale.value)
const frozenWv = computed(() => frozenW.value * scale.value)
const frozenHv = computed(() => frozenH.value * scale.value)

function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v * 100) / 100))
}

/** 以视口内某点为锚缩放，保持锚点下方内容不跳动 */
function applyScale(next: number, anchor?: { x: number; y: number }): void {
  const el = scrollEl.value
  const old = scale.value
  const s = clampScale(next)
  if (!el || s === old) return
  const rect = el.getBoundingClientRect()
  const px = anchor ? Math.max(0, Math.min(el.clientWidth, anchor.x - rect.left)) : el.clientWidth / 2
  const py = anchor ? Math.max(0, Math.min(el.clientHeight, anchor.y - rect.top)) : el.clientHeight / 2
  const contentX = (el.scrollLeft + px) / old
  const contentY = (el.scrollTop + py) / old
  scale.value = s
  nextTick(() => {
    const e2 = scrollEl.value
    if (!e2) return
    e2.scrollLeft = Math.max(0, contentX * s - px)
    e2.scrollTop = Math.max(0, contentY * s - py)
    syncScroll()
  })
}

function zoomBy(dir: 1 | -1): void {
  applyScale(scale.value * (dir > 0 ? 1.15 : 1 / 1.15))
}

function fitToWindow(): void {
  const el = scrollEl.value
  if (!el) return
  const pad = 8
  scale.value = clampScale(Math.min((el.clientWidth - pad) / totalW.value, (el.clientHeight - pad) / totalH.value))
  nextTick(() => {
    const e2 = scrollEl.value
    if (!e2) return
    e2.scrollLeft = 0
    e2.scrollTop = 0
    syncScroll()
  })
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  applyScale(scale.value * (e.deltaY > 0 ? 1 / 1.12 : 1.12), { x: e.clientX, y: e.clientY })
}

const allViews = computed<CellView[]>(() => [...blockViews.value, ...seatViews.value])

/**
 * 整表边框：由引擎统一收集（共享边只画一次，显式边框覆盖默认边框），
 * 再按当前缩放把线心对齐到设备像素，避免 1px 线落在半像素上发虚。
 */
const borderLines = computed(() => {
  const s = scale.value || 1
  /** 奇数线宽对齐到像素中心（k+0.5），偶数线宽对齐到像素边界 */
  const snap = (value: number, width: number): number => {
    const device = value * s
    const offset = Math.round(width) % 2 === 1 ? 0.5 : 0
    return (Math.round(device - offset) + offset) / s
  }
  return collectBorderLines(props.sheet).map((l, i) => ({
    key: `bd${i}`,
    x1: snap(l.x1, l.width),
    y1: snap(l.y1, l.width),
    x2: snap(l.x2, l.width),
    y2: snap(l.y2, l.width),
    color: l.color,
    // 线宽换算回逻辑像素：外层 CSS 缩放后正好是设定的设备像素宽度
    width: l.width / s,
    dash: dashArray(l.dash)
  }))
})

/** 编辑态淡虚线辅助网格：覆盖整张表，合并块内部不画线 */
const guideViews = computed(() => {
  const out: { key: string; x: number; y: number; w: number; h: number }[] = []
  for (let row = 0; row < props.sheet.rows; row++) {
    for (let col = 0; col < props.sheet.cols; col++) {
      if (isCovered(props.sheet, row, col)) continue
      const m = mergeAt(props.sheet, row, col)
      const rect = cellRect(props.sheet, row, col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
      out.push({ key: `${row}:${col}`, x: rect.x, y: rect.y, w: rect.w, h: rect.h })
    }
  }
  return out
})

/** 高亮区域包含的格子 */
const zoneViews = computed(() => {
  const h = props.zoneHighlight
  if (!h) return []
  return allViews.value.filter((v) => v.zoneId === h.id)
})
const fzRows = computed(() =>
  allViews.value.filter((v) => v.row < frozenRows.value && v.col >= frozenCols.value)
)
const fzCols = computed(() =>
  allViews.value.filter((v) => v.col < frozenCols.value && v.row >= frozenRows.value)
)
const fzCorner = computed(() =>
  allViews.value.filter((v) => v.row < frozenRows.value && v.col < frozenCols.value)
)
const zoneIn = (pred: (v: CellView) => boolean) => computed(() => zoneViews.value.filter(pred))
const fzZoneRows = zoneIn((v) => v.row < frozenRows.value && v.col >= frozenCols.value)
const fzZoneCols = zoneIn((v) => v.col < frozenCols.value && v.row >= frozenRows.value)
const fzZoneCorner = zoneIn((v) => v.row < frozenRows.value && v.col < frozenCols.value)

function measureScrollbar(): void {
  const el = scrollEl.value
  if (!el) return
  const w = el.offsetWidth - el.clientWidth
  const h = el.offsetHeight - el.clientHeight
  if (w !== scrollbar.value.w || h !== scrollbar.value.h) scrollbar.value = { w, h }
}

let ro: ResizeObserver | null = null

onMounted(() => {
  nextTick(measureScrollbar)
  if (typeof ResizeObserver !== 'undefined' && scrollEl.value) {
    ro = new ResizeObserver(() => measureScrollbar())
    ro.observe(scrollEl.value)
  }
})

/** 选区矩形：如果选框碰到合并区，自动扩到合并区完整边界 */
const selRect = computed(() => {
  const sel = normalize(props.selection)
  let { r1, c1, r2, c2 } = sel
  for (const m of props.sheet.merges) {
    const hit = m.row <= r2 && m.row + m.rowSpan - 1 >= r1 && m.col <= c2 && m.col + m.colSpan - 1 >= c1
    if (!hit) continue
    r1 = Math.min(r1, m.row)
    c1 = Math.min(c1, m.col)
    r2 = Math.max(r2, m.row + m.rowSpan - 1)
    c2 = Math.max(c2, m.col + m.colSpan - 1)
  }
  return cellRect(props.sheet, r1, c1, r2 - r1 + 1, c2 - c1 + 1)
})

/** 选中/活动指示层整体内缩，避免 1.5–2px 主色框压在 1px 黑色外框上叠成粗边 */
const INDICATOR_INSET = 2

const selStyle = computed(() => ({
  left: selRect.value.x + INDICATOR_INSET + 'px',
  top: selRect.value.y + INDICATOR_INSET + 'px',
  width: Math.max(1, selRect.value.w - INDICATOR_INSET * 2) + 'px',
  height: Math.max(1, selRect.value.h - INDICATOR_INSET * 2) + 'px'
}))

const activeRect = computed(() => {
  const a = props.active
  const m = mergeAt(props.sheet, a.row, a.col)
  // 命中的合并区必须以锚点格为起点，否则会从点击格再画一遍 span，出现错位空框
  const row = m ? m.row : a.row
  const col = m ? m.col : a.col
  return cellRect(props.sheet, row, col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
})

const activeStyle = computed(() => ({
  left: activeRect.value.x + INDICATOR_INSET + 'px',
  top: activeRect.value.y + INDICATOR_INSET + 'px',
  width: Math.max(1, activeRect.value.w - INDICATOR_INSET * 2) + 'px',
  height: Math.max(1, activeRect.value.h - INDICATOR_INSET * 2) + 'px'
}))

// ---------- 坐标换算 ----------

function locate(clientX: number, clientY: number): { row: number; col: number } | null {
  const el = scrollEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  let x = clientX - rect.left
  let y = clientY - rect.top
  // 冻结区不随滚动位移：命中冻结区时使用逻辑坐标，否则叠加滚动量
  if (x >= frozenWv.value) x += el.scrollLeft
  if (y >= frozenHv.value) y += el.scrollTop
  // 视口像素 → 表内逻辑像素
  x /= scale.value
  y /= scale.value
  const col = findIndex(colXs.value, x)
  const row = findIndex(rowYs.value, y)
  if (row < 0 || col < 0) return null
  return { row, col }
}

function findIndex(edges: number[], v: number): number {
  if (!edges.length) return -1
  if (v < edges[0]) return -1
  let lo = 0
  let hi = edges.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (edges[mid] <= v) lo = mid
    else hi = mid - 1
  }
  return lo
}

function normalize(r: CellRange): CellRange {
  return {
    r1: Math.min(r.r1, r.r2),
    c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2),
    c2: Math.max(r.c1, r.c2)
  }
}

// ---------- 选择 ----------

let drag: { anchor: { row: number; col: number } } | null = null

function selectCell(row: number, col: number, extend = false): void {
  const prev = props.selection
  const anchor = extend ? { row: prev.r1, col: prev.c1 } : { row, col }
  emit('update:active', { row, col })
  emit('update:selection', normalize({ r1: anchor.row, c1: anchor.col, r2: row, c2: col }))
}

function onPointerDown(e: PointerEvent): void {
  // 中键拖动平移画布：先于只读与选区逻辑处理
  if (e.button === 1) {
    startPan(e)
    return
  }
  const target = e.target as HTMLElement
  // 表体以外的空白：只通知外部清临时高亮，不动选区、不写历史
  if (!target.closest('.sg-space')) {
    emit('blank')
    return
  }
  if (props.readonly) return
  if (e.button !== 0) return
  const p = locate(e.clientX, e.clientY)
  if (!p) return
  if (target.closest('.sg-edit')) return
  scrollEl.value?.focus({ preventScroll: true })
  selectCell(p.row, p.col, e.shiftKey)
  if (!e.shiftKey) {
    drag = { anchor: p }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
  }
}

function onDragMove(e: PointerEvent): void {
  if (!drag) return
  const p = locate(e.clientX, e.clientY)
  if (!p) return
  emit('update:active', p)
  emit('update:selection', normalize({ r1: drag.anchor.row, c1: drag.anchor.col, r2: p.row, c2: p.col }))
}

function onDragUp(): void {
  drag = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
}

// ---------- 中键平移 ----------
// 直接改 scrollLeft / scrollTop：滚动量本身就是缩放后的视口像素，
// 所以任意缩放比例下都与内容对位一致，不需要额外的坐标换算。
let pan: { x: number; y: number; left: number; top: number } | null = null
const panning = ref(false)

function startPan(e: PointerEvent): void {
  const el = scrollEl.value
  if (!el) return
  // 阻止中键默认的自动滚动与粘贴
  e.preventDefault()
  pan = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
  panning.value = true
  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', onPanUp)
  window.addEventListener('pointercancel', onPanUp)
}

function onPanMove(e: PointerEvent): void {
  const el = scrollEl.value
  if (!pan || !el) return
  e.preventDefault()
  el.scrollLeft = pan.left - (e.clientX - pan.x)
  el.scrollTop = pan.top - (e.clientY - pan.y)
}

function onPanUp(): void {
  pan = null
  panning.value = false
  window.removeEventListener('pointermove', onPanMove)
  window.removeEventListener('pointerup', onPanUp)
  window.removeEventListener('pointercancel', onPanUp)
}

function selectRow(row: number): void {
  if (props.readonly) return
  emit('update:active', { row, col: 0 })
  emit('update:selection', { r1: row, c1: 0, r2: row, c2: props.sheet.cols - 1 })
}

function selectCol(col: number): void {
  if (props.readonly) return
  emit('update:active', { row: 0, col })
  emit('update:selection', { r1: 0, c1: col, r2: props.sheet.rows - 1, c2: col })
}

// ---------- 行列尺寸 ----------

function startColResize(col: number, e: PointerEvent): void {
  if (props.readonly) return
  e.preventDefault()
  const startX = e.clientX
  const startW = colWidthAt(props.sheet, col)
  let moved = false
  const move = (ev: PointerEvent): void => {
    const w = Math.max(48, Math.round(startW + (ev.clientX - startX) / scale.value))
    if (w !== props.sheet.colWidths[col]) {
      props.sheet.colWidths[col] = w
      moved = true
    }
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (moved) emit('commit')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function startRowResize(row: number, e: PointerEvent): void {
  if (props.readonly) return
  e.preventDefault()
  const startY = e.clientY
  const startH = rowHeightAt(props.sheet, row)
  let moved = false
  const move = (ev: PointerEvent): void => {
    const h = Math.max(32, Math.round(startH + (ev.clientY - startY) / scale.value))
    if (h !== props.sheet.rowHeights[row]) {
      props.sheet.rowHeights[row] = h
      moved = true
    }
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (moved) emit('commit')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function syncScroll(): void {
  const el = scrollEl.value
  if (!el) return
  scrollLeft.value = el.scrollLeft
  scrollTop.value = el.scrollTop
  if (colHeadEl.value) colHeadEl.value.scrollLeft = el.scrollLeft
  if (rowHeadEl.value) rowHeadEl.value.scrollTop = el.scrollTop
  measureScrollbar()
}

// ---------- 编辑 ----------

const editing = ref<{ row: number; col: number; text: string } | null>(null)

const editStyle = computed(() => {
  if (!editing.value) return {}
  const m = mergeAt(props.sheet, editing.value.row, editing.value.col)
  const row = m ? m.row : editing.value.row
  const col = m ? m.col : editing.value.col
  const rect = cellRect(props.sheet, row, col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
  return { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }
})

function startEdit(row = props.active.row, col = props.active.col, seed?: string): void {
  // 双击合并区任意位置都应编辑锚点格，避免在空白的被覆盖格上输入
  const m = mergeAt(props.sheet, row, col)
  if (m) {
    row = m.row
    col = m.col
  }
  const cell = cellAt(props.sheet, row, col)
  const initial = seed ?? (cell && (cell.kind === 'seat' || cell.kind === 'podium') ? cell.tableLabel ?? '' : cell?.text ?? '')
  editing.value = { row, col, text: initial }
  nextTick(() => {
    editEl.value?.focus()
    editEl.value?.select()
  })
}

function onEditInput(e: Event): void {
  if (editing.value) editing.value.text = (e.target as HTMLInputElement).value
}

function commitEdit(): void {
  if (!editing.value) return
  const { row, col, text } = editing.value
  editing.value = null
  emit('edit', { row, col, text })
}

function cancelEdit(): void {
  editing.value = null
  scrollEl.value?.focus({ preventScroll: true })
}

const editInCorner = computed(
  () => !!editing.value && editing.value.row < frozenRows.value && editing.value.col < frozenCols.value
)
const editInRows = computed(
  () => !!editing.value && editing.value.row < frozenRows.value && editing.value.col >= frozenCols.value
)
const editInCols = computed(
  () => !!editing.value && editing.value.row >= frozenRows.value && editing.value.col < frozenCols.value
)

function onDblClick(e: MouseEvent): void {
  if (props.readonly) return
  const p = locate(e.clientX, e.clientY)
  if (p) startEdit(p.row, p.col)
}

function onContextMenu(e: MouseEvent): void {
  if (props.readonly) return
  const p = locate(e.clientX, e.clientY)
  if (!p) return
  if (p.row < props.selection.r1 || p.row > props.selection.r2 || p.col < props.selection.c1 || p.col > props.selection.c2) {
    selectCell(p.row, p.col)
  }
  emit('context', { x: e.clientX, y: e.clientY, row: p.row, col: p.col })
}

/** 行号 / 列标右键：先整行/整列选中，再把菜单交给父组件按表头坐标处理 */
function onHeaderContext(e: MouseEvent, axis: 'row' | 'col', index: number): void {
  if (props.readonly) return
  e.preventDefault()
  e.stopPropagation()
  if (axis === 'row') selectRow(index)
  else selectCol(index)
  emit('header-context', { x: e.clientX, y: e.clientY, axis, index })
}

// ---------- 键盘 ----------

function moveTo(row: number, col: number, extend = false): void {
  const r = Math.max(0, Math.min(props.sheet.rows - 1, row))
  const c = Math.max(0, Math.min(props.sheet.cols - 1, col))
  selectCell(r, c, extend)
  scrollIntoView(r, c)
}

function scrollIntoView(row: number, col: number): void {
  const el = scrollEl.value
  if (!el) return
  const rect = cellRect(props.sheet, row, col)
  const s = scale.value
  const x = rect.x * s
  const y = rect.y * s
  const w = rect.w * s
  const h = rect.h * s
  const left = x - el.clientWidth * 0.3
  const top = y - el.clientHeight * 0.3
  if (x < el.scrollLeft + 40) el.scrollLeft = Math.max(0, left)
  else if (x + w > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x + w - el.clientWidth + 60
  if (y < el.scrollTop + 40) el.scrollTop = Math.max(0, top)
  else if (y + h > el.scrollTop + el.clientHeight - 40) el.scrollTop = y + h - el.clientHeight + 60
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function onKey(e: KeyboardEvent): void {
  if (editing.value || isTypingTarget(e.target)) return
  const a = props.active
  const shift = e.shiftKey
  const mod = e.ctrlKey || e.metaKey
  if (mod) {
    const k = e.key.toLowerCase()
    if (k === 'z') {
      e.preventDefault()
      emit('command', shift ? 'redo' : 'undo')
      return
    }
    if (k === 'y') {
      e.preventDefault()
      emit('command', 'redo')
      return
    }
    if (k === 'c') {
      e.preventDefault()
      emit('command', 'copy')
      return
    }
    if (k === 'v') {
      e.preventDefault()
      emit('command', 'paste')
      return
    }
    if (k === 'd') {
      e.preventDefault()
      emit('command', 'fill-down')
      return
    }
    if (k === 'r') {
      e.preventDefault()
      emit('command', 'fill-right')
      return
    }
    if (k === 'a') {
      e.preventDefault()
      emit('update:selection', { r1: 0, c1: 0, r2: props.sheet.rows - 1, c2: props.sheet.cols - 1 })
      return
    }
    if (k === '=' || k === '+') {
      e.preventDefault()
      zoomBy(1)
      return
    }
    if (k === '-' || k === '_') {
      e.preventDefault()
      zoomBy(-1)
      return
    }
    if (k === '0') {
      e.preventDefault()
      fitToWindow()
      return
    }
    return
  }
  switch (e.key) {
    case 'ArrowUp':
      e.preventDefault()
      moveTo(a.row - 1, a.col, shift)
      return
    case 'ArrowDown':
      e.preventDefault()
      moveTo(a.row + 1, a.col, shift)
      return
    case 'ArrowLeft':
      e.preventDefault()
      moveTo(a.row, a.col - 1, shift)
      return
    case 'ArrowRight':
      e.preventDefault()
      moveTo(a.row, a.col + 1, shift)
      return
    case 'Tab':
      e.preventDefault()
      moveTo(a.row, shift ? a.col - 1 : a.col + 1)
      return
    case 'Enter':
      e.preventDefault()
      if (shift) moveTo(a.row - 1, a.col)
      else moveTo(a.row + 1, a.col)
      return
    case 'F2':
      e.preventDefault()
      startEdit()
      return
    case 'Escape':
      e.preventDefault()
      emit('update:selection', { r1: a.row, c1: a.col, r2: a.row, c2: a.col })
      return
    case 'Delete':
    case 'Backspace':
      e.preventDefault()
      emit('command', 'clear')
      return
    default:
      break
  }
  if (e.key.length === 1 && !e.altKey) {
    e.preventDefault()
    startEdit(a.row, a.col, e.key)
  }
}

watch(
  () => props.selection,
  () => {
    if (editing.value) {
      const e = editing.value
      if (e.row < props.selection.r1 || e.row > props.selection.r2 || e.col < props.selection.c1 || e.col > props.selection.c2) cancelEdit()
    }
  },
  { deep: true }
)

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragUp)
  ro?.disconnect()
  ro = null
})

defineExpose({ focus: () => scrollEl.value?.focus({ preventScroll: true }), startEdit, zoomBy, applyScale, fitToWindow })
</script>

<template>
  <div class="sheet-grid" :class="{ 'is-readonly': readonly }">
    <div class="sg-top">
      <div class="sg-corner">▦</div>
      <div ref="colHeadEl" class="sg-colhead">
        <div class="sg-head-cols" :style="{ width: scaledW + 'px' }">
          <div
            v-for="(x, c) in colXs"
            :key="'c' + c"
            class="sg-ch"
            :style="{ left: x * scale + 'px', width: colWidthAt(sheet, c) * scale + 'px' }"
            @click="selectCol(c)"
            @contextmenu.prevent="onHeaderContext($event, 'col', c)"
          >
            {{ c + 1 }}
            <span class="sg-rz" @pointerdown.stop="startColResize(c, $event)" />
          </div>
        </div>
      </div>
      <div v-if="frozenCols" class="sg-colhead-fz" :style="{ width: frozenWv + 'px' }">
        <div
          v-for="c in frozenCols"
          :key="'fhc' + c"
          class="sg-ch is-frozen"
          :style="{ left: colXs[c - 1] * scale + 'px', width: colWidthAt(sheet, c - 1) * scale + 'px' }"
          @click="selectCol(c - 1)"
          @contextmenu.prevent="onHeaderContext($event, 'col', c - 1)"
        >
          {{ c }}
          <span class="sg-rz" @pointerdown.stop="startColResize(c - 1, $event)" />
        </div>
      </div>
    </div>

    <div class="sg-mid">
      <div ref="rowHeadEl" class="sg-rowhead">
        <div class="sg-head-rows" :style="{ height: scaledH + 'px' }">
          <div
            v-for="(y, r) in rowYs"
            :key="'r' + r"
            class="sg-rh"
            :style="{ top: y * scale + 'px', height: rowHeightAt(sheet, r) * scale + 'px' }"
            @click="selectRow(r)"
            @contextmenu.prevent="onHeaderContext($event, 'row', r)"
          >
            {{ r + 1 }}
            <span class="sg-rh-rz" @pointerdown.stop="startRowResize(r, $event)" />
          </div>
        </div>
      </div>
      <div v-if="frozenRows" class="sg-rowhead-fz" :style="{ height: frozenHv + 'px' }">
        <div
          v-for="r in frozenRows"
          :key="'fhr' + r"
          class="sg-rh is-frozen"
          :style="{ top: rowYs[r - 1] * scale + 'px', height: rowHeightAt(sheet, r - 1) * scale + 'px' }"
          @click="selectRow(r - 1)"
          @contextmenu.prevent="onHeaderContext($event, 'row', r - 1)"
        >
          {{ r }}
          <span class="sg-rh-rz" @pointerdown.stop="startRowResize(r - 1, $event)" />
        </div>
      </div>

      <div
        ref="scrollEl"
        class="sg-scroll"
        :class="{ 'is-panning': panning }"
        tabindex="0"
        @scroll="syncScroll"
        @keydown="onKey"
        @pointerdown="onPointerDown"
        @dblclick="onDblClick"
        @contextmenu.prevent="onContextMenu"
        @auxclick.prevent
        @mousedown.middle.prevent
        @wheel="onWheel"
      >
        <div class="sg-space" :style="{ width: scaledW + 'px', height: scaledH + 'px' }">
          <div
            class="sg-inner"
            :style="{ width: totalW + 'px', height: totalH + 'px', transform: `scale(${scale})` }"
          >
          <SheetCellBox v-for="v in blockViews" :key="'b' + v.key" :view="v" />
          <SheetCellBox
            v-for="v in seatViews"
            :key="'s' + v.key"
            :view="v"
            :show-label="readonly ? false : showLabel(v)"
            :show-dots="!readonly"
            :view-mode="readonly"
          />

          <!-- 辅助线：整张表的淡虚线网格，仅编辑态显示，不参与排座/打印/导出 -->
          <svg v-if="!readonly" class="sg-guides" :width="totalW" :height="totalH" aria-hidden="true">
            <rect
              v-for="v in guideViews"
              :key="'g' + v.key"
              :x="v.x"
              :y="v.y"
              :width="v.w"
              :height="v.h"
              fill="none"
              stroke="#e2e8e7"
              stroke-width="1"
              stroke-dasharray="3 4"
              vector-effect="non-scaling-stroke"
              shape-rendering="crispEdges"
            />
          </svg>

          <!-- 边框：整表统一收集并按共享边去重，每条线只画一次；坐标按缩放对齐像素，保证任意比例下线宽一致 -->
          <svg class="sg-borders" :width="totalW" :height="totalH" aria-hidden="true">
            <line
              v-for="l in borderLines"
              :key="l.key"
              :x1="l.x1"
              :y1="l.y1"
              :x2="l.x2"
              :y2="l.y2"
              :stroke="l.color"
              :stroke-width="l.width"
              :stroke-dasharray="l.dash"
            />
          </svg>

          <div v-if="!readonly" class="sg-selection" :style="selStyle" />
          <div v-if="!readonly" class="sg-active-cell" :style="activeStyle" />

          <!-- 区域反向查看：点区域管理里的区域后，高亮它包含的全部格子 -->
          <svg
            v-if="zoneHighlight && zoneViews.length"
            class="sg-zone"
            :width="totalW"
            :height="totalH"
            aria-hidden="true"
          >
            <rect
              v-for="v in zoneViews"
              :key="'z' + v.key"
              :x="v.x + 1"
              :y="v.y + 1"
              :width="Math.max(1, v.w - 2)"
              :height="Math.max(1, v.h - 2)"
              :fill="zoneHighlight.color"
              fill-opacity="0.32"
              stroke="var(--primary)"
              stroke-width="1.5"
              stroke-dasharray="5 3"
              vector-effect="non-scaling-stroke"
            />
          </svg>

          <!-- 只读排座叠加层：姓名/职级/单位落在与网格一致的座位槽内 -->
          <div class="sg-overlay">
            <slot name="overlay" :seats="seatSlots" />
          </div>

          <!-- 自由元素层：讲台、人形、箭头等，独立于单元格 -->
          <SheetElementLayer
            v-if="elements?.length"
            :elements="elements"
            :sheet="sheet"
            :selected-id="selectedElementId ?? null"
            :editable="!readonly"
            :scale="scale"
            @select="(id) => emit('element-select', id)"
            @change="(id, patch) => emit('element-change', id, patch)"
            @commit="emit('element-commit')"
          />

          <input
            v-if="editing && !readonly && !editInCorner && !editInRows && !editInCols"
            ref="editEl"
            class="sg-edit"
            :style="editStyle"
            :value="editing.text"
            @input="onEditInput"
            @keydown.enter.stop.prevent="commitEdit"
            @keydown.esc.stop.prevent="cancelEdit"
            @blur="commitEdit"
            @pointerdown.stop
          />
          </div>
        </div>
      </div>

      <!-- 冻结窗格：覆盖在滚动区上层，分冻结行 / 冻结列 / 左上角三块 -->
      <div
        v-if="frozenRows || frozenCols"
        class="sg-frozen"
        :style="{ right: scrollbar.w + 'px', bottom: scrollbar.h + 'px' }"
      >
        <div
          v-if="frozenRows"
          class="sg-fz-rows"
          :style="{ height: frozenHv + 'px' }"
        >
          <div
            class="sg-fz-layer"
            :style="{ transform: `translateX(${-scrollLeft}px) scale(${scale})`, width: totalW + 'px', height: frozenH + 'px' }"
          >
            <SheetCellBox v-for="v in fzRows" :key="'fr' + v.key" :view="v" />
            <svg v-if="zoneHighlight && fzZoneRows.length" class="sg-zone" :width="totalW" :height="totalH" aria-hidden="true">
              <rect
                v-for="v in fzZoneRows"
                :key="'fzr' + v.key"
                :x="v.x + 1" :y="v.y + 1" :width="Math.max(1, v.w - 2)" :height="Math.max(1, v.h - 2)"
                :fill="zoneHighlight.color" fill-opacity="0.32" stroke="var(--primary)" stroke-width="1.5"
                stroke-dasharray="5 3" vector-effect="non-scaling-stroke"
              />
            </svg>
            <div class="sg-overlay">
              <slot
                name="overlay"
                :seats="seatSlots.filter((s) => s.row < frozenRows && s.col >= frozenCols)"
              />
            </div>
            <div v-if="!readonly" class="sg-selection" :style="selStyle" />
            <div v-if="!readonly" class="sg-active-cell" :style="activeStyle" />
            <input
              v-if="editInRows"
              ref="editEl"
              class="sg-edit"
              :style="editStyle"
              :value="editing?.text"
              @input="onEditInput"
              @keydown.enter.stop.prevent="commitEdit"
              @keydown.esc.stop.prevent="cancelEdit"
              @blur="commitEdit"
              @pointerdown.stop
            />
          </div>
        </div>
        <div
          v-if="frozenCols"
          class="sg-fz-cols"
          :style="{ width: frozenWv + 'px', top: frozenHv + 'px' }"
        >
          <div
            class="sg-fz-layer"
            :style="{ transform: `translateY(${-scrollTop}px) scale(${scale})`, width: frozenW + 'px', height: totalH + 'px' }"
          >
            <SheetCellBox v-for="v in fzCols" :key="'fk' + v.key" :view="v" />
            <svg v-if="zoneHighlight && fzZoneCols.length" class="sg-zone" :width="totalW" :height="totalH" aria-hidden="true">
              <rect
                v-for="v in fzZoneCols"
                :key="'fzc' + v.key"
                :x="v.x + 1" :y="v.y + 1" :width="Math.max(1, v.w - 2)" :height="Math.max(1, v.h - 2)"
                :fill="zoneHighlight.color" fill-opacity="0.32" stroke="var(--primary)" stroke-width="1.5"
                stroke-dasharray="5 3" vector-effect="non-scaling-stroke"
              />
            </svg>
            <div class="sg-overlay">
              <slot
                name="overlay"
                :seats="seatSlots.filter((s) => s.col < frozenCols && s.row >= frozenRows)"
              />
            </div>
            <div v-if="!readonly" class="sg-selection" :style="selStyle" />
            <div v-if="!readonly" class="sg-active-cell" :style="activeStyle" />
            <input
              v-if="editInCols"
              ref="editEl"
              class="sg-edit"
              :style="editStyle"
              :value="editing?.text"
              @input="onEditInput"
              @keydown.enter.stop.prevent="commitEdit"
              @keydown.esc.stop.prevent="cancelEdit"
              @blur="commitEdit"
              @pointerdown.stop
            />
          </div>
        </div>
        <div v-if="frozenRows && frozenCols" class="sg-fz-corner" :style="{ width: frozenWv + 'px', height: frozenHv + 'px' }">
          <div
            class="sg-fz-layer"
            :style="{ transform: `scale(${scale})`, width: frozenW + 'px', height: frozenH + 'px' }"
          >
            <SheetCellBox v-for="v in fzCorner" :key="'fc' + v.key" :view="v" />
            <svg v-if="zoneHighlight && fzZoneCorner.length" class="sg-zone" :width="totalW" :height="totalH" aria-hidden="true">
              <rect
                v-for="v in fzZoneCorner"
                :key="'fzx' + v.key"
                :x="v.x + 1" :y="v.y + 1" :width="Math.max(1, v.w - 2)" :height="Math.max(1, v.h - 2)"
                :fill="zoneHighlight.color" fill-opacity="0.32" stroke="var(--primary)" stroke-width="1.5"
                stroke-dasharray="5 3" vector-effect="non-scaling-stroke"
              />
            </svg>
            <div class="sg-overlay">
              <slot
                name="overlay"
                :seats="seatSlots.filter((s) => s.row < frozenRows && s.col < frozenCols)"
              />
            </div>
            <div v-if="!readonly" class="sg-selection" :style="selStyle" />
            <div v-if="!readonly" class="sg-active-cell" :style="activeStyle" />
            <input
              v-if="editInCorner"
              ref="editEl"
              class="sg-edit"
              :style="editStyle"
              :value="editing?.text"
              @input="onEditInput"
              @keydown.enter.stop.prevent="commitEdit"
              @keydown.esc.stop.prevent="cancelEdit"
              @blur="commitEdit"
              @pointerdown.stop
            />
          </div>
        </div>
      </div>
    </div>

    <div class="sg-foot">
      <span>{{ sheet.rows }} 行 × {{ sheet.cols }} 列</span>
      <span class="sg-foot-sep" />
      <span v-if="!readonly">双击编辑 · 拖动行号/列号边界调尺寸 · Ctrl+C/V 复制粘贴 · Ctrl+D/R 填充 · Ctrl+Z/Y 撤销重做</span>
      <span class="sg-foot-spacer" />
      <span v-if="readonly" class="sg-foot-tip">拖拽换座 · 点选查看 · Ctrl+滚轮缩放</span>
      <span v-if="readonly" class="sg-foot-spacer" />
      <div class="sg-zoom" role="group" aria-label="画布缩放">
        <button type="button" class="sg-zoom-btn" title="缩小（Ctrl+-）" @click="zoomBy(-1)">−</button>
        <button type="button" class="sg-zoom-pct" title="恢复 100%" @click="applyScale(1)">{{ Math.round(scale * 100) }}%</button>
        <button type="button" class="sg-zoom-btn" title="放大（Ctrl++）" @click="zoomBy(1)">+</button>
        <button type="button" class="sg-zoom-fit" title="适应窗口（Ctrl+0）" @click="fitToWindow">适应</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-grid {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-left: 0;
  border-radius: 0;
  overflow: hidden;
}
.sg-top { position: relative; display: flex; height: 32px; flex: none; background: var(--bg-subtle); border-bottom: 1px solid var(--border); overflow: hidden; }
.sg-corner {
  width: 44px; flex: none; display: grid; place-items: center;
  color: var(--text-muted); font-size: 11px; border-right: 1px solid var(--border);
}
.sg-colhead { flex: 1; overflow: hidden; position: relative; }
.sg-head-cols { position: relative; height: 32px; }
.sg-ch {
  position: absolute; top: 0; height: 32px; display: grid; place-items: center;
  font-size: 11px; color: var(--text-muted); border-right: 1px solid var(--border);
  user-select: none; cursor: pointer;
}
.sg-ch:hover { background: var(--bg-hover); color: var(--text-secondary); }
.sg-rz { position: absolute; right: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 2; }
.sg-colhead-fz {
  position: absolute; left: 44px; top: 0; height: 32px; overflow: hidden;
  background: var(--bg-subtle); border-right: 1.5px solid var(--border-strong); z-index: 3;
}

.sg-mid { position: relative; flex: 1; display: flex; min-height: 0; }
.sg-rowhead { width: 44px; flex: none; overflow: hidden; position: relative; background: var(--bg-subtle); border-right: 1px solid var(--border); }
.sg-rowhead-fz {
  position: absolute; left: 0; top: 0; width: 44px; overflow: hidden;
  background: var(--bg-subtle); border-bottom: 1.5px solid var(--border-strong); z-index: 4;
}
.sg-head-rows { position: relative; width: 44px; }
.sg-rh {
  position: absolute; left: 0; width: 44px; display: grid; place-items: center;
  font-size: 11px; color: var(--text-muted); border-bottom: 1px solid var(--border);
  user-select: none; cursor: pointer;
}
.sg-rh:hover { background: var(--bg-hover); color: var(--text-secondary); }
.sg-rh-rz { position: absolute; left: 0; right: 0; bottom: -3px; height: 6px; cursor: row-resize; z-index: 2; }

.sg-scroll { flex: 1; overflow: auto; position: relative; outline: none; }
/* 中键拖动画布：按住即抓手，松手恢复 */
.sg-scroll.is-panning, .sg-scroll.is-panning * { cursor: grabbing !important; user-select: none; }
.sg-space { position: relative; }
.sg-inner { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
/* 辅助线只做定位参考：很淡的虚线网格，不参与排座/打印/导出；显式边框才按用户设置绘制 */
.sg-guides, .sg-borders, .sg-zone { position: absolute; left: 0; top: 0; pointer-events: none; }
/* 区域高亮必须压在座位层之上：已排座座位有不透明底色，否则高亮会被完全盖住 */
.sg-zone { z-index: 5; }
/* 外圈边线按设备像素对齐后会探出 0.5px，放开裁剪避免最外圈变细 */
.sg-borders { overflow: visible; z-index: 4; }
.sg-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
.sheet-grid.is-readonly .sg-scroll { cursor: default; }
.sheet-grid.is-readonly .sg-ch, .sheet-grid.is-readonly .sg-rh { cursor: default; }
.sg-foot-tip { color: var(--text-disabled); }

/* 冻结窗格：覆盖在滚动区上方，不拦截鼠标（点击穿透后由 locate 换算逻辑坐标） */
.sg-frozen {
  position: absolute; left: 44px; top: 0; right: 0; bottom: 0;
  overflow: hidden; pointer-events: none; z-index: 3;
}
.sg-fz-rows {
  position: absolute; left: 0; right: 0; top: 0; overflow: hidden;
  background: var(--bg); border-bottom: 1.5px solid var(--border-strong); z-index: 1;
}
.sg-fz-cols {
  position: absolute; left: 0; bottom: 0; overflow: hidden;
  background: var(--bg); border-right: 1.5px solid var(--border-strong); z-index: 1;
}
.sg-fz-corner {
  position: absolute; left: 0; top: 0; overflow: hidden;
  background: var(--bg); z-index: 2;
}
.sg-fz-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; }

.sg-selection {
  position: absolute; pointer-events: none;
  border: 1.5px solid var(--primary);
  background: rgba(74, 124, 123, 0.07);
  border-radius: 0;
}
.sg-active-cell { position: absolute; pointer-events: none; border: 2px solid var(--primary); border-radius: 0; }

.sg-edit {
  position: absolute; z-index: 5; padding: 4px 8px;
  border: 2px solid var(--primary); border-radius: 0;
  font-size: 13px; font-family: inherit; color: var(--text-primary);
  outline: none; background: #fff;
}

.sg-foot {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 4px 12px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--text-muted); background: var(--bg-subtle);
}
.sg-foot-sep { width: 1px; height: 12px; background: var(--border); }
.sg-foot-spacer { flex: 1; }
.sg-zoom { display: flex; align-items: center; gap: 1px; }
.sg-zoom-btn {
  width: 22px; height: 22px; display: grid; place-items: center;
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg);
  color: var(--text-secondary); font-family: inherit; font-size: 13px; line-height: 1;
  cursor: pointer; padding: 0;
}
.sg-zoom-btn:hover { background: var(--bg-hover); color: var(--primary); }
.sg-zoom-pct {
  min-width: 44px; height: 22px; border: 1px solid transparent; border-radius: 4px;
  background: none; color: var(--text-secondary); font-family: inherit; font-size: 11px;
  font-variant-numeric: tabular-nums; cursor: pointer; padding: 0 4px;
}
.sg-zoom-pct:hover { background: var(--bg-hover); color: var(--primary); }
.sg-zoom-fit {
  height: 22px; padding: 0 7px; margin-left: 3px;
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg);
  color: var(--text-secondary); font-family: inherit; font-size: 11px; cursor: pointer;
}
.sg-zoom-fit:hover { background: var(--bg-hover); color: var(--primary); }
</style>
