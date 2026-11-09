<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RankDef, RosterPlan } from '../types'
import { saveRoster, state } from '../store'
import { uid } from '../engine/geometry'
import { UiSelect, UiModal } from '../ui'

const props = withDefaults(defineProps<{ initialRosterId?: string }>(), { initialRosterId: '' })
const emit = defineEmits<{ (e: 'back'): void }>()

const COLORS = ['#2E4654', '#3D5A6C', '#587A8E', '#7C9AA8', '#8B623D', '#A4774E', '#C2A079', '#5A7A61', '#6E7364', '#939B9A']

const first = state.rosters.find((r) => r.id === props.initialRosterId) ?? state.rosters[0]
const selectedId = ref(first?.id ?? '')
const draft = ref<RosterPlan | null>(null)
const dirty = ref(false)
const toast = ref('')
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
  state.rosters.map((r) => ({ value: r.id, label: r.name, hint: `${r.members.length} 人` }))
)

const sortedRanks = computed(() =>
  draft.value ? [...draft.value.ranks].sort((a, b) => a.order - b.order) : []
)

const usedCount = computed(() =>
  draft.value ? draft.value.ranks.filter((r) => draft.value!.members.some((m) => m.rankId === r.id)).length : 0
)

function memberCount(rankId: string): number {
  return draft.value?.members.filter((m) => m.rankId === rankId).length ?? 0
}

async function persist(): Promise<void> {
  if (!draft.value) return
  await saveRoster(draft.value)
  dirty.value = false
}

async function save(): Promise<void> {
  if (!draft.value) return
  await persist()
  flash('职级序列已保存')
}

async function back(): Promise<void> {
  if (dirty.value) await persist()
  emit('back')
}

function move(id: string, dir: -1 | 1): void {
  const arr = sortedRanks.value
  const i = arr.findIndex((r) => r.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= arr.length) return
  const a = arr[i].order
  arr[i].order = arr[j].order
  arr[j].order = a
}

// ---- 拖拽排序 ----
const dragId = ref('')
const dropId = ref('')

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
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropId.value = id
}

function onDrop(id: string): void {
  const fromId = dragId.value
  dragId.value = ''
  dropId.value = ''
  if (!draft.value || !fromId || fromId === id) return
  const arr = sortedRanks.value.slice()
  const from = arr.findIndex((r) => r.id === fromId)
  const to = arr.findIndex((r) => r.id === id)
  if (from < 0 || to < 0) return
  const [item] = arr.splice(from, 1)
  arr.splice(to, 0, item)
  arr.forEach((r, i) => { r.order = i })
}

function onDragEnd(): void { dragId.value = ''; dropId.value = '' }

// ---- 新增 / 编辑 ----
const rankOpen = ref(false)
const editingId = ref<string | null>(null)
const form = ref({ name: '', shortName: '', color: COLORS[1] })

function openAdd(): void {
  if (!draft.value) return
  editingId.value = null
  form.value = { name: '', shortName: '', color: COLORS[1] }
  rankOpen.value = true
}

function openEdit(r: RankDef): void {
  editingId.value = r.id
  form.value = { name: r.name, shortName: r.shortName ?? '', color: r.color }
  rankOpen.value = true
}

