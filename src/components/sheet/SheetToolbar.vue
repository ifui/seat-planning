<script setup lang="ts">
import type { ElementKind } from '../../types'
import ElementLibrary from './ElementLibrary.vue'
import UiButton from '../../ui/components/UiButton.vue'
import UiDropdown from '../../ui/components/UiDropdown.vue'
import UiIconButton from '../../ui/components/UiIconButton.vue'
import UiColorPicker from '../../ui/components/UiColorPicker.vue'

defineProps<{
  canUndo: boolean
  canRedo: boolean
  selectionLabel: string
  cellCount: number
  borderStyle: 'solid' | 'dashed' | 'dotted'
  borderWidth: number
  borderColor: string
}>()

const quickBorders: { value: 'outer' | 'all' | 'left' | 'right' | 'top' | 'bottom' | 'none'; label: string }[] = [
  { value: 'outer', label: '外边框' },
  { value: 'all', label: '外 + 内' },
  { value: 'left', label: '左边框' },
  { value: 'right', label: '右边框' },
  { value: 'top', label: '上边框' },
  { value: 'bottom', label: '下边框' },
  { value: 'none', label: '清除边框' }
]
const lineStyles: { value: 'solid' | 'dashed' | 'dotted'; label: string }[] = [
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
  { value: 'dotted', label: '点线' }
]

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'setup'): void
  (e: 'save'): void
  (e: 'export'): void
  (e: 'import'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'merge'): void
  (e: 'unmerge'): void
  (e: 'type', kind: 'seat' | 'podium' | 'block', role?: 'aisle'): void
  (e: 'element-add', kind: ElementKind): void
  (e: 'fill'): void
  (e: 'clear'): void
  (e: 'border', kind: 'outer' | 'all' | 'left' | 'right' | 'top' | 'bottom' | 'none'): void
  (e: 'update:borderStyle', v: 'solid' | 'dashed' | 'dotted'): void
  (e: 'update:borderWidth', v: number): void
  (e: 'update:borderColor', v: string): void
}>()

</script>

<template>
  <div class="sheet-toolbar">
    <div class="st-row">
      <UiButton variant="primary" size="sm" icon="save" @click="emit('save')">保存</UiButton>
      <UiButton variant="ghost" size="sm" icon="grid" @click="emit('setup')">表格设置</UiButton>
      <UiButton variant="ghost" size="sm" icon="export" @click="emit('export')">导出</UiButton>
      <UiButton variant="ghost" size="sm" icon="import" @click="emit('import')">导入</UiButton>

      <span class="st-spacer" />
      <span class="st-selection">{{ selectionLabel }}<template v-if="cellCount > 1"> · {{ cellCount }} 格</template></span>
      <UiButton variant="ghost" size="sm" icon="undo" :disabled="!canUndo" title="撤销 Ctrl+Z" @click="emit('undo')" />
      <UiButton variant="ghost" size="sm" icon="redo" :disabled="!canRedo" title="重做 Ctrl+Shift+Z" @click="emit('redo')" />
      <span class="st-divider" />
      <UiButton variant="ghost" size="sm" icon="restore" title="放弃未保存修改，重新载入" @click="emit('back')" />
    </div>

    <div class="st-row st-row-sub">
      <span class="st-group-label">合并</span>
      <UiButton variant="ghost" size="sm" icon="square" @click="emit('merge')">合并</UiButton>
      <UiButton variant="ghost" size="sm" icon="expand" @click="emit('unmerge')">拆分</UiButton>

      <span class="st-divider" />
      <span class="st-group-label">类型</span>
      <UiButton variant="ghost" size="sm" icon="seat" @click="emit('type', 'seat')">座位</UiButton>
      <UiButton variant="ghost" size="sm" icon="podium" @click="emit('type', 'podium')">主席台</UiButton>
      <UiButton variant="ghost" size="sm" icon="aisle" @click="emit('type', 'block', 'aisle')">过道</UiButton>

      <span class="st-divider" />
      <UiDropdown :width="300" align="left">
        <template #trigger>
          <UiButton variant="ghost" size="sm" icon="layers">添加元素</UiButton>
        </template>
        <template #default="{ close }">
          <ElementLibrary @add="(k) => { emit('element-add', k); close() }" />
        </template>
      </UiDropdown>

      <span class="st-divider" />
      <UiDropdown align="left" :width="248">
        <template #trigger>
          <UiIconButton icon="border" title="边框" />
        </template>
        <template #default>
          <div class="bd-menu">
            <div class="bd-title">快捷边框<span>再点一次取消</span></div>
            <div class="bd-grid">
              <button
                v-for="q in quickBorders"
                :key="q.value"
                type="button"
                class="bd-chip"
                :class="{ 'is-danger': q.value === 'none' }"
                @click="emit('border', q.value)"
              >{{ q.label }}</button>
            </div>

            <div class="bd-sep" />
            <div class="bd-title">线型</div>
            <div class="bd-grid">
              <button
                v-for="s in lineStyles"
                :key="s.value"
                type="button"
                class="bd-chip"
                :class="{ 'is-on': borderStyle === s.value }"
                @click="emit('update:borderStyle', s.value)"
              >{{ s.label }}</button>
            </div>

            <div class="bd-title">粗细</div>
            <div class="bd-grid">
              <button
                v-for="w in [1, 2, 3]"
                :key="w"
                type="button"
                class="bd-chip"
                :class="{ 'is-on': borderWidth === w }"
                @click="emit('update:borderWidth', w)"
              >{{ w }} px</button>
            </div>

            <div class="bd-title">线色</div>
            <div class="bd-colors">
              <UiColorPicker
                :model-value="borderColor"
                custom-label="自定义线色"
                @update:model-value="emit('update:borderColor', $event)"
              />
            </div>
          </div>
        </template>
      </UiDropdown>

      <span class="st-spacer" />
      <UiButton variant="ghost" size="sm" icon="table" @click="emit('fill')">批量填充</UiButton>
      <UiButton variant="ghost" size="sm" icon="trash" @click="emit('clear')">清空</UiButton>
    </div>
  </div>
</template>

<style scoped>
.sheet-toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.st-row { display: flex; align-items: center; gap: 2px; padding: 6px 10px; min-height: 44px; flex-wrap: wrap; }
.st-row-sub { border-top: 1px solid var(--border-soft); background: var(--bg-subtle); gap: 1px; }
.st-divider { width: 1px; height: 18px; background: var(--border); margin: 0 8px; }
.st-spacer { flex: 1; }
.st-selection { font-size: 11px; color: var(--text-muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
.st-group-label { font-size: 11px; color: var(--text-disabled); margin: 0 6px 0 2px; }

/* 边框设置下拉 */
.bd-menu { padding: 4px 2px 6px; }
.bd-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 8px 4px; font-size: 11px; color: var(--text-muted);
}
.bd-title span { font-size: 10px; color: var(--text-disabled); }
.bd-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding: 0 6px; }
.bd-chip {
  height: 26px; padding: 0 4px; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius-xs);
  background: var(--bg-panel); color: var(--text-secondary);
  font-size: 11.5px; white-space: nowrap;
}
.bd-chip:hover { background: var(--bg-hover); color: var(--text-primary); }
.bd-chip.is-on { border-color: var(--primary-line); background: var(--primary-soft); color: var(--primary-hover); }
.bd-chip.is-danger { color: var(--danger); }
.bd-chip.is-danger:hover { background: var(--danger-soft); border-color: var(--danger-line); }
.bd-sep { height: 1px; margin: 6px 8px; background: var(--border-soft); }
.bd-colors { padding: 2px 8px 0; }
</style>
