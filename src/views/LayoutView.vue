<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { BaseElement, ElementType, LayerGroup, LayoutPackage, SeatingElement, Seat, ShapeKind, ZoneDef } from '../types'
import { isSeatingElement } from '../types'
import { isElementLocked, lockedGroupSet } from '../groupLocks'
import { removeLayout, saveLayout, state } from '../store'
import { createBlankLayout, makePlain, makeSeats, makeShape, makeTable, nowISO, uid } from '../engine/geometry'
import ElementCanvas from '../components/ElementCanvas.vue'
import GenerateDialog from '../components/layout/GenerateDialog.vue'
import GridDialog from '../components/layout/GridDialog.vue'
import InspectorPanel from '../components/layout/InspectorPanel.vue'
import LayoutToolbar from '../components/layout/LayoutToolbar.vue'
import type { GenOptions } from '../components/layout/generate'
import {
  applyGridGeometry, autoPlaceFreeElements, cellFromPoint, clearGrid, createGrid, detachElement,
  normalizeGrid, putElementInCell, syncMerges
} from '../engine/grid'
import { reflowSeats, buildDistributedSeats } from '../components/layout/seatOps'
import {
  ADD_ITEMS, ALIGN_ACTIONS, FILLS, FONT_FAMILIES, FONT_WEIGHTS, RULE_TAG_LABEL, RULE_TAG_OPTIONS, SHAPE_LABEL,
  SHAPE_OPTIONS, STROKES, TEXT_ALIGNS, ZONE_COLORS, type AlignKey
} from '../components/layout/options'
import { useCanvasViewport } from '../composables/useCanvasViewport'
import { useLayoutHistory } from '../composables/useLayoutHistory'
import { alignElements, distributeElements } from '../composables/useLayoutAlign'
import { elTitle, TYPE_LABEL } from '../labels'
import {
  UiButton, UiContextMenu, UiIcon, UiIconButton,
  UiMenuItem, UiModal, UiSelect
} from '../ui'

// ---------- 数据 ----------
const selectedId = ref<string>(state.layouts[0]?.id ?? '')
const draft = ref<LayoutPackage | null>(null)
const selectedIds = ref<string[]>([])
const activeTab = ref('canvas')
const dirty = ref(false)
const toast = ref('')
let loading = false
const { history, hIndex, resetHistory, historyPush, undo, redo } = useLayoutHistory(draft, selectedIds)
/** 缩放模式必须在 load() 之前初始化：immediate watch 会同步调用 load()。 */
const {
  viewport,
  zoomMode,
  scale,
  zoomLabel,
  stageOffset,
  sizerSize,
  zoomBy,
  fitToViewport,
  onWheel,
  spaceDown,
  panning,
  maybePan,
  unbindPan,
  syncViewportMetrics
} = useCanvasViewport(() => (draft.value ? draft.value.canvas : null))

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

function normalizeLayout(l: LayoutPackage): void {
  l.elements.sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
  l.elements.forEach((e, i) => {
    e.z = i
    if (typeof e.rotation !== 'number') e.rotation = 0
    if (!e.style) e.style = {}
    if (e.type === 'shape' && !e.shape) e.shape = 'rect'
  })
  if (!Array.isArray(l.zones)) l.zones = []
  if (!Array.isArray(l.groups)) l.groups = []
  l.groups = l.groups.filter((g) => g && typeof g.id === 'string' && g.id)
  const groupIds = new Set(l.groups.map((g) => g.id))
  // 清理指向已不存在分组的 groupId，避免图层列表出现“幽灵组”
  for (const e of l.elements) {
    if (e.groupId && !groupIds.has(e.groupId)) delete e.groupId
  }
  // 网格：旧布局没有 grid 就是自由布局；有 grid 则规整尺寸并清理越界的格子归属
  if (l.grid) {
    l.grid = normalizeGrid(l.grid)
    for (const e of l.elements) {
      if (!e.cell) continue
      const span = { rowSpan: Math.max(1, e.cell.rowSpan ?? 1), colSpan: Math.max(1, e.cell.colSpan ?? 1) }
      if (e.cell.row >= l.grid.rows || e.cell.col >= l.grid.cols) {
        delete e.cell
      } else {
        e.cell.rowSpan = Math.min(span.rowSpan, l.grid.rows - e.cell.row)
        e.cell.colSpan = Math.min(span.colSpan, l.grid.cols - e.cell.col)
        if (e.cell.rowSpan === 1 && e.cell.colSpan === 1) delete e.cell.rowSpan
        if (e.cell.colSpan === 1) delete e.cell.colSpan
      }
    }
    syncMerges(l)
  }
}

function load(id: string): void {
  const found = state.layouts.find((l) => l.id === id)
  loading = true
  if (found) {
    const copy = clone(found)
    normalizeLayout(copy)
    draft.value = copy
  } else {
    draft.value = null
  }
  selectedIds.value = []
  activeTab.value = 'canvas'
  resetHistory()
  dirty.value = false
  zoomMode.value = 'fit'
  setTimeout(() => { loading = false }, 0)
}

watch(selectedId, (id) => load(id), { immediate: true })
watch(draft, () => { if (draft.value && !loading) dirty.value = true }, { deep: true })
watch(
  () => state.layouts.map((l) => l.id).join(','),
  () => {
    if (!state.layouts.some((l) => l.id === selectedId.value)) selectedId.value = state.layouts[0]?.id ?? ''
  }
)
/* 点击图层只选中元素，不自动切换右侧 tab —— 让用户停留在当前上下文 */

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2200)
}

const layoutOptions = computed(() =>
  state.layouts.map((l) => ({ value: l.id, label: l.name, hint: `${l.elements.length} 个元素` }))
)

const selectedEls = computed(() => {
  if (!draft.value) return []
  return draft.value.elements.filter((e) => selectedIds.value.includes(e.id))
})

