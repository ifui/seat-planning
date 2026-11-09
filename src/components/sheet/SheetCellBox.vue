<script setup lang="ts">
import type { CellView } from './cellView'

defineProps<{ view: CellView }>()
</script>

<template>
  <div
    class="sg-cell"
    :class="[view.seats === 0 ? 'sg-block' : 'sg-seat-cell', view.tone]"
    :style="{
      left: view.x + 'px',
      top: view.y + 'px',
      width: view.w + 'px',
      height: view.h + 'px',
      background: view.seats === 0 ? view.fill : view.fill,
      color: view.textColor,
      justifyContent: view.align === 'left' ? 'flex-start' : view.align === 'right' ? 'flex-end' : 'center'
    }"
  >
    <template v-if="view.seats === 0">
      <span class="sg-block-text">{{ view.text }}</span>
    </template>
    <template v-else>
      <span v-if="view.label" class="sg-table-label">{{ view.label }}</span>
      <span class="sg-seat-dots">
        <i v-for="n in view.seats" :key="n" :class="{ 'is-podium-seat': view.tone === 'podium' }" />
      </span>
      <span v-if="view.seats === 2" class="sg-seat-count">双人位</span>
    </template>
  </div>
</template>

<style scoped>
.sg-cell { position: absolute; overflow: hidden; user-select: none; }
.sg-block {
  display: flex; align-items: center;
  border: 1px dashed var(--border-strong);
  border-radius: 4px;
  font-size: 12px; color: var(--text-muted);
  background: var(--bg-subtle);
}
.sg-block.is-aisle { background: repeating-linear-gradient(45deg, #f7f8f9, #f7f8f9 6px, #eef0f2 6px, #eef0f2 12px); }
.sg-block.is-lectern { background: #eef2f4; color: var(--text-secondary); font-weight: 500; }
.sg-block.is-backdrop { background: #e9edf0; color: var(--text-secondary); }
.sg-block-text { padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sg-seat-cell {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #fff;
  box-shadow: var(--shadow-sm);
}
.sg-seat-cell.podium { background: #f2f6f7; border-color: var(--primary-line); }
.sg-table-label { position: absolute; left: 6px; top: 3px; font-size: 10px; color: var(--text-muted); max-width: calc(100% - 12px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sg-seat-dots { display: flex; gap: 4px; }
.sg-seat-dots i { width: 9px; height: 9px; border-radius: 50%; background: var(--primary-soft); border: 1px solid var(--primary-line); }
.sg-seat-dots i.is-podium-seat { background: var(--primary); border-color: var(--primary); opacity: 0.6; }
.sg-seat-count { position: absolute; right: 6px; bottom: 3px; font-size: 9px; color: var(--text-disabled); }
</style>
