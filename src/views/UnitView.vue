<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RosterPlan, UnitNode } from '../types'
import { saveRoster, state } from '../store'
import { uid } from '../engine/sheet'
import {
  duplicateUnitGroups,
  nameKey,
  normalizeName,
  unitPathOf,
  type UnitDuplicateGroup,
} from '../engine/unitMatch'
import { UiButton, UiIconButton, UiInput, UiModal, UiSelect } from '../ui'

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

async function persist(): Promise<boolean> {
  if (!draft.value) return true
  try {
    await saveRoster(draft.value)
    dirty.value = false
    return true
  } catch (e: any) {
    flash(e?.message || '保存失败')
    return false
  }
}

async function save(): Promise<void> {
  if (!draft.value) return
  if (await persist()) flash('单位编制序列已保存')
}

async function back(): Promise<void> {
  if (dirty.value && !(await persist())) return
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
  const name = normalizeName(form.value.name)
  if (!name) { flash('请填写单位名称'); return }
  // 单位名称全树唯一：重名直接拦下，并说明和哪个已有单位冲突
  const key = nameKey(name)
  const clash = draft.value.units.find(
    (u) => u.id !== editingId.value && nameKey(u.name) === key
  )
  if (clash) {
    flash(`「${name}」与已有单位重名（${unitPathOf(draft.value.units, clash.id)}），单位名称必须全树唯一`)
    return
  }
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

// ---- 重名单位：统计 + 人工合并 / 改名 ----
const dupGroups = computed<UnitDuplicateGroup[]>(() =>
  draft.value ? duplicateUnitGroups(draft.value.units) : []
)

/** 每组选中的保留单位，默认第一个 */
const keepIds = ref<Record<string, string>>({})

function keepOf(group: UnitDuplicateGroup): string {
  const picked = keepIds.value[group.key]
  return picked && group.nodes.some((n) => n.id === picked)
    ? picked
    : group.nodes[0].id
}

function setKeep(group: UnitDuplicateGroup, id: string): void {
  keepIds.value = { ...keepIds.value, [group.key]: id }
}

function askMerge(group: UnitDuplicateGroup): void {
  const d = draft.value
  if (!d) return
  const keepId = keepOf(group)
  const keep = d.units.find((u) => u.id === keepId)
  if (!keep) return
  const others = group.nodes.filter((n) => n.id !== keepId)
  // 保留单位在下级里时不能合并，否则会形成环
  if (others.some((n) => isDescendant(n.id, keepId))) {
    flash('不能让保留单位并入自己的下级，请先调整层级')
    return
  }
  const moved = d.members.filter((m) => others.some((n) => n.id === m.unitId)).length
  ask(
    '合并重名单位',
    `把「${group.name}」的 ${others.length} 个同名单位合并到「${unitPathOf(d.units, keepId)}」，其下 ${moved} 人与下级单位会一并转移。`,
    () => {
      const target = draft.value
      if (!target) return
      const parentIds = new Set<string | null>()
      for (const node of others) {
        parentIds.add(node.parentId)
        for (const m of target.members) if (m.unitId === node.id) m.unitId = keepId
        for (const u of target.units) if (u.parentId === node.id) u.parentId = keepId
        target.units = target.units.filter((u) => u.id !== node.id)
      }
      parentIds.forEach((p) => normalize(p))
      normalize(keep.parentId)
      const next = { ...keepIds.value }
      delete next[group.key]
      keepIds.value = next
      flash(`已合并 ${others.length} 个重名单位到「${keep.name}」`)
    }
  )
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
    <div class="page-head-main">
      <div class="page-eyebrow has-back">
        <UiIconButton
          class="seq-back"
          icon="chevronLeft"
          :icon-size="12"
          title="返回名册方案"
          aria-label="返回名册方案"
          @click="back"
        />
        <span>名册与组织 / 单位编制序列</span>
      </div>
      <h1 class="page-title">单位编制序列</h1>
    </div>
    <div class="head-actions">
      <div style="width: 176px">
        <UiSelect v-model="selectedId" :options="rosterOptions" placeholder="选择名册方案" size="sm" />
      </div>
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

    <section v-if="dupGroups.length" class="card dup-card">
      <div class="card-head">
        <div class="card-title">重名单位待处理</div>
        <span class="tag ink">{{ dupGroups.length }} 组</span>
      </div>
      <p class="dup-lead">
        单位名称必须全树唯一。请为每组选择保留的单位，再把其余同名单位合并过去，或逐个改名。
      </p>
      <div v-for="g in dupGroups" :key="g.key" class="dup-group">
        <div class="dup-group-head">
          <span class="dup-name">{{ g.name }}</span>
          <span class="dup-count">{{ g.nodes.length }} 个同名</span>
        </div>
        <div class="dup-nodes">
          <label v-for="n in g.nodes" :key="n.id" class="dup-node">
            <input
              type="radio"
              :name="'dup-' + g.key"
              :checked="keepOf(g) === n.id"
              @change="setKeep(g, n.id)"
            />
            <span class="dup-path">{{ unitPathOf(draft?.units ?? [], n.id) }}</span>
            <span class="dup-meta">{{ memberCount(n.id) }} 人</span>
            <button class="btn ghost xs" @click.prevent="openEdit(n)">改名</button>
          </label>
        </div>
        <div class="dup-actions">
          <button class="btn sm" @click="askMerge(g)">合并其余 {{ g.nodes.length - 1 }} 个到所选</button>
        </div>
      </div>
    </section>

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
        <UiInput v-model="form.name" placeholder="如：办公室" @keyup.enter="submitUnit" />
      </div>
      <div class="field">
        <label>单位编号（可选）</label>
        <UiInput v-model="form.code" placeholder="如：A01" @keyup.enter="submitUnit" />
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
      <UiButton variant="ghost" @click="unitOpen = false">取消</UiButton>
      <UiButton variant="primary" @click="submitUnit">{{ editingId ? '保存修改' : '添加单位' }}</UiButton>
    </template>
  </UiModal>

  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <UiButton variant="ghost" @click="confirmState.open = false">取消</UiButton>
      <UiButton variant="danger" @click="runConfirm">确认删除</UiButton>
    </template>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>

<style scoped>
.dup-card { border-color: var(--danger-line); }
.dup-lead {
  margin: 0 0 12px;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-muted);
}
.dup-group {
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.dup-group + .dup-group { margin-top: 10px; }
.dup-group-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.dup-name { font-size: var(--fs-sm); color: var(--text-primary); }
.dup-count {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--danger);
  background: var(--danger-soft);
}
.dup-nodes { display: flex; flex-direction: column; gap: 6px; }
.dup-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-xs);
  cursor: pointer;
}
.dup-node:hover { background: var(--bg-hover); }
.dup-node input { accent-color: var(--primary); }
.dup-path { font-size: var(--fs-xs); color: var(--text-secondary); }
.dup-meta { font-size: var(--fs-xs); color: var(--text-muted); }
.dup-node .btn { margin-left: auto; }
.dup-actions { margin-top: 8px; }
</style>
