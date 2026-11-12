<script setup lang="ts">
/**
 * 设置中心：项目数据概览 + 一组入口按钮。
 * 所有图表数据都来自当前项目的真实仓储快照 / 布局 / 项目覆盖层；
 * 备份、导入、清空与快照操作统一走仓储接口。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { repository, type StorageUsage } from '../data'
import { loadAll, state } from '../store'
import type { RosterPlan, Snapshot } from '../types'
import { applySeatCapacity, applySeatOverlay, seatsOfSheet } from '../engine/sheet'
import { saveFile } from '../platform/files'
import { preferences, resetPreferences, type ExportScale, type PaperSide } from '../preferences'
import { UiChart, UiIcon, UiModal, UiSelect } from '../ui'
import { chartAxisText, chartColors, chartFont, chartTooltip, type ChartOption } from '../ui/charts'
import { version as appVersion } from '../../package.json'

const usage = ref<StorageUsage>({ totalBytes: 0, snapshotCount: 0 })
const snapshots = ref<Snapshot[]>([])
const busy = ref(false)
const pageNotice = ref('')

const generalOpen = ref(false)
const backupOpen = ref(false)
const snapshotOpen = ref(false)
const clearOpen = ref(false)
const aboutOpen = ref(false)

const backupNotice = ref('')
const backupNoticeWarn = ref(false)
const snapshotNotice = ref('')
const importInput = ref<HTMLInputElement | null>(null)

const selectedProjectId = ref(state.projects[0]?.id ?? '')
const projectOptions = computed(() => state.projects.map((p) => ({ value: p.id, label: p.name })))
const project = computed(() => state.projects.find((p) => p.id === selectedProjectId.value))

watch(
  () => state.projects.map((p) => p.id).join(','),
  () => {
    if (!state.projects.some((p) => p.id === selectedProjectId.value)) {
      selectedProjectId.value = state.projects[0]?.id ?? ''
    }
  }
)

const storageLabel = computed(() =>
  state.storage === 'sqlite'
    ? 'SQLite 本机数据库'
    : state.storage === 'indexeddb'
      ? 'IndexedDB'
      : state.storage === 'local'
        ? '本地存储'
        : '仅内存'
)

const exportScaleOptions = [
  { value: 2 as ExportScale, label: '2× 清晰' },
  { value: 3 as ExportScale, label: '3× 高清' },
  { value: 4 as ExportScale, label: '4× 超清' }
]
const paperOptions = [
  { value: 'landscape' as PaperSide, label: 'A4 横向' },
  { value: 'portrait' as PaperSide, label: 'A4 纵向' }
]

// ---------- 当前项目数据 ----------
const roster = computed<RosterPlan | undefined>(() => {
  const p = project.value
  if (!p) return undefined
  return p.rosterSnapshot ?? state.rosters.find((r) => r.id === p.rosterPlanId)
})
const members = computed(() => roster.value?.members ?? [])
const presentCount = computed(() => members.value.filter((m) => m.status !== 'leave').length)
const leaveCount = computed(() => members.value.length - presentCount.value)

const seats = computed(() => {
  const p = project.value
  if (!p) return []
  const base = state.layouts.find((l) => l.id === p.layoutPackageId)
  if (!base) return []
  const sheet = applySeatOverlay(applySeatCapacity(base.sheet, p.seatCapacity), p.seatOverlay)
  return seatsOfSheet(sheet)
})
const disabledSeats = computed(() => seats.value.filter((s) => s.disabled).length)
const availableSeats = computed(() => seats.value.length - disabledSeats.value)
/** 可用座位 id：已就座必须是它子集，避免名册/布局变化后数字互相矛盾 */
const availableSeatIds = computed(() => new Set(seats.value.filter((s) => !s.disabled).map((s) => s.seatId)))
/** 有效就座：成员未请假且座位仍可用 */
const seatedSeatIds = computed(() => {
  const p = project.value
  if (!p) return new Set<string>()
  const byMember = new Map(members.value.map((m) => [m.id, m.status]))
  return new Set(
    p.assignments
      .filter((a) => byMember.get(a.memberId) !== 'leave' && availableSeatIds.value.has(a.seatId))
      .map((a) => a.seatId)
  )
})
const assignedSeats = computed(() => seatedSeatIds.value.size)
const seatedMemberIds = computed(
  () =>
    new Set(
      (project.value?.assignments ?? [])
        .filter((a) => seatedSeatIds.value.has(a.seatId))
        .map((a) => a.memberId)
    )
)
/** 应到人数：参会名单（缺省为整套名册）中的在位人员 */
const expectedCount = computed(() => {
  const p = project.value
  if (!p) return 0
  const byId = new Map(members.value.map((m) => [m.id, m]))
  const ids = p.participantIds?.length ? p.participantIds : members.value.map((m) => m.id)
  return ids.filter((id) => byId.get(id) && byId.get(id)!.status !== 'leave').length
})