function submitRank(): void {
  if (!draft.value) return
  const name = form.value.name.trim()
  if (!name) { flash('请填写职级名称'); return }
  const shortName = form.value.shortName.trim()
  if (editingId.value) {
    const r = draft.value.ranks.find((x) => x.id === editingId.value)
    if (r) Object.assign(r, { name, shortName: shortName || undefined, color: form.value.color })
    flash('职级已更新')
  } else {
    draft.value.ranks.push({
      id: uid('rank'),
      name,
      shortName: shortName || undefined,
      color: form.value.color,
      order: sortedRanks.value.length
    })
    flash('已新增职级，位于序列末位')
  }
  rankOpen.value = false
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

function askDelete(r: RankDef): void {
  if (!draft.value) return
  if (draft.value.ranks.length <= 1) { flash('至少保留一个职级'); return }
  const used = memberCount(r.id)
  if (used > 0) { flash(`「${r.name}」还有 ${used} 人，请先调整这些人的职级`); return }
  ask('删除职级', `「${r.name}」将从序列中移除，此操作保存后生效。`, () => {
    if (!draft.value) return
    draft.value.ranks = draft.value.ranks.filter((x) => x.id !== r.id)
    sortedRanks.value.forEach((x, i) => { x.order = i })
    flash('职级已删除')
  })
}
</script>

<template>
  <header class="page-head">
    <div>
      <div class="page-eyebrow">名册与组织 / 职级序列</div>
      <h1 class="page-title">职级序列</h1>
      <p class="page-desc">序号即排座优先级，越靠前越先落座；同一职级内再按单位编制序列与名单顺序安排。颜色用于座位表与名册标识。</p>
    </div>
    <div class="head-actions">
      <div style="width: 176px">
        <UiSelect v-model="selectedId" :options="rosterOptions" placeholder="选择名册方案" size="sm" />
      </div>
      <button class="btn sm" @click="back">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M6 1L2 5l4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
        返回名册
      </button>
      <button class="btn sm" @click="openAdd">新增职级</button>
      <button class="btn sm primary" :disabled="!dirty" @click="save">{{ dirty ? '保存改动' : '已保存' }}</button>
    </div>
  </header>

  <div v-if="!draft" class="empty">当前没有名册方案，请先返回名册页新建方案。</div>

  <template v-else>
    <div class="stat-grid" style="grid-template-columns: repeat(3, minmax(0, 1fr))">
      <div class="stat"><div class="stat-k">职级数量</div><div class="stat-v">{{ sortedRanks.length }}</div></div>
      <div class="stat"><div class="stat-k">已使用</div><div class="stat-v">{{ usedCount }}</div></div>
      <div class="stat"><div class="stat-k">覆盖人数</div><div class="stat-v">{{ draft.members.length }}</div></div>
    </div>

    <div class="workspace">
      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">序列与顺序</div>
            <div class="card-sub">拖拽左侧手柄调整顺序，或用行内箭头微调；序号越小优先级越高</div>
          </div>
          <span class="tag ink">{{ sortedRanks.length }} 个职级</span>
        </div>

        <div class="seq-list">
          <div
            v-for="(r, i) in sortedRanks"
            :key="r.id"
            class="seq-row"
            :class="{ dragging: dragId === r.id, 'drop-target': dropId === r.id }"
            @dragover="onDragOver($event, r.id)"
            @dragleave="dropId = dropId === r.id ? '' : dropId"
            @drop.prevent="onDrop(r.id)"
          >
            <span
              class="seq-handle"
              draggable="true"
              title="拖拽调整顺序"
              @dragstart="onDragStart($event, r.id)"
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
            <span class="seq-index mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="seq-swatch" :style="{ background: r.color }" />
            <span class="seq-name">{{ r.name }}</span>
            <span v-if="r.shortName" class="seq-meta">{{ r.shortName }}</span>
            <span class="seq-grow" />
            <span class="tag">{{ memberCount(r.id) }} 人</span>
            <div class="seq-actions">
              <button class="icon-btn" :disabled="i === 0" title="上移" @click="move(r.id, -1)">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8V2M2 5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
              </button>
              <button class="icon-btn" :disabled="i === sortedRanks.length - 1" title="下移" @click="move(r.id, 1)">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2v6M2 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" /></svg>
              </button>
              <button class="btn ghost xs" @click="openEdit(r)">编辑</button>
              <button class="btn ghost xs" style="color: var(--danger)" @click="askDelete(r)">删除</button>
            </div>
          </div>
          <div v-if="!sortedRanks.length" class="empty">还没有职级，点右上「新增职级」开始。</div>
        </div>
      </section>

      <div class="panel">
        <section class="card tight">
          <div class="card-title" style="margin-bottom: 10px">顺序如何生效</div>
          <div class="row-list">
            <div class="row-item" style="align-items: flex-start">
              <span class="tag ink">01</span>
              <div class="grow caption" style="font-size: 11px">主席台与台下都先按职级序号安排，序号 1 最先落座。</div>
            </div>
            <div class="row-item" style="align-items: flex-start">
              <span class="tag ink">02</span>
              <div class="grow caption" style="font-size: 11px">同一职级内按单位编制序列，再按名单顺序排定先后。</div>
            </div>
            <div class="row-item" style="align-items: flex-start">
              <span class="tag ink">03</span>
              <div class="grow caption" style="font-size: 11px">颜色继承到座位表、名册与导出图片，建议相邻职级色相拉开。</div>
            </div>
          </div>
        </section>

        <section class="card tight">
          <div class="card-head">
            <div class="card-title">名册</div>
            <span class="tag">{{ draft.members.length }} 人</span>
          </div>
          <div class="caption">当前配置属于「{{ draft.name }}」。切换上方名册方案会加载对应的一套职级序列。</div>
        </section>
      </div>
    </div>
  </template>

  <UiModal
    v-model="rankOpen"
    :title="editingId ? '编辑职级' : '新增职级'"
    description="名称用于名册与座位图，颜色用于职级标识"
  >
    <div class="field-row">
      <div class="field">
        <label>职级名称</label>
        <input v-model="form.name" class="input" placeholder="如：一级巡视员" @keyup.enter="submitRank" />
      </div>
      <div class="field">
        <label>简称（可选）</label>
        <input v-model="form.shortName" class="input" placeholder="如：一级" @keyup.enter="submitRank" />
      </div>
    </div>
    <div class="field">
      <label>标识颜色</label>
      <div class="swatch-row">
        <button
          v-for="c in COLORS"
          :key="c"
          type="button"
          class="swatch"
          :class="{ on: form.color === c }"
          :style="{ background: c }"
          :title="c"
          @click="form.color = c"
        />
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="rankOpen = false">取消</button>
      <button class="btn primary" @click="submitRank">{{ editingId ? '保存修改' : '添加职级' }}</button>
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
