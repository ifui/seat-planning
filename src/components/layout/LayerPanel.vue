<script setup lang="ts">
/**
 * 图层面板：类似 PS 的图层树，支持分组（文件夹）、折叠、重命名、锁定、解散。
 * 只负责展示与交互意图，所有数据变更通过事件交还给页面/store。
 */
import { computed, nextTick, ref } from 'vue'
import type { BaseElement, LayerGroup } from '../../types'
import { elTitle, TYPE_LABEL } from '../../labels'
import { UiIcon } from '../../ui'

const props = defineProps<{
  elements: BaseElement[]
  groups: LayerGroup[]
  selectedIds: string[]
}>()

const emit = defineEmits<{
  (e: 'select', ids: string[]): void
  (e: 'create-group'): void
  (e: 'rename-group', id: string, name: string): void
  (e: 'toggle-lock', id: string): void
  (e: 'toggle-collapse', id: string): void
  (e: 'ungroup', id: string): void
}>()

interface GroupRow {
  kind: 'group'
  group: LayerGroup
  children: BaseElement[]
  sortZ: number
}
interface ElRow {
  kind: 'el'
  el: BaseElement
  sortZ: number
}
type Row = GroupRow | ElRow

const lockedGroupIds = computed(() => new Set(props.groups.filter((g) => g.locked).map((g) => g.id)))

function elLocked(el: BaseElement): boolean {
  return !!el.locked || (!!el.groupId && lockedGroupIds.value.has(el.groupId))
}

/** 分组整体按组内最高 z 定位，未分组元素按自身 z 混排，保证与画布层级一致 */
const rows = computed<Row[]>(() => {
  const groupIds = new Set(props.groups.map((g) => g.id))
  const members = new Map<string, BaseElement[]>()
  const loose: BaseElement[] = []
  for (const e of props.elements) {
    if (e.groupId && groupIds.has(e.groupId)) {
      const list = members.get(e.groupId) ?? []
      list.push(e)
      members.set(e.groupId, list)
    } else {
      loose.push(e)
    }
  }
  const out: Row[] = []
  for (const g of props.groups) {
    const children = [...(members.get(g.id) ?? [])].sort((a, b) => (b.z ?? 0) - (a.z ?? 0))
    out.push({ kind: 'group', group: g, children, sortZ: children.length ? Math.max(...children.map((c) => c.z ?? 0)) : -1 })
  }
  for (const el of loose) out.push({ kind: 'el', el, sortZ: el.z ?? 0 })
  return out.sort((a, b) => b.sortZ - a.sortZ)
})

const editingId = ref<string | null>(null)
const nameDraft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

function startRename(g: LayerGroup): void {
  editingId.value = g.id
  nameDraft.value = g.name
  nextTick(() => {
    // v-for 内的模板 ref 在运行时可能是数组
    const raw = nameInput.value as unknown
    const node = (Array.isArray(raw) ? raw[0] : raw) as HTMLInputElement | null
    node?.focus()
    node?.select()
  })
}

function commitName(g: LayerGroup): void {
  if (editingId.value !== g.id) return
  const name = nameDraft.value.trim()
  editingId.value = null
  if (name && name !== g.name) emit('rename-group', g.id, name)
}

function onGroupClick(g: LayerGroup, additive: boolean): void {
  const ids = props.elements.filter((e) => e.groupId === g.id).map((e) => e.id)
  emit('select', additive ? [...new Set([...props.selectedIds, ...ids])] : ids)
}

function onElClick(el: BaseElement, additive: boolean): void {
  if (!additive) {
    emit('select', [el.id])
    return
  }
  emit('select', props.selectedIds.includes(el.id) ? props.selectedIds.filter((id) => id !== el.id) : [...props.selectedIds, el.id])
}
</script>

<template>
  <div class="prop-section">
    <div class="prop-title">
      图层
      <span class="caption">自上层起</span>
      <button class="btn xs" style="margin-left: auto" title="把选中元素放入一个新分组" @click="emit('create-group')">
        <UiIcon name="project" :size="12" />建组
      </button>
    </div>
    <div class="el-list">
      <template v-for="row in rows" :key="row.kind === 'group' ? row.group.id : row.el.id">
        <div v-if="row.kind === 'group'" class="layer-group" :class="{ locked: row.group.locked }">
          <div class="layer-group-head" @click="onGroupClick(row.group, $event.shiftKey)">
            <button class="group-chevron" :class="{ collapsed: row.group.collapsed }" @click.stop="emit('toggle-collapse', row.group.id)">
              <UiIcon name="chevronDown" :size="11" />
            </button>
            <UiIcon name="project" :size="13" />
            <input
              v-if="editingId === row.group.id"
              ref="nameInput"
              v-model="nameDraft"
              class="group-name-input"
              @click.stop
              @keydown.enter.prevent="commitName(row.group)"
              @keydown.esc="editingId = null"
              @blur="commitName(row.group)"
            />
            <span v-else class="group-name" title="双击重命名" @dblclick.stop="startRename(row.group)">{{ row.group.name }}</span>
            <span class="tag">{{ row.children.length }}</span>
            <button class="icon-btn" :title="row.group.locked ? '解锁分组' : '锁定分组'" @click.stop="emit('toggle-lock', row.group.id)">
              <UiIcon :name="row.group.locked ? 'lock' : 'unlock'" :size="12" />
            </button>
            <button class="icon-btn" title="解散分组（保留元素）" @click.stop="emit('ungroup', row.group.id)">
              <UiIcon name="trash" :size="12" />
            </button>
          </div>
          <div v-if="!row.group.collapsed" class="layer-group-children">
            <div
              v-for="e in row.children"
              :key="e.id"
              class="el-row child"
              :class="{ active: selectedIds.includes(e.id) }"
              @click="onElClick(e, $event.shiftKey)"
            >
              <span class="dot" style="background: #cbd3d5" />
              <span class="layer-name">{{ elTitle(e) }}</span>
              <span v-if="elLocked(e)" class="tag">锁</span>
              <span class="type-tag">{{ TYPE_LABEL[e.type] }}</span>
            </div>
          </div>
        </div>
        <div
          v-else
          class="el-row"
          :class="{ active: selectedIds.includes(row.el.id) }"
          @click="onElClick(row.el, $event.shiftKey)"
        >
          <span class="dot" style="background: #cbd3d5" />
          <span class="layer-name">{{ elTitle(row.el) }}</span>
          <span v-if="elLocked(row.el)" class="tag">锁</span>
          <span class="type-tag">{{ TYPE_LABEL[row.el.type] }}</span>
        </div>
      </template>
      <div v-if="!rows.length" class="caption" style="padding: 8px 2px">画布还没有元素。</div>
    </div>
  </div>
</template>
