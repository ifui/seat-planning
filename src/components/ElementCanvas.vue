<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { BaseElement, LayoutPackage, SeatingElement, Seat } from '../types'
import { elementText, hasEditableText, isSeatingElement } from '../types'
import { isElementLocked, lockedGroupSet } from '../groupLocks'
import { buildSnapLines, snapToLines, snapGrid, type SnapLines } from '../composables/useCanvasSnap'
import { cellRect, colWidthAt, rowHeightAt, snapChangesToGrid } from '../engine/grid'

interface SeatInfo {
  name: string
  rankName: string
  color: string
  status: string
  locked: boolean
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

const props = withDefaults(
  defineProps<{
    layout: LayoutPackage
    editable?: boolean
    selectedIds?: string[]
    seatInfo?: Record<string, SeatInfo>
    scale?: number
    panMode?: boolean
  }>(),
  {
    editable: false,
    selectedIds: () => [],
    seatInfo: () => ({}),
    scale: 1,
    panMode: false
  }
)

const emit = defineEmits<{
  (e: 'select', ids: string[]): void
  (e: 'elements-change', els: BaseElement[]): void
  (e: 'commit'): void
  (e: 'context-menu', payload: { x: number; y: number; elementId: string; seatId?: string }): void
  (e: 'toggle-seat', elementId: string, seatId: string): void
  (e: 'text-change', elementId: string, text: string): void
}>()

const stage = ref<HTMLElement | null>(null)
const sorted = computed(() => [...props.layout.elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)))

/** 网格线、行列号与合并区，只做展示，不接收鼠标事件 */
const gridView = computed(() => {
  const g = props.layout.grid
  if (!g) return null
  const rows: { y: number; h: number; i: number }[] = []
  const cols: { x: number; w: number; i: number }[] = []
  const hs: number[] = []
  const vs: number[] = []
  let y = g.originY
  for (let r = 0; r < g.rows; r++) {
    const hh = rowHeightAt(g, r)
    rows.push({ y, h: hh, i: r })
    hs.push(y)
    y += hh
  }
  hs.push(y)
  let x = g.originX
  for (let c = 0; c < g.cols; c++) {
    const ww = colWidthAt(g, c)
    cols.push({ x, w: ww, i: c })
    vs.push(x)
    x += ww
  }
  vs.push(x)
  const merges = (g.merges || []).map((m) => cellRect(g, m.row, m.col, m.rowSpan ?? 1, m.colSpan ?? 1))
  return { rows, cols, hs, vs, merges }
})

function strayElement(el: BaseElement): boolean {
  return !!props.layout.grid && !el.cell
}

/** 被锁定的图层分组：锁组 = 锁组内全部元素 */
const lockedGroupIds = computed(() => lockedGroupSet(props.layout.groups))

function isLocked(el: BaseElement): boolean {
  return isElementLocked(el, lockedGroupIds.value)
}

/**
 * 拼接检测：相邻座位类元素（未旋转、间隙 <= JOIN_GAP、跨度重叠 >= 60%）视为同一排/列。
 * 命中后接缝一侧取消圆角与描边，形成整排连通的外观（外圆角、内直角）。
 */
const JOIN_GAP = 10
const JOIN_MIN_OVERLAP = 0.6
type JoinSides = { l: boolean; r: boolean; t: boolean; b: boolean }

const joinMap = computed(() => {
  const map = new Map<string, JoinSides>()
  const els = props.layout.elements.filter((e) => isSeatingElement(e) && !(e.rotation ?? 0))
  for (const a of els) {
    const j: JoinSides = { l: false, r: false, t: false, b: false }
    for (const b of els) {
      if (a === b) continue
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (oy > 0 && oy >= Math.min(a.h, b.h) * JOIN_MIN_OVERLAP) {
        const gapR = b.x - (a.x + a.w)
        if (gapR >= -1 && gapR <= JOIN_GAP) j.r = true
        const gapL = a.x - (b.x + b.w)
        if (gapL >= -1 && gapL <= JOIN_GAP) j.l = true
      }
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      if (ox > 0 && ox >= Math.min(a.w, b.w) * JOIN_MIN_OVERLAP) {
        const gapB = b.y - (a.y + a.h)
        if (gapB >= -1 && gapB <= JOIN_GAP) j.b = true
        const gapT = a.y - (b.y + b.h)
        if (gapT >= -1 && gapT <= JOIN_GAP) j.t = true
      }
    }
    if (j.l || j.r || j.t || j.b) map.set(a.id, j)
  }
  return map
})

