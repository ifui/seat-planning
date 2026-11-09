<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Member, RosterPlan, UnitNode } from '../types'
import { removeRoster, saveRoster, state } from '../store'
import { nowISO, uid } from '../engine/geometry'
import { UiChart, UiIcon, UiIconButton, UiSelect, UiModal } from '../ui'
import { chartAxisText, chartColors, chartFont, chartTooltip, type ChartOption } from '../ui/charts'

const emit = defineEmits<{ (e: 'open-ranks', rosterId: string): void; (e: 'open-units', rosterId: string): void }>()

const selectedId = ref<string>(state.rosters[0]?.id ?? '')
const draft = ref<RosterPlan | null>(null)
const dirty = ref(false)
const toast = ref('')
/** 仅用于表格行的选中高亮，不参与任何业务逻辑。 */
const activeId = ref<string | null>(null)
let loading = false

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

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
    else if (!draft.value) load(selectedId.value)
  }
)

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2200)
}

const rosterOptions = computed(() =>
  state.rosters.map((r) => ({ value: r.id, label: r.name, hint: `${r.members.length} 人` }))
)

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
  ask('删除名册方案', `「${draft.value.name}」将被删除，引用它的排座项目会失效。`, async () => {
    await removeRoster(draft.value!.id)
    selectedId.value = state.rosters[0]?.id ?? ''
    flash('已删除')
  })
}

// ---- 人员筛选 ----
const search = ref('')
const filterUnit = ref<string | undefined>()
const filterRank = ref<string | undefined>()

const visibleMembers = computed(() => {
  if (!draft.value) return []
  return draft.value.members.filter((m) => {
    if (filterUnit.value && m.unitId !== filterUnit.value) return false
    if (filterRank.value && m.rankId !== filterRank.value) return false
    if (search.value.trim() && !m.name.includes(search.value.trim())) return false
    return true
  })
})

const rankCounts = computed(() => {
  const map = new Map<string, number>()
  for (const m of draft.value?.members ?? []) map.set(m.rankId, (map.get(m.rankId) ?? 0) + 1)
  return sortedRanks.value.map((r) => ({ rank: r, count: map.get(r.id) ?? 0 }))
})

const activeCount = computed(() => (draft.value?.members ?? []).filter((m) => m.active).length)
const hasFilter = computed(() => !!search.value.trim() || !!filterUnit.value || !!filterRank.value)

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
}

// ---- 人员编辑 ----
const memberOpen = ref(false)
const editingId = ref<string | null>(null)
const form = ref({
  name: '',
  unitId: '' as string,
  rankId: '' as string,
  aliases: '',
  active: true
})

function openAddMember(): void {
  if (!draft.value) return
  editingId.value = null
  form.value = {
    name: '',
    unitId: draft.value.units[0]?.id ?? '',
    rankId: sortedRanks.value[sortedRanks.value.length - 1]?.id ?? '',
    aliases: '',
    active: true
  }
  memberOpen.value = true
}

function openEditMember(m: Member): void {
  editingId.value = m.id
  form.value = { name: m.name, unitId: m.unitId, rankId: m.rankId, aliases: m.aliases.join('、'), active: m.active }
  memberOpen.value = true
}

function submitMember(): void {
  if (!draft.value) return
  const f = form.value
  if (!f.name.trim()) { flash('请填写姓名'); return }
  if (!f.unitId || !f.rankId) { flash('请选择单位与职级'); return }
  const aliases = f.aliases.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
  if (editingId.value) {
    const m = draft.value.members.find((x) => x.id === editingId.value)
    if (m) Object.assign(m, { name: f.name.trim(), unitId: f.unitId, rankId: f.rankId, aliases, active: f.active })
    flash('人员已更新，记得保存')
  } else {
    draft.value.members.push({
      id: uid('m'), name: f.name.trim(), unitId: f.unitId, rankId: f.rankId, aliases, active: f.active
    })
    flash('人员已添加，记得保存')
  }
  memberOpen.value = false
}

function askDeleteMember(m: Member): void {
  ask('移除人员', `确定从名册中移除「${m.name}」？已排座项目中的该人员将显示为空。`, () => {
    if (!draft.value) return
    draft.value.members = draft.value.members.filter((x) => x.id !== m.id)
  })
}