const seatCount = computed(() => {
  if (!draft.value) return 0
  return draft.value.elements.reduce((n, e) => n + (isSeatingElement(e) ? e.seats.length : 0), 0)
})
const zoneOptions = computed(() =>
  [{ value: '', label: '未分区' }, ...(draft.value?.zones ?? []).map((z) => ({ value: z.id, label: z.name }))]
)
const disabledCount = computed(() => {
  if (!draft.value) return 0
  return draft.value.elements.reduce((n, e) => n + (isSeatingElement(e) ? e.seats.filter((s) => s.disabled).length : 0), 0)
})

function selectAllElements(): void {
  if (!draft.value) return
  selectedIds.value = draft.value.elements.map((e) => e.id)
}

// ---------- 图层分组（数据结构与变更都留在页面/store，展示交给 LayerPanel） ----------
const lockedGroupIds = computed(() => lockedGroupSet(draft.value?.groups))

function elLocked(el: BaseElement): boolean {
  return isElementLocked(el, lockedGroupIds.value)
}

function createGroupFromSelection(): void {
  if (!draft.value) return
  if (!selectedIds.value.length) {
    flash('先选中要成组的元素')
    return
  }
  const g: LayerGroup = { id: uid('group'), name: `分组 ${(draft.value.groups?.length ?? 0) + 1}` }
  draft.value.groups = [...(draft.value.groups ?? []), g]
  const ids = new Set(selectedIds.value)
  let moved = 0
  for (const el of draft.value.elements) {
    if (!ids.has(el.id)) continue
    el.groupId = g.id
    moved++
  }
  pruneGroups()
  historyPush()
  flash(`已创建分组，包含 ${moved} 个元素`)
}

/** 解散分组：保留元素，只清除归属关系 */
function ungroupById(id: string): void {
  if (!draft.value) return
  for (const el of draft.value.elements) if (el.groupId === id) delete el.groupId
  draft.value.groups = (draft.value.groups ?? []).filter((x) => x.id !== id)
  historyPush()
  flash('分组已解散，元素保留在画布上')
}

/** 清理没有任何成员的空分组 */
function pruneGroups(): void {
  if (!draft.value) return
  const used = new Set(draft.value.elements.map((e) => e.groupId).filter(Boolean) as string[])
  draft.value.groups = (draft.value.groups ?? []).filter((g) => used.has(g.id))
}

function toggleGroupLockById(id: string): void {
  const g = draft.value?.groups?.find((x) => x.id === id)
  if (!g) return
  g.locked = !g.locked
  historyPush()
  flash(g.locked ? `「${g.name}」已锁定` : `「${g.name}」已解锁`)
}

function toggleGroupCollapseById(id: string): void {
  const g = draft.value?.groups?.find((x) => x.id === id)
  if (g) g.collapsed = !g.collapsed
}

function renameGroupById(id: string, name: string): void {
  const g = draft.value?.groups?.find((x) => x.id === id)
  const next = name.trim()
  if (!g || !next || next === g.name) return
  g.name = next
  historyPush()
}

const zoneName = (id?: string): string => draft.value?.zones.find((z) => z.id === id)?.name ?? '未分区'

// ---------- 历史 ----------

// ---------- 保存 / 布局管理 ----------
async function save(): Promise<void> {
  if (!draft.value) return
  await saveLayout(draft.value)
  dirty.value = false
  flash('布局已保存')
}

const renameOpen = ref(false)
const renameValue = ref('')

function openRename(): void {
  if (!draft.value) return
  renameValue.value = draft.value.name
  renameOpen.value = true
}

function confirmRename(): void {
  if (!draft.value) return
  const name = renameValue.value.trim()
  if (!name) { flash('请填写布局名称'); return }
  draft.value.name = name
  renameOpen.value = false
  flash('名称已修改，记得保存')
}

const createOpen = ref(false)
const createName = ref('')

function openCreate(): void {
  createName.value = `会场布局 ${state.layouts.length + 1}`
  createOpen.value = true
}

async function confirmCreate(): Promise<void> {
  const name = createName.value.trim()
  if (!name) { flash('请填写布局名称'); return }
  const l = createBlankLayout(name)
  await saveLayout(l)
  createOpen.value = false
  selectedId.value = l.id
  flash('已新建空白布局')
}

// ---------- 增删元素 ----------
function addElement(type: ElementType): void {
  if (!draft.value) return
  const offset = (draft.value.elements.length % 6) * 16
  let el: BaseElement
  if (type === 'table' || type === 'hostTable' || type === 'lectern') {
    el = makeTable(120 + offset, 160 + offset, type === 'hostTable' ? 360 : type === 'lectern' ? 120 : 160, type === 'hostTable' ? 86 : type === 'lectern' ? 90 : 80, 1, type === 'hostTable' ? 'hostTable' : 'table') as BaseElement
    const seating = el as SeatingElement
    if (type === 'hostTable') seating.seats = buildDistributedSeats(seating, 5)
    if (type === 'lectern') { seating.type = 'lectern'; seating.seats = makeSeats(seating) }
  } else {
    el = makePlain(type as 'podium' | 'aisle' | 'zone' | 'label', 120 + offset, 480 + offset, type === 'aisle' ? 34 : type === 'zone' ? 300 : 200, type === 'aisle' ? 200 : type === 'zone' ? 220 : 60)
    const any = el as any
    if (type === 'podium') any.text = '讲台'
    if (type === 'label') any.text = '文字标注'
  }
  if (type === 'zone') {
    const z: ZoneDef = { id: el.id, name: `区域 ${draft.value.zones.length + 1}`, color: '#EEF2F4', ruleTag: 'other' }
    draft.value.zones.push(z)
    ;(el as any).name = z.name
    el.style = { fill: z.color, stroke: '#DCE1E6', radius: 8, opacity: 0.65 }
  }
  el.z = draft.value.elements.length
  draft.value.elements.push(el)
  selectedIds.value = [el.id]
  historyPush()
}

function addShape(kind: ShapeKind): void {
  if (!draft.value) return
  const size = kind === 'square' ? 120 : kind === 'circle' ? 130 : 160
  const offset = (draft.value.elements.length % 6) * 26
  const x = Math.min(draft.value.canvas.width - size - 24, Math.max(24, draft.value.canvas.width / 2 - size / 2 + offset))
  const y = Math.min(draft.value.canvas.height - size - 24, Math.max(24, draft.value.canvas.height / 2 - size / 2 + offset))
  const el = makeShape(kind, x, y, size, kind === 'rect' ? 96 : size)
  el.z = draft.value.elements.length
  draft.value.elements.push(el)
  selectedIds.value = [el.id]
  historyPush()
  flash(`已添加${SHAPE_LABEL[kind]}，可拖动、旋转，双击输入文字`)
}

