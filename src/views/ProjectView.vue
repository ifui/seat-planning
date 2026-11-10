<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as XLSX from 'xlsx'
import type { Assignment, AttendStatus, Member, Project, RosterPlan } from '../types'
import { DEFAULT_RULESET } from '../types'
import { getSnapshot, layoutOf, listSnapshots, removeProject, removeSnapshots, rosterOf, saveProject, saveSnapshot, state } from '../store'
import { applyRulesToProject, seatIndexMap, seatOrderMap } from '../engine/seating'
import { nowISO, applySeatCapacity, cellAt, clampSeats, keyOf, seatsOfSheet, sheetSize, uid, type SeatRef } from '../engine/sheet'
import { renderSeatChart } from '../engine/render'
import SeatBoardPane from '../components/project/SeatBoardPane.vue'
import RulesPanel from '../components/RulesPanel.vue'
import ImportDialog from '../components/roster/ImportDialog.vue'
import { UiChart, UiSelect, UiModal, UiIcon as Icon } from '../ui'
import { chartAxisText, chartColors, chartFont, chartTooltip, type ChartOption } from '../ui/charts'

const sideTab = ref<'overview' | 'list' | 'leave' | 'rules' | 'export'>('list')

const selectedId = ref<string>(state.projects[0]?.id ?? '')
const draft = ref<Project | null>(null)
const dirty = ref(false)
const toast = ref('')
const warnings = ref<string[]>([])
const selectedSeat = ref<string | null>(null)
/** 换座后短暂高亮两个座位，便于确认交换对象 */
const swapFlash = ref<string[]>([])
let swapTimer = 0
const CARD_W = 268
const seatAnchor = ref<HTMLElement | null>(null)
const popoverEl = ref<HTMLElement | null>(null)
const popoverPos = ref({ left: 0, top: 0, above: false, arrow: CARD_W / 2 })
let popRaf = 0
const busy = ref(false)
let loading = false

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

async function load(id: string): Promise<void> {
  if (dirty.value && draft.value && draft.value.id !== id) await flushAutosave()
  const found = state.projects.find((p) => p.id === id)
  loading = true
  draft.value = found ? clone(found) : null
  if (draft.value && !draft.value.ruleSet.zoneRules) draft.value.ruleSet.zoneRules = []
  // 旧项目没有序号开关字段，默认显示以保持原有观感
  if (draft.value && draft.value.showSeatNumbers === undefined) draft.value.showSeatNumbers = true
  // 信息行默认只显示职级，职务与单位由用户按需打开
  if (draft.value && draft.value.showRank === undefined) draft.value.showRank = true
  if (draft.value && draft.value.showDuty === undefined) draft.value.showDuty = false
  if (draft.value && draft.value.showUnit === undefined) draft.value.showUnit = false
  selectedSeat.value = null
  seatAnchor.value = null
  warnings.value = []
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
    await saveProject(draft.value)
    if (seq === autosaveSeq) dirty.value = false
  }, 900)
}

async function flushAutosave(): Promise<void> {
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  if (!dirty.value || !draft.value) return
  await saveProject(draft.value)
  dirty.value = false
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

onMounted(() => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('scroll', schedulePlace, true)
  window.addEventListener('wheel', schedulePlace, { capture: true, passive: true })
  window.addEventListener('resize', schedulePlace)
  document.addEventListener('pointerdown', onDocPointer, true)
  window.addEventListener('keydown', onEsc)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('scroll', schedulePlace, true)
  window.removeEventListener('wheel', schedulePlace, true)
  window.removeEventListener('resize', schedulePlace)
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('keydown', onEsc)
  if (popRaf) cancelAnimationFrame(popRaf)
  window.clearTimeout(swapTimer)
  window.clearTimeout(autosaveTimer)
  window.clearTimeout(flashTimer)
  void flushAutosave()
})
watch(
  () => state.projects.map((p) => p.id).join(','),
  () => {
    if (!state.projects.some((p) => p.id === selectedId.value)) selectedId.value = state.projects[0]?.id ?? ''
  }
)

let flashTimer = 0
function flash(msg: string): void {
  toast.value = msg
  // 上一条提示的定时器必须清掉，否则会把新提示提前擦除
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => { toast.value = '' }, 2600)
}

const roster = computed(() => (draft.value ? rosterOf(draft.value) : undefined))
/** 排座用布局：在布局原件之上叠加本项目的桌容量覆盖（不改动共享布局） */
const layout = computed(() => {
  const base = draft.value ? layoutOf(draft.value) : undefined
  if (!base) return undefined
  return { ...base, sheet: applySeatCapacity(base.sheet, draft.value?.seatCapacity) }
})

const memberById = computed(() => new Map((roster.value?.members ?? []).map((m) => [m.id, m])))
const rankById = computed(() => new Map((roster.value?.ranks ?? []).map((r) => [r.id, r])))
const unitById = computed(() => new Map((roster.value?.units ?? []).map((u) => [u.id, u])))

/** 名单里的辅助信息：级别 · 单位，用来区分同名/同姓 */
function memberHint(m: Member): string {
  const rank = rankById.value.get(m.rankId)?.name ?? '未定级'
  const unit = unitById.value.get(m.unitId)?.name
  return unit ? `${rank} · ${unit}` : rank
}

const seatInfo = computed(() => {
  const out: Record<string, { name: string; rankName: string; unitName: string; duty: string; color: string; status: string; locked: boolean }> = {}
  if (!draft.value) return out
  for (const a of draft.value.assignments) {
    const m = memberById.value.get(a.memberId)
    if (!m || m.status === 'leave') continue
    const r = rankById.value.get(m.rankId)
    out[a.seatId] = {
      name: m.name,
      rankName: r?.name ?? '未定级',
      unitName: unitById.value.get(m.unitId)?.name ?? '',
      duty: m.duty ?? '',
      color: r?.color ?? '#8a979d',
      status: a.status,
      locked: a.locked
    }
  }
  return out
})

const allSeats = computed<SeatRef[]>(() => (layout.value ? seatsOfSheet(layout.value.sheet) : []))
const seatIndex = computed(() => (layout.value ? seatIndexMap(layout.value) : new Map<string, SeatRef>()))
const seatOrder = computed(() =>
  layout.value && draft.value ? seatOrderMap(layout.value, draft.value.ruleSet) : new Map<string, number>()
)
/** 点选座位时记下它所在的桌，座位 id 因容量变化失效后仍能定位 */
const pickedCell = ref<{ row: number; col: number } | null>(null)

function seatLabel(seatId: string): string {
  const s = seatIndex.value.get(seatId)
  if (!s) {
    // 座位槽被增删后旧 id 可能已不存在，用点选时记下的桌兜底
    const p = pickedCell.value
    if (!p || !layout.value) return '座位'
    const cell = cellAt(layout.value.sheet, p.row, p.col)
    return cell?.kind === 'podium' ? '主席台' : `第 ${p.row + 1} 排`
  }
  const no = seatOrder.value.get(seatId)
  return `${s.stage ? '主席台' : `第 ${s.row + 1} 排`}${no ? ` · ${no} 号` : ''}`
}
const totalSeats = computed(() => allSeats.value.filter((s) => !s.disabled).length)
const disabledSeats = computed(() => allSeats.value.filter((s) => s.disabled).length)
const participants = computed(() => {
  if (!draft.value || !roster.value) return [] as Member[]
  const ids = draft.value.participantIds.length ? draft.value.participantIds : roster.value.members.map((m) => m.id)
  return ids.map((id) => memberById.value.get(id)).filter((m): m is Member => !!m)
})
const presentMembers = computed(() => participants.value.filter((m) => m.status === 'present'))
const leaveMembers = computed(() => participants.value.filter((m) => m.status === 'leave'))

// ---- 名单搜索与座位定位 ----
const boardPaneRef = ref<InstanceType<typeof SeatBoardPane> | null>(null)
const rosterQuery = ref('')
const focusedSeat = ref<string | null>(null)
const filteredParticipants = computed(() => {
  const q = rosterQuery.value.trim().toLowerCase()
  if (!q) return participants.value
  return participants.value.filter((m) => {
    const rank = rankById.value.get(m.rankId)?.name ?? ''
    const unit = unitById.value.get(m.unitId)?.name ?? ''
    return [m.name, rank, unit, m.duty ?? ''].some((s) => s.toLowerCase().includes(q))
  })
})

/** 点名单里的人：左侧座位图高亮并平滑滚动到该座位 */
function focusMember(m: Member): void {
  const a = draft.value?.assignments.find((x) => x.memberId === m.id)
  if (!a) {
    flash(`「${m.name}」还没有座位`)
    return
  }
  closeSeatCard()
  focusedSeat.value = a.seatId
  boardPaneRef.value?.scrollToSeat(a.seatId)
}
const assignedCount = computed(() => {
  if (!draft.value) return 0
  return draft.value.assignments.filter((a) => memberById.value.get(a.memberId)?.status !== 'leave').length
})
const leaveCount = computed(() => leaveMembers.value.length)
/** 座位序号开关：缺省显示，兼容旧项目 */
const showSeatNumbers = computed(() => draft.value?.showSeatNumbers !== false)
/** 座位下方信息开关：职级缺省显示，职务/单位缺省关闭 */
const showRank = computed(() => draft.value?.showRank !== false)
const showDuty = computed(() => draft.value?.showDuty === true)
const showUnit = computed(() => draft.value?.showUnit === true)
const emptySeats = computed(() => Math.max(0, totalSeats.value - assignedCount.value))