// ---- 批量添加 ----
const batchOpen = ref(false)
const batchText = ref('')
const batchUnit = ref('')
const batchRank = ref('')

function openBatch(): void {
  if (!draft.value) return
  batchText.value = ''
  batchUnit.value = draft.value.units[0]?.id ?? ''
  batchRank.value = sortedRanks.value[sortedRanks.value.length - 1]?.id ?? ''
  batchOpen.value = true
}

function submitBatch(): void {
  if (!draft.value) return
  const names = batchText.value.split(/[\n,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
  if (!names.length) { flash('没有可添加的姓名'); return }
  if (!batchUnit.value || !batchRank.value) { flash('请选择单位与职级'); return }
  for (const name of names) {
    draft.value.members.push({
      id: uid('m'), name, unitId: batchUnit.value, rankId: batchRank.value, aliases: [], active: true
    })
  }
  batchOpen.value = false
  flash(`已加入 ${names.length} 人，记得保存`)
}
</script>

<template>
  <header class="page-head roster-head">
    <div class="page-head-main">
      <div class="page-eyebrow">名册与组织</div>
      <h1 class="page-title">{{ draft?.name ?? '名册方案' }}</h1>
      <p class="page-desc">职级决定排序，单位编制序列决定同职级内的先后。人员与组织配置改动会先留在本地草稿，保存后写入本机数据库。</p>
    </div>
    <div class="head-actions roster-head-actions">
      <div class="roster-plan">
        <div class="roster-plan-select">
          <UiSelect v-model="selectedId" :options="rosterOptions" placeholder="选择方案" size="sm" />
        </div>
        <UiIconButton icon="edit" :size="15" title="重命名方案" @click="openRename" />
      </div>
      <span class="roster-head-sep" aria-hidden="true" />
      <button class="btn sm" @click="createPlan">新建方案</button>
      <UiIconButton icon="trash" :size="15" title="删除当前方案" danger @click="askDeletePlan" />
      <button class="btn sm primary" :disabled="!dirty" @click="save">{{ dirty ? '保存改动' : '已保存' }}</button>
    </div>
  </header>

  <div v-if="!draft" class="roster-blank">
    <UiIcon name="users" :size="24" />
    <div class="roster-blank-title">还没有名册方案</div>
    <p>新建一套名册，配置职级与单位后即可开始排座。</p>
    <button class="btn sm primary" @click="createPlan">新建方案</button>
  </div>

  <template v-else>
    <div class="roster-metrics">
      <div class="roster-metric">
        <span class="roster-metric-k">名册人数</span>
        <span class="roster-metric-v">{{ draft.members.length }}</span>
      </div>
      <div class="roster-metric">
        <span class="roster-metric-k">在位</span>
        <span class="roster-metric-v">{{ activeCount }}<small v-if="draft.members.length > activeCount">/ {{ draft.members.length }}</small></span>
      </div>
      <div class="roster-metric">
        <span class="roster-metric-k">职级</span>
        <span class="roster-metric-v">{{ draft.ranks.length }}</span>
      </div>
      <div class="roster-metric">
        <span class="roster-metric-k">单位</span>
        <span class="roster-metric-v">{{ draft.units.length }}</span>
      </div>
    </div>

    <div class="workspace roster-workspace">
      <section class="roster-panel">
        <div class="roster-panel-head">
          <div class="roster-panel-heading">
            <h2 class="roster-panel-title">人员名册</h2>
            <span class="roster-panel-note">停用人员不参与排座</span>
          </div>
          <div class="roster-panel-actions">
            <button class="btn sm" @click="openBatch"><UiIcon name="paste" :size="13" />批量粘贴</button>
            <button class="btn sm primary" @click="openAddMember"><UiIcon name="plus" :size="13" />新增人员</button>
          </div>
        </div>

        <div class="roster-toolbar">
          <div class="roster-filter">
            <div class="roster-search">
              <UiIcon name="search" :size="13" />
              <input v-model="search" class="roster-search-input" placeholder="搜索姓名" aria-label="搜索姓名" />
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
            <button v-if="hasFilter" class="btn ghost xs" @click="clearFilters">清除筛选</button>
          </div>
          <span class="roster-count"><b>{{ visibleMembers.length }}</b> / {{ draft.members.length }} 人</span>
        </div>

        <div class="roster-table-wrap">
          <table class="roster-table" aria-label="人员名册">
            <colgroup>
              <col style="width: 26%" />
              <col />
              <col style="width: 19%" />
              <col style="width: 88px" />
              <col style="width: 96px" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">姓名</th>
                <th scope="col">单位</th>
                <th scope="col">职级</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in visibleMembers"
                :key="m.id"
                class="roster-row"
                :class="{ selected: activeId === m.id }"
                @click="activeId = m.id"
              >
                <td>
                  <div class="roster-name">
                    <span class="roster-name-text">{{ m.name }}</span>
                    <span v-if="m.aliases.length" class="roster-alias">{{ m.aliases.join('、') }}</span>
                  </div>
                </td>
                <td class="roster-unit" :title="unitName(m.unitId)">{{ unitName(m.unitId) }}</td>
                <td>
                  <span class="roster-rank">
                    <span class="dot" :style="{ background: rankColor(m.rankId) }" />{{ rankName(m.rankId) }}
                  </span>
                </td>
                <td>
                  <span class="tag" :class="m.active ? 'ok' : ''">{{ m.active ? '在位' : '停用' }}</span>
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
            <p class="roster-empty-desc">{{ hasFilter ? '换个关键字，或清除单位、职级筛选后再试。' : '可以逐个新增，也可以把姓名批量粘贴进来。' }}</p>
            <div class="roster-empty-actions">
              <button v-if="hasFilter" class="btn sm" @click="clearFilters">清除筛选</button>
              <template v-else>
                <button class="btn sm" @click="openBatch">批量粘贴</button>
                <button class="btn sm primary" @click="openAddMember">新增人员</button>
              </template>
            </div>
          </div>
        </div>

        <div class="roster-foot">
          <span>共 <b>{{ draft.members.length }}</b> 人 · 在位 <b>{{ activeCount }}</b> 人 · 停用 <b>{{ draft.members.length - activeCount }}</b> 人</span>
          <span>改动先留在本地草稿，保存后写入本机数据库</span>
        </div>
      </section>

      <div class="panel roster-side">
        <section class="card tight">
          <div class="section-label" style="margin-bottom: 8px">组织配置</div>
          <button class="roster-org-row" @click="draft && emit('open-ranks', draft.id)">
            <div class="grow">
              <div class="roster-org-name">职级序列</div>
              <div class="roster-org-meta">{{ draft.ranks.length }} 个职级 · 决定排座优先级</div>
            </div>
            <span class="tag ink">{{ draft.members.length }} 人</span>
            <UiIcon name="chevronRight" :size="12" class="chev" />
          </button>
          <button class="roster-org-row" @click="draft && emit('open-units', draft.id)">
            <div class="grow">
              <div class="roster-org-name">单位编制序列</div>
              <div class="roster-org-meta">{{ draft.units.length }} 个单位 · 多层有序树</div>
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

        <section class="card tight">
          <div class="card-title" style="margin-bottom: 8px">提示</div>
          <div class="caption">Excel 导入、人员状态与座位分配都在「排座项目」里完成。名册只负责组织与人员基础数据。</div>
        </section>
      </div>
    </div>
  </template>

  <!-- 重命名 -->
  <UiModal v-model="renameOpen" title="重命名名册方案" description="名称用于在项目里选择引用">
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
    description="职级决定排序，单位决定同职级内的先后"
  >
    <div class="field-row">
      <div class="field">
        <label>姓名</label>
        <input v-model="form.name" class="input" placeholder="人员姓名" @keyup.enter="submitMember" />
      </div>
      <div class="field">
        <label>状态</label>
        <UiSelect
          :model-value="form.active ? '1' : '0'"
          :options="[{ value: '1', label: '在位' }, { value: '0', label: '停用（不参与排座）' }]"
          @update:model-value="form.active = $event === '1'"
        />
      </div>
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
    <template #footer>
      <button class="btn" @click="batchOpen = false">取消</button>
      <button class="btn primary" @click="submitBatch">加入名册</button>
    </template>
  </UiModal>

  <!-- 确认 -->
  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">确认删除</button>
    </template>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