function deleteSelected(): void {
  if (!draft.value || !selectedIds.value.length) return
  const total = selectedIds.value.length
  const ids = new Set(selectedIds.value.filter((id) => {
    const el = draft.value!.elements.find((x) => x.id === id)
    return el && !elLocked(el)
  }))
  if (!ids.size) {
    flash('选中的元素已锁定，请先解锁再删除')
    return
  }
  for (const el of draft.value.elements) {
    if (ids.has(el.id) && el.type === 'zone') {
      draft.value.zones = draft.value.zones.filter((z) => z.id !== el.id)
    }
  }
  draft.value.elements = draft.value.elements.filter((e) => !ids.has(e.id))
  for (const e of draft.value.elements) {
    if (isSeatingElement(e) && e.zoneId && !draft.value.zones.some((z) => z.id === e.zoneId)) e.zoneId = undefined
  }
  pruneGroups()
  selectedIds.value = []
  historyPush()
  const skipped = total - ids.size
  flash(skipped ? `已删除 ${ids.size} 个元素，${skipped} 个已锁定跳过` : '已删除选中元素')
}

function onElementsChange(els: BaseElement[]): void {
  if (!draft.value) return
  for (const el of els) {
    const idx = draft.value.elements.findIndex((e) => e.id === el.id)
    if (idx < 0) continue
    const cur = draft.value.elements[idx]
    // 尺寸变化时同步重排座位：座位槽是按桌框尺寸推导的，不重排会出现「桌面缩小但座位溢出」
    if (isSeatingElement(cur) && isSeatingElement(el) && (cur.w !== el.w || cur.h !== el.h)) {
      reflowSeats(el)
    }
    draft.value.elements[idx] = el
  }
}

// ---------- 复制 / 粘贴 ----------
const clipboard = ref<BaseElement[]>([])

function copySelected(): void {
  if (!selectedEls.value.length) return
  clipboard.value = clone(selectedEls.value)
  flash(`已复制 ${selectedEls.value.length} 个元素`)
}

function pasteClipboard(offset = 20): void {
  if (!draft.value || !clipboard.value.length) return
  const created: string[] = []
  // 分组随元素一起复制：粘贴后得到同名「副本」分组，而不是混进原分组
  const groupRemap = new Map<string, string>()
  for (const src of clipboard.value) {
    const copy = clone(src)
    copy.id = uid(copy.type)
    copy.x += offset
    copy.y += offset
    if (copy.groupId) {
      const origin = draft.value.groups?.find((g) => g.id === copy.groupId)
      if (!origin) {
        delete copy.groupId
      } else {
        let nextId = groupRemap.get(origin.id)
        if (!nextId) {
          nextId = uid('group')
          groupRemap.set(origin.id, nextId)
          draft.value.groups = [...(draft.value.groups ?? []), { id: nextId, name: `${origin.name} 副本` }]
        }
        copy.groupId = nextId
      }
    }
    if (isSeatingElement(copy)) copy.seats = copy.seats.map((s) => ({ ...s, id: uid('seat') }))
    if (copy.type === 'zone') {
      const z: ZoneDef = { id: copy.id, name: (src as any).name ? `${(src as any).name} 副本` : `区域 ${draft.value.zones.length + 1}`, color: draft.value.zones.find((x) => x.id === src.id)?.color ?? '#EEF2F4', ruleTag: 'other' }
      draft.value.zones.push(z)
      ;(copy as any).name = z.name
    }
    copy.z = draft.value.elements.length
    // 粘贴的副本不继承原格子（否则会占同一格），按新位置就近找空位
    if (draft.value.grid && copy.cell) delete copy.cell
    draft.value.elements.push(copy)
    if (draft.value.grid) {
      const c = cellFromPoint(draft.value.grid, copy.x + copy.w / 2, copy.y + copy.h / 2)
      putElementInCell(draft.value, copy, c.row, c.col)
      if (isSeatingElement(copy)) reflowSeats(copy)
    }
    created.push(copy.id)
  }
  selectedIds.value = created
  historyPush()
  flash(`已粘贴 ${created.length} 个元素`)
}

function duplicateSelected(): void {
  copySelected()
  pasteClipboard()
}

// ---------- 层级 ----------
function reindexZ(): void {
  if (!draft.value) return
  draft.value.elements.forEach((e, i) => { e.z = i })
}

function onLayerAction(action: 'front' | 'up' | 'down' | 'back'): void {
  if (action === 'front') bringToFront()
  else if (action === 'up') moveForward()
  else if (action === 'down') moveBackward()
  else sendToBack()
}

function bringToFront(): void {
  if (!draft.value || !selectedIds.value.length) return
  const ids = new Set(selectedIds.value)
  const sel = draft.value.elements.filter((e) => ids.has(e.id))
  const rest = draft.value.elements.filter((e) => !ids.has(e.id))
  draft.value.elements = [...rest, ...sel]
  reindexZ()
  historyPush()
}

function sendToBack(): void {
  if (!draft.value || !selectedIds.value.length) return
  const ids = new Set(selectedIds.value)
  const sel = draft.value.elements.filter((e) => ids.has(e.id))
  const rest = draft.value.elements.filter((e) => !ids.has(e.id))
  draft.value.elements = [...sel, ...rest]
  reindexZ()
  historyPush()
}

function moveForward(): void {
  if (!draft.value || !selectedIds.value.length) return
  const ids = new Set(selectedIds.value)
  for (let i = draft.value.elements.length - 2; i >= 0; i--) {
    if (ids.has(draft.value.elements[i].id) && !ids.has(draft.value.elements[i + 1].id)) {
      const tmp = draft.value.elements[i]
      draft.value.elements[i] = draft.value.elements[i + 1]
      draft.value.elements[i + 1] = tmp
    }
  }
  reindexZ()
  historyPush()
}

