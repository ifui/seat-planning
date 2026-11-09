<script setup lang="ts">
import { ref } from 'vue'
import type { ElementType, ShapeKind } from '../../types'
import { UiButton, UiDropdown, UiIcon, UiIconButton, UiToolbar, UiToolbarGroup } from '../../ui'
import { ADD_ITEMS, ALIGN_ACTIONS, SHAPE_MENU, type AlignKey } from './options'

defineProps<{
  elementCount: number
  seatCount: number
  disabledCount: number
  selectedCount: number
  canAlign: boolean
  canDistribute: boolean
  canUndo: boolean
  canRedo: boolean
  hasClipboard: boolean
  /** 有网格时的摘要，如「网格 10×11」；为空表示自由布局 */
  gridLabel?: string
}>()

const emit = defineEmits<{
  (e: 'add', type: ElementType): void
  (e: 'add-shape', kind: ShapeKind): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'copy'): void
  (e: 'paste'): void
  (e: 'duplicate'): void
  (e: 'delete'): void
  (e: 'tidy'): void
  (e: 'generate'): void
  (e: 'align', key: AlignKey): void
  (e: 'distribute', axis: 'h' | 'v'): void
  (e: 'layer', action: 'front' | 'up' | 'down' | 'back'): void
  (e: 'grid'): void
}>()

const shapeExpanded = ref(false)
</script>

<template>
  <UiToolbar>
    <UiToolbarGroup>
      <UiDropdown :width="288">
        <template #trigger="{ open }">
          <button type="button" class="tb-add" :class="{ open }" title="添加元素">
            <UiIcon name="plus" :size="14" />
            <span class="tb-add-text">添加</span>
            <UiIcon name="chevronDown" :size="11" class="caret" />
          </button>
        </template>
        <template #default="{ close }">
          <div class="add-menu">
            <div class="ui-menu-label">添加元素</div>
            <div class="add-grid">
              <button
                v-for="item in ADD_ITEMS"
                :key="item.key"
                type="button"
                class="add-item"
                :title="item.hint"
                @click="close(); emit('add', item.key)"
              >
                <UiIcon :name="item.icon" :size="17" />
                <span>{{ item.label }}</span>
              </button>
            </div>
            <div class="ui-menu-sep" />
            <button type="button" class="add-shape-toggle" @click="shapeExpanded = !shapeExpanded">
              <UiIcon name="diamond" :size="14" />
              <span>自定义图形</span>
              <span class="ui-menu-caret" :class="{ flip: shapeExpanded }">
                <UiIcon name="chevronRight" :size="11" />
              </span>
            </button>
            <div v-if="shapeExpanded" class="add-grid shapes">
              <button
                v-for="s in SHAPE_MENU"
                :key="s.value"
                type="button"
                class="add-item"
                :title="s.label"
                @click="close(); emit('add-shape', s.value)"
              >
                <UiIcon :name="s.value" :size="17" />
                <span>{{ s.label }}</span>
              </button>
            </div>
            <div class="add-hint">图形仅作装饰或区域标识，不参与排座。</div>
          </div>
        </template>
      </UiDropdown>
    </UiToolbarGroup>
    <div class="tb-sep" />
    <UiToolbarGroup>
      <UiIconButton icon="undo" title="撤销 Ctrl+Z" :disabled="!canUndo" @click="emit('undo')" />
      <UiIconButton icon="redo" title="重做 Ctrl+Shift+Z" :disabled="!canRedo" @click="emit('redo')" />
    </UiToolbarGroup>
    <div class="tb-sep" />
    <UiToolbarGroup>
      <UiIconButton icon="copy" title="复制 Ctrl+C" :disabled="!selectedCount" @click="emit('copy')" />
      <UiIconButton icon="paste" title="粘贴 Ctrl+V" :disabled="!hasClipboard" @click="emit('paste')" />
      <UiIconButton icon="duplicate" title="创建副本 Ctrl+D" :disabled="!selectedCount" @click="emit('duplicate')" />
      <UiIconButton icon="trash" title="删除 Del" danger :disabled="!selectedCount" @click="emit('delete')" />
    </UiToolbarGroup>
    <UiToolbarGroup margin-left>
      <UiButton variant="ghost" size="sm" icon="expand" title="把画布扩展到全部元素并适配窗口" @click="emit('tidy')">整理画布</UiButton>
      <UiButton variant="ghost" size="sm" icon="grid" :title="gridLabel || '按行列生成表格式网格，元素放进格子'" @click="emit('grid')">
        {{ gridLabel || '网格' }}
      </UiButton>
      <UiButton variant="copper" size="sm" icon="grid" @click="emit('generate')">批量生成桌子</UiButton>
    </UiToolbarGroup>
  </UiToolbar>

  <UiToolbar sub>
    <UiToolbarGroup label="对齐">
      <UiIconButton
        v-for="a in ALIGN_ACTIONS"
        :key="a.key"
        :icon="a.icon"
        :title="a.title"
        :disabled="!canAlign"
        @click="emit('align', a.key)"
      />
      <UiIconButton icon="distH" title="横向等间距分布" :disabled="!canDistribute" @click="emit('distribute', 'h')" />
      <UiIconButton icon="distV" title="纵向等间距分布" :disabled="!canDistribute" @click="emit('distribute', 'v')" />
    </UiToolbarGroup>
    <div class="tb-sep" />
    <UiToolbarGroup label="层级">
      <UiIconButton icon="front" title="置于顶层" :disabled="!selectedCount" @click="emit('layer', 'front')" />
      <UiIconButton icon="up" title="上移一层" :disabled="!selectedCount" @click="emit('layer', 'up')" />
      <UiIconButton icon="down" title="下移一层" :disabled="!selectedCount" @click="emit('layer', 'down')" />
      <UiIconButton icon="back" title="置于底层" :disabled="!selectedCount" @click="emit('layer', 'back')" />
    </UiToolbarGroup>
    <div class="tb-sep" />
    <div class="tb-group tb-meta">
      <span class="mono">{{ elementCount }} 元素 · {{ seatCount }} 座</span>
      <span v-if="disabledCount" class="tag ink">{{ disabledCount }} 个固定空位</span>
      <span v-if="selectedCount" class="tag copper">{{ selectedCount }} 已选</span>
    </div>
  </UiToolbar>
</template>