const TYPE_LABEL: Record<string, string> = {
  table: '会议桌',
  hostTable: '主席台',
  podium: '讲台',
  lectern: '演讲台',
  aisle: '过道',
  zone: '区域',
  label: '标注',
  shape: '图形'
}

function textOf(el: BaseElement): string {
  const t = elementText(el)
  if (t) return t
  if (el.type === 'shape') return ''
  return TYPE_LABEL[el.type] ?? ''
}

function elStyle(el: BaseElement): Record<string, string> {
  const st = el.style || {}
  const isShape = el.type === 'shape'
  const stroke = st.stroke ?? '#DCE1E6'
  const r = st.radius ?? 8
  const j = joinMap.value.get(el.id)
  let tl = r
  let tr = r
  let br = r
  let bl = r
  if (j) {
    if (j.t) { tl = 0; tr = 0 }
    if (j.r) { tr = 0; br = 0 }
    if (j.b) { br = 0; bl = 0 }
    if (j.l) { bl = 0; tl = 0 }
  }
  const style: Record<string, string> = {
    left: el.x + 'px',
    top: el.y + 'px',
    width: el.w + 'px',
    height: el.h + 'px',
    background: isShape ? 'transparent' : (st.fill ?? (el.type === 'aisle' ? '#F1F3F4' : '#fff')),
    border: isShape ? 'none' : `1px solid ${stroke}`,
    borderRadius: `${tl}px ${tr}px ${br}px ${bl}px`,
    opacity: String(st.opacity ?? 1),
    color: st.textColor ?? '#33424B',
    transform: `rotate(${el.rotation ?? 0}deg)`,
    zIndex: String(el.z ?? 0)
  }
  if (j && !isShape) {
    // 接缝一侧隐藏描边，避免相邻桌之间出现双线/断口
    if (j.t) style.borderTopColor = 'transparent'
    if (j.r) style.borderRightColor = 'transparent'
    if (j.b) style.borderBottomColor = 'transparent'
    if (j.l) style.borderLeftColor = 'transparent'
  }
  return style
}

/** 文字样式：字体族 / 字号 / 字重 / 对齐，全部来自元素 style */
function textStyle(el: BaseElement): Record<string, string> {
  const st = el.style || {}
  const align = st.textAlign ?? 'center'
  return {
    fontFamily: st.fontFamily || '',
    fontSize: (st.fontSize ?? 12) + 'px',
    fontWeight: String(st.fontWeight ?? 400),
    textAlign: align,
    justifyContent: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
    color: st.textColor ?? '#33424B'
  }
}

function shapeSvgStyle(el: BaseElement): Record<string, string> {
  return { position: 'absolute', left: '0', top: '0', overflow: 'visible' }
}

/** 圆形/菱形/三角形的几何路径（按元素实际尺寸绘制，保证描边不被拉伸） */
function shapePoints(el: BaseElement): string {
  const w = el.w
  const h = el.h
  if (el.shape === 'diamond') return `${w / 2},0.5 ${w - 0.5},${h / 2} ${w / 2},${h - 0.5} 0.5,${h / 2}`
  if (el.shape === 'triangle') return `${w / 2},0.5 ${w - 0.5},${h - 0.5} 0.5,${h - 0.5}`
  return ''
}

function seatStyle(s: Seat): Record<string, string | undefined> {
  return {
    left: s.x + 'px',
    top: s.y + 'px',
    width: s.w + 'px',
    height: s.h + 'px'
  }
}

function infoOf(s: Seat): SeatInfo | undefined {
  return props.seatInfo[s.id]
}

function isSelected(id: string): boolean {
  return props.selectedIds.includes(id)
}

function toCanvas(e: MouseEvent): { x: number; y: number } {
  const rect = stage.value?.getBoundingClientRect()
  const s = props.scale || 1
  if (!rect) return { x: 0, y: 0 }
  return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s }
}

// ---------- 就地编辑文字 ----------
const editingId = ref<string | null>(null)
const editText = ref('')

function beginEdit(el: BaseElement): void {
  if (!hasEditableText(el)) return
  editingId.value = el.id
  editText.value = elementText(el)
  nextTick(() => {
    const box = stage.value?.querySelector('.el-editor') as HTMLTextAreaElement | null
    if (!box) return
    box.focus()
    box.select()
  })
}

