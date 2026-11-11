<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Member, RankDef, RosterPlan, UnitNode } from '../types'
import { removeRoster, saveRoster, state } from '../store'
import { nowISO, uid } from '../engine/sheet'
import { UiChart, UiIcon, UiIconButton, UiSelect, UiModal, COLOR_PRESETS } from '../ui'
import { chartAxisText, chartColors, chartFont, chartTooltip, type ChartOption } from '../ui/charts'
import ImportDialog from '../components/roster/ImportDialog.vue'

const emit = defineEmits<{ (e: 'open-ranks', rosterId: string): void; (e: 'open-units', rosterId: string): void }>()

const selectedId = ref<string>(state.rosters[0]?.id ?? '')
const draft = ref<RosterPlan | null>(null)
const dirty = ref(false)
const toast = ref('')
/** 仅用于表格行的选中高亮，不参与任何业务逻辑。 */
const activeId = ref<string | null>(null)
let loading = false

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

async function load(id: string): Promise<void> {
  if (dirty.value && draft.value && draft.value.id !== id) await flushAutosave()
  const found = state.rosters.find((r) => r.id === id)
  loading = true
  draft.value = found ? clone(found) : null
  dirty.value = false
  setTimeout(() => { loading = false }, 0)
}

watch(selectedId, (id) => load(id), { immediate: true })
watch(draft, () => { if (draft.value && !loading) markDirty() }, { deep: true })

// ---- 自动保存：停止编辑 900ms 后落盘 ----
let autosaveTimer = 0
let autosaveSeq = 0

function markDirty(): void {
  dirty.value = true
  autosaveSeq++
  const seq = autosaveSeq
  window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(async () => {
    if (seq !== autosaveSeq || !dirty.value || !draft.value) return
    await saveRoster(draft.value)
    if (seq === autosaveSeq) dirty.value = false
  }, 900)
}

async function flushAutosave(): Promise<void> {
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  if (!dirty.value || !draft.value) return
  await saveRoster(draft.value)
  dirty.value = false
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.clearTimeout(autosaveTimer)
  void flushAutosave()
})
watch(
  () => state.rosters.map((r) => r.id).join(','),
  () => {
    if (!state.rosters.some((r) => r.id === selectedId.value)) selectedId.value = state.rosters[0]?.id ?? ''
    else if (!draft.value) load(selectedId.value)
  }
)

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2200)
}

const rosterOptions = computed(() => state.rosters.map((r) => ({ value: r.id, label: r.name })))

const sortedRanks = computed(() =>
  draft.value ? [...draft.value.ranks].sort((a, b) => a.order - b.order) : []
)

const rankOptions = computed(() =>
  sortedRanks.value.map((r) => ({ value: r.id, label: r.name, color: r.color }))
)

interface UnitPath { node: UnitNode; depth: number; pathName: string; path: number[] }

const unitPaths = computed<UnitPath[]>(() => {
  if (!draft.value) return []
  const byId = new Map(draft.value.units.map((u) => [u.id, u]))
  const pathOf = (u: UnitNode): string => {
    const names: string[] = [u.name]
    let p = u.parentId ? byId.get(u.parentId) : undefined
    let guard = 0
    while (p && guard++ < 20) { names.unshift(p.name); p = p.parentId ? byId.get(p.parentId) : undefined }
    return names.join(' / ')
  }
  const orderOf = (u: UnitNode): number[] => {
    const out: number[] = [u.order]
    let p = u.parentId ? byId.get(u.parentId) : undefined
    let guard = 0
    while (p && guard++ < 20) { out.unshift(p.order); p = p.parentId ? byId.get(p.parentId) : undefined }
    return out
  }
  const depthOf = (u: UnitNode): number => {
    let d = 0
    let p = u.parentId ? byId.get(u.parentId) : undefined
    let guard = 0
    while (p && guard++ < 20) { d++; p = p.parentId ? byId.get(p.parentId) : undefined }
    return d
  }
  return [...draft.value.units]
    .map((u) => ({ node: u, depth: depthOf(u), pathName: pathOf(u), path: orderOf(u) }))
    .sort((a, b) => {
      const n = Math.min(a.path.length, b.path.length)
      for (let i = 0; i < n; i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i]
      return a.path.length - b.path.length
    })
})

