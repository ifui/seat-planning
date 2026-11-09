<script setup lang="ts">
/**
 * Excel 式工作表：冻结行列号、单元格选区、拖动行列尺寸、双击编辑。
 * 只做交互与渲染；数据修改通过事件抛给 LayoutView，便于统一进撤销栈。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MergeRange, Sheet, SheetCell } from '../../types'
import { cellAt, cellRect, colLabel, colWidthAt, mergeAt, rowHeightAt, sheetSize } from '../../engine/sheet'
import type { CellRange } from '../../engine/sheet'
import SheetCellBox from './SheetCellBox.vue'
import type { CellView } from './cellView'

const props = defineProps<{
  sheet: Sheet
  selection: CellRange
  active: { row: number; col: number }
}>()

const emit = defineEmits<{
  (e: 'update:selection', v: CellRange): void
  (e: 'update:active', v: { row: number; col: number }): void
  (e: 'commit'): void
  (e: 'context', p: { x: number; y: number; row: number; col: number }): void
  (e: 'edit', p: { row: number; col: number; text: string }): void
  (e: 'command', cmd: 'copy' | 'paste' | 'clear' | 'undo' | 'redo' | 'fill-down' | 'fill-right'): void
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
    tone: cell.kind === 'podium' ? 'podium' : cell.kind === 'block' ? `block is-${cell.role ?? 'label'}` : 'seat',
    fill: cell.style?.fill,
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

const allViews = computed<CellView[]>(() => [...blockViews.value, ...seatViews.value])
const fzRows = computed(() =>
  allViews.value.filter((v) => v.row < frozenRows.value && v.col >= frozenCols.value)
)
const fzCols = computed(() =>
  allViews.value.filter((v) => v.col < frozenCols.value && v.row >= frozenRows.value)
)
const fzCorner = computed(() =>
  allViews.value.filter((v) => v.row < frozenRows.value && v.col < frozenCols.value)
)

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

const selStyle = computed(() => ({
  left: selRect.value.x + 'px',
  top: selRect.value.y + 'px',
  width: selRect.value.w + 'px',
  height: selRect.value.h + 'px'
}))

const activeRect = computed(() => {
  const a = props.active
  const m = mergeAt(props.sheet, a.row, a.col)
  return cellRect(props.sheet, a.row, a.col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
})

const activeStyle = computed(() => ({
  left: activeRect.value.x + 'px',
  top: activeRect.value.y + 'px',
  width: activeRect.value.w + 'px',
  height: activeRect.value.h + 'px'
}))

// ---------- 坐标换算 ----------

function locate(clientX: number, clientY: number): { row: number; col: number } | null {
  const el = scrollEl.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  let x = clientX - rect.left
  let y = clientY - rect.top
  // 冻结区不随滚动位移：命中冻结区时使用逻辑坐标，否则叠加滚动量
  if (x >= frozenW.value) x += el.scrollLeft
  if (y >= frozenH.value) y += el.scrollTop
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
  if (e.button !== 0) return
  const p = locate(e.clientX, e.clientY)
  if (!p) return
  const target = e.target as HTMLElement
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

function selectRow(row: number): void {
  emit('update:active', { row, col: 0 })
  emit('update:selection', { r1: row, c1: 0, r2: row, c2: props.sheet.cols - 1 })
}

function selectCol(col: number): void {
  emit('update:active', { row: 0, col })
  emit('update:selection', { r1: 0, c1: col, r2: props.sheet.rows - 1, c2: col })
}

// ---------- 行列尺寸 ----------

function startColResize(col: number, e: PointerEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startW = colWidthAt(props.sheet, col)
  let moved = false
  const move = (ev: PointerEvent): void => {
    const w = Math.max(48, Math.round(startW + ev.clientX - startX))
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
  e.preventDefault()
  const startY = e.clientY
  const startH = rowHeightAt(props.sheet, row)
  let moved = false
  const move = (ev: PointerEvent): void => {
    const h = Math.max(32, Math.round(startH + ev.clientY - startY))
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
  const rect = cellRect(props.sheet, editing.value.row, editing.value.col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
  return { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' }
})

function startEdit(row = props.active.row, col = props.active.col, seed?: string): void {
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
  const p = locate(e.clientX, e.clientY)
  if (p) startEdit(p.row, p.col)
}

function onContextMenu(e: MouseEvent): void {
  const p = locate(e.clientX, e.clientY)
  if (!p) return
  if (p.row < props.selection.r1 || p.row > props.selection.r2 || p.col < props.selection.c1 || p.col > props.selection.c2) {
    selectCell(p.row, p.col)
  }
  emit('context', { x: e.clientX, y: e.clientY, row: p.row, col: p.col })
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
  const left = rect.x - el.clientWidth * 0.3
  const top = rect.y - el.clientHeight * 0.3
  if (rect.x < el.scrollLeft + 40) el.scrollLeft = Math.max(0, left)
  else if (rect.x + rect.w > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = rect.x + rect.w - el.clientWidth + 60
  if (rect.y < el.scrollTop + 40) el.scrollTop = Math.max(0, top)
  else if (rect.y + rect.h > el.scrollTop + el.clientHeight - 40) el.scrollTop = rect.y + rect.h - el.clientHeight + 60
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

defineExpose({ focus: () => scrollEl.value?.focus({ preventScroll: true }), startEdit })
</script>

<template>
  <div class="sheet-grid">
    <div class="sg-top">
      <div class="sg-corner">▦</div>
      <div ref="colHeadEl" class="sg-colhead">
        <div class="sg-head-cols" :style="{ width: totalW + 'px' }">
          <div
            v-for="(x, c) in colXs"
            :key="'c' + c"
            class="sg-ch"
            :style="{ left: x + 'px', width: colWidthAt(sheet, c) + 'px' }"
            @click="selectCol(c)"
          >
            {{ colLabel(c) }}
            <span class="sg-rz" @pointerdown.stop="startColResize(c, $event)" />
          </div>
        </div>
      </div>
      <div v-if="frozenCols" class="sg-colhead-fz" :style="{ width: frozenW + 'px' }">
        <div
          v-for="c in frozenCols"
          :key="'fhc' + c"
          class="sg-ch is-frozen"
          :style="{ left: colXs[c - 1] + 'px', width: colWidthAt(sheet, c - 1) + 'px' }"
          @click="selectCol(c - 1)"
        >
          {{ colLabel(c - 1) }}
          <span class="sg-rz" @pointerdown.stop="startColResize(c - 1, $event)" />
        </div>
      </div>
    </div>

    <div class="sg-mid">
      <div ref="rowHeadEl" class="sg-rowhead">
        <div class="sg-head-rows" :style="{ height: totalH + 'px' }">
          <div
            v-for="(y, r) in rowYs"
            :key="'r' + r"
            class="sg-rh"
            :style="{ top: y + 'px', height: rowHeightAt(sheet, r) + 'px' }"
            @click="selectRow(r)"
          >
            {{ r + 1 }}
            <span class="sg-rh-rz" @pointerdown.stop="startRowResize(r, $event)" />
          </div>
        </div>
      </div>
      <div v-if="frozenRows" class="sg-rowhead-fz" :style="{ height: frozenH + 'px' }">
        <div
          v-for="r in frozenRows"
          :key="'fhr' + r"
          class="sg-rh is-frozen"
          :style="{ top: rowYs[r - 1] + 'px', height: rowHeightAt(sheet, r - 1) + 'px' }"
          @click="selectRow(r - 1)"
        >
          {{ r }}
          <span class="sg-rh-rz" @pointerdown.stop="startRowResize(r - 1, $event)" />
        </div>
      </div>

      <div
        ref="scrollEl"
        class="sg-scroll"
        tabindex="0"
        @scroll="syncScroll"
        @keydown="onKey"
        @pointerdown="onPointerDown"
        @dblclick="onDblClick"
        @contextmenu.prevent="onContextMenu"
      >
        <div class="sg-inner" :style="{ width: totalW + 'px', height: totalH + 'px' }">
          <svg class="sg-lines" :width="totalW" :height="totalH" aria-hidden="true">
            <line
              v-for="(x, c) in colXs"
              :key="'v' + c"
              :x1="x"
              :y1="sheet.originY"
              :x2="x"
              :y2="totalH"
              :class="{ 'is-major': sheet.frozenCols && c === sheet.frozenCols }"
            />
            <line :x1="totalW - 1" :y1="sheet.originY" :x2="totalW - 1" :y2="totalH" />
            <line
              v-for="(y, r) in rowYs"
              :key="'h' + r"
              :x1="sheet.originX"
              :y1="y"
              :x2="totalW"
              :y2="y"
              :class="{ 'is-major': sheet.frozenRows && r === sheet.frozenRows }"
            />
            <line :x1="sheet.originX" :y1="totalH - 1" :x2="totalW" :y2="totalH - 1" />
          </svg>

          <SheetCellBox v-for="v in blockViews" :key="'b' + v.key" :view="v" />
          <SheetCellBox v-for="v in seatViews" :key="'s' + v.key" :view="v" />

          <div class="sg-selection" :style="selStyle" />
          <div class="sg-active-cell" :style="activeStyle" />

          <input
            v-if="editing && !editInCorner && !editInRows && !editInCols"
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

      <!-- 冻结窗格：覆盖在滚动区上层，分冻结行 / 冻结列 / 左上角三块 -->
      <div
        v-if="frozenRows || frozenCols"
        class="sg-frozen"
        :style="{ right: scrollbar.w + 'px', bottom: scrollbar.h + 'px' }"
      >
        <div
          v-if="frozenRows"
          class="sg-fz-rows"
          :style="{ height: frozenH + 'px' }"
        >
          <div
            class="sg-fz-layer"
            :style="{ transform: `translateX(${-scrollLeft}px)`, width: totalW + 'px', height: frozenH + 'px' }"
          >
            <SheetCellBox v-for="v in fzRows" :key="'fr' + v.key" :view="v" />
            <div class="sg-selection" :style="selStyle" />
            <div class="sg-active-cell" :style="activeStyle" />
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
          :style="{ width: frozenW + 'px', top: frozenH + 'px' }"
        >
          <div
            class="sg-fz-layer"
            :style="{ transform: `translateY(${-scrollTop}px)`, width: frozenW + 'px', height: totalH + 'px' }"
          >
            <SheetCellBox v-for="v in fzCols" :key="'fk' + v.key" :view="v" />
            <div class="sg-selection" :style="selStyle" />
            <div class="sg-active-cell" :style="activeStyle" />
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
        <div v-if="frozenRows && frozenCols" class="sg-fz-corner" :style="{ width: frozenW + 'px', height: frozenH + 'px' }">
          <SheetCellBox v-for="v in fzCorner" :key="'fc' + v.key" :view="v" />
          <div class="sg-selection" :style="selStyle" />
          <div class="sg-active-cell" :style="activeStyle" />
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

    <div class="sg-foot">
      <span>{{ sheet.rows }} 行 × {{ sheet.cols }} 列</span>
      <span class="sg-foot-sep" />
      <span>双击编辑 · 拖动行号/列号边界调尺寸 · Ctrl+C/V 复制粘贴 · Ctrl+D/R 填充 · Ctrl+Z/Y 撤销重做</span>
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
  border-radius: var(--radius-md);
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
.sg-inner { position: relative; }
.sg-lines { position: absolute; left: 0; top: 0; pointer-events: none; }
.sg-lines line { stroke: var(--border-soft); stroke-width: 1; }
.sg-lines line.is-major { stroke: var(--border-strong); stroke-width: 1.5; }

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
.sg-fz-layer { position: absolute; left: 0; top: 0; }

.sg-selection {
  position: absolute; pointer-events: none;
  border: 1.5px solid var(--primary);
  background: rgba(74, 124, 123, 0.07);
  border-radius: 2px;
}
.sg-active-cell { position: absolute; pointer-events: none; border: 2px solid var(--primary); border-radius: 2px; }

.sg-edit {
  position: absolute; z-index: 5; padding: 4px 8px;
  border: 2px solid var(--primary); border-radius: 3px;
  font-size: 13px; font-family: inherit; color: var(--text-primary);
  outline: none; background: #fff;
}

.sg-foot {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-top: 1px solid var(--border);
  font-size: 11px; color: var(--text-muted); background: var(--bg-subtle);
}
.sg-foot-sep { width: 1px; height: 12px; background: var(--border); }
</style>
