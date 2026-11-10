<script setup lang="ts">
/**
 * 排座图：复用布局页 SheetGrid 的网格几何（行列头、合并块、斜纹、缩放），
 * 只在其上叠加就座状态（姓名、职级、单位、锁定/请假）。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { LayoutPackage, RuleSet } from '../types'
import { seatOrderMap } from '../engine/seating'
import { seatsOfSheet } from '../engine/sheet'
import SheetGrid from './sheet/SheetGrid.vue'

type CardInfo = {
  name: string
  rankName: string
  unitName: string
  duty?: string
  color: string
  status: string
  locked: boolean
}

const props = defineProps<{
  layout: LayoutPackage
  rules: RuleSet
  seatInfo: Record<string, CardInfo>
  selectedSeatId?: string | null
  /** 换座完成后短暂高亮的两个座位 */
  highlightSeatIds?: string[]
  /** 名单点选后定位高亮 */
  focusSeatId?: string | null
  /** 是否显示左上角座位序号（与导出开关一致） */
  showSeatNumbers?: boolean
  /** 座位下方信息：职级 */
  showRank?: boolean
  /** 座位下方信息：职务 */
  showDuty?: boolean
  /** 座位下方信息：单位 */
  showUnit?: boolean
  /** 批量容量模式：点击座位改为选中其所在桌 */
  capacityMode?: boolean
  /** 批量容量模式下已选中的桌（"行:列"） */
  selectedCells?: string[]
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string, el: HTMLElement, row: number, col: number): void
  (e: 'swap', from: string, to: string): void
  (e: 'cellPick', cellKey: string): void
  (e: 'cellSelect', keys: string[], append: boolean): void
}>()

const gridRef = ref<InstanceType<typeof SheetGrid> | null>(null)
const rootRef = ref<HTMLElement | null>(null)
const orderMap = computed(() => seatOrderMap(props.layout, props.rules))
const emptySel = { r1: 0, c1: 0, r2: 0, c2: 0 }
const emptyActive = { row: 0, col: 0 }
const dragFrom = ref('')
const dragOver = ref('')
/** 缺省视为显示，兼容没有该字段的旧项目 */
const showNos = computed(() => props.showSeatNumbers !== false)
/** 职级缺省显示；职务、单位缺省关闭，由用户自选 */
const showRank = computed(() => props.showRank !== false)
const showDuty = computed(() => props.showDuty === true)
const showUnit = computed(() => props.showUnit === true)

function noOf(seatId: string, fallback: number): number {
  return orderMap.value.get(seatId) ?? fallback
}

function seatTitle(row: number, stage: boolean, no: number, info?: CardInfo): string {
  const where = stage ? '主席台' : `第 ${row + 1} 排`
  const parts = [`${where} · ${no} 号`]
  if (info) {
    parts.push(info.name)
    parts.push([info.rankName, info.unitName].filter(Boolean).join(' · '))
  } else {
    parts.push('空位')
  }
  return parts.filter(Boolean).join(' · ')
}

function onPick(seatId: string, e: MouseEvent, row: number, col: number): void {
  if (props.capacityMode) {
    emit('cellPick', `${row}:${col}`)
    return
  }
  emit('pick', seatId, e.currentTarget as HTMLElement, row, col)
}