// ---- 图表数据：全部取自当前项目的名册快照 / 布局 / 覆盖层 / 历史快照 ----

/** 职级结构：每个职级在位 / 请假人数，按职级序列自上而下 */
const rankRows = computed(() => {
  const ranks = [...(roster.value?.ranks ?? [])].sort((a, b) => a.order - b.order)
  const known = new Set(ranks.map((r) => r.id))
  const rows = ranks.map((r) => {
    const list = members.value.filter((m) => m.rankId === r.id)
    return {
      name: r.name,
      present: list.filter((m) => m.status !== 'leave').length,
      leave: list.filter((m) => m.status === 'leave').length
    }
  })
  const unknown = members.value.filter((m) => !known.has(m.rankId))
  if (unknown.length) {
    rows.push({
      name: '未定级',
      present: unknown.filter((m) => m.status !== 'leave').length,
      leave: unknown.filter((m) => m.status === 'leave').length
    })
  }
  return rows.filter((r) => r.present + r.leave > 0)
})
const rankChartHeight = computed(() => {
  const n = rankRows.value.length
  return n ? Math.min(210, Math.max(128, n * 26 + 34)) : 128
})

/** 区域占用：每个区域已坐 / 空闲 / 停用座位数 */
const zoneSeatRows = computed(() => {
  const p = project.value
  if (!p) return []
  const zones = new Map((p.seatOverlay?.zones ?? []).map((z) => [z.id, z.name]))
  const rows = new Map<string, { name: string; seated: number; free: number; disabled: number }>()
  for (const s of seats.value) {
    const id = s.zoneId && zones.has(s.zoneId) ? s.zoneId : ''
    const name = id ? zones.get(id)! : '未分区'
    const row = rows.get(id) ?? { name, seated: 0, free: 0, disabled: 0 }
    if (s.disabled) row.disabled++
    else if (seatedSeatIds.value.has(s.seatId)) row.seated++
    else row.free++
    rows.set(id, row)
  }
  const list = [...rows.values()]
    .filter((r) => r.seated + r.free + r.disabled > 0)
    .sort((a, b) => b.seated + b.free - (a.seated + a.free) || a.name.localeCompare(b.name, 'zh-CN'))
  if (list.length > 7) {
    const rest = list.slice(6)
    list.splice(6, rest.length, {
      name: `其他 ${rest.length} 个区域`,
      seated: rest.reduce((n, r) => n + r.seated, 0),
      free: rest.reduce((n, r) => n + r.free, 0),
      disabled: rest.reduce((n, r) => n + r.disabled, 0)
    })
  }
  return list
})
const zoneChartHeight = computed(() => {
  const n = zoneSeatRows.value.length
  return n ? Math.min(210, Math.max(128, n * 26 + 34)) : 128
})

/** 待排人员：应到但还没有有效座位的人，按单位聚合 */
const pendingRows = computed(() => {
  const p = project.value
  if (!p) return []
  const byId = new Map(members.value.map((m) => [m.id, m]))
  const ids = p.participantIds?.length ? p.participantIds : members.value.map((m) => m.id)
  const unitOf = (id: string): string => roster.value?.units.find((u) => u.id === id)?.name ?? '未分单位'
  const counts = new Map<string, number>()
  for (const id of ids) {
    const m = byId.get(id)
    if (!m || m.status === 'leave' || seatedMemberIds.value.has(id)) continue
    counts.set(m.unitId, (counts.get(m.unitId) ?? 0) + 1)
  }
  const rows = [...counts.entries()].map(([id, value]) => ({ id, name: unitOf(id), value }))
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'zh-CN'))
  if (rows.length > 6) {
    const rest = rows.slice(5)
    rows.splice(5, rest.length, {
      id: '__other',
      name: `其他 ${rest.length} 个单位`,
      value: rest.reduce((n, r) => n + r.value, 0)
    })
  }
  return rows
})
const pendingTotal = computed(() => pendingRows.value.reduce((n, r) => n + r.value, 0))
const pendingChartHeight = computed(() => {
  const n = pendingRows.value.length
  return n ? Math.min(210, Math.max(110, n * 26 + 8)) : 110
})
const pendingEmptyText = computed(() =>
  members.value.length ? '应到人员已全部就座' : '项目还没有名册数据'
)

