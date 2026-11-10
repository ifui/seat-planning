<script setup lang="ts">
/**
 * 排座项目页的座位图面板：图例 + 座位图。
 * 缩放/滚动直接复用布局页 SheetGrid（Ctrl+滚轮缩放、底栏缩放控件），保证两边算法一致。
 */
import { nextTick, onMounted, ref, watch } from 'vue'
import type { LayoutPackage, RuleSet } from '../../types'
import SeatBoard from '../SeatBoard.vue'

type CardInfo = {
  name: string
  rankName: string
  unitName: string
  color: string
  status: string
  locked: boolean
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
  /** 批量容量模式 */
  capacityMode?: boolean
  /** 批量容量模式下已选中的桌 */
  selectedCells?: string[]
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string, el: HTMLElement, row: number, col: number): void
  (e: 'swap', from: string, to: string): void
  (e: 'cellPick', cellKey: string): void
  (e: 'cellSelect', keys: string[], append: boolean): void
  (e: 'toggleCapacity'): void
  (e: 'applyCapacity', n: number): void
}>()

const batchSeats = ref(1)
const batchCustom = ref(1)

function applyBatch(): void {
  emit('applyCapacity', Math.max(1, Math.round(batchSeats.value || batchCustom.value || 1)))
}

const boardRef = ref<InstanceType<typeof SeatBoard> | null>(null)

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
    <div class="board-bar" :class="{ 'is-batch': capacityMode }">
      <template v-if="capacityMode">
        <span class="batch-hint">空白处框选 / 点选桌位 · 已选 <b>{{ selectedCells?.length ?? 0 }}</b> 桌</span>
        <button type="button" class="batch-btn" :class="{ on: batchSeats === 1 }" @click="batchSeats = 1">单人</button>
        <button type="button" class="batch-btn" :class="{ on: batchSeats === 2 }" @click="batchSeats = 2">双人</button>
        <label class="batch-custom" :class="{ on: batchSeats === 0 }">
          <input v-model.number="batchCustom" type="number" min="1" max="50" @focus="batchSeats = 0" />
          <span>人</span>
        </label>
        <button type="button" class="batch-apply" :disabled="!selectedCells?.length" @click="applyBatch">应用</button>
      </template>
      <div v-else class="legend">
        <span class="lg"><i class="lg-dot is-ok" />已排座</span>
        <span class="lg"><i class="lg-dot is-empty" />未排座</span>
        <span class="lg"><i class="lg-dot is-lock" />锁定</span>
        <span class="lg"><i class="lg-dot is-disabled" />固定空位</span>
      </div>
      <span class="grow" />
      <button class="board-fit" :class="{ on: capacityMode }" @click="emit('toggleCapacity')">
        {{ capacityMode ? '退出批量' : '批量容量' }}
      </button>
      <button v-if="!capacityMode" class="board-fit" title="整张座位图完整显示" @click="fitBoard">适应窗口</button>
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
        :capacity-mode="capacityMode"
        :selected-cells="selectedCells"
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
  border: 1px solid var(--border-soft); border-radius: 8px; background: var(--bg);
  overflow: hidden;
}
.board-bar {
  flex: none; display: flex; align-items: center; gap: 14px;
  height: 34px; padding: 0 10px;
  border-bottom: 1px solid var(--border-soft); background: var(--bg);
}
.legend { display: flex; align-items: center; gap: 12px; }
.lg { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-muted); }
.lg-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border); }
.lg-dot.is-ok { background: #4f8f7a; }
.lg-dot.is-empty { background: #dfe6e5; border: 1px solid #c3cecd; }
.lg-dot.is-lock { background: var(--text-secondary); border-radius: 1px; }
.lg-dot.is-disabled { background: repeating-linear-gradient(45deg, #f3f4f4, #f3f4f4 2px, #dfe3e3 2px, #dfe3e3 4px); border: 1px solid #c9cfd0; }
.grow { flex: 1; }
.board-fit {
  height: 22px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 4px; background: var(--bg); color: var(--text-muted);
  font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.board-fit:hover { color: var(--text-primary); border-color: var(--primary-line); }
.board-fit.on { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary); }

/* 批量容量条 */
.batch-hint { font-size: 10.5px; color: var(--text-muted); }
.batch-hint b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.batch-btn {
  height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg); color: var(--text-muted); font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.batch-btn.on { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary); }
.batch-custom {
  display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: 4px; font-size: 10.5px; color: var(--text-muted);
}
.batch-custom.on { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary); }
.batch-custom input {
  width: 30px; height: 18px; padding: 0; border: none; background: none; outline: none;
  color: inherit; font-family: inherit; font-size: 10.5px; text-align: right;
  font-variant-numeric: tabular-nums; -moz-appearance: textfield;
}
.batch-custom input::-webkit-outer-spin-button,
.batch-custom input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.batch-apply {
  height: 22px; padding: 0 10px; border: 1px solid var(--primary); border-radius: 4px;
  background: var(--primary); color: #fff; font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.batch-apply:disabled { opacity: .45; cursor: default; }
.board-body { flex: 1; min-height: 0; display: flex; }
.board-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-disabled); font-size: 12px;
}
</style>