function onDragStart(seatId: string, e: DragEvent): void {
  dragFrom.value = seatId
  e.dataTransfer?.setData('text/plain', seatId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnter(seatId: string): void {
  if (dragFrom.value && dragFrom.value !== seatId) dragOver.value = seatId
}

function onDragEnd(): void {
  dragFrom.value = ''
  dragOver.value = ''
}

function onDrop(to: string): void {
  const from = dragFrom.value
  dragFrom.value = ''
  dragOver.value = ''
  if (!from || from === to) return
  emit('swap', from, to)
}

/** 与布局页同一套缩放：窗口自适应 */
function fitBoard(): void {
  gridRef.value?.fitToWindow()
}

// ---------- 批量容量：空白处框选 ----------
/** 选框用视口坐标绘制在面板根节点上，不受缩放层影响 */
const marquee = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const marqueeing = ref(false)
let startClient = { x: 0, y: 0 }
let startSheet = { x: 0, y: 0 }
let moved = false
let rootBox = { left: 0, top: 0 }

/** 每一格（合并区按锚点）覆盖的座位几何范围，用于与选框求交 */
const cellRects = computed(() => {
  const map = new Map<string, { x1: number; y1: number; x2: number; y2: number }>()
  for (const s of seatsOfSheet(props.layout.sheet)) {
    const k = `${s.row}:${s.col}`
    const cur = map.get(k)
    if (!cur) {
      map.set(k, { x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y + s.h })
      continue
    }
    cur.x1 = Math.min(cur.x1, s.x)
    cur.y1 = Math.min(cur.y1, s.y)
    cur.x2 = Math.max(cur.x2, s.x + s.w)
    cur.y2 = Math.max(cur.y2, s.y + s.h)
  }
  return map
})

/** 视口坐标 → 工作表坐标：用缩放层的实际包围盒换算，滚动/缩放后依旧对位 */
function sheetPoint(clientX: number, clientY: number): { x: number; y: number } {
  const inner = rootRef.value?.querySelector('.sg-inner') as HTMLElement | null
  if (!inner) return { x: 0, y: 0 }
  const r = inner.getBoundingClientRect()
  const scale = inner.offsetWidth ? r.width / inner.offsetWidth : 1
  return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale }
}

function onMarqueeMove(e: PointerEvent): void {
  const dx = e.clientX - startClient.x
  const dy = e.clientY - startClient.y
  if (!moved && Math.hypot(dx, dy) < 4) return
  moved = true
  marqueeing.value = true
  const box = rootRef.value?.getBoundingClientRect()
  if (box) rootBox = { left: box.left, top: box.top }
  // 拖动期间画布可能被滚轮滚动，起点要按当前视图重新换算，否则选框与实际选中的格子错位
  startSheet = sheetPoint(startClient.x, startClient.y)
  marquee.value = {
    left: Math.min(startClient.x, e.clientX) - rootBox.left,
    top: Math.min(startClient.y, e.clientY) - rootBox.top,
    width: Math.abs(dx),
    height: Math.abs(dy)
  }
}

function onMarqueeUp(e: PointerEvent): void {
  window.removeEventListener('pointermove', onMarqueeMove)
  const append = e.ctrlKey || e.metaKey
  if (moved) {
    const b = sheetPoint(e.clientX, e.clientY)
    const x1 = Math.min(startSheet.x, b.x)
    const x2 = Math.max(startSheet.x, b.x)
    const y1 = Math.min(startSheet.y, b.y)
    const y2 = Math.max(startSheet.y, b.y)
    const keys: string[] = []
    for (const [k, r] of cellRects.value) {
      if (r.x2 > x1 && r.x1 < x2 && r.y2 > y1 && r.y1 < y2) keys.push(k)
    }
    emit('cellSelect', keys, append)
  } else if (!append) {
    // 空白处单击：清空选区
    emit('cellSelect', [], false)
  }
  marquee.value = null
  marqueeing.value = false
  moved = false
}

/** 框选必须从空白处起手：座位、行列头、缩放条一律不接管 */
function onRootPointerDown(e: PointerEvent): void {
  if (!props.capacityMode || e.button !== 0) return
  const t = e.target as HTMLElement | null
  if (!t || t.closest('.sb-seat') || t.closest('.sg-rh') || t.closest('.sg-ch') || t.closest('.sg-corner')) return
  // 底栏缩放控件、原生滚动条不接管，否则会抢掉点击/拖动滚动
  if (t.closest('.sg-foot')) return
  const scroll = t.closest('.sg-scroll') as HTMLElement | null
  if (scroll) {
    const sr = scroll.getBoundingClientRect()
    if (e.clientX - sr.left > scroll.clientWidth || e.clientY - sr.top > scroll.clientHeight) return
  }
  e.preventDefault()
  e.stopPropagation()
  const box = rootRef.value?.getBoundingClientRect()
  if (!box) return
  rootBox = { left: box.left, top: box.top }
  startClient = { x: e.clientX, y: e.clientY }
  startSheet = sheetPoint(e.clientX, e.clientY)
  moved = false
  marquee.value = null
  window.addEventListener('pointermove', onMarqueeMove)
  window.addEventListener('pointerup', onMarqueeUp, { once: true })
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMarqueeMove)
  window.removeEventListener('pointerup', onMarqueeUp)
})

