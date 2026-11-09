<script setup lang="ts">
/**
 * 座位图：直接投影工作表——行 = 排，行内座位顺序 = 座号。
 * 不做任何坐标聚类，排号与座号全部来自单元格本身。
 */
import { computed } from 'vue'
import type { LayoutPackage } from '../types'
import { seatsInRow } from '../engine/sheet'

type CardInfo = { name: string; rankName: string; color: string; status: string; locked: boolean }

const props = defineProps<{
  layout: LayoutPackage
  seatInfo: Record<string, CardInfo>
  selectedSeatId?: string | null
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string): void
  (e: 'swap', from: string, to: string): void
}>()

interface RowView {
  row: number
  label: string
  stage: boolean
  seats: {
    seatId: string
    seatNo: number
    disabled: boolean
    info?: CardInfo
  }[]
}

const rows = computed<RowView[]>(() => {
  const out: RowView[] = []
  const s = props.layout.sheet
  for (let row = 0; row < s.rows; row++) {
    const seats = seatsInRow(s, row)
    if (!seats.length) continue
    out.push({
      row,
      label: seats[0].stage ? '主席台' : `第 ${row + 1} 排`,
      stage: seats[0].stage,
      seats: seats.map((seat) => ({
        seatId: seat.seatId,
        seatNo: seat.seatNo,
        disabled: seat.disabled,
        info: props.seatInfo[seat.seatId]
      }))
    })
  }
  return out
})

const tableLabels = computed(() => {
  const out: Record<string, string> = {}
  for (const cell of Object.values(props.layout.sheet.cells)) {
    if (!cell.seatIds || !cell.tableLabel) continue
    for (const id of cell.seatIds) out[id] = cell.tableLabel
  }
  return out
})

const tableLabelOf = (_row: number, seatId: string): string => tableLabels.value[seatId] ?? ''

let dragFrom = ''

function onDragStart(seatId: string, e: DragEvent): void {
  dragFrom = seatId
  e.dataTransfer?.setData('text/plain', seatId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDrop(to: string): void {
  const from = dragFrom
  dragFrom = ''
  if (!from || from === to) return
  emit('swap', from, to)
}
</script>

<template>
  <div class="seat-board">
    <div
      v-for="row in rows"
      :key="row.row"
      class="sb-row"
      :class="{ 'is-stage': row.stage }"
    >
      <div class="sb-row-label">{{ row.label }}</div>
      <div class="sb-seats">
        <button
          v-for="seat in row.seats"
          :key="seat.seatId"
          class="sb-seat"
          :class="{
            'is-empty': !seat.info,
            'is-disabled': seat.disabled,
            'is-leave': seat.info?.status === 'leave',
            'is-locked': seat.info?.locked,
            'is-selected': selectedSeatId === seat.seatId,
            'is-stage': row.stage
          }"
          :title="tableLabelOf(row.row, seat.seatId)"
          draggable="true"
          @click="emit('pick', seat.seatId)"
          @dragstart="onDragStart(seat.seatId, $event)"
          @dragover.prevent
          @drop.prevent="onDrop(seat.seatId)"
        >
          <span class="sb-no">{{ seat.disabled ? '固定' : seat.seatNo }}</span>
          <span class="sb-name">{{ seat.disabled ? '固定空位' : seat.info?.name || '空位' }}</span>
          <span v-if="seat.info" class="sb-rank" :style="{ color: seat.info.color }">{{ seat.info.rankName }}</span>
          <i v-if="seat.info?.locked" class="sb-lock" title="已锁定" />
        </button>
      </div>
    </div>
    <div v-if="!rows.length" class="sb-empty">工作表中还没有座位格，请先在「会场布局」里填充座位</div>
  </div>
</template>

<style scoped>
.seat-board { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: #fff; border-radius: 8px; }
.sb-row { display: flex; align-items: stretch; gap: 10px; }
.sb-row-label {
  width: 58px; flex: none; display: flex; align-items: center; justify-content: flex-end;
  font-size: 10px; color: var(--text-muted); white-space: nowrap;
}
.sb-row.is-stage .sb-row-label { color: var(--primary); font-weight: 600; }
.sb-seats { display: flex; flex-wrap: nowrap; gap: 6px; }
.sb-seat {
  position: relative; width: 78px; min-height: 46px; flex: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  padding: 4px 4px 3px;
  border: 1px solid var(--border); border-radius: 6px; background: #fff;
  font-family: inherit; cursor: pointer;
  box-shadow: var(--shadow-sm);
}
.sb-seat:hover { border-color: var(--primary-line); }
.sb-seat.is-stage { background: #f4f8f8; border-color: var(--primary-line); }
.sb-seat.is-empty { background: #fbfbfa; border-style: dashed; }
.sb-seat.is-disabled { background: #f4f4f3; border-color: #e1e0da; color: #a5a299; }
.sb-seat.is-leave { opacity: 0.72; }
.sb-seat.is-locked { border-color: var(--warning); }
.sb-seat.is-selected { outline: 2px solid var(--primary); outline-offset: 1px; }
.sb-no {
  position: absolute; left: 3px; top: 1px;
  font-size: 8px; color: var(--text-disabled); font-variant-numeric: tabular-nums;
}
.sb-name {
  font-size: 11px; color: var(--text-primary); max-width: 100%;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.sb-seat.is-empty .sb-name { color: var(--text-disabled); }
.sb-rank { font-size: 8px; line-height: 1; }
.sb-lock { position: absolute; right: 3px; top: 3px; width: 4px; height: 4px; border-radius: 50%; background: var(--warning); }
.sb-empty { padding: 30px; text-align: center; font-size: 12px; color: var(--text-muted); }
</style>