// ---- 会场概览图表 ----
const usedSeats = computed(() => assignedCount.value)

const STATUS_META: { key: AttendStatus; label: string; color: string }[] = [
  { key: 'present', label: '在位', color: chartColors.success },
  { key: 'leave', label: '请假', color: chartColors.warning }
]

const statusCounts = computed(() => {
  const counts: Record<AttendStatus, number> = { present: 0, leave: 0 }
  for (const a of draft.value?.assignments ?? []) {
    if (memberById.value.get(a.memberId)?.status === 'leave') continue
    counts[a.status]++
  }
  counts.leave = leaveMembers.value.length
  return counts
})

/** 座位使用率：请假者不占座，只统计已就座与空位。 */
const usageChart = computed<ChartOption | null>(() => {
  if (!totalSeats.value) return null
  const rate = Math.round((usedSeats.value / totalSeats.value) * 100)
  const data = [
    { value: assignedCount.value, name: '已就座', itemStyle: { color: chartColors.success } },
    { value: emptySeats.value, name: '空位', itemStyle: { color: chartColors.border } }
  ].filter((d) => d.value > 0)
  return {
    animationDuration: 320,
    title: {
      text: `${rate}%`,
      subtext: '座位使用率',
      left: 'center',
      top: '30%',
      itemGap: 2,
      textStyle: { color: chartColors.textPrimary, fontSize: 18, fontWeight: 600, fontFamily: chartFont },
      subtextStyle: { color: chartColors.muted, fontSize: 11, fontFamily: chartFont }
    },
    tooltip: { ...chartTooltip, trigger: 'item', formatter: '{b}：{c} 个（{d}%）' },
    legend: {
      bottom: 0, left: 'center', icon: 'circle',
      itemWidth: 8, itemHeight: 8, itemGap: 12,
      textStyle: { color: chartColors.textSecondary, fontSize: 11, fontFamily: chartFont }
    },
    series: [{
      type: 'pie',
      radius: ['54%', '76%'],
      center: ['50%', '40%'],
      avoidLabelOverlap: false,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
      emphasis: { scaleSize: 3 },
      data
    }]
  }
})

/** 顶栏座位构成：已就座 / 空位 / 请假 / 固定空位 的堆叠占比 */
const mixChart = computed<ChartOption | null>(() => {
  const total = assignedCount.value + emptySeats.value + leaveCount.value + disabledSeats.value
  if (!total) return null
  const segs = [
    { name: '已就座', value: assignedCount.value, color: chartColors.success, labelColor: '#ffffff' },
    { name: '空位', value: emptySeats.value, color: '#cfdcdb', labelColor: '#415a59' },
    { name: '请假', value: leaveCount.value, color: chartColors.warning, labelColor: '#ffffff' },
    { name: '固定空位', value: disabledSeats.value, color: chartColors.muted, labelColor: '#ffffff' }
  ]
  const pct = (v: number): number => Math.round((v / total) * 100)
  return {
    animationDuration: 320,
    grid: { left: 0, right: 0, top: 3, bottom: 3 },
    tooltip: {
      ...chartTooltip,
      trigger: 'item',
      formatter: (p: any) => `${p.name}：${p.value}（${pct(Number(p.value))}%）`
    },
    xAxis: { type: 'value', max: total, show: false },
    yAxis: { type: 'category', data: [''], show: false },
    series: segs.map((s) => ({
      type: 'bar',
      name: s.name,
      stack: 'mix',
      barWidth: 20,
      data: [s.value],
      itemStyle: { color: s.color },
      label: {
        show: s.value > 0 && s.value / total >= 0.1,
        position: 'inside',
        color: s.labelColor,
        fontSize: 10,
        fontFamily: chartFont,
        formatter: () => String(s.value)
      }
    }))
  }
})

const statusChart = computed<ChartOption | null>(() => {
  const data = STATUS_META
    .map((s) => ({ value: statusCounts.value[s.key], name: s.label, itemStyle: { color: s.color } }))
    .filter((d) => d.value > 0)
  if (!data.length) return null
  return {
    animationDuration: 320,
    tooltip: { ...chartTooltip, trigger: 'item', formatter: '{b}：{c} 人（{d}%）' },
    legend: {
      bottom: 0, left: 'center', icon: 'circle',
      itemWidth: 8, itemHeight: 8, itemGap: 12,
      textStyle: { color: chartColors.textSecondary, fontSize: 11, fontFamily: chartFont }
    },
    series: [{
      type: 'pie',
      radius: ['52%', '74%'],
      center: ['50%', '42%'],
      avoidLabelOverlap: false,
      label: { show: false },
      labelLine: { show: false },
      itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
      emphasis: { scaleSize: 3 },
      data
    }]
  }
})

/** 区域就座：按布局分区汇总可用座位与已占用座位（请假者不占座）。 */
const zoneStats = computed(() => {
  if (!layout.value) return []
  const cap = new Map<string, number>()
  const occ = new Map<string, number>()
  const seatZone = new Map<string, string>()
  for (const s of allSeats.value) {
    if (s.disabled) continue
    const zid = s.zoneId ?? '__none'
    cap.set(zid, (cap.get(zid) ?? 0) + 1)
    seatZone.set(s.seatId, zid)
  }
  for (const a of draft.value?.assignments ?? []) {
    const zid = seatZone.get(a.seatId)
    if (zid) occ.set(zid, (occ.get(zid) ?? 0) + 1)
  }
  const rows = layout.value.zones
    .filter((z) => cap.has(z.id))
    .map((z) => ({ id: z.id, name: z.name, total: cap.get(z.id) ?? 0, occupied: occ.get(z.id) ?? 0 }))
  if (cap.has('__none')) {
    rows.push({ id: '__none', name: '未分区', total: cap.get('__none') ?? 0, occupied: occ.get('__none') ?? 0 })
  }
  return rows
})

const zoneChartHeight = computed(() => {
  const n = zoneStats.value.length
  return n ? Math.min(200, Math.max(88, n * 30 + 8)) : 88
})

const zoneChart = computed<ChartOption | null>(() => {
  const rows = zoneStats.value
  if (!rows.length) return null
  const max = Math.max(1, ...rows.map((r) => r.total))
  return {
    animationDuration: 320,
    grid: { left: 0, right: 42, top: 4, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(74, 124, 123, .06)' } },
      formatter: (p: any) => {
        const row = rows[(Array.isArray(p) ? p[0] : p).dataIndex]
        return `${row.name}<br/>已就座 ${row.occupied} / 可用 ${row.total}`
      }
    },
    xAxis: {
      type: 'value',
      max,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, width: 52, overflow: 'truncate', ellipsis: '…' }
    },
    series: [{
      type: 'bar',
      data: rows.map((r) => r.occupied),
      barWidth: 9,
      itemStyle: { color: chartColors.primary, borderRadius: [0, 4, 4, 0] },
      showBackground: true,
      backgroundStyle: { color: chartColors.bgHover, borderRadius: [0, 4, 4, 0] },
      label: {
        show: true, position: 'right', distance: 6,
        color: chartColors.muted, fontSize: 11, fontFamily: chartFont,
        formatter: (p: any) => {
          const row = rows[p.dataIndex]
          return `${row.occupied}/${row.total}`
        }
      }
    }]
  }
})

const selectedAssignment = computed<Assignment | undefined>(() =>
  draft.value && selectedSeat.value ? draft.value.assignments.find((a) => a.seatId === selectedSeat.value) : undefined
)
const selectedMember = computed(() => {
  const a = selectedAssignment.value
  return a ? memberById.value.get(a.memberId) : undefined
})
const selectedSeatDisabled = computed(() => {
  if (!selectedSeat.value) return false
  return !!seatIndex.value.get(selectedSeat.value)?.disabled
})

// ---- 座位详情卡片：锚定在座位上方/下方，随滚动与缩放跟随 ----
function placeSeatCard(): void {
  const el = seatAnchor.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const gap = 10
  const roomBelow = window.innerHeight - r.bottom - 8
  const roomAbove = r.top - 8
  const above = roomBelow < 190 && roomAbove > roomBelow
  const left = Math.min(Math.max(8, r.left + r.width / 2 - CARD_W / 2), window.innerWidth - CARD_W - 8)
  const arrow = Math.min(Math.max(14, r.left + r.width / 2 - left), CARD_W - 14)
  popoverPos.value = { left, top: above ? r.top - gap : r.bottom + gap, above, arrow }
}

function schedulePlace(): void {
  if (popRaf) return
  popRaf = requestAnimationFrame(() => {
    popRaf = 0
    placeSeatCard()
  })
}

function pickSeat(seatId: string, el: HTMLElement, row?: number, col?: number): void {
  if (selectedSeat.value === seatId && seatAnchor.value === el) {
    closeSeatCard()
    return
  }
  if (Number.isFinite(row) && Number.isFinite(col)) pickedCell.value = { row: row as number, col: col as number }
  selectedSeat.value = seatId
  seatAnchor.value = el
  placeSeatCard()
  void nextTick(() => popoverEl.value?.focus({ preventScroll: true }))
}

function closeSeatCard(): void {
  selectedSeat.value = null
  seatAnchor.value = null
}

function onDocPointer(e: PointerEvent): void {
  const t = e.target as HTMLElement | null
  // 点页面空白处取消名单里的人员高亮；点其他人员则切换选中
  if (focusedSeat.value && !t?.closest('.member-row')) focusedSeat.value = null
  if (!selectedSeat.value) return
  if (!t || t.closest('.seat-popover') || t.closest('.sb-seat') || t.closest('.ui-select-panel')) return
  closeSeatCard()
}

