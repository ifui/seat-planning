<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LayoutPackage } from '../types'
import { allSeatRows } from '../engine/grid'

interface CardInfo {
  name: string
  rankName: string
  color: string
  status: string
  locked: boolean
}

const props = defineProps<{
  layout: LayoutPackage
  seatInfo: Record<string, CardInfo>
  selectedSeatId?: string | null
}>()

const emit = defineEmits<{
  (e: 'pick', seatId: string): void
  (e: 'swap', from: string, to: string): void
}>()

const dragging = ref<string | null>(null)
const overSeat = ref<string | null>(null)

const rows = computed(() => {
  // 有网格时排号直接来自格子行号；旧布局仍按坐标聚类
  return allSeatRows(props.layout).map((row) => ({
    rowIndex: row.rowIndex,
    stage: row.stage,
    grid: row.grid,
    seats: row.seats.map((s, i) => {
      const prev = i > 0 ? row.seats[i - 1] : null
      const gap = prev ? Math.max(0, s.x - (prev.x + prev.w)) : 0
      return {
        id: s.seat.id,
        index: s.seat.index,
        pos: i + 1,
        table: s.element.id,
        disabled: !!s.seat.disabled,
        gapBefore: gap > 16 ? Math.min(56, gap) : 0
      }
    })
  }))
})

function info(id: string): CardInfo | undefined {
  return props.seatInfo[id]
}

function onDragStart(e: DragEvent, id: string): void {
  dragging.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDrop(e: DragEvent, id: string): void {
  e.preventDefault()
  const from = dragging.value || e.dataTransfer?.getData('text/plain') || ''
  if (from && from !== id) emit('swap', from, id)
  dragging.value = null
  overSeat.value = null
}

function onDragOver(e: DragEvent, id: string): void {
  e.preventDefault()
  overSeat.value = id
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onDragEnd(): void {
  dragging.value = null
  overSeat.value = null
}
</script>

<template>
  <div>
    <div v-for="(row, ri) in rows" :key="ri" :class="row.stage ? 'board-host' : 'board-row'" style="margin-bottom: 14px">
      <div class="caption" style="width: 100%; text-align: center; margin-bottom: 6px">
        第 {{ row.rowIndex }} 排<template v-if="row.stage"> · 主席台</template>
        <span v-if="!row.grid && layout.grid" class="caption-tag">游离</span>
      </div>
      <template v-for="s in row.seats" :key="s.id">
        <span v-if="s.gapBefore" :style="{ width: s.gapBefore + 'px', flex: 'none' }" />
        <div
          class="seat-card"
          :class="{
            leave: info(s.id)?.status === 'leave',
            locked: info(s.id)?.locked,
            disabled: s.disabled,
          }"
          :style="{
            borderColor: selectedSeatId === s.id ? 'var(--primary)' : undefined,
            boxShadow: overSeat === s.id ? '0 0 0 2px rgba(61,90,108,.25)' : undefined
          }"
          :draggable="!s.disabled"
          @click="!s.disabled && emit('pick', s.id)"
          @dragstart="!s.disabled && onDragStart($event, s.id)"
          @dragend="onDragEnd"
          @dragover="!s.disabled && onDragOver($event, s.id)"
          @dragleave="overSeat = null"
          @drop="!s.disabled && onDrop($event, s.id)"
        >
          <template v-if="s.disabled">
            <div class="nm" style="color: var(--text-muted)">不可用</div>
            <div class="rk">固定空位</div>
          </template>
          <template v-else>
            <div v-if="info(s.id)" class="nm" :style="{ color: info(s.id)!.status === 'leave' ? '#a8b0b2' : undefined }">
              {{ info(s.id)!.name }}
            </div>
            <div v-else class="nm empty">空位</div>
            <div v-if="info(s.id)" class="rk" style="display: flex; align-items: center; justify-content: center; gap: 4px">
              <span class="dot" :style="{ background: info(s.id)!.color, width: '6px', height: '6px' }" />
              {{ info(s.id)!.rankName }}
            </div>
            <div v-else class="rk">第 {{ row.rowIndex }} 排 · {{ s.pos }} 座</div>
          </template>
          <span
            v-if="info(s.id)?.locked"
            title="已锁定"
            :style="{ position: 'absolute', top: '4px', right: '5px', width: '5px', height: '5px', borderRadius: '50%', background: 'var(--primary)' }"
          />
        </div>
      </template>
    </div>
    <div v-if="!rows.length" class="empty">布局里还没有可用座位，去「会场布局」画桌子。</div>
  </div>
</template>