function moveBackward(): void {
  if (!draft.value || !selectedIds.value.length) return
  const ids = new Set(selectedIds.value)
  for (let i = 1; i < draft.value.elements.length; i++) {
    if (ids.has(draft.value.elements[i].id) && !ids.has(draft.value.elements[i - 1].id)) {
      const tmp = draft.value.elements[i]
      draft.value.elements[i] = draft.value.elements[i - 1]
      draft.value.elements[i - 1] = tmp
    }
  }
  reindexZ()
  historyPush()
}

// ---------- 对齐与分布 ----------
const canAlign = computed(() => selectedEls.value.length >= 2)
const canDistribute = computed(() => selectedEls.value.length >= 3)

function applyAlign(key: AlignKey): void {
  alignElements(selectedEls.value.filter((e) => !elLocked(e)), key)
  historyPush()
}

function distribute(axis: 'h' | 'v'): void {
  distributeElements(selectedEls.value.filter((e) => !elLocked(e)), axis)
  historyPush()
}

// ---------- 属性 ----------
function applyTextChange(elementId: string, text: string): void {
  if (!draft.value) return
  const el = draft.value.elements.find((e) => e.id === elementId)
  if (!el) return
  el.text = text
  if (el.type === 'zone') {
    const z = draft.value.zones.find((x) => x.id === el.id)
    if (z) z.name = text || '未命名区域'
  }
  historyPush()
}

function setLockSelected(locked: boolean): void {
  for (const el of selectedEls.value) el.locked = locked
  historyPush()
}

function toggleSeat(elementId: string, seatId: string): void {
  if (!draft.value) return
  const el = draft.value.elements.find((e) => e.id === elementId)
  if (!el || !isSeatingElement(el)) return
  const seat = el.seats.find((s) => s.id === seatId)
  if (!seat) return
  seat.disabled = !seat.disabled
  historyPush()
}

// ---------- 区域 ----------
const zoneOpen = ref(false)
const zoneEditingId = ref<string | null>(null)
const zoneForm = ref({ name: '', color: ZONE_COLORS[0], ruleTag: 'other' })

function openZoneAdd(): void {
  if (!draft.value) return
  zoneEditingId.value = null
  zoneForm.value = { name: `区域 ${draft.value.zones.length + 1}`, color: ZONE_COLORS[0], ruleTag: 'other' }
  zoneOpen.value = true
}

function openZoneEdit(z: ZoneDef): void {
  zoneEditingId.value = z.id
  zoneForm.value = { name: z.name, color: z.color, ruleTag: z.ruleTag ?? 'other' }
  zoneOpen.value = true
}

function submitZone(): void {
  if (!draft.value) return
  const name = zoneForm.value.name.trim()
  if (!name) { flash('请填写区域名称'); return }
  const color = zoneForm.value.color
  const ruleTag = zoneForm.value.ruleTag as ZoneDef['ruleTag']
  if (zoneEditingId.value) {
    const z = draft.value.zones.find((x) => x.id === zoneEditingId.value)
    if (z) Object.assign(z, { name, color, ruleTag })
    const el = draft.value.elements.find((e) => e.id === zoneEditingId.value)
    if (el) {
      ;(el as any).name = name
      el.style = { ...(el.style ?? {}), fill: color }
    }
    flash('区域已更新')
  } else {
    const z: ZoneDef = { id: uid('zone'), name, color, ruleTag }
    draft.value.zones.push(z)
    const el = makePlain('zone', 120 + (draft.value.elements.length % 5) * 18, 480, 300, 220)
    el.id = z.id
    el.z = draft.value.elements.length
    el.style = { fill: color, stroke: '#DCE1E6', radius: 8, opacity: 0.65 }
    ;(el as any).name = name
    draft.value.elements.push(el)
    selectedIds.value = [el.id]
    flash('区域已创建，可在画布上调整范围')
  }
  zoneOpen.value = false
  historyPush()
}

const confirmState = ref<{ open: boolean; title: string; desc: string; action: () => void }>({
  open: false, title: '', desc: '', action: () => {}
})

function ask(title: string, desc: string, action: () => void): void {
  confirmState.value = { open: true, title, desc, action }
}

function runConfirm(): void {
  confirmState.value.action()
  confirmState.value.open = false
}

function askDeleteZone(z: ZoneDef): void {
  if (!draft.value) return
  const count = draft.value.elements.filter((e) => isSeatingElement(e) && e.zoneId === z.id).length
  if (count > 0) { flash(`该区域下还有 ${count} 张桌，请先调整这些桌的区域`); return }
  ask('删除区域', `「${z.name}」及对应的画布区域将被移除。`, () => {
    if (!draft.value) return
    draft.value.zones = draft.value.zones.filter((x) => x.id !== z.id)
    draft.value.elements = draft.value.elements.filter((e) => !(e.type === 'zone' && e.id === z.id))
    selectedIds.value = selectedIds.value.filter((id) => id !== z.id)
    historyPush()
    flash('区域已删除')
  })
}

// ---------- 批量生成 ----------
const genOpen = ref(false)

function openGenerate(): void {
  genOpen.value = true
}