/** 版本进度：最近 12 个快照各自保存的已排人数 */
const snapshotProgress = computed(() =>
  [...snapshots.value]
    .filter((s) => !!s.createdAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-12)
    .map((s) => ({
      label: s.createdAt.slice(5, 16).replace('T', ' '),
      time: s.createdAt,
      value: s.assignments?.length ?? 0
    }))
)
/** 仓储按主键返回，不保证时间序：显式取最新一条 */
const latestSnapshot = computed(() =>
  snapshots.value.reduce<Snapshot | undefined>(
    (latest, s) => (!latest || s.createdAt > latest.createdAt ? s : latest),
    undefined
  )
)

// ---------- 图表 ----------
const chartLegend = {
  bottom: 0,
  left: 'center' as const,
  icon: 'circle',
  itemWidth: 7,
  itemHeight: 7,
  itemGap: 12,
  textStyle: { ...chartAxisText, fontSize: 11 }
}

/** 职级结构：按职级序列的横向双条，在职级维度看人力与请假 */
const rankChart = computed<ChartOption | null>(() => {
  const rows = rankRows.value
  if (!rows.length) return null
  return {
    animationDuration: 320,
    legend: chartLegend,
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        const row = rows[p.dataIndex]
        return `${row.name}<br/>在位 ${row.present} 人 · 请假 ${row.leave} 人`
      }
    },
    grid: { left: 0, right: 16, top: 6, bottom: 22, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLabel: { ...chartAxisText, width: 54, overflow: 'truncate', ellipsis: '…' },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        name: '在位',
        type: 'bar',
        barWidth: 7,
        data: rows.map((r) => r.present),
        itemStyle: { color: chartColors.primary, borderRadius: [0, 2, 2, 0] }
      },
      {
        name: '请假',
        type: 'bar',
        barWidth: 7,
        data: rows.map((r) => r.leave),
        itemStyle: { color: chartColors.warning, borderRadius: [0, 2, 2, 0] }
      }
    ]
  } as ChartOption
})

/** 区域占用：每个区域座位被真实使用的比例（堆叠：已坐 / 空闲 / 停用） */
const zoneChart = computed<ChartOption | null>(() => {
  const rows = zoneSeatRows.value
  if (!rows.length) return null
  return {
    animationDuration: 320,
    legend: chartLegend,
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        const row = rows[p.dataIndex]
        const usable = row.seated + row.free
        const rate = usable ? Math.round((row.seated / usable) * 100) : 0
        return `${row.name}<br/>已坐 ${row.seated} · 空闲 ${row.free} · 停用 ${row.disabled}<br/>占用率 ${rate}%`
      }
    },
    grid: { left: 0, right: 16, top: 6, bottom: 22, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLabel: { ...chartAxisText, width: 66, overflow: 'truncate', ellipsis: '…' },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [
      {
        name: '已坐',
        type: 'bar',
        stack: 'seat',
        barWidth: 10,
        data: rows.map((r) => r.seated),
        itemStyle: { color: chartColors.primary }
      },
      {
        name: '空闲',
        type: 'bar',
        stack: 'seat',
        barWidth: 10,
        data: rows.map((r) => r.free),
        itemStyle: { color: 'rgba(74, 124, 123, 0.16)' }
      },
      {
        name: '停用',
        type: 'bar',
        stack: 'seat',
        barWidth: 10,
        data: rows.map((r) => r.disabled),
        itemStyle: { color: 'rgba(139, 147, 160, 0.35)', borderRadius: [0, 4, 4, 0] }
      }
    ]
  } as ChartOption
})