function commitEdit(): void {
  const id = editingId.value
  if (!id) return
  const text = editText.value.trim()
  editingId.value = null
  emit('text-change', id, text)
}

function cancelEdit(): void {
  editingId.value = null
}

function onEditKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    commitEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

// ---------- 选择 / 拖动 ----------
// 拖拽期间不写入响应式状态：直接改 DOM，松手后再一次性写回（避免整棵元素树重渲染）。

const guideVEl = ref<HTMLElement | null>(null)
const guideHEl = ref<HTMLElement | null>(null)
const marqueeEl = ref<HTMLElement | null>(null)

interface MoveState {
  kind: 'move'
  startX: number
  startY: number
  primaryId: string
  ids: string[]
  base: Map<string, { x: number; y: number; w: number; h: number }>
  moved: boolean
  dx: number
  dy: number
  snapV: number | null
  snapH: number | null
  previewing: boolean
  useVar: boolean
  lines: SnapLines
}

interface ResizeState {
  kind: 'resize'
  startX: number
  startY: number
  elementId: string
  handle: Handle
  base: { x: number; y: number; w: number; h: number; rotation: number }
  moved: boolean
  rect: { x: number; y: number; w: number; h: number }
  origin: { left: string; top: string; width: string; height: string }
}

interface RotateState {
  kind: 'rotate'
  elementId: string
  centerX: number
  centerY: number
  startAngle: number
  baseRotation: number
  moved: boolean
  deg: number
  originTransform: string
}

interface MarqueeState {
  kind: 'marquee'
  x0: number
  y0: number
  x1: number
  y1: number
  additive: boolean
  baseSelection: string[]
  moved: boolean
}

type DragState = MoveState | ResizeState | RotateState | MarqueeState
let drag: DragState | null = null

function setGuide(v: number | null, h: number | null): void {
  if (guideVEl.value) {
    guideVEl.value.style.display = v === null ? 'none' : 'block'
    if (v !== null) guideVEl.value.style.left = v + 'px'
  }
  if (guideHEl.value) {
    guideHEl.value.style.display = h === null ? 'none' : 'block'
    if (h !== null) guideHEl.value.style.top = h + 'px'
  }
}

function setMarquee(x: number, y: number, w: number, h: number): void {
  const box = marqueeEl.value
  if (!box) return
  box.style.display = w > 0 || h > 0 ? 'block' : 'none'
  box.style.left = x + 'px'
  box.style.top = y + 'px'
  box.style.width = w + 'px'
  box.style.height = h + 'px'
}

function hideMarquee(): void {
  if (marqueeEl.value) marqueeEl.value.style.display = 'none'
}

function elNode(id: string): HTMLElement | null {
  return stage.value?.querySelector<HTMLElement>(`.el[data-el-id="${id}"]`) ?? null
}

// 多选拖动时只改画布上的两个 CSS 变量，由 .preview-move 统一位移，
// 避免每帧向几十/几百个节点写 style（大幅降低 style recalc 与 mutation 数量）。
// 少量元素拖动仍逐节点写 inline translate：自定义属性会继承，在 1300+ 节点的画布上
// 反而会让整棵子树参与样式重算（实测单元素 33ms → 61ms），故按数量分档。
const MOVE_VAR_THRESHOLD = 8
const previewIds = new Set<string>()

function beginMovePreview(ids: string[]): void {
  const st = stage.value
  if (!st) return
  previewIds.clear()
  for (const id of ids) {
    const node = elNode(id)
    if (!node) continue
    node.classList.add('preview-move')
    previewIds.add(id)
  }
  st.style.setProperty('--mv-x', '0px')
  st.style.setProperty('--mv-y', '0px')
  st.classList.add('is-moving')
}

function setMovePreview(dx: number, dy: number): void {
  const st = stage.value
  if (!st) return
  st.style.setProperty('--mv-x', dx + 'px')
  st.style.setProperty('--mv-y', dy + 'px')
}

function endMovePreview(): void {
  const st = stage.value
  st?.classList.remove('is-moving')
  st?.style.removeProperty('--mv-x')
  st?.style.removeProperty('--mv-y')
  for (const id of previewIds) elNode(id)?.classList.remove('preview-move')
  previewIds.clear()
}