function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 批量容量：先把框选/点选的桌清掉，再考虑关闭座位详情
  if (capacityMode.value && cellSelection.value.length) {
    cellSelection.value = []
    e.preventDefault()
    return
  }
  if (!selectedSeat.value) return
  const el = seatAnchor.value
  closeSeatCard()
  if (el?.isConnected) el.focus({ preventScroll: true })
}

// ---- 桌容量：按本项目设置，缺省沿用布局旧数据 ----
/** 批量调整容量：点选多张桌后统一设置 */
const capacityMode = ref(false)
const cellSelection = ref<string[]>([])
const capCustom = ref(1)

const selectedSeatRef = computed(() => (selectedSeat.value ? seatIndex.value.get(selectedSeat.value) : undefined))
/** 座位 id 失效时回落到点选时记录的桌，保证「应用」始终作用在用户点的那一格 */
const selectedCellPos = computed(() => {
  const s = selectedSeatRef.value
  if (s) return { row: s.row, col: s.col }
  return pickedCell.value
})
const selectedCellKey = computed(() => {
  const p = selectedCellPos.value
  return p ? keyOf(p.row, p.col) : ''
})
const selectedCellSeats = computed(() => {
  const p = selectedCellPos.value
  if (!p || !layout.value) return 1
  return clampSeats(cellAt(layout.value.sheet, p.row, p.col)?.seats ?? 1)
})
watch(selectedCellSeats, (v) => { capCustom.value = v }, { immediate: true })

/** 容量变化后座位槽可能被重排：旧 id 失效时把选中态移到该桌第一个座位，卡片不脱锚 */
watch(allSeats, () => {
  if (!selectedSeat.value) return
  if (seatIndex.value.has(selectedSeat.value)) return
  const p = pickedCell.value
  if (!p) return
  const first = allSeats.value.find((s) => s.row === p.row && s.col === p.col)
  if (!first) {
    closeSeatCard()
    return
  }
  selectedSeat.value = first.seatId
  void nextTick(() => {
    const el = document.querySelector(`.board-card [data-seat-id="${CSS.escape(first.seatId)}"]`) as HTMLElement | null
    if (!el) return
    seatAnchor.value = el
    placeSeatCard()
  })
})

/** 指定格当前包含的座位 id（合并区按锚点归属） */
function seatIdsOfCell(key: string): string[] {
  if (!layout.value) return []
  return seatsOfSheet(layout.value.sheet)
    .filter((s) => keyOf(s.row, s.col) === key)
    .map((s) => s.seatId)
}

function sameCaps(a?: Record<string, number>, b?: Record<string, number>): boolean {
  const ka = Object.keys(a ?? {})
  const kb = Object.keys(b ?? {})
  if (ka.length !== kb.length) return false
  return ka.every((k) => (a ?? {})[k] === (b ?? {})[k])
}

/**
 * 设置若干张桌的容量：重排座位槽，保留仍存在的已落座人员；
 * 被裁掉的座位若有人，自动移出并明确提示，不静默丢弃。
 */
function setCapacity(keys: string[], nRaw: number): void {
  if (!draft.value || !layout.value) return
  const n = clampSeats(nRaw)
  const targets = [...new Set(keys.filter(Boolean))]
  if (!targets.length) {
    flash('没有定位到座位所在的桌，请重新点选')
    return
  }
  const before = new Set(targets.flatMap(seatIdsOfCell))
  const base = layoutOf(draft.value)
  const prevCaps = { ...(draft.value.seatCapacity ?? {}) }
  const caps = { ...prevCaps }
  let touched = 0
  for (const key of targets) {
    const cell = base?.sheet.cells[key]
    if (!cell || (cell.kind !== 'seat' && cell.kind !== 'podium')) continue
    touched++
    if (clampSeats(cell.seats ?? 1) === n) delete caps[key]
    else caps[key] = n
  }
  if (!touched) {
    flash('这张桌不能在排座项目里设置人数')
    return
  }
  const changed = !sameCaps(prevCaps, caps)
  draft.value.seatCapacity = caps
  const after = new Set(targets.flatMap(seatIdsOfCell))
  const lost = new Set([...before].filter((id) => !after.has(id)))
  const removed = lost.size ? draft.value.assignments.filter((a) => lost.has(a.seatId)) : []
  if (removed.length) {
    draft.value.assignments = draft.value.assignments.filter((a) => !lost.has(a.seatId))
    const names = removed.slice(0, 3).map((a) => memberById.value.get(a.memberId)?.name ?? '未知').join('、')
    flash(`容量改为 ${n} 人，${removed.length} 位已落座人员被移出：${names}${removed.length > 3 ? ' 等' : ''}`)
    return
  }
  flash(changed ? `本桌容量已设为 ${n} 人` : `本桌已是 ${n} 人`)
}

/** 预设按钮：写入数字框并立即应用，保持两者选中态同步 */
function applyPreset(n: number): void {
  capCustom.value = n
  setCapacity([selectedCellKey.value], n)
}

/** 详情卡「应用」：读取数字框，越界自动收敛后立即重算该格座位槽 */
function applyCapacityFromCard(): void {
  const raw = Number(capCustom.value)
  const n = clampSeats(Number.isFinite(raw) && raw > 0 ? raw : selectedCellSeats.value)
  capCustom.value = n
  setCapacity([selectedCellKey.value], n)
}

function toggleCapacityMode(): void {
  capacityMode.value = !capacityMode.value
  cellSelection.value = []
  if (capacityMode.value) closeSeatCard()
}

function toggleCell(key: string): void {
  const i = cellSelection.value.indexOf(key)
  if (i >= 0) cellSelection.value.splice(i, 1)
  else cellSelection.value.push(key)
}

/** 框选结果：不按 Ctrl 替换选区，按住 Ctrl 追加 */
function selectCells(keys: string[], append: boolean): void {
  if (!capacityMode.value) return
  if (!append) {
    cellSelection.value = [...new Set(keys)]
    return
  }
  const set = new Set(cellSelection.value)
  for (const k of keys) set.add(k)
  cellSelection.value = [...set]
}

function applyBatchCapacity(n: number): void {
  if (!cellSelection.value.length) {
    flash('先点选要调整的桌位')
    return
  }
  setCapacity(cellSelection.value, n)
  cellSelection.value = []
  capacityMode.value = false
}
const unseatedMembers = computed(() => {
  if (!draft.value) return [] as Member[]
  const seated = new Set(draft.value.assignments.map((a) => a.memberId))
  return presentMembers.value.filter((m) => !seated.has(m.id))
})
const projectOptions = computed(() => state.projects.map((p) => ({ value: p.id, label: p.name })))
const rosterOptions = computed(() => state.rosters.map((r) => ({ value: r.id, label: r.name })))
const layoutOptions = computed(() => state.layouts.map((l) => ({ value: l.id, label: l.name })))
const unseatedOptions = computed(() => [
  { value: '', label: '选择人员…' },
  ...unseatedMembers.value.map((m) => ({ value: m.id, label: m.name }))
])

async function save(): Promise<void> {
  if (!draft.value) return
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  await saveProject(draft.value)
  dirty.value = false
  flash('项目已保存')
}

// ---- 新建 / 重命名 / 删除 ----
const createOpen = ref(false)
const createForm = ref({ name: '', rosterPlanId: '', layoutPackageId: '' })

function openCreate(): void {
  if (!state.rosters.length || !state.layouts.length) { flash('需要至少一套名册和一个布局'); return }
  createForm.value = {
    name: `排座项目 ${state.projects.length + 1}`,
    rosterPlanId: roster.value?.id ?? state.rosters[0].id,
    layoutPackageId: layout.value?.id ?? state.layouts[0].id
  }
  createOpen.value = true
}

async function createProject(): Promise<void> {
  const name = createForm.value.name.trim()
  if (!name) { flash('请填写项目名称'); return }
  if (!createForm.value.rosterPlanId || !createForm.value.layoutPackageId) { flash('请选择名册与布局'); return }
  const sourceRoster = state.rosters.find((r) => r.id === createForm.value.rosterPlanId)
  if (!sourceRoster) { flash('所选名册不存在'); return }
  const p: Project = {
    id: uid('proj'),
    name,
    rosterPlanId: createForm.value.rosterPlanId,
    layoutPackageId: createForm.value.layoutPackageId,
    rosterSnapshot: clone(sourceRoster),
    ruleSet: clone(DEFAULT_RULESET),
    assignments: [],
    participantIds: [],
    unassigned: [],
    pendingNames: [],
    status: 'draft',
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
  await saveProject(p)
  createOpen.value = false
  selectedId.value = p.id
  flash('项目已创建')
}

/** 显式切换名册来源：重新冻结快照并清空旧分配，避免新旧人员混用 */
function changeRosterSource(id: string): void {
  if (!draft.value || !id || id === draft.value.rosterPlanId) return
  const live = state.rosters.find((r) => r.id === id)
  if (!live) return
  draft.value.rosterPlanId = id
  draft.value.rosterSnapshot = clone(live)
  draft.value.assignments = []
  draft.value.participantIds = []
  draft.value.unassigned = []
  draft.value.pendingNames = []
  draft.value.status = 'draft'
  flash('已切换名册来源，名单与排座结果已重置')
}

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
  if (!name) { flash('请填写项目名称'); return }
  draft.value.name = name
  renameOpen.value = false
  flash('名称已修改，记得保存')
}

