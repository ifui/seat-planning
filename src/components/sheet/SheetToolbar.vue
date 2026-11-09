<script setup lang="ts">
import UiButton from '../../ui/components/UiButton.vue'

defineProps<{
  name: string
  canUndo: boolean
  canRedo: boolean
  selectionLabel: string
  cellCount: number
  seats: 1 | 2
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'setup'): void
  (e: 'save'): void
  (e: 'export'): void
  (e: 'import'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'insert-row'): void
  (e: 'delete-row'): void
  (e: 'insert-col'): void
  (e: 'delete-col'): void
  (e: 'merge'): void
  (e: 'unmerge'): void
  (e: 'type', kind: 'seat' | 'podium' | 'block', role?: 'aisle' | 'lectern' | 'backdrop' | 'label'): void
  (e: 'seats', n: 1 | 2): void
  (e: 'fill'): void
  (e: 'clear'): void
}>()
</script>

<template>
  <div class="sheet-toolbar">
    <div class="st-row">
      <UiButton variant="ghost" size="sm" icon="restore" title="放弃未保存修改，重新载入" @click="emit('back')">重载</UiButton>
      <span class="st-name">{{ name }}</span>
      <span class="st-divider" />

      <UiButton variant="ghost" size="sm" icon="grid" @click="emit('setup')">表格设置</UiButton>
      <UiButton variant="ghost" size="sm" icon="save" @click="emit('save')">保存</UiButton>
      <UiButton variant="ghost" size="sm" icon="export" @click="emit('export')">导出</UiButton>
      <UiButton variant="ghost" size="sm" icon="import" @click="emit('import')">导入</UiButton>

      <span class="st-spacer" />
      <span class="st-selection">{{ selectionLabel }}<template v-if="cellCount > 1"> · {{ cellCount }} 格</template></span>
      <UiButton variant="ghost" size="sm" icon="undo" :disabled="!canUndo" title="撤销 Ctrl+Z" @click="emit('undo')" />
      <UiButton variant="ghost" size="sm" icon="redo" :disabled="!canRedo" title="重做 Ctrl+Shift+Z" @click="emit('redo')" />
    </div>

    <div class="st-row st-row-sub">
      <span class="st-group-label">行列</span>
      <UiButton variant="ghost" size="sm" icon="plus" title="在上方插入行" @click="emit('insert-row')">行</UiButton>
      <UiButton variant="ghost" size="sm" icon="minus" title="删除选中行" @click="emit('delete-row')">行</UiButton>
      <UiButton variant="ghost" size="sm" icon="plus" title="在左侧插入列" @click="emit('insert-col')">列</UiButton>
      <UiButton variant="ghost" size="sm" icon="minus" title="删除选中列" @click="emit('delete-col')">列</UiButton>

      <span class="st-divider" />
      <span class="st-group-label">合并</span>
      <UiButton variant="ghost" size="sm" icon="square" @click="emit('merge')">合并</UiButton>
      <UiButton variant="ghost" size="sm" icon="expand" @click="emit('unmerge')">拆分</UiButton>

      <span class="st-divider" />
      <span class="st-group-label">类型</span>
      <UiButton variant="ghost" size="sm" icon="seat" @click="emit('type', 'seat')">座位</UiButton>
      <UiButton variant="ghost" size="sm" icon="podium" @click="emit('type', 'podium')">主席台</UiButton>
      <UiButton variant="ghost" size="sm" icon="aisle" @click="emit('type', 'block', 'aisle')">过道</UiButton>
      <UiButton variant="ghost" size="sm" icon="lectern" @click="emit('type', 'block', 'lectern')">讲台</UiButton>
      <UiButton variant="ghost" size="sm" icon="rect" @click="emit('type', 'block', 'backdrop')">背景板</UiButton>
      <UiButton variant="ghost" size="sm" icon="label" @click="emit('type', 'block', 'label')">标签</UiButton>

      <span class="st-divider" />
      <span class="st-group-label">座位规格</span>
      <UiButton :variant="seats === 1 ? 'primary' : 'ghost'" size="sm" @click="emit('seats', 1)">单人位</UiButton>
      <UiButton :variant="seats === 2 ? 'primary' : 'ghost'" size="sm" @click="emit('seats', 2)">双人位</UiButton>

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
.st-name { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 0 8px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-divider { width: 1px; height: 18px; background: var(--border); margin: 0 8px; }
.st-spacer { flex: 1; }
.st-selection { font-size: 11px; color: var(--text-muted); margin-right: 8px; font-variant-numeric: tabular-nums; }
.st-group-label { font-size: 11px; color: var(--text-disabled); margin: 0 6px 0 2px; }
</style>
