<script setup lang="ts">
/**
 * 排座项目页的座位图面板：图例 + 可缩放/平移的座位图 + 缩放工具条。
 * 缩放交互与布局页保持一致：Ctrl/⌘ + 滚轮围绕指针缩放，空格 + 拖拽平移，可一键适应窗口。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LayoutPackage } from '../../types'
import SeatBoard from '../SeatBoard.vue'
import { UiIcon as Icon } from '../../ui'

type CardInfo = { name: string; rankName: string; color: string; status: string; locked: boolean }

const props = defineProps<{
  layout?: LayoutPackage
  seatInfo: Record<string, CardInfo>
  selectedSeatId?: string | null
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string): void
  (e: 'swap', from: string, to: string): void
}>()

// 大场馆（数百桌）在窄侧栏里需要缩到很小才能整张看全，最小值放宽到 5%
const BOARD_MIN = 0.05
const BOARD_MAX = 2.5
const boardScale = ref(1)
const boardScroll = ref<HTMLElement | null>(null)
const boardInner = ref<HTMLElement | null>(null)
const boardNatW = ref(0)
const boardNatH = ref(0)
const boardSpace = ref(false)
const isPanning = ref(false)
const boardSpaceW = computed(() => Math.max(1, Math.round(boardNatW.value * boardScale.value)))
const boardSpaceH = computed(() => Math.max(1, Math.round(boardNatH.value * boardScale.value)))

let boardRo: ResizeObserver | null = null
let boardRaf = 0
let autoFitDone = false
let boardPan: { x: number; y: number; left: number; top: number } | null = null

function measureBoard(): void {
  const el = boardInner.value
  if (!el) return
  boardNatW.value = el.offsetWidth
  boardNatH.value = el.offsetHeight
  // 首次量到尺寸后：内容比视口宽时自动适应，避免一进来只看到左上角
  const vp = boardScroll.value
  if (!autoFitDone && boardNatW.value > 0 && vp && vp.clientWidth > 80) {
    autoFitDone = true
    if (boardNatW.value > vp.clientWidth - 32) fitBoard()
  }
}

function scheduleMeasure(): void {
  if (boardRaf) return
  boardRaf = requestAnimationFrame(() => {
    boardRaf = 0
    measureBoard()
  })
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/** 以视口内某点为中心缩放，缩放前后该点对应的内容位置保持不动 */
function setBoardScale(next: number, cx?: number, cy?: number): void {
  const el = boardScroll.value
  const prev = boardScale.value
  const clamped = Math.min(BOARD_MAX, Math.max(BOARD_MIN, next))
  if (!el || Math.abs(clamped - prev) < 0.0005) {
    boardScale.value = clamped
    return
  }
  const px = cx ?? el.clientWidth / 2
  const py = cy ?? el.clientHeight / 2
  const contentX = (el.scrollLeft + px) / prev
  const contentY = (el.scrollTop + py) / prev
  boardScale.value = clamped
  nextTick(() => {
    el.scrollLeft = contentX * clamped - px
    el.scrollTop = contentY * clamped - py
  })
}

function zoomBoard(dir: number): void {
  setBoardScale(boardScale.value * (dir > 0 ? 1.15 : 1 / 1.15))
}

function onBoardWheel(e: WheelEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  const el = boardScroll.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  setBoardScale(boardScale.value * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - rect.left, e.clientY - rect.top)
}

/** 适应窗口：整张座位图完整可见，最大不超过 100% */
function fitBoard(): void {
  const el = boardScroll.value
  if (!el || !boardNatW.value || !boardNatH.value) return
  const pad = 32
  const s = Math.min((el.clientWidth - pad) / boardNatW.value, (el.clientHeight - pad) / boardNatH.value, 1)
  boardScale.value = Math.min(BOARD_MAX, Math.max(BOARD_MIN, s))
  nextTick(() => {
    el.scrollLeft = 0
    el.scrollTop = 0
  })
}