const unitOptions = computed(() => unitPaths.value.map((u) => ({ value: u.node.id, label: u.pathName })))

const rankColor = (id: string): string => draft.value?.ranks.find((r) => r.id === id)?.color ?? '#939b9a'
const rankName = (id: string): string => draft.value?.ranks.find((r) => r.id === id)?.name ?? '未定级'
const unitName = (id: string): string => draft.value?.units.find((u) => u.id === id)?.name ?? '未分配'

async function save(): Promise<void> {
  if (!draft.value) return
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  await saveRoster(draft.value)
  dirty.value = false
  flash('名册已保存')
}

async function createPlan(): Promise<void> {
  const base = state.rosters[0]
  const plan: RosterPlan = {
    id: uid('roster'),
    name: `名册方案${state.rosters.length + 1}`,
    ranks: base ? clone(base.ranks) : [{ id: uid('rank'), name: '一级', order: 0, color: '#3D5A6C' }],
    units: base ? clone(base.units) : [{ id: uid('unit'), name: '机关', parentId: null, order: 0 }],
    members: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
  await saveRoster(plan)
  selectedId.value = plan.id
  flash('已新建名册方案')
}

// ---- 重命名 ----
const renameOpen = ref(false)
const renameValue = ref('')

function openRename(): void {
  if (!draft.value) return
  renameValue.value = draft.value.name
  renameOpen.value = true
}

function confirmRename(): void {
  if (!draft.value) return
  const name = renameValue.value.trim()
  if (!name) return
  draft.value.name = name
  renameOpen.value = false
  flash('名称已修改，记得保存')
}

// ---- 删除方案 ----
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

function askDeletePlan(): void {
  if (!draft.value) return
  if (state.rosters.length <= 1) { flash('至少保留一套名册方案'); return }
  ask('删除名册方案', `「${draft.value.name}」将被删除。已创建的排座项目保留自己的名册快照，不受影响；之后新建项目将无法再选择它。`, async () => {
    autosaveSeq++
    window.clearTimeout(autosaveTimer)
    dirty.value = false
    await removeRoster(draft.value!.id)
    selectedId.value = state.rosters[0]?.id ?? ''
    flash('已删除')
  })
}

// ---- 人员筛选 ----
const search = ref('')
const filterUnit = ref<string | undefined>()
const filterRank = ref<string | undefined>()
const filterDuty = ref<string | undefined>()

const dutyOptions = computed(() => {
  const set = new Set<string>()
  for (const m of draft.value?.members ?? []) if (m.duty?.trim()) set.add(m.duty.trim())
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((d) => ({ value: d, label: d }))
})

const visibleMembers = computed(() => {
  if (!draft.value) return []
  const q = search.value.trim()
  return draft.value.members.filter((m) => {
    if (filterUnit.value && m.unitId !== filterUnit.value) return false
    if (filterRank.value && m.rankId !== filterRank.value) return false
    if (filterDuty.value && (m.duty ?? '') !== filterDuty.value) return false
    if (q && !m.name.includes(q) && !(m.duty ?? '').includes(q)) return false
    return true
  })
})

const rankCounts = computed(() => {
  const map = new Map<string, number>()
  for (const m of draft.value?.members ?? []) map.set(m.rankId, (map.get(m.rankId) ?? 0) + 1)
  return sortedRanks.value.map((r) => ({ rank: r, count: map.get(r.id) ?? 0 }))
})

const hasFilter = computed(() => !!search.value.trim() || !!filterUnit.value || !!filterRank.value || !!filterDuty.value)

/** 单位人数按人数降序；超过 6 个单位时收成前 5 + 其他，避免条形图过长。 */
const unitRows = computed(() => {
  const map = new Map<string, number>()
  for (const m of draft.value?.members ?? []) map.set(m.unitId, (map.get(m.unitId) ?? 0) + 1)
  const rows = [...map.entries()].map(([id, count]) => ({
    id,
    label: unitName(id),
    path: unitPaths.value.find((u) => u.node.id === id)?.pathName ?? unitName(id),
    count
  }))
  rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
  if (rows.length > 6) {
    const rest = rows.slice(5)
    rows.splice(5, rest.length, {
      id: '__other',
      label: `其他 ${rest.length} 个单位`,
      path: `其他 ${rest.length} 个单位`,
      count: rest.reduce((n, r) => n + r.count, 0)
    })
  }
  return rows
})

const rankChartHeight = computed(() => {
  const n = rankCounts.value.filter((r) => r.count > 0).length
  return n ? Math.min(210, Math.max(96, n * 30 + 8)) : 96
})
const unitChartHeight = computed(() => {
  const n = unitRows.value.length
  return n ? Math.min(200, Math.max(110, n * 28 + 8)) : 96
})

/** 职级分布：按职级序列自上而下，沿用职级定义色，条形与表格圆点一一对应。 */
const rankChart = computed<ChartOption | null>(() => {
  const rows = rankCounts.value.filter((r) => r.count > 0)
  if (!rows.length) return null
  return {
    animationDuration: 320,
    grid: { left: 0, right: 20, top: 6, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(74, 124, 123, .06)' } },
      formatter: '{b}<br/>{c} 人'
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.rank.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, width: 62, overflow: 'truncate', ellipsis: '…' }
    },
    series: [{
      type: 'bar',
      data: rows.map((r) => ({ value: r.count, itemStyle: { color: r.rank.color } })),
      barWidth: 9,
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      showBackground: true,
      backgroundStyle: { color: chartColors.bgHover, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true, position: 'right', distance: 6,
        color: chartColors.muted, fontSize: 11, fontFamily: chartFont
      }
    }]
  }
})