/** 生成参数由 GenerateDialog 计算好，页面只负责建元素、自动分组与历史记录 */
function onGenerate(opts: GenOptions): void {
  if (!draft.value) return
  const baseZ = draft.value.elements.length
  const total = opts.rows * opts.blocks.reduce((a, b) => a + b, 0)
  const group: LayerGroup = { id: uid('group'), name: `批量 ${opts.rows} 排 · ${total} 桌` }
  draft.value.groups = [...(draft.value.groups ?? []), group]
  // 每块的起始列偏移：块内按 gapX 连续，块间用 blockGap 留出纵向过道
  const colOffsets: number[] = []
  let acc = 0
  for (const cols of opts.blocks) {
    colOffsets.push(acc)
    acc += cols * (opts.w + opts.gapX) - opts.gapX + opts.blockGap
  }
  let created = 0
  let gridCol = 0
  const createdIds: string[] = []
  for (let r = 0; r < opts.rows; r++) {
    const y = opts.startY + r * (opts.h + opts.gapY)
    for (let b = 0; b < opts.blocks.length; b++) {
      for (let c = 0; c < opts.blocks[b]; c++) {
        const x = opts.startX + colOffsets[b] + c * (opts.w + opts.gapX)
        const el = makeTable(x, y, opts.w, opts.h, opts.capacity)
        el.zoneId = opts.zoneId || undefined
        el.groupId = group.id
        el.label = `${r + 1} 排`
        el.z = baseZ + created
        // 有网格时按「第几排第几列」直接写格子号，不靠坐标反推
        if (draft.value.grid) el.cell = { row: Math.min(r, draft.value.grid.rows - 1), col: Math.min(gridCol, draft.value.grid.cols - 1) }
        draft.value.elements.push(el)
        createdIds.push(el.id)
        created++
        gridCol++
      }
    }
  }
  if (draft.value.grid) {
    for (const id of createdIds) {
      const el = draft.value.elements.find((e) => e.id === id)!
      const ok = putElementInCell(draft.value, el, el.cell!.row, el.cell!.col)
      if (!ok) delete el.cell
    }
    applyGridGeometry(draft.value)
    reflowGridSeats()
  }
  expandCanvasToContent(64)
  selectedIds.value = createdIds
  activeTab.value = 'canvas'
  fitToViewport()
  historyPush()
  flash(`已生成 ${created} 张桌，共 ${created * opts.capacity} 个座位，并归入分组「${group.name}」`)
}

// ---------- 网格 ----------
const gridOpen = ref(false)
const gridLabel = computed(() => {
  const g = draft.value?.grid
  return g ? `网格 ${g.rows}×${g.cols}` : ''
})

/** 网格改变了几何后，座位槽要跟着桌框重排（保留已有座位 id） */
function reflowGridSeats(): void {
  if (!draft.value) return
  for (const el of draft.value.elements) {
    if (isSeatingElement(el) && el.cell) reflowSeats(el)
  }
}

function onCreateGrid(opts: Parameters<typeof createGrid>[0] & { autoPlace: boolean }): void {
  if (!draft.value) return
  draft.value.grid = createGrid(opts)
  if (opts.autoPlace) autoPlaceFreeElements(draft.value)
  applyGridGeometry(draft.value)
  reflowGridSeats()
  expandCanvasToContent(64)
  fitToViewport()
  historyPush()
  flash(`已生成 ${opts.rows}×${opts.cols} 网格，排/列号由格子决定`)
}

function onUpdateGrid(opts: Parameters<typeof createGrid>[0]): void {
  if (!draft.value) return
  const old = draft.value.grid
  const next = createGrid(opts)
  // 只改内边距/起点时，保留逐列、逐行手工调过的尺寸
  if (old && old.cols === next.cols && old.colWidth === next.colWidth) next.colWidths = [...(old.colWidths ?? [])]
  if (old && old.rows === next.rows && old.rowHeight === next.rowHeight) next.rowHeights = [...(old.rowHeights ?? [])]
  draft.value.grid = next
  applyGridGeometry(draft.value)
  reflowGridSeats()
  expandCanvasToContent(64)
  fitToViewport()
  historyPush()
  flash('网格参数已更新，入格元素已重新落位')
}

function onApplyGrid(): void {
  if (!draft.value?.grid) return
  const n = autoPlaceFreeElements(draft.value)
  applyGridGeometry(draft.value)
  reflowGridSeats()
  expandCanvasToContent(64)
  historyPush()
  flash(n ? `已把 ${n} 个元素套进网格` : '所选元素都已在网格内')
}

function onClearGrid(): void {
  if (!draft.value?.grid) return
  clearGrid(draft.value)
  historyPush()
  flash('已解除网格：元素保留当前位置，恢复自由布局')
}

function onElementCell(p: {
  id: string
  row: number
  col: number
  rowSpan: number
  colSpan: number
  align: BaseElement['align']
  pad: number
}): void {
  if (!draft.value?.grid) return
  const el = draft.value.elements.find((e) => e.id === p.id)
  if (!el) return
  el.align = p.align
  el.pad = p.pad
  if (!putElementInCell(draft.value, el, p.row, p.col, { rowSpan: p.rowSpan, colSpan: p.colSpan })) {
    flash('目标格子放不下：可能已被占用或超出网格范围')
    return
  }
  if (isSeatingElement(el)) reflowSeats(el)
  expandCanvasToContent(64)
  historyPush()
  flash(`已放入第 ${el.cell!.row + 1} 排 · 第 ${el.cell!.col + 1} 列`)
}

function onDetachCell(id: string): void {
  if (!draft.value) return
  const el = draft.value.elements.find((e) => e.id === id)
  if (!el) return
  detachElement(el)
  syncMerges(draft.value)
  historyPush()
  flash('已移出网格：该元素按坐标参与排座，座位图会标为游离')
}

// ---------- 右键菜单 ----------
type CtxMode = 'element' | 'blank'
const ctx = ref<{ open: boolean; x: number; y: number; mode: CtxMode; elementId: string; seatId?: string }>({
  open: false, x: 0, y: 0, mode: 'element', elementId: ''
})
const tabItems = computed(() => [
  { key: 'canvas', label: '画布' },
  { key: 'props', label: '属性', badge: selectedIds.value.length || undefined },
  { key: 'zones', label: '区域', badge: draft.value?.zones.length || undefined }
])
const ctxEl = computed(() => draft.value?.elements.find((e) => e.id === ctx.value.elementId) ?? null)
const ctxSeatEl = computed<SeatingElement | null>(() => (ctxEl.value && isSeatingElement(ctxEl.value) ? ctxEl.value : null))
const ctxSeat = computed<Seat | null>(() => ctxSeatEl.value?.seats.find((s) => s.id === ctx.value.seatId) ?? null)
const ctxAllLocked = computed(() => selectedEls.value.length > 0 && selectedEls.value.every((e) => elLocked(e)))

function onContextMenu(payload: { x: number; y: number; elementId: string; seatId?: string }): void {
  ctx.value = { open: true, x: payload.x, y: payload.y, mode: 'element', elementId: payload.elementId, seatId: payload.seatId }
}