const confirmState = ref<{ open: boolean; title: string; desc: string; action: () => void }>({
  open: false, title: '', desc: '', action: () => {}
})

function askDelete(): void {
  if (!draft.value) return
  const id = draft.value.id
  const name = draft.value.name
  confirmState.value = {
    open: true,
    title: '删除排座项目',
    desc: `「${name}」及其排座结果将被删除，此操作不可撤销。`,
    action: async () => {
      autosaveSeq++
      window.clearTimeout(autosaveTimer)
      dirty.value = false
      await removeProject(id)
      selectedId.value = state.projects[0]?.id ?? ''
      flash('项目已删除')
    }
  }
}

function runConfirm(): void {
  confirmState.value.action()
  confirmState.value.open = false
}

// ---- 排座 ----
async function runArrange(): Promise<void> {
  if (!draft.value || !roster.value || !layout.value) return
  const ids = draft.value.participantIds.length
    ? draft.value.participantIds
    : roster.value.members.map((m) => m.id)
  if (!ids.length) {
    flash('名册中没有可排座人员，请先维护名册或勾选参会人员')
    return
  }
  if (!seatsOfSheet(layout.value.sheet).some((s) => !s.disabled)) {
    flash('当前布局没有可用座位，请先在布局页添加座位')
    return
  }
  busy.value = true
  try {
    if (draft.value.assignments.length) {
      await saveSnapshot({
        id: uid('snap'),
        projectId: draft.value.id,
        createdAt: nowISO(),
        label: '排座前快照',
        assignments: clone(draft.value.assignments)
      })
    }
    const res = applyRulesToProject(draft.value, roster.value, layout.value)
    draft.value.assignments = res.assignments
    draft.value.unassigned = res.unassigned
    draft.value.status = 'seated'
    warnings.value = res.warnings
    await saveProject(draft.value)
    await loadSnaps()
    dirty.value = false
    flash(`已排出 ${res.assignments.length} 个座位，请假 ${leaveMembers.value.length} 人不参与排座`)
  } finally {
    busy.value = false
  }
}

function seatDisabled(id: string): boolean {
  return !!seatIndex.value.get(id)?.disabled
}

function swapSeats(a: string, b: string): void {
  if (!draft.value) return
  if (seatDisabled(a) || seatDisabled(b)) { flash('固定空位不可用于换座'); return }
  const aa = draft.value.assignments.find((x) => x.seatId === a)
  const bb = draft.value.assignments.find((x) => x.seatId === b)
  if (aa?.locked || bb?.locked) { flash('锁定座位不能移动，先解锁'); return }
  if (aa && bb) {
    const m = aa.memberId
    aa.memberId = bb.memberId
    bb.memberId = m
    const s = aa.status
    aa.status = bb.status
    bb.status = s
  } else if (aa) {
    aa.seatId = b
  } else if (bb) {
    bb.seatId = a
  }
  swapFlash.value = [a, b]
  window.clearTimeout(swapTimer)
  swapTimer = window.setTimeout(() => { swapFlash.value = [] }, 950)
}

/** 在位 / 请假：只改本项目快照，不影响总名册与其它项目。 */
async function setMemberStatus(m: Member, status: Member['status']): Promise<void> {
  if (m.status === status) return
  const snap = draft.value?.rosterSnapshot
  if (!draft.value || !snap) return
  const target = snap.members.find((x) => x.id === m.id)
  if (!target) return
  target.status = status
  if (status === 'leave') {
    draft.value.assignments = draft.value.assignments.filter((a) => a.memberId !== m.id)
  }
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  await saveProject(draft.value)
  dirty.value = false
  flash(status === 'leave' ? `「${m.name}」已请假，并已从座位移出` : `「${m.name}」已恢复在位，可重新排座`)
}

/** 座位详情里的与会状态：点一下立即切换并保存 */
async function setStatus(s: AttendStatus): Promise<void> {
  const a = selectedAssignment.value
  if (!a || a.status === s || !draft.value) return
  a.status = s
  autosaveSeq++
  window.clearTimeout(autosaveTimer)
  await saveProject(draft.value)
  dirty.value = false
}

function toggleLock(): void {
  const a = selectedAssignment.value
  if (!a) return
  a.locked = !a.locked
}

function clearSeat(): void {
  if (!draft.value || !selectedSeat.value) return
  draft.value.assignments = draft.value.assignments.filter((a) => a.seatId !== selectedSeat.value)
}

function seatMember(memberId: string): void {
  if (!draft.value || !selectedSeat.value || !memberId) return
  if (selectedSeatDisabled.value) { flash('该座位已标记为空位，排座时会跳过'); return }
  const existing = draft.value.assignments.find((a) => a.seatId === selectedSeat.value)
  if (existing) existing.memberId = memberId
  else draft.value.assignments.push({ seatId: selectedSeat.value, memberId, status: 'present', locked: false })
}

// ---- 名单 ----

// ---- 手动添加人员：对话框录入，单个回车添加，支持逗号 / 顿号 / 换行分隔批量添加 ----
const addOpen = ref(false)
const addText = ref('')
const addRankId = ref('')
const addUnitId = ref('')
const addDuty = ref('')
const addInputEl = ref<HTMLTextAreaElement | null>(null)

const addRankOptions = computed(() => {
  const base = [{ value: '', label: '级别（可留空）' }]
  if (!roster.value) return base
  const ranks = [...roster.value.ranks].sort((a, b) => a.order - b.order)
  return [...base, ...ranks.map((r) => ({ value: r.id, label: r.name }))]
})
const addUnitOptions = computed(() => {
  const base = [{ value: '', label: '单位（可留空）' }]
  if (!roster.value) return base
  return [...base, ...roster.value.units.map((u) => ({ value: u.id, label: u.name }))]
})

const snapUnitOptions = computed(() =>
  (roster.value?.units ?? []).map((u) => ({ value: u.id, label: u.name }))
)
const snapUnitNames = computed(() => (roster.value?.units ?? []).map((u) => u.name))
const snapRankNames = computed(() => (roster.value?.ranks ?? []).map((r) => r.name))
const snapRootUnitId = computed(
  () => roster.value?.units.find((u) => u.parentId === null)?.id ?? roster.value?.units[0]?.id ?? ''
)

function openAdd(): void {
  addText.value = ''
  addDuty.value = ''
  addOpen.value = true
  void nextTick(() => addInputEl.value?.focus())
}

function splitNames(text: string): string[] {
  return [...new Set(text.split(/[,，、;；\r\n]+/).map((s) => s.trim()).filter(Boolean))]
}

function onAddKey(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  void submitAdd()
}

async function submitAdd(): Promise<void> {
  const snap = draft.value?.rosterSnapshot
  if (!draft.value || !snap) return
  const names = splitNames(addText.value)
  if (!names.length) return
  const unitId = addUnitId.value || snap.units[0]?.id
  const rankId = addRankId.value || [...snap.ranks].sort((a, b) => b.order - a.order)[0]?.id
  if (!unitId || !rankId) { flash('名册里至少需要一个单位和一个职级'); return }

  const wasEmpty = !draft.value.participantIds.length
  const touched: string[] = []
  const duty = addDuty.value.trim() || undefined
  let created = 0
  for (const name of names) {
    const hit = snap.members.find((m) => m.name === name || m.aliases.includes(name))
    if (hit) {
      touched.push(hit.id)
      continue
    }
    const member: Member = { id: uid('m'), name, unitId, rankId, duty, aliases: [], status: 'present' }
    snap.members.push(member)
    touched.push(member.id)
    created++
  }
  // 名单为空时表示「全名册参与」，新增后仍保持全员在名单内
  draft.value.participantIds = wasEmpty
    ? snap.members.map((m) => m.id)
    : [...new Set([...draft.value.participantIds, ...touched])]
  addText.value = ''
  addDuty.value = ''
  addOpen.value = false
  flash(created ? `已添加 ${created} 人并加入参会名单` : `已加入参会名单：${names.join('、')}`)
}

// ---- 导入名册：复用名册页的批量导入（文件解析 / 字段映射 / 预览修正） ----
const importOpen = ref(false)

function handleProjectImport(payload: {
  rows: { name: string; gender: '' | 'M' | 'F'; unit: string; rank: string; duty: string; note: string }[]
  targetUnitId: string
}): void {
  const snap = draft.value?.rosterSnapshot
  if (!draft.value || !snap || !payload.rows.length) return
  const rootId = snap.units.find((u) => u.parentId === null)?.id ?? snap.units[0]?.id ?? ''
  const fallbackRank = [...snap.ranks].sort((a, b) => b.order - a.order)[0]
  const wasEmpty = !draft.value.participantIds.length
  const createdIds: string[] = []
  let newRanks = 0
  for (const row of payload.rows) {
    const unitName = row.unit.trim()
    const unitId = (unitName ? snap.units.find((u) => u.name === unitName)?.id : '') || payload.targetUnitId || rootId
    let rankId = fallbackRank?.id ?? ''
    const rankName = row.rank.trim()
    if (rankName) {
      const exact = snap.ranks.find((r) => r.name === rankName)
      if (exact) rankId = exact.id
      else {
        const order = Math.max(0, ...snap.ranks.map((r) => r.order)) + 1
        const created = { id: uid('rank'), name: rankName, order, color: '#8a979d' }
        snap.ranks.push(created)
        rankId = created.id
        newRanks++
      }
    }
    const member: Member = {
      id: uid('m'),
      name: row.name,
      unitId,
      rankId,
      duty: row.duty.trim() || undefined,
      aliases: [],
      gender: row.gender || undefined,
      note: row.note || undefined,
      status: 'present'
    }
    snap.members.push(member)
    createdIds.push(member.id)
  }
  draft.value.participantIds = wasEmpty
    ? snap.members.map((m) => m.id)
    : [...new Set([...draft.value.participantIds, ...createdIds])]
  importOpen.value = false
  flash(`已导入 ${payload.rows.length} 人${newRanks ? `，新建职级 ${newRanks} 个` : ''}`)
}