/** 平滑滚动到指定座位（座位在冻结层/主层都按 data-seat-id 定位） */
function scrollToSeat(seatId: string): void {
  const el = rootRef.value?.querySelector(`[data-seat-id="${CSS.escape(seatId)}"]`) as HTMLElement | null
  el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
}

defineExpose({ fitBoard, scrollToSeat })
</script>

<template>
  <div
    ref="rootRef"
    class="seat-board"
    :class="{ 'is-capacity': capacityMode, 'is-marqueeing': marqueeing }"
    @pointerdown.capture="onRootPointerDown"
  >
    <SheetGrid
      ref="gridRef"
      :sheet="layout.sheet"
      :selection="emptySel"
      :active="emptyActive"
      readonly
    >
      <template #overlay="{ seats }">
        <button
          v-for="s in seats"
          :key="s.seatId"
          class="sb-seat"
          :class="{
            'is-empty': !seatInfo[s.seatId],
            'is-filled': !!seatInfo[s.seatId],
            'is-disabled': s.disabled,
            'is-leave': seatInfo[s.seatId]?.status === 'leave',
            'is-locked': seatInfo[s.seatId]?.locked,
            'is-selected': selectedSeatId === s.seatId,
            'is-focus': focusSeatId === s.seatId,
            'is-drag-source': dragFrom === s.seatId,
            'is-drag-over': dragOver === s.seatId,
            'is-flash': highlightSeatIds?.includes(s.seatId),
            'is-stage': s.stage,
            'is-cell-picked': capacityMode && selectedCells?.includes(`${s.row}:${s.col}`)
          }"
          :style="{
            left: s.x + 'px',
            top: s.y + 'px',
            width: s.w + 'px',
            height: s.h + 'px',
            ...(seatInfo[s.seatId] ? { '--rank': seatInfo[s.seatId].color } : {})
          }"
          :title="seatTitle(s.row, s.stage, noOf(s.seatId, s.seatNo), seatInfo[s.seatId])"
          :data-seat-id="s.seatId"
          :data-row="s.row"
          :data-col="s.col"
          :draggable="!capacityMode"
          @click="onPick(s.seatId, $event, s.row, s.col)"
          @dragstart="onDragStart(s.seatId, $event)"
          @dragenter.prevent="onDragEnter(s.seatId)"
          @dragover.prevent
          @dragend="onDragEnd"
          @drop.prevent="onDrop(s.seatId)"
        >
          <span v-if="s.disabled || showNos" class="sb-no">{{ s.disabled ? '固定' : noOf(s.seatId, s.seatNo) }}</span>
          <span class="sb-name">{{ s.disabled ? '固定空位' : seatInfo[s.seatId]?.name || '空位' }}</span>
          <span v-if="seatInfo[s.seatId]" class="sb-meta">
            <span v-if="showRank">{{ seatInfo[s.seatId].rankName }}</span>
            <span v-if="showDuty && seatInfo[s.seatId].duty">{{ seatInfo[s.seatId].duty }}</span>
            <span v-if="showUnit && seatInfo[s.seatId].unitName">{{ seatInfo[s.seatId].unitName }}</span>
          </span>
          <i v-if="seatInfo[s.seatId]?.locked" class="sb-lock" title="已锁定" />
        </button>
      </template>
    </SheetGrid>
    <div
      v-if="marquee"
      class="sb-marquee"
      :style="{
        left: marquee.left + 'px',
        top: marquee.top + 'px',
        width: marquee.width + 'px',
        height: marquee.height + 'px'
      }"
    />
  </div>
</template>

