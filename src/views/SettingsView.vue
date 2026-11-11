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
  state.storage === 'indexeddb' ? 'IndexedDB' : state.storage === 'local' ? '本地存储' : '仅内存'
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
const assignedSeats = computed(() => {
  const p = project.value
  if (!p) return 0
  const byMember = new Map(members.value.map((m) => [m.id, m.status]))
  return p.assignments.filter(
    (a) => byMember.get(a.memberId) !== 'leave' && availableSeatIds.value.has(a.seatId)
  ).length
})
const freeSeats = computed(() => Math.max(0, availableSeats.value - assignedSeats.value))

const zoneRows = computed(() => {
  const zones = new Map((project.value?.seatOverlay?.zones ?? []).map((z) => [z.id, z.name]))
  const counts = new Map<string, number>()
  for (const s of seats.value) {
    if (s.disabled) continue
    const id = s.zoneId && zones.has(s.zoneId) ? s.zoneId : ''
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const rows = [...counts.entries()]
    .map(([id, value]) => ({ name: id ? zones.get(id)! : '未分区', value }))
    .sort((a, b) => b.value - a.value)
  if (rows.length > 8) {
    const head = rows.slice(0, 7)
    const rest = rows.slice(7).reduce((n, r) => n + r.value, 0)
    head.push({ name: '其他', value: rest })
    return head
  }
  return rows
})
const zoneSeatTotal = computed(() => zoneRows.value.reduce((n, r) => n + r.value, 0))

const snapshotRows = computed(() => {
  const map = new Map<string, number>()
  for (const s of snapshots.value) {
    const date = (s.createdAt || '').slice(0, 10)
    if (date) map.set(date, (map.get(date) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }))
})
const snapshotBytes = computed(() =>
  snapshots.value.length ? new TextEncoder().encode(JSON.stringify(snapshots.value)).length : 0
)
/** 仓储按主键返回，不保证时间序：显式取最新一条 */
const latestSnapshot = computed(() =>
  snapshots.value.reduce<Snapshot | undefined>(
    (latest, s) => (!latest || s.createdAt > latest.createdAt ? s : latest),
    undefined
  )
)

// ---------- 图表 ----------
const pieBase = {
  tooltip: { ...chartTooltip, trigger: 'item' as const, formatter: '{b}<br/>{c} 人 · {d}%' },
  legend: {
    bottom: 0,
    left: 'center',
    icon: 'circle',
    itemWidth: 7,
    itemHeight: 7,
    itemGap: 12,
    textStyle: { ...chartAxisText, fontSize: 11 }
  }
}

const memberChart = computed<ChartOption | null>(() => {
  if (!members.value.length) return null
  return {
    ...pieBase,
    series: [{
      type: 'pie',
      radius: ['54%', '74%'],
      center: ['50%', '43%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
      data: [
        { name: '在位', value: presentCount.value, itemStyle: { color: chartColors.success } },
        { name: '请假', value: leaveCount.value, itemStyle: { color: chartColors.warning } }
      ]
    }]
  } as ChartOption
})

const seatChart = computed<ChartOption | null>(() => {
  if (!seats.value.length) return null
  return {
    ...pieBase,
    tooltip: { ...chartTooltip, trigger: 'item', formatter: '{b}<br/>{c} 个座位 · {d}%' },
    series: [{
      type: 'pie',
      radius: ['54%', '74%'],
      center: ['50%', '43%'],
      avoidLabelOverlap: true,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
      data: [
        { name: '已就座', value: assignedSeats.value, itemStyle: { color: chartColors.success } },
        { name: '空位', value: freeSeats.value, itemStyle: { color: chartColors.primary } },
        { name: '不坐人', value: disabledSeats.value, itemStyle: { color: chartColors.muted } }
      ]
    }]
  } as ChartOption
})

const zonePalette = [chartColors.primary, chartColors.info, chartColors.warning, chartColors.success, chartColors.muted]

const zoneChart = computed<ChartOption | null>(() => {
  if (!zoneRows.value.length) return null
  return {
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        return `${p.name}<br/>${p.value} 个座位`
      }
    },
    grid: { left: 0, right: 28, top: 4, bottom: 0, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { ...chartAxisText },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: zoneRows.value.map((r) => r.name),
      axisLabel: { ...chartAxisText, width: 76, overflow: 'truncate' },
      axisLine: { show: false },
      axisTick: { show: false }
    },
    series: [{
      type: 'bar',
      barWidth: 9,
      data: zoneRows.value.map((r, i) => ({ value: r.value, itemStyle: { color: zonePalette[i % zonePalette.length] } })),
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      showBackground: true,
      backgroundStyle: { color: chartColors.bgHover, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true,
        position: 'right',
        color: chartColors.textSecondary,
        fontSize: 11,
        fontFamily: chartFont
      }
    }]
  } as ChartOption
})