function onElementDown(e: MouseEvent, el: BaseElement): void {
  if (!props.editable) { emit('select', [el.id]); return }
  if (e.button !== 0) return
  if (editingId.value) {
    e.stopPropagation()
    return
  }
  e.stopPropagation()
  const additive = e.shiftKey || e.metaKey || e.ctrlKey
  let sel = [...props.selectedIds]
  if (additive) {
    sel = sel.includes(el.id) ? sel.filter((id) => id !== el.id) : [...sel, el.id]
    emit('select', sel)
    return
  }
  if (!sel.includes(el.id)) {
    sel = [el.id]
    emit('select', sel)
  }
  if (isLocked(el)) return

  const ids = sel.filter((id) => {
    const item = props.layout.elements.find((x) => x.id === id)
    return item && !isLocked(item)
  })
  if (!ids.length) return

  const pt = toCanvas(e)
  const base = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const id of ids) {
    const item = props.layout.elements.find((x) => x.id === id)
    if (item) base.set(id, { x: item.x, y: item.y, w: item.w, h: item.h })
  }
  drag = {
    kind: 'move',
    startX: pt.x,
    startY: pt.y,
    primaryId: el.id,
    ids,
    base,
    moved: false,
    dx: 0,
    dy: 0,
    snapV: null,
    snapH: null,
    previewing: false,
    useVar: ids.length > MOVE_VAR_THRESHOLD,
    lines: buildSnapLines(
      { elements: props.layout.elements, canvasW: props.layout.canvas.width, canvasH: props.layout.canvas.height },
      ids
    )
  }
  bindWindow()
}

function startResize(e: MouseEvent, el: BaseElement, handle: Handle): void {
  if (!props.editable || isLocked(el)) return
  e.stopPropagation()
  e.preventDefault()
  const pt = toCanvas(e)
  const node = elNode(el.id)
  drag = {
    kind: 'resize',
    startX: pt.x,
    startY: pt.y,
    elementId: el.id,
    handle,
    base: { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation ?? 0 },
    moved: false,
    rect: { x: el.x, y: el.y, w: el.w, h: el.h },
    origin: {
      left: node?.style.left ?? '',
      top: node?.style.top ?? '',
      width: node?.style.width ?? '',
      height: node?.style.height ?? ''
    }
  }
  bindWindow()
}

function startRotate(e: MouseEvent, el: BaseElement): void {
  if (!props.editable || isLocked(el)) return
  e.stopPropagation()
  e.preventDefault()
  const pt = toCanvas(e)
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  drag = {
    kind: 'rotate',
    elementId: el.id,
    centerX: cx,
    centerY: cy,
    startAngle: Math.atan2(pt.y - cy, pt.x - cx),
    baseRotation: el.rotation ?? 0,
    moved: false,
    deg: el.rotation ?? 0,
    originTransform: elNode(el.id)?.style.transform ?? ''
  }
  bindWindow()
}

function onStageDown(e: MouseEvent): void {
  if (editingId.value) return
  if (!props.editable || props.panMode || e.button !== 0) return
  const pt = toCanvas(e)
  drag = {
    kind: 'marquee',
    x0: pt.x,
    y0: pt.y,
    x1: pt.x,
    y1: pt.y,
    additive: e.shiftKey || e.metaKey || e.ctrlKey,
    baseSelection: [...props.selectedIds],
    moved: false
  }
  bindWindow()
}

function bindWindow(): void {
  window.addEventListener('mousemove', onWindowMove)
  window.addEventListener('mouseup', onWindowUp)
}

function unbindWindow(): void {
  window.removeEventListener('mousemove', onWindowMove)
  window.removeEventListener('mouseup', onWindowUp)
}

let pendingEvent: MouseEvent | null = null
let pendingFrame = 0

/** mousemove 合并到 rAF：每帧最多计算/写 DOM 一次 */
function onWindowMove(e: MouseEvent): void {
  if (!drag) return
  pendingEvent = e
  if (pendingFrame) return
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0
    const ev = pendingEvent
    pendingEvent = null
    if (ev && drag) applyMove(ev)
  })
}

