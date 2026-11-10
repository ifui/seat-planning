<script setup lang="ts">
/**
 * 元素选择面板：工具栏「添加元素」下拉里的图标网格。
 * 每项都是独立的可视化预览，点击即插入；默认浮于单元格。
 */
import type { ElementKind } from '../../types'
import { ELEMENT_LIBRARY, ELEMENT_SHAPES } from '../../engine/elements'

const emit = defineEmits<{ (e: 'add', kind: ElementKind): void }>()
</script>

<template>
  <div class="el-lib">
    <div class="el-lib-head">
      <span class="el-lib-title">添加元素</span>
      <span class="el-lib-hint">插入后浮于单元格，可自由拖动、缩放与旋转</span>
    </div>
    <div class="el-lib-grid">
      <button
        v-for="m in ELEMENT_LIBRARY"
        :key="m.kind"
        type="button"
        class="el-tile"
        :title="`添加${m.label}`"
        @click="emit('add', m.kind)"
      >
        <svg class="el-tile-art" viewBox="0 0 100 100" aria-hidden="true">
          <path
            :d="ELEMENT_SHAPES[m.kind].fill"
            :fill="m.color"
            :stroke="m.bordered ? m.stroke : 'none'"
            stroke-width="3"
            stroke-linejoin="round"
          />
          <path
            v-for="(d, i) in ELEMENT_SHAPES[m.kind].lines ?? []"
            :key="i"
            :d="d"
            fill="none"
            :stroke="m.stroke"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="el-tile-name">{{ m.label }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.el-lib { width: 292px; padding: 2px 2px 4px; }
.el-lib-head { display: flex; flex-direction: column; gap: 3px; padding: 4px 6px 8px; }
.el-lib-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.el-lib-hint { font-size: 10.5px; line-height: 1.4; color: var(--text-muted); }
.el-lib-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.el-tile {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 9px 4px 7px;
  background: var(--bg-soft, #f7f6f2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}
.el-tile:hover { border-color: var(--primary-line); background: var(--primary-soft); transform: translateY(-1px); }
.el-tile:active { transform: translateY(0); }
.el-tile-art { width: 30px; height: 30px; }
.el-tile-name { font-size: 10.5px; color: var(--text-secondary); white-space: nowrap; }
</style>