const trendChart = computed<ChartOption | null>(() => {
  if (!snapshotRows.value.length) return null
  const rows = snapshotRows.value
  return {
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        const row = rows[p.dataIndex]
        return `${row?.date ?? p.name}<br/>${p.value} 条快照`
      }
    },
    grid: { left: 0, right: 8, top: 14, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.date.slice(5)),
      axisLabel: { ...chartAxisText, interval: rows.length > 9 ? 'auto' : 0 },
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
      label: { show: rows.length <= 9, position: 'top', color: chartColors.textSecondary, fontSize: 11, fontFamily: chartFont }
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

function download(name: string, body: string, type: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([body], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function backupAll(): Promise<void> {
  try {
    const json = await repository.exportAll()
    download(`seat-planning-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
    backupNoticeWarn.value = false
    backupNotice.value = '已导出全量备份，请妥善保存该文件。'
  } catch {
    backupNoticeWarn.value = true
    backupNotice.value = '当前浏览器不支持本机数据库，备份不可用。'
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
            <span class="ov-title">名册状态</span>
            <span class="ov-meta">{{ roster?.members ? (project.rosterSnapshot ? '名册快照' : '实时名册') : '无名册' }} · {{ members.length }} 人</span>
          </div>
          <UiChart :option="memberChart" :height="168" empty-text="项目还没有名册数据" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">座位构成</span>
            <span class="ov-meta">已就座 {{ assignedSeats }} / 可用 {{ availableSeats }}</span>
          </div>
          <UiChart :option="seatChart" :height="168" empty-text="布局中没有座位" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">区域分布</span>
            <span class="ov-meta">{{ zoneRows.length }} 个区域 · {{ zoneSeatTotal }} 座</span>
          </div>
          <UiChart :option="zoneChart" :height="168" empty-text="还没有划分区域" />
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span class="ov-title">快照趋势</span>
            <span class="ov-meta">{{ snapshots.length }} 条 · {{ fmtBytes(snapshotBytes) }}</span>
          </div>
          <UiChart :option="trendChart" :height="168" empty-text="还没有历史快照" />
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
      <UiIcon name="list" :size="14" />关于
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
        <b>{{ storageLabel }} · {{ state.persistent ? '关闭浏览器后保留' : '仅本次会话有效' }}</b>
      </div>
    </div>
    <p class="modal-note">将删除全部名册方案、会场布局、排座项目、历史快照与布局预设。</p>
    <template #footer>
      <button class="btn" :disabled="busy" @click="clearOpen = false">取消</button>
      <button class="btn danger" :disabled="busy" @click="clearAll">{{ busy ? '正在清空…' : '确认清空' }}</button>
    </template>
  </UiModal>

  <UiModal v-model="aboutOpen" title="关于">
    <dl class="about-meta">
      <div><dt>作者</dt><dd>ifui</dd></div>
      <div><dt>邮箱</dt><dd><a href="mailto:ifui@foxmail.com">ifui@foxmail.com</a></dd></div>
      <div><dt>版本</dt><dd>{{ appVersion }}</dd></div>
      <div><dt>存储</dt><dd>{{ storageLabel }}{{ state.persistent ? ' · 关闭浏览器后保留' : ' · 仅本次会话有效' }}</dd></div>
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