/** 单位人数：横向条形，长名称截断、完整路径进 tooltip。 */
const unitChart = computed<ChartOption | null>(() => {
  if (!unitRows.value.length) return null
  const rows = unitRows.value
  return {
    animationDuration: 320,
    grid: { left: 0, right: 20, top: 6, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(74, 124, 123, .06)' } },
      formatter: (p: any) => {
        const row = rows[(Array.isArray(p) ? p[0] : p).dataIndex]
        return `${row.path}<br/>${row.count} 人`
      }
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, width: 66, overflow: 'truncate', ellipsis: '…' }
    },
    series: [{
      type: 'bar',
      data: rows.map((r) => r.count),
      barWidth: 9,
      itemStyle: { color: chartColors.primary, borderRadius: [0, 4, 4, 0] },
      showBackground: true,
      backgroundStyle: { color: chartColors.bgHover, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true, position: 'right', distance: 6,
        color: chartColors.muted, fontSize: 11, fontFamily: chartFont
      }
    }]
  }
})

function clearFilters(): void {
  search.value = ''
  filterUnit.value = undefined
  filterRank.value = undefined
  filterDuty.value = undefined
}

// ---- 拖拽排序：名册顺序完全由用户决定，不做任何自动排序 ----
const dragId = ref<string | null>(null)
const dropTarget = ref<{ id: string; after: boolean } | null>(null)

/** 增删或拖拽后把 order 重编为连续序号，排座直接读取这个顺序 */
function reindexMembers(): void {
  draft.value?.members.forEach((m, i) => { m.order = i })
}