// ---- 手动更新名册快照：与当前名册比对，逐项选择应用 ----
type DiffKind = 'unit' | 'rank' | 'duty' | 'removed' | 'added' | 'order'
interface RosterDiffItem {
  key: string
  kind: DiffKind
  memberId: string
  name: string
  from: string
  to: string
}
const DIFF_META: Record<DiffKind, { label: string; icon: string }> = {
  unit: { label: '单位变更', icon: 'host' },
  rank: { label: '职级调整', icon: 'up' },
  duty: { label: '职务变更', icon: 'label' },
  removed: { label: '已不在名册', icon: 'warning' },
  added: { label: '新增人员', icon: 'plus' },
  order: { label: '顺序调整', icon: 'grip' }
}
const DIFF_ORDER: DiffKind[] = ['unit', 'rank', 'duty', 'removed', 'added', 'order']

const liveRoster = computed(() => {
  const id = draft.value?.rosterPlanId
  return id ? state.rosters.find((r) => r.id === id) : undefined
})

/** 当前名册 vs 项目快照的差异；未应用的差异会一直提示 */
const rosterDiff = computed<RosterDiffItem[]>(() => {
  const snap = draft.value?.rosterSnapshot
  const live = liveRoster.value
  if (!draft.value || !snap || !live) return []
  const liveById = new Map(live.members.map((m) => [m.id, m]))
  const snapById = new Map(snap.members.map((m) => [m.id, m]))
  const unitName = (r: RosterPlan, id: string): string => r.units.find((u) => u.id === id)?.name ?? '未定单位'
  const rankName = (r: RosterPlan, id: string): string => r.ranks.find((x) => x.id === id)?.name ?? '未定级'
  const items: RosterDiffItem[] = []
  for (const m of snap.members) {
    const cur = liveById.get(m.id)
    if (!cur) {
      items.push({ key: `removed:${m.id}`, kind: 'removed', memberId: m.id, name: m.name, from: memberHint(m), to: '名册中已移除' })
      continue
    }
    if (cur.unitId !== m.unitId) {
      items.push({ key: `unit:${m.id}`, kind: 'unit', memberId: m.id, name: cur.name, from: unitName(snap, m.unitId), to: unitName(live, cur.unitId) })
    }
    if (cur.rankId !== m.rankId) {
      items.push({ key: `rank:${m.id}`, kind: 'rank', memberId: m.id, name: cur.name, from: rankName(snap, m.rankId), to: rankName(live, cur.rankId) })
    }
    const oldDuty = (m.duty ?? '').trim()
    const newDuty = (cur.duty ?? '').trim()
    if (oldDuty !== newDuty) {
      items.push({ key: `duty:${m.id}`, kind: 'duty', memberId: m.id, name: cur.name, from: oldDuty || '未填写', to: newDuty || '未填写' })
    }
  }
  for (const m of live.members) {
    if (snapById.has(m.id)) continue
    items.push({ key: `added:${m.id}`, kind: 'added', memberId: m.id, name: m.name, from: '名册中新增', to: `${rankName(live, m.rankId)} · ${unitName(live, m.unitId)}` })
  }
  // 顺序：只比较双方都存在的成员，纯排序变化也要用户确认
  const snapCommon = snap.members.filter((m) => liveById.has(m.id)).map((m) => m.id)
  const liveCommon = live.members.filter((m) => snapById.has(m.id)).map((m) => m.id)
  if (snapCommon.join('|') !== liveCommon.join('|')) {
    items.push({
      key: 'order', kind: 'order', memberId: '', name: '名册顺序',
      from: '与本项目快照不同', to: `按当前名册顺序（${liveCommon.length} 人）`
    })
  }
  return items
})

const diffGroups = computed(() =>
  DIFF_ORDER
    .map((kind) => ({ kind, label: DIFF_META[kind].label, icon: DIFF_META[kind].icon, items: rosterDiff.value.filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length)
)

const diffOpen = ref(false)
const diffPick = ref<Record<string, boolean>>({})
const diffPickedCount = computed(() => rosterDiff.value.filter((it) => diffPick.value[it.key]).length)
const diffAllPicked = computed(() => rosterDiff.value.length > 0 && diffPickedCount.value === rosterDiff.value.length)

function openRosterDiff(): void {
  diffPick.value = Object.fromEntries(rosterDiff.value.map((it) => [it.key, true]))
  diffOpen.value = true
}

function toggleDiffAll(): void {
  const next = !diffAllPicked.value
  diffPick.value = Object.fromEntries(rosterDiff.value.map((it) => [it.key, next]))
}

async function applyRosterDiff(): Promise<void> {
  const snap = draft.value?.rosterSnapshot
  const live = liveRoster.value
  if (!draft.value || !snap || !live) return
  const picked = rosterDiff.value.filter((it) => diffPick.value[it.key])
  if (!picked.length) { diffOpen.value = false; return }
  const liveById = new Map(live.members.map((m) => [m.id, m]))
  const removed = new Set<string>()
  for (const it of picked) {
    if (it.kind === 'order') continue
    const cur = liveById.get(it.memberId)
    if (it.kind === 'removed') {
      removed.add(it.memberId)
      continue
    }
    if (!cur) continue
    if (it.kind === 'added') {
      if (!snap.members.some((m) => m.id === cur.id)) snap.members.push(clone(cur))
      if (draft.value.participantIds.length && !draft.value.participantIds.includes(cur.id)) {
        draft.value.participantIds.push(cur.id)
      }
    } else {
      const target = snap.members.find((m) => m.id === it.memberId)
      if (!target) continue
      if (it.kind === 'unit') target.unitId = cur.unitId
      if (it.kind === 'rank') target.rankId = cur.rankId
      if (it.kind === 'duty') target.duty = (cur.duty ?? '').trim() || undefined
    }
  }
  if (picked.some((it) => it.kind === 'order')) {
    const pos = new Map(live.members.map((m, i) => [m.id, i]))
    snap.members = [...snap.members].sort((a, b) => (pos.get(a.id) ?? snap.members.length) - (pos.get(b.id) ?? snap.members.length))
    if (draft.value.participantIds.length) {
      const order = new Map(snap.members.map((m, i) => [m.id, i]))
      draft.value.participantIds = [...draft.value.participantIds].sort((a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6))
    }
  }
  if (removed.size) {
    snap.members = snap.members.filter((m) => !removed.has(m.id))
    draft.value.assignments = draft.value.assignments.filter((a) => !removed.has(a.memberId))
    draft.value.participantIds = draft.value.participantIds.filter((id) => !removed.has(id))
    draft.value.unassigned = draft.value.unassigned.filter((id) => !removed.has(id))
  }
  // 职级/单位定义同步为最新，保证名称与排序一致
  snap.ranks = clone(live.ranks)
  snap.units = clone(live.units)
  diffOpen.value = false
  const needArrange = picked.some((it) => it.kind !== 'removed')
  if (needArrange) warnings.value = ['名册快照已更新，建议重新排座']
  flash(`已应用 ${picked.length} 项名册变更${needArrange ? '，建议重新排座' : ''}`)
}

// ---- 导出 ----
const exportScale = ref(3)
const paper = ref<'landscape' | 'portrait'>('landscape')
const exportScaleOptions = [
  { value: 2, label: '2× 清晰' },
  { value: 3, label: '3× 高清' },
  { value: 4, label: '4× 超清' }
]
const paperOptions = [
  { value: 'landscape', label: 'A4 横向' },
  { value: 'portrait', label: 'A4 纵向' }
]

/** 控制像素上限，避免大布局导出成空白画布 */
function chartCanvas(scale: number): { canvas: HTMLCanvasElement; scale: number } {
  const layoutNow = layout.value!
  const size = sheetSize(layoutNow.sheet)
  const fit = Math.min(12000 / (size.w + 128), 12000 / (size.h + 164), 4)
  const used = Math.max(0.5, Math.min(scale, fit))
  const canvas = renderSeatChart({
    layout: layoutNow,
    roster: roster.value!,
    assignments: draft.value!.assignments,
    title: draft.value!.name,
    subtitle: `${roster.value!.name} · 共 ${assignedCount.value} 人就座 · ${disabledSeats.value} 个固定空位`,
    showSeatNumbers: showSeatNumbers.value,
    showRank: showRank.value,
    showDuty: showDuty.value,
    showUnit: showUnit.value,
    seatNumbers: seatOrder.value,
    scale: used
  })
  return { canvas, scale: used }
}

function exportPng(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const { canvas, scale } = chartCanvas(exportScale.value)
  if (scale < exportScale.value) flash(`画幅较大，已按 ${scale.toFixed(1)}× 输出`)
  canvas.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${draft.value!.name.replace(/\s+/g, '-')}.png`
    a.click()
    URL.revokeObjectURL(a.href)
  }, 'image/png')
}

const STATUS_LABEL: Record<AttendStatus, string> = { present: '在位', leave: '请假' }

/** 导出排座结果明细：排号/座号来自工作表，人员信息来自名册 */
function exportExcel(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const bySeat = new Map(draft.value.assignments.map((a) => [a.seatId, a]))
  const zoneName = (id?: string) => layout.value!.zones.find((z) => z.id === id)?.name ?? ''
  const unitName = (id?: string) => roster.value!.units.find((u) => u.id === id)?.name ?? ''
  const rows: (string | number)[][] = [['排号', '座号', '姓名', '职级', '单位', '状态', '锁定', '区域']]
  const noOf = (seat: SeatRef): number => seatOrder.value.get(seat.seatId) ?? seat.seatNo
  const seats = [...allSeats.value].sort((a, b) => a.row - b.row || noOf(a) - noOf(b))
  for (const s of seats) {
    const zone = zoneName(s.zoneId)
    if (s.disabled) {
      rows.push([s.stage ? '主席台' : s.row + 1, '', '固定空位', '', '', '不可用', '', zone])
      continue
    }
    const a = bySeat.get(s.seatId)
    const m = a ? memberById.value.get(a.memberId) : undefined
    rows.push([
      s.stage ? '主席台' : s.row + 1,
      noOf(s),
      m?.name ?? '',
      m ? rankById.value.get(m.rankId)?.name ?? '未定级' : '',
      m ? unitName(m.unitId) : '',
      a ? STATUS_LABEL[a.status] : '空位',
      a?.locked ? '是' : '',
      zone
    ])
  }
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 8 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 8 }, { wch: 6 }, { wch: 10 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '排座结果')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  const url = URL.createObjectURL(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = `${draft.value.name.replace(/\s+/g, '-')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}

/** 一键导出当前项目在位人员名单：请假人员不导出 */
function exportPresentRoster(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const bySeat = new Map(draft.value.assignments.map((a) => [a.seatId, a]))
  const zoneName = (id?: string) => layout.value!.zones.find((z) => z.id === id)?.name ?? ''
  const unitName = (id?: string) => roster.value!.units.find((u) => u.id === id)?.name ?? ''
  const noOf = (seat: SeatRef): number => seatOrder.value.get(seat.seatId) ?? seat.seatNo
  const rows: (string | number)[][] = [['姓名', '职级', '单位', '职务', '座位号', '区域']]
  const seats = [...allSeats.value].sort((a, b) => a.row - b.row || noOf(a) - noOf(b))
  for (const s of seats) {
    if (s.disabled) continue
    const a = bySeat.get(s.seatId)
    const m = a ? memberById.value.get(a.memberId) : undefined
    if (!a || !m || m.status === 'leave' || a.status === 'leave') continue
    rows.push([
      m.name,
      rankById.value.get(m.rankId)?.name ?? '未定级',
      unitName(m.unitId),
      m.duty ?? '',
      `${s.stage ? '主席台' : `${s.row + 1} 排`} ${noOf(s)} 号`,
      zoneName(s.zoneId)
    ])
  }
  if (rows.length === 1) {
    flash('当前没有在位人员')
    return
  }
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 10 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '在位人员')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  const url = URL.createObjectURL(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${draft.value.name.replace(/\s+/g, '-')}-在位人员名单.xlsx`
  link.click()
  URL.revokeObjectURL(url)
  flash(`已导出 ${rows.length - 1} 位在位人员`)
}

function printChart(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const { canvas } = chartCanvas(2)
  const url = canvas.toDataURL('image/png')
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) return
  doc.open()
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${draft.value.name}</title>` +
    `<style>@page{size:A4 ${paper.value};margin:8mm}html,body{margin:0;padding:0}img{width:100%;height:auto}</style>` +
    `</head><body><img src="${url}" onload="window.focus()"></body></html>`
  )
  doc.close()
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => document.body.removeChild(iframe), 800)
  }, 400)
}

