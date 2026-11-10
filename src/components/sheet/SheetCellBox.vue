<script setup lang="ts">
import { computed } from 'vue'
import type { CellView } from './cellView'

const props = defineProps<{ view: CellView; showLabel?: boolean; showDots?: boolean; viewMode?: boolean }>()

const isPodium = computed(() => props.view.tone === 'podium')

/** 主席台文字与普通座位文字同一量级：固定小号，不再按块尺寸放大 */
const textStyle = computed(() => (isPodium.value ? { fontSize: '12px' } : {}))

/** 单元格自定义线框：未设置时交由画布网格线表现，避免相邻格重复描边 */
const cellStyle = computed(() => {
  const v = props.view
  const style: Record<string, string> = {
    left: v.x + 'px',
    top: v.y + 'px',
    width: v.w + 'px',
    height: v.h + 'px',
    justifyContent: v.align === 'left' ? 'flex-start' : v.align === 'right' ? 'flex-end' : 'center'
  }
  if (v.fill) style.background = v.fill
  if (v.textColor) style.color = v.textColor
  return style
})
</script>

<template>
  <div
    class="sg-cell"
    :class="[view.seats === 0 ? 'sg-block' : 'sg-seat-cell', view.tone, { 'is-disabled': view.disabled, 'is-view': viewMode }]"
    :style="cellStyle"
  >
    <template v-if="view.seats === 0">
      <span class="sg-block-text" :style="textStyle">{{ view.text }}</span>
    </template>
    <template v-else>
      <span
        v-if="view.label && showLabel !== false"
        class="sg-table-label"
        :class="{ 'is-center': isPodium, 'is-view-label': viewMode && isPodium }"
        :style="textStyle"
      >{{ view.label }}</span>
      <span v-if="showDots !== false" class="sg-seat-dots" :class="{ 'is-podium-seat': isPodium }">
        <i v-for="n in view.seats" :key="n" />
      </span>
    </template>
  </div>
</template>

<style scoped>
.sg-cell { position: absolute; overflow: hidden; user-select: none; background: #fff; }
.sg-block {
  display: flex; align-items: center;
  border-radius: 0;
  font-size: 12px; color: var(--text-muted);
}
/* 特殊块按用途区分，避免整张表全是同一种灰白 */
.sg-block.is-aisle { background: repeating-linear-gradient(45deg, #f8f9f9, #f8f9f9 7px, #f0f2f2 7px, #f0f2f2 14px); }
.sg-block.is-lectern { background: #f4f7f8; color: var(--text-secondary); }
.sg-block.is-backdrop { background: #eef2f3; color: var(--text-secondary); }
.sg-block.is-label { background: #fff; color: var(--text-disabled); }
.sg-block-text {
  padding: 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.25;
}

.sg-seat-cell {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  border-radius: 0;
  background: #fff;
}
/* 主席台不再用左侧高亮条，保持干净的整块底色 */
.sg-seat-cell.podium {
  background: #fff;
}
/* 固定空位/不可用：斜线底纹 + 虚线边框，与可排座位一眼区分 */
.sg-seat-cell.is-disabled {
  background: repeating-linear-gradient(45deg, #f3f4f4, #f3f4f4 5px, #e7e9e9 5px, #e7e9e9 10px);
  border: 1px dashed #b9c0c1;
}
.sg-seat-cell.is-disabled .sg-seat-dots i { background: #eceeee; border-color: #c9cfd0; }

.sg-table-label {
  position: absolute; left: 6px; top: 3px;
  font-size: 10px; color: var(--text-muted);
  max-width: calc(100% - 12px);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
/* 主席台文字：黑字、小号，居中；字号与普通座位文字同一量级 */
.sg-table-label.is-center {
  position: static; left: auto; top: auto;
  max-width: calc(100% - 22px);
  padding-bottom: 2px;
  color: var(--text-primary);
  text-align: center;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}

/* 排座只读视图不显示桌名/区域名，避免压住姓名 */
.sg-seat-dots {
  position: absolute; right: 5px; bottom: 4px;
  display: flex; gap: 3px; line-height: 0;
  opacity: 0.9;
}
.sg-seat-dots i {
  width: 6px; height: 6px; border-radius: 50%;
  background: #e6eeee; border: 1px solid #b9d1cf;
}
.sg-seat-dots.is-podium-seat i { background: var(--primary); border-color: var(--primary); opacity: 0.7; }
</style>