function onBoardDown(e: MouseEvent): void {
  if (!boardSpace.value || e.button !== 0) return
  const el = boardScroll.value
  if (!el) return
  e.preventDefault()
  boardPan = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
  isPanning.value = true
  window.addEventListener('mousemove', onBoardPanMove)
  window.addEventListener('mouseup', onBoardPanUp)
}

function onBoardPanMove(e: MouseEvent): void {
  const el = boardScroll.value
  if (!el || !boardPan) return
  el.scrollLeft = boardPan.left - (e.clientX - boardPan.x)
  el.scrollTop = boardPan.top - (e.clientY - boardPan.y)
}

function onBoardPanUp(): void {
  boardPan = null
  isPanning.value = false
  window.removeEventListener('mousemove', onBoardPanMove)
  window.removeEventListener('mouseup', onBoardPanUp)
}

function onBoardKeyDown(e: KeyboardEvent): void {
  if (e.code === 'Space' && !isTypingTarget(e.target)) {
    boardSpace.value = true
    e.preventDefault()
  }
}

function onBoardKeyUp(e: KeyboardEvent): void {
  if (e.code === 'Space') boardSpace.value = false
}

watch(boardInner, (el) => {
  boardRo?.disconnect()
  boardRo = null
  if (!el) return
  boardRo = new ResizeObserver(scheduleMeasure)
  boardRo.observe(el)
  scheduleMeasure()
})

watch(
  () => props.layout,
  () => nextTick(scheduleMeasure),
  { deep: true }
)

onMounted(() => {
  window.addEventListener('keydown', onBoardKeyDown)
  window.addEventListener('keyup', onBoardKeyUp)
  scheduleMeasure()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onBoardKeyDown)
  window.removeEventListener('keyup', onBoardKeyUp)
  onBoardPanUp()
  boardRo?.disconnect()
  if (boardRaf) cancelAnimationFrame(boardRaf)
})

defineExpose({ fitBoard, setBoardScale })
</script>

<template>
  <section class="board-card">
    <div class="board-bar">
      <div class="legend">
        <span class="lg"><i class="lg-dot is-ok" />已就座</span>
        <span class="lg"><i class="lg-dot is-leave" />请假</span>
        <span class="lg"><i class="lg-dot is-lock" />锁定</span>
        <span class="lg"><i class="lg-dot is-empty" />固定空位</span>
      </div>
      <span class="caption">拖拽换座 · 点选查看人员 · Ctrl+滚轮缩放 · 空格拖拽平移</span>
    </div>
    <div
      ref="boardScroll"
      class="board-scroll"
      :class="{ 'is-panning': boardSpace, 'is-panning-active': isPanning }"
      @wheel="onBoardWheel"
      @mousedown="onBoardDown"
    >
      <div class="board-zoom-space" :style="{ width: boardSpaceW + 'px', height: boardSpaceH + 'px' }">
        <div ref="boardInner" class="board-zoom-inner" :style="{ transform: `scale(${boardScale})` }">
          <SeatBoard
            v-if="layout"
            :layout="layout"
            :seat-info="seatInfo"
            :selected-seat-id="selectedSeatId"
            @pick="emit('pick', $event)"
            @swap="(from, to) => emit('swap', from, to)"
          />
        </div>
      </div>
    </div>
    <div class="board-zoom-bar">
      <button class="icon-btn" title="缩小（Ctrl+滚轮）" @click="zoomBoard(-1)"><Icon name="minus" :size="14" /></button>
      <button class="zoom-pct" title="适应窗口" @click="fitBoard">{{ Math.round(boardScale * 100) }}%</button>
      <button class="icon-btn" title="放大（Ctrl+滚轮）" @click="zoomBoard(1)"><Icon name="plus" :size="14" /></button>
      <span class="zoom-sep" />
      <button class="btn xs" title="整张座位图完整显示" @click="fitBoard"><Icon name="fit" :size="12" />适应</button>
    </div>
  </section>
</template>