/** 待排人员：应到但还没坐下的人，按单位看缺口，全部排完则为空态 */
const pendingChart = computed<ChartOption | null>(() => {
  const rows = pendingRows.value
  if (!rows.length) return null
  return {
    animationDuration: 320,
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        return `${p.name}<br/>待排 ${p.value} 人`
      }
    },
    grid: { left: 0, right: 26, top: 6, bottom: 0, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLabel: { ...chartAxisText, width: 78, overflow: 'truncate', ellipsis: '…' },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [{
      type: 'bar',
      barWidth: 9,
      data: rows.map((r) => r.value),
      itemStyle: { color: chartColors.warning, borderRadius: [0, 4, 4, 0] },
      showBackground: true,
      backgroundStyle: { color: chartColors.bgHover, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true,
        position: 'right',
        distance: 6,
        color: chartColors.muted,
        fontSize: 11,
        fontFamily: chartFont
      }
    }]
  } as ChartOption
})

/** 版本进度：每个历史快照保存的已排人数，看排座是否在推进 */
const snapshotChart = computed<ChartOption | null>(() => {
  const rows = snapshotProgress.value
  if (!rows.length) return null
  return {
    animationDuration: 320,
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        const row = rows[p.dataIndex]
        return `${fmtTime(row.time)}<br/>已排 ${row.value} 人`
      }
    },
    grid: { left: 0, right: 8, top: 14, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.label),
      axisLabel: { ...chartAxisText, interval: rows.length > 8 ? 'auto' : 0 },
      axisLine: { lineStyle: { color: chartColors.borderSoft } },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...chartAxisText },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [{
      type: 'bar',
      data: rows.map((r) => r.value),
      barMaxWidth: 22,
      itemStyle: { color: chartColors.info, borderRadius: [4, 4, 0, 0] },
      label: {
        show: rows.length <= 9,
        position: 'top',
        color: chartColors.textSecondary,
        fontSize: 11,
        fontFamily: chartFont
      }
    }]
  } as ChartOption
})

// ---------- 数据刷新 ----------
async function refreshUsage(): Promise<void> {
  usage.value = await repository.usage()
}

async function refreshSnapshots(): Promise<void> {
  snapshots.value = project.value ? await repository.listSnapshots(project.value.id) : []
}

watch(selectedProjectId, () => { refreshSnapshots() })

onMounted(async () => {
  await Promise.all([refreshUsage(), refreshSnapshots()])
})

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------- 弹框操作 ----------
function openBackup(): void {
  backupNotice.value = ''
  backupNoticeWarn.value = false
  backupOpen.value = true
}

function openSnapshots(): void {
  snapshotNotice.value = ''
  snapshotOpen.value = true
}