<style scoped>
.seat-board { position: relative; height: 100%; min-height: 0; display: flex; }
.seat-board > :deep(.sheet-grid) { flex: 1; }

/* 批量容量模式：空白处可起手框选，光标给出明确反馈 */
.seat-board.is-capacity :deep(.sg-scroll) { cursor: crosshair; }
.seat-board.is-capacity :deep(.sg-space) { cursor: crosshair; }
.seat-board.is-marqueeing, .seat-board.is-marqueeing :deep(*) {
  cursor: crosshair !important;
  user-select: none;
}
/* 框选矩形：视口坐标绘制在面板根节点上，不受画布缩放影响 */
.sb-marquee {
  position: absolute; z-index: 6; pointer-events: none;
  border: 1px dashed var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  border-radius: 2px;
}

/* 座位槽：尺寸与位置完全来自网格几何，不额外造卡片 */
.sb-seat {
  position: absolute; z-index: 1;
  /* 父层 .sg-overlay 为穿透点击设为 none，座位槽需显式恢复命中 */
  pointer-events: auto;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px; padding: 0; margin: 0;
  border: none; border-radius: 0; background: transparent;
  font-family: inherit; line-height: 1.15; text-align: center;
  overflow: hidden; cursor: pointer;
  transition: background .12s ease, box-shadow .12s ease;
}
.sb-seat:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
/* 已排座：用很淡的职级底色区分，不再画左侧彩色竖线 */
.sb-seat.is-filled { background: color-mix(in srgb, var(--rank, #8a979d) 9%, #fff); }
.sb-seat.is-filled:hover { background: var(--primary-soft); }
.sb-seat.is-empty { background: transparent; }
.sb-seat.is-empty .sb-name { color: var(--text-disabled); font-weight: 400; }
.sb-seat.is-stage .sb-name { font-weight: 500; }
.sb-seat.is-leave { opacity: .55; }
.sb-seat.is-leave .sb-name { text-decoration: line-through; }
.sb-seat.is-selected { background: var(--primary-soft); box-shadow: inset 0 0 0 1.5px var(--primary); }
.sb-seat.is-focus {
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 2px var(--primary);
  animation: sb-focus 1.1s ease;
}
@keyframes sb-focus {
  0% { background: var(--primary-line); }
  100% { background: var(--primary-soft); }
}
.sb-seat.is-drag-source { opacity: .38; }
.sb-seat.is-drag-over { outline: 1.5px dashed var(--primary); outline-offset: -2px; }
/* 批量容量模式：点选桌位 */
.sb-seat.is-cell-picked {
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 2px var(--primary);
  cursor: copy;
}
.sb-seat.is-flash { animation: sb-flash .7s ease; }
.sb-seat.is-disabled { cursor: default; }
.sb-seat.is-disabled .sb-name { color: var(--text-disabled); font-weight: 400; }

.sb-no {
  position: absolute; left: 3px; top: 1px;
  font-size: 8px; line-height: 1; color: var(--text-disabled);
  font-variant-numeric: tabular-nums;
}
.sb-name {
  width: 100%; max-width: 100%; box-sizing: border-box;
  padding: 0 3px;
  font-size: 10px; font-weight: 500; color: var(--text-primary);
  white-space: normal; overflow-wrap: anywhere; line-height: 1.2;
  text-align: center;
}
.sb-meta {
  display: flex; flex-direction: column; align-items: center;
  max-width: 100%; max-height: 100%; overflow: hidden;
  font-size: 8px; line-height: 1.1; color: var(--text-muted);
}
.sb-meta > span {
  max-width: 100%; padding: 0 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-lock {
  position: absolute; right: 3px; top: 2px;
  width: 6px; height: 6px; border-radius: 1px;
  background: var(--text-secondary);
}
.sb-lock::after {
  content: ''; position: absolute; left: 1px; top: -3px;
  width: 4px; height: 3px; border: 1px solid var(--text-secondary); border-bottom: none;
  border-radius: 3px 3px 0 0;
}

@keyframes sb-flash {
  0% { background: var(--primary-soft); }
  100% { background: transparent; }
}
</style>