/** 画布空白处右键：只处理真正空白（元素/浮层之外的区域） */
function onBlankContext(e: MouseEvent): void {
  const t = e.target as HTMLElement | null
  if (!t) return
  if (t.closest('.el') || t.closest('.ui-menu') || t.closest('.ui-dropdown-panel') || t.closest('.ui-select-panel')) return
  e.preventDefault()
  ctx.value = { open: true, x: e.clientX, y: e.clientY, mode: 'blank', elementId: '' }
}

function closeCtx(): void {
  ctx.value.open = false
}

function ctxToggleSeat(): void {
  if (!ctxEl.value || !ctx.value.seatId) return
  toggleSeat(ctxEl.value.id, ctx.value.seatId)
}

function ctxAllSeats(disabled: boolean): void {
  const el = ctxSeatEl.value
  if (!el) return
  for (const s of el.seats) s.disabled = disabled
  historyPush()
}

function ctxSetCapacity(v: 1 | 2): void {
  const el = ctxSeatEl.value
  if (!el) return
  el.capacity = v
  reflowSeats(el)
  historyPush()
}

// ---------- 画布内容 ----------
const inspectorOpen = ref(true)

/** 画布内容的外接范围（含超出画布的元素） */







/** 画布内容的外接范围（含超出画布的元素） */
function contentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!draft.value?.elements.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of draft.value.elements) {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.w)
    maxY = Math.max(maxY, el.y + el.h)
  }
  return { minX, minY, maxX, maxY }
}

/** 内容超出画布时把画布扩到刚好容纳，避免桌子跑到画布外面 */
function expandCanvasToContent(pad = 48): boolean {
  if (!draft.value) return false
  const b = contentBounds()
  if (!b) return false
  const left = Math.max(0, Math.min(0, b.minX - pad))
  const top = Math.max(0, Math.min(0, b.minY - pad))
  if (left || top) {
    for (const el of draft.value.elements) {
      el.x -= left
      el.y -= top
    }
  }
  const needW = Math.ceil((b.maxX - left) + pad)
  const needH = Math.ceil((b.maxY - top) + pad)
  let changed = false
  if (needW > draft.value.canvas.width) { draft.value.canvas.width = needW; changed = true }
  if (needH > draft.value.canvas.height) { draft.value.canvas.height = needH; changed = true }
  return changed || left > 0 || top > 0
}



function tidyCanvas(): void {
  const changed = expandCanvasToContent()
  fitToViewport()
  if (changed) historyPush()
  flash(changed ? '画布已扩展并适配到全部元素' : '画布已适应当前窗口')
}



/** 点击画布空白（画布外的灰底也算）取消选择 */
function onViewportDown(e: MouseEvent): void {
  if (e.button !== 0 || spaceDown.value || e.shiftKey || e.metaKey || e.ctrlKey) return
  const target = e.target as HTMLElement
  if (target.closest('.el') || target.closest('.zoom-bar') || target.closest('.inspector')) return
  if (selectedIds.value.length) selectedIds.value = []
}



// ---------- 键盘 ----------
let nudgeTimer = 0

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

function hasPopupOpen(): boolean {
  return !!document.querySelector('.ui-dropdown-panel, .ui-select-panel, .ui-menu')
}

function onKeyDown(e: KeyboardEvent): void {
  if (anyModalOpen.value) return
  // 任何浮层打开时，画布快捷键一律让位，避免误删/误全选
  if (hasPopupOpen()) return
  if (e.code === 'Space' && !isTyping(e)) {
    spaceDown.value = true
    e.preventDefault()
    return
  }
  if (isTyping(e)) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return }
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectAllElements()
    return
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedIds.value.length) {
      e.preventDefault()
      deleteSelected()
    }
    return
  }
  if (e.key === 'Escape') {
    closeCtx()
    selectedIds.value = []
    return
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selectedIds.value.length) {
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    for (const el of selectedEls.value) {
      if (elLocked(el)) continue
      if (e.key === 'ArrowLeft') el.x -= step
      if (e.key === 'ArrowRight') el.x += step
      if (e.key === 'ArrowUp') el.y -= step
      if (e.key === 'ArrowDown') el.y += step
    }
    window.clearTimeout(nudgeTimer)
    nudgeTimer = window.setTimeout(() => historyPush(), 400)
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') spaceDown.value = false
}