async function backupAll(): Promise<void> {
  try {
    const json = await repository.exportAll()
    const res = await saveFile(`seat-planning-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'json')
    backupNoticeWarn.value = false
    backupNotice.value = res.saved ? '已导出全量备份，请妥善保存该文件。' : '已取消导出。'
  } catch {
    backupNoticeWarn.value = true
    backupNotice.value = '当前环境不支持本机数据库，备份不可用。'
  }
}

async function importBackup(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const summary = await repository.importAll(await file.text())
    await loadAll(false)
    await Promise.all([refreshUsage(), refreshSnapshots()])
    const total = summary.rosters + summary.layouts + summary.projects + summary.presets + summary.snapshots
    backupNoticeWarn.value = false
    backupNotice.value = `已导入 ${total} 条数据${summary.warnings.length ? `（${summary.warnings.join('；')}）` : ''}。`
  } catch (err) {
    backupNoticeWarn.value = true
    backupNotice.value = err instanceof Error ? err.message : '导入失败，请检查备份文件。'
  } finally {
    busy.value = false
  }
}

async function clearSnaps(): Promise<void> {
  const count = usage.value.snapshotCount
  if (!count) return
  busy.value = true
  try {
    await repository.clearSnapshots()
    await Promise.all([refreshUsage(), refreshSnapshots()])
    snapshotNotice.value = `已清空全部 ${count} 条历史快照。`
  } finally {
    busy.value = false
  }
}

async function clearAll(): Promise<void> {
  busy.value = true
  try {
    await repository.clearAll()
    await loadAll(false)
    await Promise.all([refreshUsage(), refreshSnapshots()])
    clearOpen.value = false
    pageNotice.value = '已清空全部本机数据，可导入备份恢复。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <header class="page-head">
    <div class="page-head-main">
      <div class="page-eyebrow">系统</div>
      <h1 class="page-title">设置中心</h1>
    </div>
    <div class="head-actions">
      <div v-if="state.projects.length" style="width: 200px">
        <UiSelect v-model="selectedProjectId" :options="projectOptions" placeholder="选择项目" size="sm" />
      </div>
    </div>
  </header>

  <section class="card overview-card">
    <div class="card-head">
      <div class="card-title">项目数据概览</div>
      <span v-if="project" class="tag">{{ project.name }}</span>
    </div>

    <div v-if="!project" class="empty">还没有排座项目，创建项目后这里会显示名册、座位与快照数据。</div>

    <template v-else>
      <div class="stat-grid four">
        <div class="stat"><span class="stat-k">名册人数</span><span class="stat-v">{{ members.length }}</span></div>
        <div class="stat"><span class="stat-k">可用座位</span><span class="stat-v">{{ availableSeats }}</span></div>
        <div class="stat"><span class="stat-k">已就座</span><span class="stat-v">{{ assignedSeats }}</span></div>
        <div class="stat"><span class="stat-k">快照数量</span><span class="stat-v">{{ snapshots.length }}</span></div>
      </div>

      <div class="overview-grid">
        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">职级结构</span>
            <span class="ov-meta">职级序列 · 请假 {{ leaveCount }} 人</span>
          </div>
          <UiChart :option="rankChart" :height="rankChartHeight" empty-text="项目还没有名册数据" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">区域占用</span>
            <span class="ov-meta">已坐 {{ assignedSeats }} / 可用 {{ availableSeats }}</span>
          </div>
          <UiChart :option="zoneChart" :height="zoneChartHeight" empty-text="布局中没有座位" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">待排人员</span>
            <span class="ov-meta">应到 {{ expectedCount }} 人 · 待排 {{ pendingTotal }} 人</span>
          </div>
          <UiChart :option="pendingChart" :height="pendingChartHeight" :empty-text="pendingEmptyText" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">版本进度</span>
            <span class="ov-meta">共 {{ snapshots.length }} 个版本 · 最近 {{ snapshotProgress.length }} 个</span>
          </div>
          <UiChart :option="snapshotChart" :height="168" empty-text="还没有历史快照" />
        </div>
      </div>
    </template>
  </section>

  <div class="settings-tools">
    <button class="btn" @click="generalOpen = true">
      <UiIcon name="settings" :size="14" />常规设置
    </button>
    <button class="btn" @click="openBackup">
      <UiIcon name="backup" :size="14" />备份与恢复
    </button>
    <button class="btn" @click="openSnapshots">
      <UiIcon name="clock" :size="14" />历史快照
      <span class="tool-num">{{ usage.snapshotCount }}</span>
    </button>
    <button class="btn" @click="aboutOpen = true">
      <UiIcon name="info" :size="14" />关于
    </button>
    <button class="btn danger" @click="clearOpen = true">
      <UiIcon name="trash" :size="14" />清空数据
    </button>
  </div>
  <p v-if="pageNotice" class="page-notice">{{ pageNotice }}</p>

  <UiModal
    v-model="generalOpen"
    title="常规设置"
    description="导出与打印的初始值，下次打开导出面板时生效。"
  >
    <div class="field-row">
      <div class="field">
        <label>默认图片清晰度</label>
        <UiSelect v-model="preferences.exportScale" :options="exportScaleOptions" />
      </div>
      <div class="field">
        <label>默认打印纸张</label>
        <UiSelect v-model="preferences.paper" :options="paperOptions" />
      </div>
    </div>
    <p class="modal-note">单次导出仍可在项目内临时调整。</p>
    <template #footer>
      <button class="btn" @click="resetPreferences">恢复默认值</button>
      <button class="btn primary" @click="generalOpen = false">完成</button>
    </template>
  </UiModal>

  <UiModal
    v-model="backupOpen"
    title="备份与恢复"
    description="导入会覆盖同 ID 的数据。"
  >
    <div class="modal-actions">
      <button class="btn" :disabled="busy" @click="backupAll">
        <UiIcon name="export" :size="14" />导出全量备份
      </button>
      <button class="btn" :disabled="busy" @click="importInput?.click()">
        <UiIcon name="import" :size="14" />导入备份
      </button>
      <input ref="importInput" type="file" accept=".json" hidden @change="importBackup" />
    </div>
    <p v-if="backupNotice" class="modal-note" :class="{ 'is-warn': backupNoticeWarn }">{{ backupNotice }}</p>
    <template #footer>
      <button class="btn" @click="backupOpen = false">关闭</button>
    </template>
  </UiModal>

  <UiModal
    v-model="snapshotOpen"
    title="历史快照"
    description="只清空排座版本记录，名册、布局与项目不受影响。"
  >
    <div class="snap-count">
      <b>{{ usage.snapshotCount }}</b>
      <span>条历史快照（全部项目）</span>
    </div>
    <p v-if="latestSnapshot" class="modal-note">
      当前项目最近一条：{{ fmtTime(latestSnapshot.createdAt) }}
    </p>
    <p v-if="snapshotNotice" class="modal-note">{{ snapshotNotice }}</p>
    <template #footer>
      <button class="btn" @click="snapshotOpen = false">关闭</button>
      <button class="btn danger" :disabled="busy || !usage.snapshotCount" @click="clearSnaps">
        {{ busy ? '正在清空…' : '清空全部快照' }}
      </button>
    </template>
  </UiModal>

  <UiModal
    v-model="clearOpen"
    title="清空数据"
    description="删除本机全部数据，操作不可恢复。"
  >
    <div class="settings-usage">
      <div class="settings-usage-row">
        <span>总占用</span>
        <b>{{ fmtBytes(usage.totalBytes) }}</b>
      </div>
      <div class="settings-usage-row">
        <span>存储位置</span>
        <b>{{ storageLabel }} · {{ state.persistent ? '关闭应用后保留' : '仅本次会话有效' }}</b>
      </div>
    </div>
    <p class="modal-note">将删除全部名册方案、会场布局、排座项目、历史快照与布局预设。</p>
    <template #footer>
      <button class="btn" :disabled="busy" @click="clearOpen = false">取消</button>
      <button class="btn danger" :disabled="busy" @click="clearAll">{{ busy ? '正在清空…' : '确认清空' }}</button>
    </template>
  </UiModal>

  <UiModal v-model="aboutOpen" title="关于" icon="info">
    <dl class="about-meta">
      <div><dt>作者</dt><dd>ifui</dd></div>
      <div><dt>邮箱</dt><dd><a href="mailto:ifui@foxmail.com">ifui@foxmail.com</a></dd></div>
      <div><dt>版本</dt><dd>{{ appVersion }}</dd></div>
      <div><dt>存储</dt><dd>{{ storageLabel }}{{ state.persistent ? ' · 关闭应用后保留' : ' · 仅本次会话有效' }}</dd></div>
    </dl>
    <template #footer>
      <button class="btn" @click="aboutOpen = false">关闭</button>
    </template>
  </UiModal>
</template>

<style scoped>
.stat-grid.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 24px;
  row-gap: 10px;
  margin-top: 16px;
}
.ov-block { min-width: 0; }
.ov-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}
.ov-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-primary); }
.ov-meta {
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.settings-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.settings-tools .btn { height: 32px; }
/* 危险操作独占视觉权重：始终靠右，换行后仍与主动作拉开距离 */
.settings-tools .btn.danger { margin-left: auto; }
.tool-num {
  margin-left: 2px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.page-notice { margin: 0; font-size: 11.5px; color: var(--text-muted); }

.modal-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.modal-note { margin: 0; font-size: 11.5px; line-height: 1.6; color: var(--text-muted); }
.modal-note.is-warn { color: var(--warning); }

.settings-usage {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.settings-usage-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.settings-usage-row + .settings-usage-row { border-top: 1px solid var(--border-soft); }
.settings-usage-row b {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.snap-count {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.snap-count b {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.snap-count span { font-size: var(--fs-xs); color: var(--text-muted); }

.about-meta { margin: 0; display: flex; flex-direction: column; gap: 8px; }
.about-meta > div { display: flex; align-items: baseline; gap: 10px; font-size: var(--fs-xs); }
.about-meta dt { width: 36px; flex: none; color: var(--text-muted); }
.about-meta dd { margin: 0; min-width: 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.about-meta a { color: var(--primary); text-decoration: none; }
.about-meta a:hover { text-decoration: underline; }

@media (max-width: 1000px) {
  .overview-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .stat-grid.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-grid.four .stat:nth-child(even) { border-left: 1px solid var(--border-soft); }
  .stat-grid.four .stat:nth-child(3) { border-left: 0; border-top: 1px solid var(--border-soft); }
  .stat-grid.four .stat:nth-child(4) { border-top: 1px solid var(--border-soft); }
}
</style>
