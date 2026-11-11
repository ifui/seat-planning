<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RosterPlan, UnitNode } from '../types'
import { saveRoster, state } from '../store'
import { uid } from '../engine/sheet'
import { UiSelect, UiModal } from '../ui'

const props = withDefaults(defineProps<{ initialRosterId?: string }>(), { initialRosterId: '' })
const emit = defineEmits<{ (e: 'back'): void }>()

const first = state.rosters.find((r) => r.id === props.initialRosterId) ?? state.rosters[0]
const selectedId = ref(first?.id ?? '')
const draft = ref<RosterPlan | null>(null)
const dirty = ref(false)
const toast = ref('')
const collapsed = ref<Set<string>>(new Set())
let loading = false

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2200)
}

function load(id: string): void {
  const found = state.rosters.find((r) => r.id === id)
  loading = true
  draft.value = found ? clone(found) : null
  dirty.value = false
  collapsed.value = new Set()
  setTimeout(() => { loading = false }, 0)
}

watch(selectedId, (id) => load(id), { immediate: true })
watch(draft, () => { if (draft.value && !loading) dirty.value = true }, { deep: true })
watch(
  () => state.rosters.map((r) => r.id).join(','),
  () => {
    if (!state.rosters.some((r) => r.id === selectedId.value)) selectedId.value = state.rosters[0]?.id ?? ''
  }
)

const rosterOptions = computed(() =>
  state.rosters.map((r) => ({ value: r.id, label: r.name }))
)

function childrenOf(parentId: string | null): UnitNode[] {
  return (draft.value?.units ?? [])
    .filter((u) => u.parentId === parentId)
    .sort((a, b) => a.order - b.order)
}

function depthOf(u: UnitNode): number {
  let d = 0
  let p = u.parentId ? draft.value?.units.find((x) => x.id === u.parentId) : undefined
  let guard = 0
  while (p && guard++ < 30) { d++; p = p.parentId ? draft.value?.units.find((x) => x.id === p!.parentId) : undefined }
  return d
}

function pathName(u: UnitNode): string {
  const names: string[] = [u.name]
  let p = u.parentId ? draft.value?.units.find((x) => x.id === u.parentId) : undefined
  let guard = 0
  while (p && guard++ < 30) { names.unshift(p.name); p = p.parentId ? draft.value?.units.find((x) => x.id === p!.parentId) : undefined }
  return names.join(' / ')
}

function memberCount(unitId: string): number {
  return draft.value?.members.filter((m) => m.unitId === unitId).length ?? 0
}

interface FlatUnit { node: UnitNode; depth: number; hasChildren: boolean; childCount: number }