// ---------- 导入导出 ----------
function exportLayout(): void {
  if (!draft.value) return
  const blob = new Blob([JSON.stringify(draft.value, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${draft.value.name.replace(/\s+/g, '-')}.seatlayout.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

const fileInput = ref<HTMLInputElement | null>(null)

async function onFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !draft.value) return
  try {
    const text = await file.text()
    const data = JSON.parse(text) as LayoutPackage
    if (!data || !Array.isArray(data.elements) || !data.canvas) throw new Error('bad layout')
    const copy = clone(data)
    normalizeLayout(copy)
    draft.value.elements = copy.elements
    draft.value.zones = copy.zones
    draft.value.groups = copy.groups ?? []
    draft.value.canvas = copy.canvas
    if (copy.grid) draft.value.grid = copy.grid
    else delete draft.value.grid
    if (copy.name) draft.value.name = copy.name
    selectedIds.value = []
    resetHistory()
    flash('布局包已导入，记得保存')
  } catch {
    flash('导入失败：不是有效的布局包 JSON')
  }
  input.value = ''
}

// ---------- 模态框状态 ----------
const anyModalOpen = computed(() =>
  renameOpen.value || createOpen.value || genOpen.value || gridOpen.value || zoneOpen.value || confirmState.value.open
)

// ---------- 生命周期 ----------
let ro: ResizeObserver | null = null

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  if (viewport.value) {
    syncViewportMetrics()
    ro = new ResizeObserver(syncViewportMetrics)
    ro.observe(viewport.value)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.clearTimeout(nudgeTimer)
  ro?.disconnect()
  unbindPan()
})
</script>

<template>
  <header class="page-head compact">
    <div class="page-head-main">
      <div class="page-eyebrow">会场布局</div>
      <div class="title-row">
        <h1 class="page-title">{{ draft?.name ?? '布局包' }}</h1>
        <span v-if="dirty" class="save-dot">未保存</span>
      </div>
      <p class="page-desc">框选多选 · 吸附对齐 · 缩放平移 · 撤销重做。双击元素改文字，双击座位标记空位。</p>
    </div>
    <div class="head-actions">
      <div style="width: 168px">
        <UiSelect v-model="selectedId" :options="layoutOptions" placeholder="选择布局" size="sm" />
      </div>
      <UiButton size="sm" icon="edit" title="重命名布局" @click="openRename">重命名</UiButton>
      <UiButton size="sm" icon="plus" title="新建布局" @click="openCreate">新建</UiButton>
      <UiButton size="sm" icon="import" title="导入布局 JSON" @click="fileInput?.click()">导入</UiButton>
      <UiButton size="sm" icon="export" title="导出布局 JSON" @click="exportLayout">导出</UiButton>
      <UiIconButton
        icon="trash"
        title="删除布局"
        danger
        @click="draft && ask('删除布局', `「${draft.name}」将被删除。`, async () => { await removeLayout(draft!.id); flash('布局已删除') })"
      />
      <UiButton variant="primary" size="sm" icon="save" :disabled="!dirty" @click="save">
        {{ dirty ? '保存布局' : '已保存' }}
      </UiButton>
      <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile" />
    </div>
  </header>

  <div v-if="!draft" class="empty">还没有布局，点「新建布局」开始。</div>

  <template v-else>
    <div class="editor-shell">
      <section class="canvas-card">
        <LayoutToolbar
          :element-count="draft.elements.length"
          :seat-count="seatCount"
          :disabled-count="disabledCount"
          :selected-count="selectedIds.length"
          :can-align="canAlign"
          :can-distribute="canDistribute"
          :can-undo="hIndex > 0"
          :can-redo="hIndex < history.length - 1"
          :has-clipboard="!!clipboard.length"
          :grid-label="gridLabel"
          @grid="gridOpen = true"
          @add="addElement"
          @add-shape="addShape"
          @undo="undo"
          @redo="redo"
          @copy="copySelected"
          @paste="pasteClipboard()"
          @duplicate="duplicateSelected"
          @delete="deleteSelected"
          @tidy="tidyCanvas"
          @generate="openGenerate"
          @align="applyAlign"
          @distribute="distribute"
          @layer="onLayerAction"
        />

        <div class="canvas-area" :class="{ 'with-inspector': inspectorOpen }">
          <div
            ref="viewport"
            class="canvas-viewport"
            :class="{ 'pan-ready': spaceDown, panning }"
            @mousedown.capture="maybePan"
            @mousedown="onViewportDown"
            @contextmenu.prevent="onBlankContext"
            @wheel="onWheel"
          >
            <div class="canvas-sizer" :style="{ width: sizerSize.w + 'px', height: sizerSize.h + 'px' }">
              <div class="canvas-scale" :style="{ width: draft.canvas.width + 'px', height: draft.canvas.height + 'px', left: stageOffset.x + 'px', top: stageOffset.y + 'px', transform: `scale(${scale})` }">
                <ElementCanvas
                  :layout="draft"
                  editable
                  :scale="scale"
                  :selected-ids="selectedIds"
                  :pan-mode="spaceDown"
                  @select="selectedIds = $event"
                  @elements-change="onElementsChange"
                  @commit="historyPush"
                  @context-menu="onContextMenu"
                  @toggle-seat="toggleSeat"
                  @text-change="applyTextChange"
                />
              </div>
            </div>
          </div>

          <div class="canvas-status">
            <span v-if="selectedIds.length">已选 {{ selectedIds.length }} 个元素</span>
            <span v-else>未选中 · 点击空白取消选择</span>
            <span class="hide-sm">Shift 加选 · 空格拖拽平移 · Ctrl 滚轮缩放</span>
          </div>

          <div class="zoom-bar">
            <UiIconButton icon="minus" :icon-size="13" title="缩小" @click="zoomBy(-1)" />
            <button class="zoom-label mono" title="适应窗口" @click="fitToViewport()">{{ zoomLabel }}</button>
            <UiIconButton icon="plus" :icon-size="13" title="放大" @click="zoomBy(1)" />
            <div class="tb-sep" />
            <UiIconButton icon="fit" title="适应窗口" @click="fitToViewport()" />
            <UiIconButton icon="expand" title="画布随内容扩展" @click="tidyCanvas" />
          </div>

          <button v-if="!inspectorOpen" class="insp-reopen" @click="inspectorOpen = true">
            <UiIcon name="sliders" />面板
          </button>

          <InspectorPanel
            :layout="draft"
            :active-tab="activeTab"
            :selected-ids="selectedIds"
            :open="inspectorOpen"
            @update:active-tab="activeTab = $event"
            @commit="historyPush"
            @select="selectedIds = $event"
            @create-group="createGroupFromSelection"
            @rename-group="renameGroupById"
            @toggle-lock="toggleGroupLockById"
            @toggle-collapse="toggleGroupCollapseById"
            @ungroup="ungroupById"
            @tidy="tidyCanvas"
            @layer="onLayerAction"
            @align="applyAlign"
            @distribute="distribute"
            @zone-add="openZoneAdd"
            @zone-edit="openZoneEdit"
            @zone-delete="askDeleteZone"
            @collapse="inspectorOpen = false"
          />
        </div>
      </section>
    </div>
  </template>

  <!-- 右键菜单 -->
  <UiContextMenu
    :open="ctx.open"
    :x="ctx.x"
    :y="ctx.y"
    :min-width="ctx.mode === 'blank' ? 216 : 196"
    @close="closeCtx"
  >
    <template #default="{ close }">
      <!-- 画布空白处 -->
      <template v-if="ctx.mode === 'blank'">
        <div class="ui-menu-label">添加元素</div>
        <div class="ui-menu-grid">
          <UiMenuItem
            v-for="item in ADD_ITEMS"
            :key="item.key"
            :icon="item.icon"
            :label="item.label"
            @click="close(); addElement(item.key)"
          />
        </div>
        <div class="ui-menu-sep" />
        <UiMenuItem icon="paste" label="粘贴" shortcut="Ctrl V" :disabled="!clipboard.length" @click="close(); pasteClipboard()" />
        <UiMenuItem icon="selectAll" label="全选" shortcut="Ctrl A" @click="close(); selectAllElements()" />
        <UiMenuItem icon="cursor" label="取消选择" shortcut="Esc" :disabled="!selectedIds.length" @click="close(); selectedIds = []" />
        <div class="ui-menu-sep" />
        <UiMenuItem icon="fit" label="适应画布" @click="close(); fitToViewport()" />
        <UiMenuItem icon="expand" label="整理画布" @click="close(); tidyCanvas()" />
        <div class="ui-menu-sep" />
        <UiMenuItem icon="grid" label="批量生成桌子…" @click="close(); openGenerate()" />
        <UiMenuItem icon="sliders" label="画布设置" @click="close(); activeTab = 'canvas'; inspectorOpen = true" />
      </template>

      <!-- 元素 -->
      <template v-else>
        <template v-if="ctxSeat">
          <div class="ui-menu-label">座位</div>
          <UiMenuItem :icon="ctxSeat.disabled ? 'unlock' : 'lock'" :label="ctxSeat.disabled ? '恢复该座位可用' : '标记该座位为空位'" @click="close(); ctxToggleSeat()" />
          <UiMenuItem icon="lock" label="整桌设为不可用" @click="close(); ctxAllSeats(true)" />
          <UiMenuItem icon="unlock" label="整桌恢复可用" @click="close(); ctxAllSeats(false)" />
          <div class="ui-menu-sep" />
        </template>
        <template v-if="ctxSeatEl">
          <div class="ui-menu-label">容量</div>
          <UiMenuItem label="单人位" :checked="ctxSeatEl.capacity === 1" @click="close(); ctxSetCapacity(1)" />
          <UiMenuItem label="双人位" :checked="ctxSeatEl.capacity === 2" @click="close(); ctxSetCapacity(2)" />
          <div class="ui-menu-sep" />
        </template>
        <div class="ui-menu-label">元素</div>
        <UiMenuItem icon="copy" label="复制" shortcut="Ctrl C" @click="close(); copySelected()" />
        <UiMenuItem icon="paste" label="粘贴" shortcut="Ctrl V" :disabled="!clipboard.length" @click="close(); pasteClipboard()" />
        <UiMenuItem icon="duplicate" label="创建副本" shortcut="Ctrl D" @click="close(); duplicateSelected()" />
        <UiMenuItem icon="trash" label="删除" shortcut="Del" danger @click="close(); deleteSelected()" />
        <div class="ui-menu-sep" />
        <div class="ui-menu-label">层级</div>
        <UiMenuItem icon="front" label="置于顶层" @click="close(); bringToFront()" />
        <UiMenuItem icon="up" label="上移一层" @click="close(); moveForward()" />
        <UiMenuItem icon="down" label="下移一层" @click="close(); moveBackward()" />
        <UiMenuItem icon="back" label="置于底层" @click="close(); sendToBack()" />
        <div class="ui-menu-sep" />
        <UiMenuItem v-if="!ctxAllLocked" icon="lock" label="锁定所选元素" @click="close(); setLockSelected(true)" />
        <UiMenuItem v-else icon="unlock" label="解锁所选元素" @click="close(); setLockSelected(false)" />
      </template>
    </template>
  </UiContextMenu>

  <!-- 重命名 -->
  <UiModal v-model="renameOpen" title="重命名布局" description="名称用于在排座项目中选择引用">
    <div class="field">
      <label>布局名称</label>
      <input v-model="renameValue" class="input" @keyup.enter="confirmRename" />
    </div>
    <template #footer>
      <button class="btn" @click="renameOpen = false">取消</button>
      <button class="btn primary" @click="confirmRename">保存名称</button>
    </template>
  </UiModal>

  <!-- 新建 -->
  <UiModal v-model="createOpen" title="新建布局" description="将创建一块空白画布，含讲台与一条主席台">
    <div class="field">
      <label>布局名称</label>
      <input v-model="createName" class="input" @keyup.enter="confirmCreate" />
    </div>
    <template #footer>
      <button class="btn" @click="createOpen = false">取消</button>
      <button class="btn primary" @click="confirmCreate">创建布局</button>
    </template>
  </UiModal>

  <!-- 批量生成 -->
  <GenerateDialog
    v-model="genOpen"
    :canvas-w="draft?.canvas.width ?? 1200"
    :canvas-h="draft?.canvas.height ?? 800"
    :zones="zoneOptions"
    @generate="onGenerate"
  />

  <!-- 布局网格 -->
  <GridDialog
    v-model="gridOpen"
    :grid="draft?.grid"
    :selection="selectedEls"
    @create="onCreateGrid"
    @update="onUpdateGrid"
    @apply="onApplyGrid"
    @clear="onClearGrid"
    @cell="onElementCell"
    @detach="onDetachCell"
  />

  <!-- 区域新增/编辑 -->
  <UiModal v-model="zoneOpen" :title="zoneEditingId ? '编辑区域' : '新增区域'" description="区域颜色用于画布标识，规则标签会影响排座">
    <div class="field">
      <label>区域名称</label>
      <input v-model="zoneForm.name" class="input" @keyup.enter="submitZone" />
    </div>
    <div class="field">
      <label>区域颜色</label>
      <div class="swatch-row">
        <button v-for="c in ZONE_COLORS" :key="c" class="swatch" :class="{ on: zoneForm.color === c }" :style="{ background: c }" @click="zoneForm.color = c" />
      </div>
    </div>
    <div class="field">
      <label>规则标签</label>
      <UiSelect v-model="zoneForm.ruleTag" :options="RULE_TAG_OPTIONS" />
    </div>
    <template #footer>
      <button class="btn" @click="zoneOpen = false">取消</button>
      <button class="btn primary" @click="submitZone">{{ zoneEditingId ? '保存修改' : '创建区域' }}</button>
    </template>
  </UiModal>

  <!-- 确认 -->
  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">确认删除</button>
    </template>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
