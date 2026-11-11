<script setup lang="ts">
/**
 * 排座项目页的座位图面板：图例 + 座位图 + 选区提示。
 * 缩放/滚动直接复用布局页 SheetGrid（Ctrl+滚轮缩放、底栏缩放控件），保证两边算法一致。
 * 框选默认可用，选中的格子交给项目属性面板统一设置容量、区域与座位状态。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { LayoutPackage, RuleSet } from '../../types'
import SeatBoard from '../SeatBoard.vue'

type CardInfo = {
  name: string
  rankName: string
  unitName: string
  color: string
  status: string
}

const props = defineProps<{
  layout?: LayoutPackage
  rules: RuleSet
  seatInfo: Record<string, CardInfo>
  selectedSeatId?: string | null
  highlightSeatIds?: string[]
  /** 名单点选后需要定位的座位 */
  focusSeatId?: string | null
  /** 是否显示座位序号 */
  showSeatNumbers?: boolean
  /** 座位下方信息开关 */
  showRank?: boolean
  showDuty?: boolean
  showUnit?: boolean
  /** 画布框选结果（"行:列"） */
  selectedCells?: string[]
  /** 区域列表点选后的画布高亮 */
  zoneHighlight?: { id: string; color: string } | null
  /** 固定座位：seatId → memberId */
  fixedSeats?: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string, el: HTMLElement, row: number, col: number): void
  (e: 'swap', from: string, to: string): void
  (e: 'cellPick', cellKey: string): void
  (e: 'cellSelect', keys: string[], append: boolean): void
  (e: 'clearSelection'): void
}>()

const boardRef = ref<InstanceType<typeof SeatBoard> | null>(null)
const selectedCount = computed(() => props.selectedCells?.length ?? 0)

function fitBoard(): void {
  boardRef.value?.fitBoard()
}

/** 平滑滚动到指定座位，并保持高亮 */
function scrollToSeat(seatId: string): void {
  boardRef.value?.scrollToSeat(seatId)
}

function fitSoon(): void {
  void nextTick(() => {
    window.requestAnimationFrame(() => fitBoard())
  })
}

onMounted(fitSoon)
watch(() => props.layout?.id, fitSoon)

defineExpose({ fitBoard, scrollToSeat })
</script>

<template>
  <section class="board-card">
    <div class="board-bar">
      <div class="legend">
        <span class="lg"><i class="lg-dot is-ok" />已排座</span>
        <span class="lg"><i class="lg-dot is-empty" />未排座</span>
        <span class="lg"><i class="lg-dot is-disabled" />不坐人</span>
      </div>
      <span class="grow" />
      <span v-if="selectedCount" class="batch-hint">已选 <b>{{ selectedCount }}</b> 格</span>
      <span v-else class="batch-hint">空白处拖动框选 · Ctrl 追加</span>
      <button v-if="selectedCount" class="board-fit" @click="emit('clearSelection')">清空选择</button>
      <button class="board-fit" title="整张座位图完整显示" @click="fitBoard">适应窗口</button>
    </div>
    <div class="board-body">
      <SeatBoard
        v-if="layout"
        ref="boardRef"
        :layout="layout"
        :rules="rules"
        :seat-info="seatInfo"
        :selected-seat-id="selectedSeatId"
        :highlight-seat-ids="highlightSeatIds"
        :focus-seat-id="focusSeatId"
        :show-seat-numbers="showSeatNumbers"
        :show-rank="showRank"
        :show-duty="showDuty"
        :show-unit="showUnit"
        :selected-cells="selectedCells"
        :zone-highlight="zoneHighlight"
        :fixed-seats="fixedSeats"
        @pick="(seatId, el, row, col) => emit('pick', seatId, el, row, col)"
        @swap="(from, to) => emit('swap', from, to)"
        @cell-pick="(key) => emit('cellPick', key)"
        @cell-select="(keys, append) => emit('cellSelect', keys, append)"
      />
      <div v-else class="board-empty">选择排座项目后显示座位图</div>
    </div>
  </section>
</template>

<style scoped>
.board-card {
  display: flex; flex-direction: column; min-width: 0; min-height: 0;
  border: 1px solid var(--border-soft); border-radius: 0; background: var(--bg);
  overflow: hidden;
}
.board-bar {
  flex: none; display: flex; align-items: center; gap: 12px;
  height: 34px; padding: 0 10px;
  border-bottom: 1px solid var(--border-soft); background: var(--bg);
}
.legend { display: flex; align-items: center; gap: 12px; }
.lg { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-muted); }
.lg-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border); }
.lg-dot.is-ok { background: #4f8f7a; }
.lg-dot.is-empty { background: #dfe6e5; border: 1px solid #c3cecd; }
.lg-dot.is-disabled { background: repeating-linear-gradient(45deg, var(--bg-subtle) 0 2px, var(--border-strong) 2px 3px); border: 1px solid var(--border); }
.grow { flex: 1; }
.board-fit {
  height: 22px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 4px; background: var(--bg); color: var(--text-muted);
  font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.board-fit:hover { color: var(--text-primary); border-color: var(--primary-line); }
.batch-hint { font-size: 10.5px; color: var(--text-muted); white-space: nowrap; }
.batch-hint b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.board-body { flex: 1; min-height: 0; display: flex; }
.board-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-disabled); font-size: 12px;
}
</style>
