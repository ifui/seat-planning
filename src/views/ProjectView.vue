<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import * as XLSX from 'xlsx'
import type { Assignment, AttendStatus, Member, Project } from '../types'
import { DEFAULT_RULESET } from '../types'
import { getSnapshot, layoutOf, listSnapshots, removeProject, rosterOf, saveProject, saveRoster, saveSnapshot, state } from '../store'
import { applyRulesToProject, seatIndexMap } from '../engine/seating'
import { nowISO, seatsOfSheet, uid, type SeatRef } from '../engine/sheet'
import { renderSeatChart } from '../engine/render'
import { exportAllData, importAllData } from '../db'
import SeatBoardPane from '../components/project/SeatBoardPane.vue'
import RulesPanel from '../components/RulesPanel.vue'
import { UiChart, UiSelect, UiModal, UiIcon as Icon } from '../ui'
import { chartAxisText, chartColors, chartFont, chartTooltip, type ChartOption } from '../ui/charts'

const sideTab = ref<'seat' | 'overview' | 'list' | 'rules' | 'export'>('seat')

const selectedId = ref<string>(state.projects[0]?.id ?? '')
const draft = ref<Project | null>(null)
const dirty = ref(false)
const toast = ref('')
const warnings = ref<string[]>([])
const selectedSeat = ref<string | null>(null)
const busy = ref(false)
let loading = false

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) }

function load(id: string): void {
  const found = state.projects.find((p) => p.id === id)
  loading = true
  draft.value = found ? clone(found) : null
  // 旧项目没有 viewpoint 字段，补默认观众视角
  if (draft.value?.ruleSet && !draft.value.ruleSet.viewpoint) draft.value.ruleSet.viewpoint = 'audience'
  selectedSeat.value = null
  warnings.value = []
  dirty.value = false
  setTimeout(() => { loading = false }, 0)
}

watch(selectedId, (id) => load(id), { immediate: true })
watch(draft, () => { if (draft.value && !loading) dirty.value = true }, { deep: true })
watch(
  () => state.projects.map((p) => p.id).join(','),
  () => {
    if (!state.projects.some((p) => p.id === selectedId.value)) selectedId.value = state.projects[0]?.id ?? ''
  }
)

function flash(msg: string): void {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 2400)
}

const roster = computed(() => (draft.value ? rosterOf(draft.value) : undefined))
const layout = computed(() => (draft.value ? layoutOf(draft.value) : undefined))

const memberById = computed(() => new Map((roster.value?.members ?? []).map((m) => [m.id, m])))
const rankById = computed(() => new Map((roster.value?.ranks ?? []).map((r) => [r.id, r])))

const seatInfo = computed(() => {
  const out: Record<string, { name: string; rankName: string; color: string; status: string; locked: boolean }> = {}
  if (!draft.value) return out
  for (const a of draft.value.assignments) {
    const m = memberById.value.get(a.memberId)
    if (!m) continue
    const r = rankById.value.get(m.rankId)
    out[a.seatId] = { name: m.name, rankName: r?.name ?? '未定级', color: r?.color ?? '#8a979d', status: a.status, locked: a.locked }
  }
  return out
})

const allSeats = computed<SeatRef[]>(() => (layout.value ? seatsOfSheet(layout.value.sheet) : []))
const seatIndex = computed(() => (layout.value ? seatIndexMap(layout.value) : new Map<string, SeatRef>()))
const totalSeats = computed(() => allSeats.value.filter((s) => !s.disabled).length)
const disabledSeats = computed(() => allSeats.value.filter((s) => s.disabled).length)
const participants = computed(() => {
  if (!draft.value || !roster.value) return [] as Member[]
  const ids = draft.value.participantIds.length ? draft.value.participantIds : roster.value.members.filter((m) => m.active).map((m) => m.id)
  return ids.map((id) => memberById.value.get(id)).filter((m): m is Member => !!m)
})
const assignedCount = computed(() => (draft.value ? draft.value.assignments.filter((a) => a.status !== 'leave').length : 0))
const leaveCount = computed(() => (draft.value ? draft.value.assignments.filter((a) => a.status === 'leave').length : 0))
const emptySeats = computed(() => Math.max(0, totalSeats.value - assignedCount.value - leaveCount.value))

// ---- 会场概览图表 ----
const usedSeats = computed(() => assignedCount.value + leaveCount.value)