// ---- 快照恢复 ----
const snapshots = ref<{ id: string; createdAt: string; label: string }[]>([])
/** 勾选待删除的快照 */
const snapSelected = ref<string[]>([])
async function loadSnaps(): Promise<void> {
  snapSelected.value = []
  if (!draft.value) return
  const list = await listSnapshots(draft.value.id)
  snapshots.value = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
watch(selectedId, () => loadSnaps(), { immediate: true })
// 排座会新增快照、切回导出页时需要重新读取
watch(sideTab, (t) => { if (t === 'export') void loadSnaps() })

function toggleSnap(id: string): void {
  const i = snapSelected.value.indexOf(id)
  if (i >= 0) snapSelected.value.splice(i, 1)
  else snapSelected.value.push(id)
}

/** 删除选中的快照：只影响历史版本，当前排座结果与实体数据不动 */
function askDeleteSnaps(): void {
  const ids = [...snapSelected.value]
  if (!ids.length) return
  confirmState.value = {
    open: true,
    title: '删除历史快照',
    desc: `将删除选中的 ${ids.length} 个历史快照，删除后无法再恢复到这些版本；当前排座结果与名册、布局、项目数据不受影响。`,
    action: async () => {
      await removeSnapshots(ids)
      await loadSnaps()
      flash(`已删除 ${ids.length} 个历史快照`)
    }
  }
}

async function restoreSnap(id: string): Promise<void> {
  if (!draft.value) return
  const s = await getSnapshot(id)
  if (!s) return
  draft.value.assignments = clone(s.assignments)
  flash('已恢复该版本（记得保存）')
}
</script>

<template>
  <header class="page-head compact">
    <div class="page-head-main">
      <div class="page-eyebrow">排座项目</div>
      <div class="title-row">
        <h1 class="page-title">{{ draft?.name ?? '排座项目' }}</h1>
        <span v-if="dirty" class="save-dot">未保存</span>
      </div>
      <p class="page-desc">选名册与布局 → 导入名单 → 开始排座。点选座位会在其上方/下方弹出详情卡片；拖拽两张座位卡换座；请假人员不参与排座。</p>
    </div>
    <div class="head-actions">
      <div style="width: 168px">
        <UiSelect v-model="selectedId" :options="projectOptions" placeholder="选择项目" size="sm" />
      </div>
      <button class="btn sm" @click="openCreate"><Icon name="plus" />新建</button>
      <button class="btn sm" :disabled="!draft" @click="openRename"><Icon name="edit" />重命名</button>
      <button class="icon-btn" title="删除项目" :disabled="!draft" style="color: var(--danger)" @click="askDelete"><Icon name="trash" /></button>
      <button class="btn sm primary" :disabled="!dirty" @click="save"><Icon name="save" />{{ dirty ? '保存项目' : '已保存' }}</button>
    </div>
  </header>

  <div v-if="!draft" class="empty">还没有排座项目，点「新建项目」。</div>

  <template v-else-if="!roster || !layout">
    <div class="empty">当前项目引用的名册或布局已被删除，请重新选择。</div>
  </template>

  <template v-else>
    <div class="project-stage">
      <section class="project-setup">
        <div class="field">
          <label>名册方案</label>
          <UiSelect :model-value="draft.rosterPlanId" :options="rosterOptions" size="sm" @update:model-value="changeRosterSource" />
        </div>
        <div class="field">
          <label>会场布局</label>
          <UiSelect v-model="draft.layoutPackageId" :options="layoutOptions" size="sm" />
        </div>
        <div class="field setup-status">
          <label>项目状态</label>
          <div class="status-line">
            <span class="tag" :class="{ copper: draft.status === 'seated' }">{{ draft.status === 'seated' ? '已排座' : '草稿' }}</span>
            <span v-if="disabledSeats" class="tag">固定空位 {{ disabledSeats }}</span>
            <span class="caption">{{ participants.length }} 人在名单</span>
          </div>
        </div>
        <div class="setup-grow">
          <button class="btn primary" :disabled="busy" @click="runArrange">
            <Icon name="render" />{{ busy ? '排座中…' : '开始排座' }}
          </button>
        </div>
      </section>

      <div class="project-metrics">
        <div class="pm-head">
          <span class="pm-title">座位构成</span>
          <span class="pm-rate">使用率<b>{{ totalSeats ? Math.round((assignedCount / totalSeats) * 100) : 0 }}%</b></span>
        </div>
        <UiChart :option="mixChart" :height="40" empty-text="布局里还没有座位数据" />
        <div class="pm-legend">
          <span class="pm-item"><i class="pm-dot is-filled" />已就座 <b>{{ assignedCount }}</b></span>
          <span class="pm-item"><i class="pm-dot is-empty" />空位 <b>{{ emptySeats }}</b></span>
          <span class="pm-item"><i class="pm-dot is-leave" />请假 <b>{{ leaveCount }}</b></span>
          <span class="pm-item"><i class="pm-dot is-disabled" />固定空位 <b>{{ disabledSeats }}</b></span>
          <span class="pm-total">可用座位 <b>{{ totalSeats }}</b><em>·</em>名单 <b>{{ participants.length }}</b></span>
        </div>
      </div>

      <div class="project-alert" :class="{ 'is-quiet': !warnings.length }">
        <template v-if="warnings.length">
          <Icon name="warning" :size="14" />
          <span class="pa-text">{{ warnings.join(' · ') }}</span>
        </template>
        <span v-else class="pa-text">暂无排座提醒</span>
        <div class="pa-toggles">
          <label class="pa-toggle" title="排座图与导出图片是否显示座位序号">
            <input v-model="draft.showSeatNumbers" type="checkbox" />
            <span>座位序号</span>
          </label>
          <label class="pa-toggle" title="座位下方显示职级">
            <input v-model="draft.showRank" type="checkbox" />
            <span>职级</span>
          </label>
          <label class="pa-toggle" title="座位下方显示职务">
            <input v-model="draft.showDuty" type="checkbox" />
            <span>职务</span>
          </label>
          <label class="pa-toggle" title="座位下方显示单位">
            <input v-model="draft.showUnit" type="checkbox" />
            <span>单位</span>
          </label>
        </div>
      </div>

      <div class="project-body">
        <SeatBoardPane
          ref="boardPaneRef"
          :layout="layout"
          :rules="draft.ruleSet"
          :seat-info="seatInfo"
          :selected-seat-id="selectedSeat"
          :highlight-seat-ids="swapFlash"
          :focus-seat-id="focusedSeat"
          :show-seat-numbers="showSeatNumbers"
          :show-rank="showRank"
          :show-duty="showDuty"
          :show-unit="showUnit"
          :capacity-mode="capacityMode"
          :selected-cells="cellSelection"
          @pick="pickSeat"
          @swap="swapSeats"
          @cell-pick="toggleCell"
          @cell-select="selectCells"
          @toggle-capacity="toggleCapacityMode"
          @apply-capacity="applyBatchCapacity"
        />

        <aside class="project-side">
          <div class="side-tabs">
            <button class="tab" :class="{ active: sideTab === 'overview' }" @click="sideTab = 'overview'">概览</button>
            <button class="tab" :class="{ active: sideTab === 'list' }" @click="sideTab = 'list'">
              名单<span class="tab-badge">{{ participants.length }}</span>
            </button>
            <button class="tab" :class="{ active: sideTab === 'leave' }" @click="sideTab = 'leave'">
              请假<span class="tab-badge">{{ leaveMembers.length }}</span>
            </button>
            <button class="tab" :class="{ active: sideTab === 'rules' }" @click="sideTab = 'rules'">规则</button>
            <button class="tab" :class="{ active: sideTab === 'export' }" @click="sideTab = 'export'">导出</button>
          </div>

          <div class="project-side-body">
            <section v-if="sideTab === 'overview'" class="side-section">
              <div class="side-head">
                <span class="side-title">会场概览</span>
                <span class="caption">随排座更新</span>
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>座位使用率</span>
                  <span class="caption">{{ usedSeats }} / {{ totalSeats }} 席</span>
                </div>
                <UiChart :option="usageChart" :height="176" empty-text="布局里还没有可用座位" />
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>参会状态</span>
                  <span class="caption">{{ draft.assignments.length }} 条安排</span>
                </div>
                <UiChart :option="statusChart" :height="164" empty-text="还没有安排人员" />
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>区域就座</span>
                  <span class="caption">已就座 / 可用</span>
                </div>
                <UiChart :option="zoneChart" :height="zoneChartHeight" empty-text="布局里没有可用座位" />
              </div>

              <p class="caption chart-note">请假人员不占座；区域统计按座位所在分区汇总。</p>
            </section>

            <section v-else-if="sideTab === 'list'" class="side-section is-list">
              <div class="side-head">
                <span class="side-title">参会名单</span>
                <div class="side-head-actions">
                  <span class="tag">{{ participants.length }} 人</span>
                  <button
                    type="button"
                    class="side-sync"
                    :class="{ 'has-diff': rosterDiff.length }"
                    title="对比当前名册，手动更新本项目快照"
                    @click="openRosterDiff"
                  ><Icon name="rotate" :size="12" />手动更新<span v-if="rosterDiff.length" class="side-sync-count">{{ rosterDiff.length }}</span></button>
                </div>
              </div>

              <div class="list-tools">
                <label class="member-search">
                  <Icon name="search" :size="12" />
                  <input v-model="rosterQuery" type="search" placeholder="搜索姓名 / 单位 / 职级 / 职务" />
                  <button v-if="rosterQuery" type="button" class="ms-clear" aria-label="清空搜索" @click="rosterQuery = ''">×</button>
                </label>
                <button type="button" class="btn sm primary" @click="openAdd"><Icon name="plus" :size="12" />添加人员</button>
                <button type="button" class="btn sm" @click="importOpen = true"><Icon name="import" :size="12" />导入名册</button>
              </div>

              <div v-if="rosterDiff.length" class="roster-stale">
                <Icon name="warning" :size="12" />
                <span>名册已变化，{{ rosterDiff.length }} 项待更新</span>
                <button type="button" class="roster-stale-link" @click="openRosterDiff">查看差异</button>
              </div>

              <div class="member-list">
                <div
                  v-for="m in filteredParticipants"
                  :key="m.id"
                  class="member-row is-clickable"
                  role="button"
                  tabindex="0"
                  :class="{ 'is-leave': m.status === 'leave', 'is-focus': focusedSeat && draft.assignments.some(a => a.memberId === m.id && a.seatId === focusedSeat) }"
                  @click="focusMember(m)"
                  @keydown.enter.prevent="focusMember(m)"
                >
                  <span class="dot" :style="{ background: rankById.get(m.rankId)?.color ?? '#c9d1d4' }" />
                  <span class="member-name">{{ m.name }}</span>
                  <span class="member-hint" :title="memberHint(m)">{{ memberHint(m) }}</span>
                  <span v-if="m.duty" class="member-duty" :title="`职务：${m.duty}`">{{ m.duty }}</span>
                  <span v-if="m.status !== 'leave' && unseatedMembers.some(u => u.id === m.id)" class="tag warn">未排</span>
                  <span class="grow" />
                  <div class="status-toggle" role="group" :aria-label="`${m.name} 状态`">
                    <button
                      type="button"
                      class="st-btn"
                      :class="{ on: m.status === 'present' }"
                      @click.stop="setMemberStatus(m, 'present')"
                    >在位</button>
                    <button
                      type="button"
                      class="st-btn leave"
                      :class="{ on: m.status === 'leave' }"
                      @click.stop="setMemberStatus(m, 'leave')"
                    >请假</button>
                  </div>
                </div>
                <div v-if="!filteredParticipants.length" class="caption">
                  {{ participants.length ? '没有匹配的人员，换个关键词试试。' : '名单为空，点击「添加人员」或「导入名册」开始。' }}
                </div>
              </div>
              <p class="caption member-note">切换为「请假」后不参与排座，并立即从当前座位安排中移出。</p>

              <p v-if="unseatedMembers.length" class="caption" style="margin-top: 10px">
                未排到座位：{{ unseatedMembers.map(m => m.name).join('、') }}
              </p>
            </section>

            <section v-else-if="sideTab === 'leave'" class="side-section">
              <div class="side-head">
                <span class="side-title">请假人员</span>
                <span class="tag warn">{{ leaveMembers.length }} 人</span>
              </div>
              <p class="caption">请假人员不参与排座，也不占用座位。恢复在位后可重新排座。</p>
              <div class="member-list" style="margin-top: 10px">
                <div v-for="m in leaveMembers" :key="m.id" class="member-row is-leave">
                  <span class="dot" :style="{ background: rankById.get(m.rankId)?.color ?? '#c9d1d4' }" />
                  <span class="member-name">{{ m.name }}</span>
                  <span class="grow" />
                  <button type="button" class="btn xs" @click="setMemberStatus(m, 'present')">恢复在位</button>
                </div>
                <div v-if="!leaveMembers.length" class="side-empty">
                  <Icon name="users" :size="20" />
                  <p>暂无请假人员。</p>
                </div>
              </div>
            </section>

            <section v-else-if="sideTab === 'rules'" class="side-section rules-section">
              <div class="side-head">
                <span class="side-title">排座规则</span>
              </div>
              <RulesPanel
                :rules="draft.ruleSet"
                :ranks="roster.ranks"
                :layout="layout"
                :members="roster.members"
                :units="roster.units"
              />
            </section>

            <section v-else class="side-section">
              <div class="side-head">
                <span class="side-title">导出与备份</span>
              </div>
              <div class="export-opts">
                <label class="export-opt">
                  <span>图片清晰度</span>
                  <UiSelect v-model="exportScale" :options="exportScaleOptions" size="sm" />
                </label>
                <label class="export-opt">
                  <span>打印纸张</span>
                  <UiSelect v-model="paper" :options="paperOptions" size="sm" />
                </label>
              </div>
              <div class="export-grid">
                <button class="btn" @click="exportPng"><Icon name="image" />导出 PNG</button>
                <button class="btn" @click="exportExcel"><Icon name="table" />导出 Excel</button>
                <button class="btn" @click="exportPresentRoster"><Icon name="users" />在位人员名单</button>
                <button class="btn" @click="printChart"><Icon name="print" />直接打印</button>
              </div>
              <template v-if="snapshots.length">
                <div class="side-sub snap-head">
                  <span>历史快照 · {{ snapshots.length }}</span>
                  <button class="btn ghost sm" :disabled="!snapSelected.length" @click="askDeleteSnaps">
                    删除所选{{ snapSelected.length ? ` ${snapSelected.length}` : '' }}
                  </button>
                </div>
                <div class="snap-list">
                  <label
                    v-for="s in snapshots"
                    :key="s.id"
                    class="snap-row"
                    :class="{ 'is-on': snapSelected.includes(s.id) }"
                  >
                    <input type="checkbox" :checked="snapSelected.includes(s.id)" @change="toggleSnap(s.id)" />
                    <Icon name="clock" :size="13" />
                    <span class="grow tiny muted">{{ s.createdAt.slice(5, 16).replace('T', ' ') }}</span>
                    <button class="btn ghost sm" @click.stop.prevent="restoreSnap(s.id)">恢复</button>
                  </label>
                </div>
              </template>
              <p class="caption" style="margin-top: 12px">按所选倍率导出 PNG，画幅超出上限会自动降倍；打印按所选纸张排版，固定空位以斜纹标出。</p>
            </section>
          </div>
        </aside>
      </div>
    </div>
  </template>

  <!-- 新建项目 -->
  <UiModal v-model="createOpen" title="新建排座项目" description="选择一套名册与一个会场布局，之后可再调整">
    <div class="field">
      <label>项目名称</label>
      <input v-model="createForm.name" class="input" @keyup.enter="createProject" />
    </div>
    <div class="field">
      <label>名册方案</label>
      <UiSelect v-model="createForm.rosterPlanId" :options="rosterOptions" placeholder="选择名册" />
    </div>
    <div class="field">
      <label>会场布局</label>
      <UiSelect v-model="createForm.layoutPackageId" :options="layoutOptions" placeholder="选择布局" />
    </div>
    <template #footer>
      <button class="btn" @click="createOpen = false">取消</button>
      <button class="btn primary" @click="createProject">创建项目</button>
    </template>
  </UiModal>

  <!-- 重命名 -->
  <UiModal v-model="renameOpen" title="重命名项目" description="名称会显示在项目列表与导出的座位表中">
    <div class="field">
      <label>项目名称</label>
      <input v-model="renameValue" class="input" @keyup.enter="confirmRename" />
    </div>
    <template #footer>
      <button class="btn" @click="renameOpen = false">取消</button>
      <button class="btn primary" @click="confirmRename">保存名称</button>
    </template>
  </UiModal>

  <!-- 删除确认 -->
  <UiModal v-model="confirmState.open" :title="confirmState.title" :description="confirmState.desc" width="400px">
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">确认删除</button>
    </template>
  </UiModal>

  <!-- 手动更新名册快照 -->
  <UiModal
    v-model="diffOpen"
    title="手动更新名册"
    description="本项目使用创建时冻结的名册快照。勾选需要同步的变更，未勾选的保持不变。"
    width="580px"
  >
    <div v-if="!rosterDiff.length" class="diff-empty">
      <Icon name="check" :size="14" />
      <span>当前名册与本项目快照一致，无需更新。</span>
    </div>
    <template v-else>
      <div class="diff-head">
        <label class="diff-all">
          <input type="checkbox" :checked="diffAllPicked" @change="toggleDiffAll" />
          <span>全选应用</span>
        </label>
        <span class="caption">共 {{ rosterDiff.length }} 项 · 已选 {{ diffPickedCount }}</span>
      </div>
      <div class="diff-groups">
        <section v-for="g in diffGroups" :key="g.kind" class="diff-group">
          <header class="diff-group-head">
            <Icon :name="g.icon" :size="12" />
            <span>{{ g.label }}</span>
            <span class="diff-group-count">{{ g.items.length }}</span>
          </header>
          <label v-for="it in g.items" :key="it.key" class="diff-item">
            <input v-model="diffPick[it.key]" type="checkbox" />
            <span class="diff-name">{{ it.name }}</span>
            <span class="diff-change">
              <span class="diff-from">{{ it.from }}</span>
              <span class="diff-arrow">→</span>
              <span class="diff-to">{{ it.to }}</span>
            </span>
          </label>
        </section>
      </div>
      <p class="caption diff-tip">应用后不会自动重排；如涉及单位、职级或人员增减，建议再点「开始排座」。</p>
    </template>
    <template #footer>
      <button class="btn" @click="diffOpen = false">取消</button>
      <button class="btn primary" :disabled="!diffPickedCount" @click="applyRosterDiff">应用所选（{{ diffPickedCount }}）</button>
    </template>
  </UiModal>

  <!-- 添加人员：与名册页批量添加同款录入方式 -->
  <UiModal
    v-model="addOpen"
    title="添加人员"
    description="输入单个姓名回车即可添加；也可粘贴多人，用逗号、顿号或换行分隔。"
    width="440px"
  >
    <div class="field">
      <label>姓名</label>
      <textarea
        ref="addInputEl"
        v-model="addText"
        class="textarea"
        rows="3"
        placeholder="张三、李四、王五…"
        @keydown.enter.exact="onAddKey"
      />
    </div>
    <div class="field-row">
      <div class="field">
        <label>职级（可留空）</label>
        <UiSelect v-model="addRankId" :options="addRankOptions" />
      </div>
      <div class="field">
        <label>单位（可留空）</label>
        <UiSelect v-model="addUnitId" :options="addUnitOptions" />
      </div>
    </div>
    <div class="field">
      <label>职务（可留空，仅展示与筛选）</label>
      <input v-model="addDuty" class="input" placeholder="如：主任、处长、副主任" />
    </div>
    <template #footer>
      <button class="btn" @click="addOpen = false">取消</button>
      <button class="btn primary" :disabled="!addText.trim()" @click="submitAdd">添加</button>
    </template>
  </UiModal>

  <!-- 导入名册：复用名册页的批量导入 -->
  <ImportDialog
    v-model="importOpen"
    :unit-options="snapUnitOptions"
    :unit-names="snapUnitNames"
    :rank-names="snapRankNames"
    :default-unit-id="snapRootUnitId"
    @import="handleProjectImport"
  />

  <!-- 座位详情：锚定在座位上方/下方的浮层卡片 -->
  <Teleport to="body">
    <div
      v-if="selectedSeat"
      ref="popoverEl"
      class="seat-popover"
      role="dialog"
      aria-label="座位详情"
      tabindex="-1"
      :data-placement="popoverPos.above ? 'above' : 'below'"
      :style="{
        left: popoverPos.left + 'px',
        top: popoverPos.top + 'px',
        width: CARD_W + 'px',
        '--sp-arrow': popoverPos.arrow + 'px',
        transform: popoverPos.above ? 'translateY(-100%)' : undefined
      }"
    >
      <div class="sp-head">
        <span class="sp-kicker">{{ seatLabel(selectedSeat) }}</span>
        <button class="sp-close" type="button" title="关闭" aria-label="关闭座位详情" @click="closeSeatCard">
          <Icon name="close" :size="12" />
        </button>
      </div>

      <div v-if="!selectedSeatDisabled" class="sp-cap" title="只影响当前排座项目，不改动会场布局">
        <span class="sp-cap-k">本桌容量</span>
        <div class="sp-cap-opts">
          <button type="button" class="sp-cap-btn" :class="{ on: capCustom === 1 }" @click="applyPreset(1)">单人</button>
          <button type="button" class="sp-cap-btn" :class="{ on: capCustom === 2 }" @click="applyPreset(2)">双人</button>
          <input
            v-model.number="capCustom"
            type="number"
            min="1"
            max="50"
            class="sp-cap-num"
            aria-label="自定义容量"
            @keydown.enter.prevent="applyCapacityFromCard"
          />
          <button type="button" class="sp-cap-btn" @click="applyCapacityFromCard">应用</button>
        </div>
      </div>

      <div v-if="selectedSeatDisabled" class="sp-body">
        <div class="tag warn">固定空位 · 不可安排人员</div>
        <p class="caption">该座位已在布局中标记为「不坐人」，排座时会自动跳过。如需恢复，请到「会场布局」双击该座位。</p>
        <button v-if="selectedAssignment" class="btn sm danger sp-full" @click="clearSeat">清空残留安排</button>
      </div>

      <div v-else-if="selectedAssignment && selectedMember" class="sp-body">
        <div class="person-main">
          <div class="avatar">{{ selectedMember.name.slice(0, 1) }}</div>
          <div>
            <div class="person-name">{{ selectedMember.name }}</div>
            <div class="caption">{{ seatInfo[selectedSeat]?.unitName || '未填写单位' }}</div>
          </div>
        </div>
        <div class="sp-meta">
          <div class="sp-meta-row">
            <span class="sp-meta-k">职级</span>
            <span class="sp-meta-v">{{ seatInfo[selectedSeat]?.rankName }}</span>
          </div>
          <div class="sp-meta-row">
            <span class="sp-meta-k">单位</span>
            <span class="sp-meta-v">{{ seatInfo[selectedSeat]?.unitName || '—' }}</span>
          </div>
          <div class="sp-meta-row">
            <span class="sp-meta-k">职务</span>
            <span class="sp-meta-v">{{ seatInfo[selectedSeat]?.duty || '—' }}</span>
          </div>
        </div>
        <div class="field sp-field">
          <label>与会状态</label>
          <div class="status-toggle sp-status" role="group" aria-label="与会状态">
            <button
              type="button"
              class="st-btn"
              :class="{ on: selectedAssignment.status === 'present' }"
              :aria-pressed="selectedAssignment.status === 'present'"
              @click="setStatus('present')"
            >在位</button>
            <button
              type="button"
              class="st-btn leave"
              :class="{ on: selectedAssignment.status === 'leave' }"
              :aria-pressed="selectedAssignment.status === 'leave'"
              @click="setStatus('leave')"
            >请假</button>
          </div>
        </div>
        <div class="mini-btns">
          <button class="btn sm" :class="{ copper: selectedAssignment.locked }" @click="toggleLock">
            <Icon :name="selectedAssignment.locked ? 'lock' : 'unlock'" />
            {{ selectedAssignment.locked ? '解除锁定' : '锁定座位' }}
          </button>
          <button class="btn sm danger" @click="clearSeat">清空座位</button>
        </div>
      </div>

      <div v-else class="sp-body">
        <p class="caption">空位，可从名单中安排一位：</p>
        <UiSelect
          :model-value="''"
          :options="unseatedOptions"
          placeholder="选择人员…"
          size="sm"
          @update:model-value="seatMember($event)"
        />
      </div>
    </div>
  </Teleport>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