const flat = computed<FlatUnit[]>(() => {
  if (!draft.value) return []
  const out: FlatUnit[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const u of childrenOf(parentId)) {
      const kids = childrenOf(u.id)
      out.push({ node: u, depth, hasChildren: kids.length > 0, childCount: kids.length })
      if (kids.length && !collapsed.value.has(u.id)) walk(u.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
})

const maxDepth = computed(() => {
  if (!draft.value) return 0
  return draft.value.units.reduce((m, u) => Math.max(m, depthOf(u) + 1), 0)
})

const coveredMembers = computed(() => {
  if (!draft.value) return 0
  return draft.value.members.filter((m) => draft.value!.units.some((u) => u.id === m.unitId)).length
})

async function persist(): Promise<void> {
  if (!draft.value) return
  await saveRoster(draft.value)
  dirty.value = false
}

async function save(): Promise<void> {
  if (!draft.value) return
  await persist()
  flash('单位编制序列已保存')
}

async function back(): Promise<void> {
  if (dirty.value) await persist()
  emit('back')
}

function normalize(parentId: string | null): void {
  childrenOf(parentId).forEach((u, i) => { u.order = i })
}

function move(id: string, dir: -1 | 1): void {
  if (!draft.value) return
  const u = draft.value.units.find((x) => x.id === id)
  if (!u) return
  const siblings = childrenOf(u.parentId)
  const i = siblings.findIndex((x) => x.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= siblings.length) return
  const a = siblings[i].order
  siblings[i].order = siblings[j].order
  siblings[j].order = a
}

function toggle(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

// ---- 拖拽排序 ----
const dragId = ref('')
const dropId = ref('')

function isDescendant(ancestorId: string, id: string): boolean {
  let cur: UnitNode | undefined = draft.value?.units.find((u) => u.id === id)
  let guard = 0
  while (cur && cur.parentId && guard++ < 30) {
    if (cur.parentId === ancestorId) return true
    cur = draft.value?.units.find((u) => u.id === cur!.parentId)
  }
  return false
}

function onDragStart(e: DragEvent, id: string): void {
  dragId.value = id
  dropId.value = ''
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(e: DragEvent, id: string): void {
  if (!dragId.value || dragId.value === id) return
  if (isDescendant(dragId.value, id)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropId.value = id
}

function onDrop(id: string): void {
  const fromId = dragId.value
  dragId.value = ''
  dropId.value = ''
  if (!draft.value || !fromId || fromId === id) return
  const moving = draft.value.units.find((u) => u.id === fromId)
  const target = draft.value.units.find((u) => u.id === id)
  if (!moving || !target) return
  if (isDescendant(moving.id, target.id)) return
  const oldParent = moving.parentId
  moving.parentId = target.parentId
  const siblings = childrenOf(target.parentId).filter((u) => u.id !== moving.id)
  const at = Math.max(0, siblings.findIndex((u) => u.id === target.id))
  siblings.splice(at, 0, moving)
  siblings.forEach((u, i) => { u.order = i })
  if (oldParent !== target.parentId) normalize(oldParent)
}

function onDragEnd(): void { dragId.value = ''; dropId.value = '' }

// ---- 新增 / 编辑 ----
const unitOpen = ref(false)
const editingId = ref<string | null>(null)
const parentLocked = ref<string | null>(null)
const form = ref({ name: '', code: '', parentId: '' })

const parentOptions = computed(() => {
  if (!draft.value) return [{ value: '', label: '无（根级单位）' }]
  const excluded = new Set<string>()
  if (editingId.value) {
    excluded.add(editingId.value)
    for (const u of draft.value.units) if (isDescendant(editingId.value, u.id)) excluded.add(u.id)
  }
  const opts: { value: string; label: string }[] = [{ value: '', label: '无（根级单位）' }]
  for (const u of draft.value.units) {
    if (excluded.has(u.id)) continue
    opts.push({ value: u.id, label: `${'　'.repeat(depthOf(u))}${u.name}` })
  }
  return opts
})

function openAdd(parentId: string | null): void {
  if (!draft.value) return
  editingId.value = null
  parentLocked.value = parentId
  form.value = { name: '', code: '', parentId: parentId ?? '' }
  unitOpen.value = true
}

function openEdit(u: UnitNode): void {
  editingId.value = u.id
  parentLocked.value = null
  form.value = { name: u.name, code: u.code ?? '', parentId: u.parentId ?? '' }
  unitOpen.value = true
}

function submitUnit(): void {
  if (!draft.value) return
  const name = form.value.name.trim()
  if (!name) { flash('请填写单位名称'); return }
  const parentId = form.value.parentId || null
  const code = form.value.code.trim()
  if (editingId.value) {
    const u = draft.value.units.find((x) => x.id === editingId.value)
    if (!u) return
    const parentChanged = u.parentId !== parentId
    const oldParent = u.parentId
    Object.assign(u, { name, code: code || undefined, parentId })
    if (parentChanged) {
      u.order = childrenOf(parentId).filter((x) => x.id !== u.id).length
      normalize(oldParent)
    }
    flash('单位已更新')
  } else {
    const order = childrenOf(parentId).length
    draft.value.units.push({ id: uid('unit'), name, code: code || undefined, parentId, order })
    if (parentId) {
      const next = new Set(collapsed.value)
      next.delete(parentId)
      collapsed.value = next
    }
    flash('已新增单位')
  }
  unitOpen.value = false
}

// ---- 删除 ----
const confirmState = ref<{ open: boolean; title: string; desc: string; action: () => void }>({
  open: false, title: '', desc: '', action: () => {}
})

function ask(title: string, desc: string, action: () => void): void {
  confirmState.value = { open: true, title, desc, action }
}

function runConfirm(): void {
  confirmState.value.action()
  confirmState.value.open = false
}

function askDelete(u: UnitNode): void {
  if (!draft.value) return
  if (childrenOf(u.id).length > 0) { flash('该单位还有下级，请先删除或移走下级单位'); return }
  const count = memberCount(u.id)
  if (count > 0) { flash(`该单位下还有 ${count} 人，请先调整人员单位`); return }
  ask('删除单位', `「${u.name}」将从编制序列中移除，此操作保存后生效。`, () => {
    if (!draft.value) return
    const parentId = u.parentId
    draft.value.units = draft.value.units.filter((x) => x.id !== u.id)
    normalize(parentId)
    flash('单位已删除')
  })
}
</script>

<template>
  <header class="page-head">
    <div>
      <div class="page-eyebrow">名册与组织 / 单位编制序列</div>
      <h1 class="page-title">单位编制序列</h1>
    </div>
    <div class="head-actions">
      <div style="width: 176px">
        <UiSelect v-model="selectedId" :options="rosterOptions" placeholder="选择名册方案" size="sm" />
      </div>
      <button class="btn sm" @click="back">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M6 1L2 5l4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
        返回名册
      </button>
      <button class="btn sm" @click="openAdd(null)">新增单位</button>
      <button class="btn sm primary" :disabled="!dirty" @click="save">{{ dirty ? '保存改动' : '已保存' }}</button>
    </div>
  </header>

  <div v-if="!draft" class="empty">当前没有名册方案，请先返回名册页新建方案。</div>

  <template v-else>
    <div class="stat-grid">
      <div class="stat"><span class="stat-k">单位数量</span><span class="stat-v">{{ draft.units.length }}</span></div>
      <div class="stat"><span class="stat-k">最大层级</span><span class="stat-v">{{ maxDepth }}</span></div>
      <div class="stat"><span class="stat-k">已归属人员</span><span class="stat-v">{{ coveredMembers }}</span></div>
    </div>

    <section class="card">
      <div class="card-head">
        <div class="card-title">编制树</div>
        <div class="head-actions">
          <button class="btn ghost xs" @click="collapsed = new Set()">全部展开</button>
          <span class="tag ink">{{ flat.length }} / {{ draft.units.length }}</span>
        </div>
      </div>

      <div class="seq-list">
        <div
          v-for="row in flat"
          :key="row.node.id"
          class="seq-row"
          :class="{ dragging: dragId === row.node.id, 'drop-target': dropId === row.node.id, 'is-parent': row.hasChildren }"
          :style="{ paddingLeft: 12 + row.depth * 22 + 'px' }"
          @dragover="onDragOver($event, row.node.id)"
          @dragleave="dropId = dropId === row.node.id ? '' : dropId"
          @drop.prevent="onDrop(row.node.id)"
        >
          <button
            v-if="row.hasChildren"
            class="seq-collapse"
            :title="collapsed.has(row.node.id) ? '展开' : '收起'"
            @click="toggle(row.node.id)"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" :style="{ transform: collapsed.has(row.node.id) ? 'rotate(-90deg)' : '', transition: 'transform .15s ease' }">
              <path d="M1 2l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <span v-else class="seq-collapse" style="cursor: default">
            <svg width="5" height="5" viewBox="0 0 5 5"><circle cx="2.5" cy="2.5" r="1.4" fill="#c9c7be" /></svg>
          </span>

          <span
            class="seq-handle"
            draggable="true"
            title="拖拽调整顺序或归属"
            @dragstart="onDragStart($event, row.node.id)"
            @dragend="onDragEnd"
          >
            <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
              <g fill="currentColor">
                <circle cx="2.5" cy="3" r="1.1" /><circle cx="7.5" cy="3" r="1.1" />
                <circle cx="2.5" cy="7" r="1.1" /><circle cx="7.5" cy="7" r="1.1" />
                <circle cx="2.5" cy="11" r="1.1" /><circle cx="7.5" cy="11" r="1.1" />
              </g>
            </svg>
          </span>

          <span class="seq-name">{{ row.node.name }}</span>
          <span v-if="row.node.code" class="tag">{{ row.node.code }}</span>
          <span class="seq-grow" />
          <span v-if="row.childCount" class="seq-meta">下辖 {{ row.childCount }}</span>
          <span class="tag">{{ memberCount(row.node.id) }} 人</span>

          <div class="seq-actions">
            <button class="icon-btn" :disabled="!draft.units.some(u => u.parentId === row.node.id && u.order < row.node.order)" title="上移" @click="move(row.node.id, -1)">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8V2M2 5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
            </button>
            <button class="icon-btn" :disabled="!draft.units.some(u => u.parentId === row.node.id && u.order > row.node.order)" title="下移" @click="move(row.node.id, 1)">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2v6M2 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
            </button>
            <button class="btn ghost xs" @click="openAdd(row.node.id)">加下级</button>
            <button class="btn ghost xs" @click="openEdit(row.node)">编辑</button>
            <button class="btn ghost xs" style="color: var(--danger)" @click="askDelete(row.node)">删除</button>
          </div>
        </div>
        <div v-if="!flat.length" class="empty">还没有单位，点右上「新增单位」开始。</div>
      </div>
    </section>
  </template>

  <UiModal
    v-model="unitOpen"
    :title="editingId ? '编辑单位' : '新增单位'"
  >
    <div class="field-row">
      <div class="field">
        <label>单位名称</label>
        <input v-model="form.name" class="input" placeholder="如：办公室" @keyup.enter="submitUnit" />
      </div>
      <div class="field">
        <label>单位编号（可选）</label>
        <input v-model="form.code" class="input" placeholder="如：A01" @keyup.enter="submitUnit" />
      </div>
    </div>
    <div class="field">
      <label>上级单位</label>
      <UiSelect
        :model-value="form.parentId"
        :options="parentOptions"
        :disabled="parentLocked !== null && !editingId"
        placeholder="无（根级单位）"
        @update:model-value="form.parentId = $event"
      />
      <span v-if="parentLocked !== null && !editingId" class="caption">上级已锁定，可用「编辑」调整。</span>
    </div>
    <template #footer>
      <button class="btn" @click="unitOpen = false">取消</button>
      <button class="btn primary" @click="submitUnit">{{ editingId ? '保存修改' : '添加单位' }}</button>
    </template>
  </UiModal>

  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">确认删除</button>
    </template>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