function applyMove(e: MouseEvent): void {
  const d = drag
  if (!d) return
  const pt = toCanvas(e)

  if (d.kind === 'move') {
    let dx = pt.x - d.startX
    let dy = pt.y - d.startY
    if (!d.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) d.moved = true

    const primary = d.base.get(d.primaryId)
    if (!primary) return
    const snapped = snapToLines(
      { x: snapGrid(primary.x + dx), y: snapGrid(primary.y + dy), w: primary.w, h: primary.h },
      d.lines,
      6 / (props.scale || 1)
    )
    dx = snapped.x - primary.x
    dy = snapped.y - primary.y
    d.dx = Math.round(dx)
    d.dy = Math.round(dy)
    d.snapV = snapped.v
    d.snapH = snapped.h
    setGuide(snapped.v, snapped.h)

    // 直接改 DOM：整组元素同步平移，不触发 Vue 更新
    if (d.moved) {
      if (d.useVar) {
        if (!d.previewing) {
          beginMovePreview(d.ids)
          d.previewing = true
        }
        setMovePreview(d.dx, d.dy)
      } else {
        for (const id of d.ids) {
          const node = elNode(id)
          if (node) node.style.translate = `${d.dx}px ${d.dy}px`
        }
      }
    }
    return
  }

  if (d.kind === 'rotate') {
    const el = props.layout.elements.find((x) => x.id === d.elementId)
    if (!el) return
    const angle = Math.atan2(pt.y - d.centerY, pt.x - d.centerX)
    let deg = d.baseRotation + ((angle - d.startAngle) * 180) / Math.PI
    deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.round(deg)
    deg = ((deg % 360) + 360) % 360
    if (!d.moved && Math.abs(deg - d.baseRotation) > 0.5) d.moved = true
    d.deg = deg
    const node = elNode(d.elementId)
    if (node) node.style.transform = `rotate(${deg}deg)`
    return
  }

  if (d.kind === 'resize') {
    const rawDx = pt.x - d.startX
    const rawDy = pt.y - d.startY
    if (!d.moved && (Math.abs(rawDx) > 2 || Math.abs(rawDy) > 2)) d.moved = true
    // 旋转后的元素：把屏幕位移换算回元素本地坐标
    const rad = (-(d.base.rotation) * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const dx = rawDx * cos - rawDy * sin
    const dy = rawDx * sin + rawDy * cos
    const b = d.base
    let x = b.x
    let y = b.y
    let w = b.w
    let h = b.h
    if (d.handle.includes('e')) w = Math.max(24, snapGrid(b.w + dx))
    if (d.handle.includes('s')) h = Math.max(20, snapGrid(b.h + dy))
    if (d.handle.includes('w')) {
      w = Math.max(24, snapGrid(b.w - dx))
      x = Math.round(b.x + b.w - w)
    }
    if (d.handle.includes('n')) {
      h = Math.max(20, snapGrid(b.h - dy))
      y = Math.round(b.y + b.h - h)
    }
    d.rect = { x, y, w, h }
    const node = elNode(d.elementId)
    if (node) {
      node.style.left = x + 'px'
      node.style.top = y + 'px'
      node.style.width = w + 'px'
      node.style.height = h + 'px'
    }
    return
  }

  d.x1 = pt.x
  d.y1 = pt.y
  if (!d.moved && (Math.abs(d.x1 - d.x0) > 3 || Math.abs(d.y1 - d.y0) > 3)) d.moved = true
  if (!d.moved) return
  const x = Math.min(d.x0, d.x1)
  const y = Math.min(d.y0, d.y1)
  const w = Math.abs(d.x1 - d.x0)
  const h = Math.abs(d.y1 - d.y0)
  setMarquee(x, y, w, h)
  const hits = props.layout.elements
    .filter((el) => !isLocked(el))
    .filter((el) => el.x < x + w && el.x + el.w > x && el.y < y + h && el.y + el.h > y)
    .map((el) => el.id)
  const next = d.additive ? [...new Set([...d.baseSelection, ...hits])] : hits
  emit('select', next)
}

function onWindowUp(): void {
  const d = drag
  unbindWindow()
  if (pendingFrame) {
    cancelAnimationFrame(pendingFrame)
    pendingFrame = 0
    pendingEvent = null
  }
  drag = null
  setGuide(null, null)
  hideMarquee()
  if (!d) return

  if (d.kind === 'marquee') {
    if (!d.moved && !d.additive) emit('select', [])
    return
  }

  if (!d.moved) {
    // 没有产生位移：恢复拖拽前直接写入的内联样式
    if (d.kind === 'resize') {
      const node = elNode(d.elementId)
      if (node) {
        node.style.left = d.origin.left
        node.style.top = d.origin.top
        node.style.width = d.origin.width
        node.style.height = d.origin.height
      }
    } else if (d.kind === 'rotate') {
      const node = elNode(d.elementId)
      if (node) node.style.transform = d.originTransform
    }
    return
  }

  // 松手一次性写回响应式状态；随后清理预览用的内联样式
  if (d.kind === 'move') {
    let changes: BaseElement[] = []
    for (const [id, base] of d.base) {
      const el = props.layout.elements.find((x) => x.id === id)
      if (!el) continue
      changes.push({ ...el, x: Math.round(base.x + d.dx), y: Math.round(base.y + d.dy) })
    }
    // 有网格时松手吸附进格子（格子行列号同步写回元素）
    if (props.layout.grid) changes = snapChangesToGrid(props.layout, changes, 'move')
    emit('elements-change', changes)
    nextTick(() => {
      endMovePreview()
      if (!d.useVar) {
        for (const id of d.base.keys()) {
          const node = elNode(id)
          if (node) node.style.translate = ''
        }
      }
    })
  } else if (d.kind === 'resize') {
    const el = props.layout.elements.find((x) => x.id === d.elementId)
    if (el) {
      let next: BaseElement = { ...el, ...d.rect }
      if (props.layout.grid && el.cell) next = snapChangesToGrid(props.layout, [next], 'resize')[0]
      emit('elements-change', [next])
    }
  } else {
    const el = props.layout.elements.find((x) => x.id === d.elementId)
    if (el) emit('elements-change', [{ ...el, rotation: d.deg }])
  }
  emit('commit')
}

function onElementContextMenu(e: MouseEvent, el: BaseElement): void {
  e.preventDefault()
  e.stopPropagation()
  if (!props.editable) return
  if (!isSelected(el.id)) emit('select', [el.id])
  emit('context-menu', { x: e.clientX, y: e.clientY, elementId: el.id })
}

function onSeatContextMenu(e: MouseEvent, el: BaseElement, s: Seat): void {
  e.preventDefault()
  e.stopPropagation()
  if (!props.editable) return
  if (!isSelected(el.id)) emit('select', [el.id])
  emit('context-menu', { x: e.clientX, y: e.clientY, elementId: el.id, seatId: s.id })
}

function onSeatDblClick(e: MouseEvent, el: BaseElement, s: Seat): void {
  e.preventDefault()
  e.stopPropagation()
  if (!props.editable) return
  emit('toggle-seat', el.id, s.id)
}

function onElementDblClick(e: MouseEvent, el: BaseElement): void {
  if (!props.editable) return
  const target = e.target as HTMLElement
  if (target.closest('.seat-slot')) return
  if (!hasEditableText(el)) return
  e.stopPropagation()
  beginEdit(el)
}

function seatText(el: SeatingElement, s: Seat): string {
  const info = infoOf(s)
  if (info) return info.name
  return s.disabled ? '空位' : String(el.seats.indexOf(s) + 1)
}

onBeforeUnmount(() => {
  unbindWindow()
  if (pendingFrame) cancelAnimationFrame(pendingFrame)
})
</script>

<template>
  <div
    ref="stage"
    class="canvas-stage"
    :style="{
      width: layout.canvas.width + 'px',
      height: layout.canvas.height + 'px',
      background: layout.canvas.background
    }"
    @mousedown.self="onStageDown"
  >
    <!-- 网格：行列由格子自身决定，画在这里只为“看得见”，不接收鼠标事件 -->
    <svg
      v-if="gridView"
      class="grid-layer"
      :width="layout.canvas.width"
      :height="layout.canvas.height"
    >
      <line
        v-for="(x, i) in gridView.vs"
        :key="'v' + i"
        :x1="x" :x2="x" :y1="gridView.hs[0]" :y2="gridView.hs[gridView.hs.length - 1]"
        stroke="#DCE5E9" stroke-width="1"
      />
      <line
        v-for="(y, i) in gridView.hs"
        :key="'h' + i"
        :x1="gridView.vs[0]" :x2="gridView.vs[gridView.vs.length - 1]" :y1="y" :y2="y"
        stroke="#DCE5E9" stroke-width="1"
      />
      <!-- 合并单元格：用画布底色盖掉内部网格线，再描一圈边 -->
      <rect
        v-for="(m, i) in gridView.merges"
        :key="'m' + i"
        :x="m.x" :y="m.y" :width="m.w" :height="m.h"
        :fill="layout.canvas.background"
        stroke="#C9D5DA" stroke-width="1" rx="2"
      />
      <text
        v-for="r in gridView.rows"
        :key="'rn' + r.i"
        :x="gridView.vs[0] - 6" :y="r.y + r.h / 2 + 3"
        text-anchor="end" class="grid-num"
      >{{ r.i + 1 }}</text>
      <text
        v-for="c in gridView.cols"
        :key="'cn' + c.i"
        :x="c.x + c.w / 2" :y="gridView.hs[0] - 6"
        text-anchor="middle" class="grid-num"
      >{{ c.i + 1 }}</text>
    </svg>

    <div
      v-for="el in sorted"
      :key="el.id"
      class="el"
      :class="{ selected: isSelected(el.id), readonly: !editable, locked: isLocked(el), editing: editingId === el.id, 'grid-stray': strayElement(el), ['type-' + el.type]: true }"
      :style="elStyle(el)"
      :data-el-id="el.id"
      @mousedown="onElementDown($event, el)"
      @dblclick="onElementDblClick($event, el)"
      @contextmenu="onElementContextMenu($event, el)"
    >
      <!-- 几何图形 -->
      <svg
        v-if="el.type === 'shape'"
        :width="el.w"
        :height="el.h"
        :style="shapeSvgStyle(el)"
        :viewBox="`0 0 ${el.w} ${el.h}`"
        class="shape-svg"
      >
        <rect
          v-if="el.shape === 'rect' || el.shape === 'square' || !el.shape"
          x="0.5" y="0.5" :width="el.w - 1" :height="el.h - 1"
          :rx="el.style?.radius ?? 8"
          :fill="el.style?.fill ?? '#ECF1F3'" :stroke="el.style?.stroke ?? '#B9C7CE'" stroke-width="1"
        />
        <ellipse
          v-else-if="el.shape === 'circle'"
          :cx="el.w / 2" :cy="el.h / 2" :rx="el.w / 2 - 0.5" :ry="el.h / 2 - 0.5"
          :fill="el.style?.fill ?? '#ECF1F3'" :stroke="el.style?.stroke ?? '#B9C7CE'" stroke-width="1"
        />
        <polygon
          v-else
          :points="shapePoints(el)"
          :fill="el.style?.fill ?? '#ECF1F3'" :stroke="el.style?.stroke ?? '#B9C7CE'" stroke-width="1"
        />
      </svg>

      <div v-if="!isSeatingElement(el) && textOf(el)" class="el-label" :style="textStyle(el)">{{ textOf(el) }}</div>

      <template v-if="isSeatingElement(el)">
        <div
          v-for="s in (el as SeatingElement).seats"
          :key="s.id"
          class="seat-slot"
          :class="{ 'has-name': !!infoOf(s), disabled: s.disabled }"
          :style="seatStyle(s)"
          :data-seat-id="s.id"
          :title="infoOf(s) ? `${infoOf(s)!.name} · ${infoOf(s)!.rankName}` : (s.disabled ? '空位 / 不可用（双击恢复）' : `座位 ${s.index}（双击标记空位）`)"
          @contextmenu="onSeatContextMenu($event, el, s)"
          @dblclick="onSeatDblClick($event, el, s)"
        >
          <span class="seat-name">{{ seatText(el as SeatingElement, s) }}</span>
        </div>
      </template>

      <!-- 就地编辑文字 -->
      <textarea
        v-if="editingId === el.id"
        v-model="editText"
        class="el-editor"
        :style="textStyle(el)"
        placeholder="输入文字…"
        @mousedown.stop
        @dblclick.stop
        @keydown="onEditKeydown"
        @blur="commitEdit"
      />

      <template v-if="editable && isSelected(el.id) && selectedIds.length === 1 && !isLocked(el) && editingId !== el.id">
        <div
          v-for="h in HANDLES"
          :key="h"
          class="rz"
          :class="'rz-' + h"
          @mousedown="startResize($event, el, h)"
        />
        <div class="rot-handle" title="拖动旋转（按住 Shift 以 15° 步进）" @mousedown="startRotate($event, el)">
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M10.5 6a4.5 4.5 0 1 1-1.3-3.1M10.5 1.5V3.8H8.2" />
          </svg>
        </div>
      </template>
    </div>

    <div ref="guideVEl" class="guide v" style="display: none" />
    <div ref="guideHEl" class="guide h" style="display: none" />
    <div ref="marqueeEl" class="marquee" style="display: none" />
  </div>
</template>