function onDragStart(id: string, e: DragEvent): void {
  if (hasFilter.value) { e.preventDefault(); return }
  dragId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(id: string, e: DragEvent): void {
  if (!dragId.value || dragId.value === id) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropTarget.value = { id, after: e.clientY > rect.top + rect.height / 2 }
}

function onDrop(): void {
  const target = dropTarget.value
  if (!draft.value || !dragId.value || !target) { onDragEnd(); return }
  const from = draft.value.members.findIndex((m) => m.id === dragId.value)
  if (from < 0) { onDragEnd(); return }
  const [moved] = draft.value.members.splice(from, 1)
  let to = draft.value.members.findIndex((m) => m.id === target.id)
  if (to < 0) to = draft.value.members.length
  else if (target.after) to += 1
  draft.value.members.splice(to, 0, moved)
  reindexMembers()
  flash(`已调整「${moved.name}」的顺序`)
  onDragEnd()
}

function onDragEnd(): void {
  dragId.value = null
  dropTarget.value = null
}

// ---- 人员编辑 ----
const memberOpen = ref(false)
const editingId = ref<string | null>(null)
const form = ref({
  name: '',
  unitId: '' as string,
  rankId: '' as string,
  duty: '',
  aliases: ''
})

function openAddMember(): void {
  if (!draft.value) return
  editingId.value = null
  form.value = {
    name: '',
    unitId: draft.value.units[0]?.id ?? '',
    rankId: sortedRanks.value[sortedRanks.value.length - 1]?.id ?? '',
    duty: '',
    aliases: ''
  }
  memberOpen.value = true
}

function openEditMember(m: Member): void {
  editingId.value = m.id
  form.value = { name: m.name, unitId: m.unitId, rankId: m.rankId, duty: m.duty ?? '', aliases: m.aliases.join('、') }
  memberOpen.value = true
}

function submitMember(): void {
  if (!draft.value) return
  const f = form.value
  if (!f.name.trim()) { flash('请填写姓名'); return }
  if (!f.unitId || !f.rankId) { flash('请选择单位与职级'); return }
  const aliases = f.aliases.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
  const duty = f.duty.trim() || undefined
  if (editingId.value) {
    const m = draft.value.members.find((x) => x.id === editingId.value)
    if (m) Object.assign(m, { name: f.name.trim(), unitId: f.unitId, rankId: f.rankId, duty, aliases })
    flash('人员已更新，记得保存')
  } else {
    draft.value.members.push({
      id: uid('m'), name: f.name.trim(), unitId: f.unitId, rankId: f.rankId, duty, aliases, status: 'present'
    })
    reindexMembers()
    flash('人员已添加，记得保存')
  }
  memberOpen.value = false
}

function askDeleteMember(m: Member): void {
  ask('移除人员', `确定从名册中移除「${m.name}」？已排座项目不受影响。`, () => {
    if (!draft.value) return
    draft.value.members = draft.value.members.filter((x) => x.id !== m.id)
    reindexMembers()
  })
}

// ---- 批量添加 ----
const batchOpen = ref(false)
const batchText = ref('')
const batchUnit = ref('')
const batchRank = ref('')
const batchDuty = ref('')

function openBatch(): void {
  if (!draft.value) return
  batchText.value = ''
  batchUnit.value = draft.value.units[0]?.id ?? ''
  batchRank.value = sortedRanks.value[sortedRanks.value.length - 1]?.id ?? ''
  batchDuty.value = ''
  batchOpen.value = true
}

function submitBatch(): void {
  if (!draft.value) return
  const names = batchText.value.split(/[\n,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
  if (!names.length) { flash('没有可添加的姓名'); return }
  if (!batchUnit.value || !batchRank.value) { flash('请选择单位与职级'); return }
  const duty = batchDuty.value.trim() || undefined
  for (const name of names) {
    draft.value.members.push({
      id: uid('m'), name, unitId: batchUnit.value, rankId: batchRank.value, duty, aliases: [], status: 'present'
    })
  }
  batchOpen.value = false
  reindexMembers()
  flash(`已加入 ${names.length} 人，记得保存`)
}

// ---- 文件批量导入 ----
const importOpen = ref(false)
/** 新增职级的默认色轮：取统一预设里的非浅色项，避免职级色条过淡 */
const RANK_PALETTE = COLOR_PRESETS.slice(1)

const unitNames = computed(() => [...new Set((draft.value?.units ?? []).map((u) => u.name))])
const rankNames = computed(() => sortedRanks.value.map((r) => r.name))

function openImport(): void {
  if (!draft.value) return
  importOpen.value = true
}

function ensureUnit(name: string, rootId: string): UnitNode {
  const d = draft.value!
  const hit = d.units.find((u) => u.name === name)
  if (hit) return hit
  const order = Math.max(-1, ...d.units.filter((u) => u.parentId === rootId).map((u) => u.order)) + 1
  const node: UnitNode = { id: uid('unit'), name, parentId: rootId, order }
  d.units.push(node)
  return node
}

function ensureRank(name: string): RankDef {
  const d = draft.value!
  const hit = d.ranks.find((r) => r.name === name)
  if (hit) return hit
  const order = Math.max(-1, ...d.ranks.map((r) => r.order)) + 1
  const rank: RankDef = {
    id: uid('rank'),
    name,
    order,
    color: RANK_PALETTE[order % RANK_PALETTE.length]
  }
  d.ranks.push(rank)
  return rank
}

async function handleImport(payload: {
  rows: { name: string; gender: '' | 'M' | 'F'; unit: string; rank: string; duty: string; note: string }[]
  targetUnitId: string
}): Promise<void> {
  if (!draft.value || !payload.rows.length) return
  const d = draft.value
  const rootId = d.units.find((u) => u.parentId === null)?.id ?? d.units[0]?.id ?? ''
  let fallbackRank = [...d.ranks].sort((a, b) => b.order - a.order)[0]
  if (!fallbackRank) fallbackRank = ensureRank('未定级')
  let newUnits = 0
  let newRanks = 0
  const unitsBefore = d.units.length
  const ranksBefore = d.ranks.length
  for (const row of payload.rows) {
    const unitName = row.unit.trim()
    const unitId = unitName
      ? ensureUnit(unitName, rootId).id
      : payload.targetUnitId || rootId
    let rankId = fallbackRank.id
    if (row.rank.trim()) {
      const r = ensureRank(row.rank.trim())
      rankId = r.id
    }
    d.members.push({
      id: uid('m'),
      name: row.name,
      unitId,
      rankId,
      duty: row.duty.trim() || undefined,
      aliases: [],
      gender: row.gender || undefined,
      note: row.note || undefined,
      status: 'present'
    })
  }
  newUnits = d.units.length - unitsBefore
  newRanks = d.ranks.length - ranksBefore
  reindexMembers()
  await saveRoster(d)
  dirty.value = false
  const extras = [
    newUnits ? `新建单位 ${newUnits} 个` : '',
    newRanks ? `新建职级 ${newRanks} 个` : ''
  ].filter(Boolean)
  flash(`已导入 ${payload.rows.length} 人${extras.length ? `，${extras.join('，')}` : ''}`)
}
</script>

<template>
  <header class="page-head roster-head">
    <div class="page-head-main">
      <div class="page-eyebrow">名册与组织</div>
      <h1 class="page-title">{{ draft?.name ?? '名册方案' }}</h1>
    </div>
    <div class="head-actions roster-head-actions">
      <div class="roster-plan">
        <div class="roster-plan-select">
          <UiSelect v-model="selectedId" :options="rosterOptions" placeholder="选择方案" size="sm" />
        </div>
        <UiIconButton icon="edit" :size="15" title="重命名方案" @click="openRename" />
      </div>
      <span class="roster-head-sep" aria-hidden="true" />
      <UiIconButton icon="plus" :size="15" title="新建方案" aria-label="新建方案" @click="createPlan" />
      <UiIconButton icon="trash" :size="15" title="删除当前方案" danger @click="askDeletePlan" />
      <button class="btn sm primary" :disabled="!dirty" @click="save">{{ dirty ? '保存改动' : '已保存' }}</button>
    </div>
  </header>

  <div v-if="!draft" class="roster-blank">
    <UiIcon name="users" :size="24" />
    <div class="roster-blank-title">还没有名册方案</div>
    <button class="btn sm primary" @click="createPlan">新建方案</button>
  </div>

  <template v-else>
    <div class="workspace roster-workspace">
      <section class="roster-panel">
        <div class="roster-panel-head">
          <div class="roster-panel-heading">
            <h2 class="roster-panel-title">人员名册</h2>
          </div>
          <div class="roster-panel-actions">
            <button class="btn sm" @click="openImport"><UiIcon name="import" :size="13" />批量导入</button>
            <button class="btn sm" @click="openBatch"><UiIcon name="paste" :size="13" />批量粘贴</button>
            <button class="btn sm primary" @click="openAddMember"><UiIcon name="plus" :size="13" />新增人员</button>
          </div>
        </div>

        <div class="roster-toolbar">
          <div class="roster-filter">
            <div class="roster-search">
              <UiIcon name="search" :size="13" />
              <input v-model="search" class="roster-search-input" placeholder="搜索姓名 / 职务" aria-label="搜索姓名或职务" />
              <button v-if="search" type="button" class="roster-search-clear" title="清空搜索" @click="search = ''">
                <UiIcon name="close" :size="11" />
              </button>
            </div>
            <div class="roster-filter-unit">
              <UiSelect v-model="filterUnit" :options="[{ value: '', label: '全部单位' }, ...unitOptions]" placeholder="全部单位" size="sm" />
            </div>
            <div class="roster-filter-rank">
              <UiSelect v-model="filterRank" :options="[{ value: '', label: '全部职级' }, ...rankOptions]" placeholder="全部职级" size="sm" />
            </div>
            <div class="roster-filter-duty">
              <UiSelect v-model="filterDuty" :options="[{ value: '', label: '全部职务' }, ...dutyOptions]" placeholder="全部职务" size="sm" />
            </div>
            <button v-if="hasFilter" class="btn ghost xs" @click="clearFilters">清除筛选</button>
          </div>
          <span class="roster-count"><b>{{ visibleMembers.length }}</b> / {{ draft.members.length }} 人</span>
        </div>

        <div class="roster-table-wrap">
          <table class="roster-table" aria-label="人员名册">
            <colgroup>
              <col style="width: 30px" />
              <col style="width: 26%" />
              <col />
              <col style="width: 16%" />
              <col style="width: 17%" />
              <col style="width: 96px" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" class="roster-drag-head" title="拖拽调整顺序"><UiIcon name="grip" :size="12" /></th>
                <th scope="col">姓名</th>
                <th scope="col">单位</th>
                <th scope="col">职务</th>
                <th scope="col">职级</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in visibleMembers"
                :key="m.id"
                class="roster-row"
                :class="{
                  selected: activeId === m.id,
                  'is-dragging': dragId === m.id,
                  'drop-before': dropTarget?.id === m.id && !dropTarget.after,
                  'drop-after': dropTarget?.id === m.id && dropTarget.after
                }"
                :draggable="!hasFilter"
                @click="activeId = m.id"
                @dblclick="openEditMember(m)"
                @dragstart="onDragStart(m.id, $event)"
                @dragover="onDragOver(m.id, $event)"
                @drop.prevent="onDrop"
                @dragend="onDragEnd"
              >
                <td class="roster-drag-cell">
                  <UiIcon name="grip" :size="13" class="roster-grip" :class="{ 'is-off': hasFilter }" :title="hasFilter ? '清除筛选后可拖拽排序' : '拖拽调整顺序'" />
                </td>
                <td>
                  <div class="roster-name">
                    <span class="roster-name-text">{{ m.name }}</span>
                    <span v-if="m.aliases.length" class="roster-alias">{{ m.aliases.join('、') }}</span>
                  </div>
                </td>
                <td class="roster-unit" :title="unitName(m.unitId)">{{ unitName(m.unitId) }}</td>
                <td class="roster-duty" :title="m.duty || ''">{{ m.duty || '—' }}</td>
                <td>
                  <span class="roster-rank">
                    <span class="dot" :style="{ background: rankColor(m.rankId) }" />{{ rankName(m.rankId) }}
                  </span>
                </td>
                <td>
                  <div class="roster-actions">
                    <UiIconButton icon="edit" :size="14" :title="`编辑 ${m.name}`" @click.stop="openEditMember(m)" />
                    <UiIconButton icon="trash" :size="14" danger :title="`移出 ${m.name}`" @click.stop="askDeleteMember(m)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!visibleMembers.length" class="roster-empty">
            <UiIcon :name="hasFilter ? 'search' : 'users'" :size="22" />
            <div class="roster-empty-title">{{ hasFilter ? '没有匹配的人员' : '名册里还没有人员' }}</div>
            <p v-if="hasFilter" class="roster-empty-desc">换个关键字，或清除筛选后再试。</p>
            <div class="roster-empty-actions">
              <button v-if="hasFilter" class="btn sm" @click="clearFilters">清除筛选</button>
              <template v-else>
                <button class="btn sm" @click="openImport">批量导入</button>
                <button class="btn sm" @click="openBatch">批量粘贴</button>
                <button class="btn sm primary" @click="openAddMember">新增人员</button>
              </template>
            </div>
          </div>
        </div>

        <div class="roster-foot">
          <span>共 <b>{{ draft.members.length }}</b> 人</span>
        </div>
      </section>

      <div class="panel roster-side">
        <section class="card tight">
          <div class="section-label" style="margin-bottom: 8px">组织配置</div>
          <button class="roster-org-row" @click="draft && emit('open-ranks', draft.id)">
            <div class="grow">
              <div class="roster-org-name">职级序列</div>
              <div class="roster-org-meta">{{ draft.ranks.length }} 个职级</div>
            </div>
            <span class="tag ink">{{ draft.members.length }} 人</span>
            <UiIcon name="chevronRight" :size="12" class="chev" />
          </button>
          <button class="roster-org-row" @click="draft && emit('open-units', draft.id)">
            <div class="grow">
              <div class="roster-org-name">单位编制序列</div>
              <div class="roster-org-meta">{{ draft.units.length }} 个单位</div>
            </div>
            <UiIcon name="chevronRight" :size="12" class="chev" />
          </button>
        </section>

        <section class="card tight">
          <div class="card-head">
            <div class="card-title">结构概览</div>
            <span class="caption">{{ draft.members.length }} 人</span>
          </div>
          <div class="chart-block">
            <div class="chart-title">
              <span>职级分布</span>
              <span class="caption">按职级序列</span>
            </div>
            <UiChart :option="rankChart" :height="rankChartHeight" empty-text="暂无人员数据" />
          </div>
          <div class="chart-block">
            <div class="chart-title">
              <span>单位人数</span>
              <span class="caption">按人数排序</span>
            </div>
            <UiChart :option="unitChart" :height="unitChartHeight" empty-text="暂无单位数据" />
          </div>
        </section>
      </div>
    </div>
  </template>

  <!-- 重命名 -->
  <UiModal v-model="renameOpen" title="重命名名册方案">
    <div class="field">
      <label>方案名称</label>
      <input v-model="renameValue" class="input" placeholder="如：名册方案一" @keyup.enter="confirmRename" />
    </div>
    <template #footer>
      <button class="btn" @click="renameOpen = false">取消</button>
      <button class="btn primary" @click="confirmRename">保存名称</button>
    </template>
  </UiModal>

  <!-- 人员新增/编辑 -->
  <UiModal
    v-model="memberOpen"
    :title="editingId ? '编辑人员' : '新增人员'"
  >
    <div class="field">
      <label>姓名</label>
      <input v-model="form.name" class="input" placeholder="人员姓名" @keyup.enter="submitMember" />
    </div>
    <div class="field-row">
      <div class="field">
        <label>单位</label>
        <UiSelect v-model="form.unitId" :options="unitOptions" placeholder="选择单位" />
      </div>
      <div class="field">
        <label>职级</label>
        <UiSelect v-model="form.rankId" :options="rankOptions" placeholder="选择职级" />
      </div>
    </div>
    <div class="field">
      <label>职务（可留空）</label>
      <input v-model="form.duty" class="input" placeholder="如：主任、处长、副主任" />
    </div>
    <div class="field">
      <label>别名（用于 Excel 姓名匹配，用逗号分隔）</label>
      <input v-model="form.aliases" class="input" placeholder="如：老张、张处" />
    </div>
    <template #footer>
      <button class="btn" @click="memberOpen = false">取消</button>
      <button class="btn primary" @click="submitMember">{{ editingId ? '保存修改' : '添加人员' }}</button>
    </template>
  </UiModal>

  <!-- 批量添加 -->
  <UiModal v-model="batchOpen" title="批量添加人员" description="姓名用换行、逗号或空格分隔">
    <div class="field">
      <label>姓名列表</label>
      <textarea v-model="batchText" class="textarea" rows="5" placeholder="张三、李四、王五…" />
    </div>
    <div class="field-row">
      <div class="field">
        <label>统一单位</label>
        <UiSelect v-model="batchUnit" :options="unitOptions" placeholder="选择单位" />
      </div>
      <div class="field">
        <label>统一职级</label>
        <UiSelect v-model="batchRank" :options="rankOptions" placeholder="选择职级" />
      </div>
    </div>
    <div class="field">
      <label>统一职务（可留空）</label>
      <input v-model="batchDuty" class="input" placeholder="如：主任、处长" />
    </div>
    <template #footer>
      <button class="btn" @click="batchOpen = false">取消</button>
      <button class="btn primary" @click="submitBatch">加入名册</button>
    </template>
  </UiModal>

  <!-- 文件批量导入 -->
  <ImportDialog
    v-model="importOpen"
    :unit-options="unitOptions"
    :unit-names="unitNames"
    :rank-names="rankNames"
    :default-unit-id="draft?.units.find((u) => u.parentId === null)?.id ?? draft?.units[0]?.id ?? ''"
    @import="handleImport"
  />

  <!-- 确认 -->
  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">确认删除</button>
    </template>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