const STATUS_META: { key: AttendStatus; label: string; color: string }[] = [
  { key: 'present', label: '在位', color: chartColors.success },
  { key: 'leave', label: '请假', color: chartColors.warning },
  { key: 'absent', label: '缺席', color: chartColors.muted },
  { key: 'guest', label: '来宾', color: chartColors.info }
]

const statusCounts = computed(() => {
  const counts: Record<AttendStatus, number> = { present: 0, leave: 0, absent: 0, guest: 0 }
  for (const a of draft.value?.assignments ?? []) counts[a.status]++
  return counts
})

/** 座位使用率：已就座 + 请假保留（座位仍占用），空位用中性灰。 */
const usageChart = computed<ChartOption | null>(() => {
  if (!totalSeats.value) return null
  const rate = Math.round((usedSeats.value / totalSeats.value) * 100)
  const data = [
    { value: assignedCount.value, name: '已就座', itemStyle: { color: chartColors.success } },
    { value: leaveCount.value, name: '请假保留', itemStyle: { color: chartColors.warning } },
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

/** 区域就座：按布局分区汇总可用座位与已占用座位（含请假保留）。 */
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
const unseatedMembers = computed(() => {
  if (!draft.value) return [] as Member[]
  const seated = new Set(draft.value.assignments.map((a) => a.memberId))
  return participants.value.filter((m) => !seated.has(m.id))
})
const pendingList = computed(() => (draft.value ? draft.value.pendingNames : []))

const projectOptions = computed(() =>
  state.projects.map((p) => ({ value: p.id, label: p.name, hint: p.status === 'seated' ? '已排座' : '草稿' }))
)
const rosterOptions = computed(() =>
  state.rosters.map((r) => ({ value: r.id, label: r.name, hint: `${r.members.length} 人` }))
)
const layoutOptions = computed(() =>
  state.layouts.map((l) => ({ value: l.id, label: l.name, hint: `${l.sheet.rows} 排 × ${l.sheet.cols} 列` }))
)
const STATUS_OPTIONS = [
  { value: 'present', label: '在位' },
  { value: 'leave', label: '请假（保留位置）' },
  { value: 'absent', label: '缺席' },
  { value: 'guest', label: '来宾' }
]
const unseatedOptions = computed(() => [
  { value: '', label: '选择人员…' },
  ...unseatedMembers.value.map((m) => ({ value: m.id, label: m.name, hint: rankById.value.get(m.rankId)?.name ?? '' }))
])
const unitOptions = computed(() => {
  if (!roster.value) return [{ value: '', label: '默认单位' }]
  return [{ value: '', label: '默认单位' }, ...roster.value.units.map((u) => ({ value: u.id, label: u.name }))]
})
const rankOptions = computed(() => {
  if (!roster.value) return [{ value: '', label: '默认最低职级' }]
  const ranks = [...roster.value.ranks].sort((a, b) => a.order - b.order)
  return [{ value: '', label: '默认最低职级' }, ...ranks.map((r) => ({ value: r.id, label: r.name }))]
})

async function save(): Promise<void> {
  if (!draft.value) return
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
  const p: Project = {
    id: uid('proj'),
    name,
    rosterPlanId: createForm.value.rosterPlanId,
    layoutPackageId: createForm.value.layoutPackageId,
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
    dirty.value = false
    flash(`已排出 ${res.assignments.filter((a) => a.status !== 'leave').length} 个座位，空置座位已跳过`)
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
}

function setStatus(s: string): void {
  const a = selectedAssignment.value
  if (!a) return
  a.status = s as AttendStatus
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
function selectAllMembers(): void {
  if (!draft.value || !roster.value) return
  draft.value.participantIds = roster.value.members.filter((m) => m.active).map((m) => m.id)
  flash(`已载入 ${draft.value.participantIds.length} 人`)
}

const excelInput = ref<HTMLInputElement | null>(null)

async function onExcel(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !draft.value || !roster.value) return
  try {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false })
    let names: string[] = []
    for (const row of rows) {
      const first = row.map((c) => (c == null ? '' : String(c).trim()))
      if (!first.length) continue
      const candidate = first.find((c) => c.length > 0) ?? ''
      if (!candidate) continue
      if (/^(姓名|名字|人员|参会人|name)$/i.test(candidate)) continue
      names.push(candidate)
    }
    // 若第一列不是姓名，尝试找含「姓名」表头的列
    const header = rows[0]?.map((c) => String(c ?? '').trim()) ?? []
    const colIdx = header.findIndex((h) => /姓名|名字|人员/.test(h))
    if (colIdx > 0) {
      names = rows.slice(1).map((r) => String((r as unknown[])[colIdx] ?? '').trim()).filter(Boolean)
    }
    names = [...new Set(names)].filter(Boolean)
    if (!names.length) { flash('没有读到姓名，请确认表格首列或「姓名」列'); return }

    const matched: string[] = []
    const unmatched: string[] = []
    for (const n of names) {
      const m = roster.value.members.find((mm) => mm.name === n || mm.aliases.includes(n))
      if (m) matched.push(m.id)
      else unmatched.push(n)
    }
    draft.value.participantIds = [...new Set([...draft.value.participantIds, ...matched])]
    draft.value.pendingNames = [...new Set([...draft.value.pendingNames, ...unmatched])]
    flash(`读入 ${names.length} 个姓名，匹配 ${matched.length} 人，待处理 ${unmatched.length} 个`)
  } catch {
    flash('Excel 解析失败，请确认为 .xlsx/.xls 文件')
  }
  input.value = ''
}

const newUnitId = ref('')
const newRankId = ref('')

async function createFromPending(name: string): Promise<void> {
  if (!roster.value || !draft.value) return
  const copy = clone(roster.value)
  const unitId = newUnitId.value || copy.units[0]?.id
  const rankId = newRankId.value || [...copy.ranks].sort((a, b) => b.order - a.order)[0]?.id
  if (!unitId || !rankId) { flash('名册里缺少单位或职级'); return }
  const member: Member = { id: uid('m'), name, unitId, rankId, aliases: [], active: true }
  copy.members.push(member)
  await saveRoster(copy)
  draft.value.participantIds.push(member.id)
  draft.value.pendingNames = draft.value.pendingNames.filter((n) => n !== name)
  flash(`已新建人员：${name}`)
}

function ignorePending(name: string): void {
  if (!draft.value) return
  draft.value.pendingNames = draft.value.pendingNames.filter((n) => n !== name)
}

function ignoreAllPending(): void {
  if (!draft.value) return
  draft.value.pendingNames = []
}

// ---- 导出 ----
function chartCanvas(scale: number): HTMLCanvasElement {
  return renderSeatChart({
    layout: layout.value!,
    roster: roster.value!,
    assignments: draft.value!.assignments,
    title: draft.value!.name,
    subtitle: `${roster.value!.name} · 共 ${assignedCount.value} 人就座 · ${disabledSeats.value} 个固定空位`,
    scale
  })
}

function exportPng(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const canvas = chartCanvas(3)
  canvas.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${draft.value!.name.replace(/\s+/g, '-')}.png`
    a.click()
    URL.revokeObjectURL(a.href)
  }, 'image/png')
}

const STATUS_LABEL: Record<AttendStatus, string> = { present: '在位', leave: '请假', absent: '缺席', guest: '来宾' }

/** 导出排座结果明细：排号/座号来自工作表，人员信息来自名册 */
function exportExcel(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const bySeat = new Map(draft.value.assignments.map((a) => [a.seatId, a]))
  const zoneName = (id?: string) => layout.value!.zones.find((z) => z.id === id)?.name ?? ''
  const unitName = (id?: string) => roster.value!.units.find((u) => u.id === id)?.name ?? ''
  const rows: (string | number)[][] = [['排号', '座号', '姓名', '职级', '单位', '状态', '锁定', '区域']]
  const seats = [...allSeats.value].sort((a, b) => a.row - b.row || a.seatNo - b.seatNo)
  for (const s of seats) {
    const zone = zoneName(s.zoneId)
    if (s.disabled) {
      rows.push([s.stage ? '主席台' : s.row + 1, s.seatNo || '', '固定空位', '', '', '不可用', '', zone])
      continue
    }
    const a = bySeat.get(s.seatId)
    const m = a ? memberById.value.get(a.memberId) : undefined
    rows.push([
      s.stage ? '主席台' : s.row + 1,
      s.seatNo,
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

function printChart(): void {
  if (!draft.value || !layout.value || !roster.value) return
  const canvas = chartCanvas(2)
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
    `<style>@page{size:A4 landscape;margin:8mm}html,body{margin:0;padding:0}img{width:100%;height:auto}</style>` +
    `</head><body><img src="${url}" onload="window.focus()"></body></html>`
  )
  doc.close()
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => document.body.removeChild(iframe), 800)
  }, 400)
}

// ---- 备份 ----
async function backup(): Promise<void> {
  let json = ''
  try {
    json = await exportAllData()
  } catch {
    flash('当前浏览器不支持本机数据库，备份不可用')
    return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  a.download = `seat-planning-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

const restoreInput = ref<HTMLInputElement | null>(null)
async function restore(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await importAllData(await file.text())
    flash('备份已导入，请刷新页面查看')
  } catch {
    flash('导入失败：不是有效的备份文件')
  }
  input.value = ''
}

// ---- 快照恢复 ----
const snapshots = ref<{ id: string; createdAt: string; label: string }[]>([])
async function loadSnaps(): Promise<void> {
  if (!draft.value) return
  const list = await listSnapshots(draft.value.id)
  snapshots.value = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6)
}
watch(selectedId, () => loadSnaps(), { immediate: true })

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
      <p class="page-desc">选名册与布局 → 导入名单 → 开始排座。点选座位查看人员；拖拽两张座位卡换座。</p>
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
          <UiSelect v-model="draft.rosterPlanId" :options="rosterOptions" size="sm" />
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
        <div class="metric"><span>可用座位</span><b>{{ totalSeats }}</b></div>
        <div class="metric"><span>已就座</span><b>{{ assignedCount }}</b></div>
        <div class="metric"><span>请假</span><b>{{ leaveCount }}</b></div>
        <div class="metric"><span>空位</span><b>{{ emptySeats }}</b></div>
        <div class="metric copper"><span>固定空位</span><b>{{ disabledSeats }}</b></div>
        <div class="metric"><span>名单人数</span><b>{{ participants.length }}</b></div>
      </div>

      <div v-if="warnings.length" class="project-alert">
        <Icon name="warning" :size="14" />
        <span>{{ warnings.join(' · ') }}</span>
      </div>

      <div class="project-body">
        <SeatBoardPane
          :layout="layout"
          :seat-info="seatInfo"
          :selected-seat-id="selectedSeat"
          @pick="selectedSeat = $event"
          @swap="swapSeats"
        />

        <aside class="project-side">
          <div class="side-tabs">
            <button class="tab" :class="{ active: sideTab === 'seat' }" @click="sideTab = 'seat'">座位</button>
            <button class="tab" :class="{ active: sideTab === 'overview' }" @click="sideTab = 'overview'">概览</button>
            <button class="tab" :class="{ active: sideTab === 'list' }" @click="sideTab = 'list'">
              名单<span class="tab-badge">{{ participants.length }}</span>
            </button>
            <button class="tab" :class="{ active: sideTab === 'rules' }" @click="sideTab = 'rules'">规则</button>
            <button class="tab" :class="{ active: sideTab === 'export' }" @click="sideTab = 'export'">导出</button>
          </div>

          <div class="project-side-body">
            <section v-if="sideTab === 'seat'" class="side-section">
              <div class="side-head">
                <span class="side-title">座位详情</span>
                <span class="tag">{{ selectedSeat ? '已选中' : '未选中' }}</span>
              </div>

              <div v-if="selectedSeat">
                <div v-if="selectedSeatDisabled" class="notice">
                  <div class="tag warn">固定空位 · 不可安排人员</div>
                  <p class="caption">该座位已在布局中标记为「不坐人」，排座时会自动跳过，导出图中以斜纹显示。如需恢复，请到「会场布局」双击该座位。</p>
                  <button v-if="selectedAssignment" class="btn sm danger" @click="clearSeat">清空残留安排</button>
                </div>
                <div v-else-if="selectedAssignment && selectedMember" class="person-card">
                  <div class="person-main">
                    <div class="avatar">{{ selectedMember.name.slice(0, 1) }}</div>
                    <div>
                      <div class="person-name">{{ selectedMember.name }}</div>
                      <div class="caption">{{ seatInfo[selectedSeat]?.rankName }}</div>
                    </div>
                  </div>
                  <div class="field" style="margin-top: 12px">
                    <label>与会状态</label>
                    <UiSelect :model-value="selectedAssignment.status" :options="STATUS_OPTIONS" size="sm" @update:model-value="setStatus($event)" />
                  </div>
                  <div class="mini-btns" style="margin-top: 10px">
                    <button class="btn sm" :class="{ copper: selectedAssignment.locked }" @click="toggleLock">
                      <Icon :name="selectedAssignment.locked ? 'lock' : 'unlock'" />{{ selectedAssignment.locked ? '解除锁定' : '锁定座位' }}
                    </button>
                    <button class="btn sm danger" @click="clearSeat">清空座位</button>
                  </div>
                </div>
                <div v-else>
                  <p class="caption" style="margin-bottom: 8px">空位，可从名单中安排一位：</p>
                  <UiSelect :model-value="''" :options="unseatedOptions" placeholder="选择人员…" size="sm" @update:model-value="seatMember($event)" />
                </div>
              </div>
              <div v-else class="side-empty">
                <Icon name="seat" :size="22" />
                <p>点选任意座位卡，查看人员、状态与锁定情况。</p>
              </div>
            </section>

            <section v-else-if="sideTab === 'overview'" class="side-section">
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

              <p class="caption chart-note">使用率包含请假保留的座位；区域统计按座位所在分区汇总。</p>
            </section>

            <section v-else-if="sideTab === 'list'" class="side-section">
              <div class="side-head">
                <span class="side-title">参会名单</span>
                <span class="tag">{{ participants.length }} 人</span>
              </div>
              <div class="mini-btns">
                <button class="btn sm" @click="selectAllMembers"><Icon name="users" />载入全名册</button>
                <button class="btn sm" @click="excelInput?.click()"><Icon name="import" />导入 Excel</button>
                <input ref="excelInput" type="file" accept=".xlsx,.xls,.csv" hidden @change="onExcel" />
              </div>

              <div class="member-list">
                <div v-for="m in participants" :key="m.id" class="member-row">
                  <span class="dot" :style="{ background: rankById.get(m.rankId)?.color ?? '#c9d1d4' }" />
                  <span class="grow">{{ m.name }}</span>
                  <span class="caption">{{ rankById.get(m.rankId)?.name ?? '未定级' }}</span>
                  <span v-if="unseatedMembers.some(u => u.id === m.id)" class="tag warn">未排</span>
                </div>
                <div v-if="!participants.length" class="caption">名单为空，先载入全名册或导入 Excel。</div>
              </div>

              <template v-if="pendingList.length">
                <div class="side-sub">库中查不到（{{ pendingList.length }}）</div>
                <div class="field-row" style="margin-bottom: 8px">
                  <UiSelect v-model="newUnitId" :options="unitOptions" size="sm" placeholder="默认单位" />
                  <UiSelect v-model="newRankId" :options="rankOptions" size="sm" placeholder="默认最低职级" />
                </div>
                <div class="row-list" style="max-height: 220px; overflow: auto">
                  <div v-for="n in pendingList" :key="n" class="row-item" style="padding: 6px 8px">
                    <span class="grow tiny">{{ n }}</span>
                    <button class="btn sm" @click="createFromPending(n)">新建</button>
                    <button class="btn ghost sm" @click="ignorePending(n)">忽略</button>
                  </div>
                </div>
                <button class="btn ghost sm" style="margin-top: 6px" @click="ignoreAllPending">全部忽略</button>
              </template>

              <p v-if="unseatedMembers.length" class="caption" style="margin-top: 10px">
                未排到座位：{{ unseatedMembers.map(m => m.name).join('、') }}
              </p>
            </section>

            <section v-else-if="sideTab === 'rules'" class="side-section rules-section">
              <div class="side-head">
                <span class="side-title">排座规则</span>
                <span class="caption">按职级 → 单位 → 名单顺序</span>
              </div>
              <RulesPanel :rules="draft.ruleSet" :ranks="roster.ranks" :layout="layout" />
            </section>

            <section v-else class="side-section">
              <div class="side-head">
                <span class="side-title">导出与备份</span>
              </div>
              <div class="export-grid">
                <button class="btn" @click="exportPng"><Icon name="image" />导出 PNG</button>
                <button class="btn" @click="exportExcel"><Icon name="table" />导出 Excel</button>
                <button class="btn" @click="printChart"><Icon name="print" />直接打印</button>
                <button class="btn" @click="backup"><Icon name="backup" />全量备份</button>
                <button class="btn" @click="restoreInput?.click()"><Icon name="restore" />导入备份</button>
                <input ref="restoreInput" type="file" accept=".json" hidden @change="restore" />
              </div>
              <template v-if="snapshots.length">
                <div class="side-sub">历史快照</div>
                <div v-for="s in snapshots" :key="s.id" class="row-item" style="padding: 6px 0; border: 0">
                  <Icon name="clock" :size="13" />
                  <span class="grow tiny muted">{{ s.createdAt.slice(5, 16).replace('T', ' ') }}</span>
                  <button class="btn ghost sm" @click="restoreSnap(s.id)">恢复</button>
                </div>
              </template>
              <p class="caption" style="margin-top: 12px">导出图为 3 倍分辨率 PNG；打印按 A4 横向排版，固定空位以斜纹标出。</p>
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

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
