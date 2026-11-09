import type {
  Assignment, AttendStatus, LayoutPackage, Member, Project, RosterPlan, RuleSet
} from '../types'
import { seatsInRow, type SeatRef } from './sheet'

export interface ArrangeInput {
  roster: RosterPlan
  layout: LayoutPackage
  rules: RuleSet
  /** 名单中参与排座的人（默认：名册里所有 active 的人） */
  participantIds?: string[]
  /** 人员状态（默认 present） */
  statuses?: Record<string, AttendStatus>
  keepLocked?: Assignment[]
}

export interface ArrangeResult {
  assignments: Assignment[]
  unassigned: string[]
  warnings: string[]
}

/** 主席台顺序：1 号居中；2 号在就座者左侧（画布 x+），一左一右交替 */
export function podiumOrder(seats: SeatRef[], evenCenterSide: 'left' | 'right' = 'left'): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  const n = list.length
  if (!n) return []
  const out: SeatRef[] = []
  if (n % 2 === 1) {
    const c = (n - 1) / 2
    out.push(list[c])
    let l = c - 1
    let r = c + 1
    while (l >= 0 || r < n) {
      if (r < n) out.push(list[r++])
      if (l >= 0) out.push(list[l--])
    }
  } else {
    const cR = n / 2
    const cL = n / 2 - 1
    if (evenCenterSide === 'left') {
      out.push(list[cR])
      out.push(list[cL])
    } else {
      out.push(list[cL])
      out.push(list[cR])
    }
    let l = cL - 1
    let r = cR + 1
    while (l >= 0 || r < n) {
      if (r < n) out.push(list[r++])
      if (l >= 0) out.push(list[l--])
    }
  }
  return out
}

/** 台下横向顺序：居中向两侧（观众视角以左为先）；mirror 为 true 时左右镜像（主席台视角） */
export function hallOrder(seats: SeatRef[], mode: RuleSet['hallOrder'], mirror = false): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  if (mirror) list.reverse()
  const n = list.length
  if (!n) return []
  if (mode === 'left-to-right') return list
  if (mode === 'right-to-left') return [...list].reverse()
  const out: SeatRef[] = []
  if (n % 2 === 1) {
    const c = (n - 1) / 2
    out.push(list[c])
    let l = c - 1
    let r = c + 1
    while (l >= 0 || r < n) {
      if (l >= 0) out.push(list[l--])
      if (r < n) out.push(list[r++])
    }
  } else {
    const cL = n / 2 - 1
    const cR = n / 2
    out.push(list[cL])
    out.push(list[cR])
    let l = cL - 1
    let r = cR + 1
    while (l >= 0 || r < n) {
      if (l >= 0) out.push(list[l--])
      if (r < n) out.push(list[r++])
    }
  }
  return out
}

function unitPathOrder(roster: RosterPlan): Map<string, number[]> {
  const byId = new Map(roster.units.map((u) => [u.id, u]))
  const cache = new Map<string, number[]>()
  const path = (id: string, depth = 0): number[] => {
    if (cache.has(id)) return cache.get(id)!
    if (depth > 20) return []
    const u = byId.get(id)
    if (!u) return []
    const p = u.parentId ? [...path(u.parentId, depth + 1), u.order] : [u.order]
    cache.set(id, p)
    return p
  }
  const out = new Map<string, number[]>()
  for (const u of roster.units) out.set(u.id, path(u.id))
  return out
}

function cmpPath(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/** 按职级 → 单位 → 名单序排序候选人员 */
function sortCandidates(members: Member[], roster: RosterPlan, rules: RuleSet): Member[] {
  const rankOrder = new Map(roster.ranks.map((r) => [r.id, r.order]))
  const upath = unitPathOrder(roster)
  const listIdx = new Map(roster.members.map((m, i) => [m.id, i]))
  const base = [...members].sort((a, b) => {
    const ra = rankOrder.get(a.rankId) ?? 999
    const rb = rankOrder.get(b.rankId) ?? 999
    if (ra !== rb) return ra - rb
    const pa = upath.get(a.unitId) ?? []
    const pb = upath.get(b.unitId) ?? []
    const c = cmpPath(pa, pb)
    if (c !== 0) return c
    return (listIdx.get(a.id) ?? 0) - (listIdx.get(b.id) ?? 0)
  })
  if (rules.unitOrder === 'continuous' || !rules.keepListOrder) return base

  const out: Member[] = []
  let i = 0
  while (i < base.length) {
    const rank = rankOrder.get(base[i].rankId) ?? 999
    const group: Member[] = []
    while (i < base.length && (rankOrder.get(base[i].rankId) ?? 999) === rank) group.push(base[i++])
    const buckets = new Map<string, Member[]>()
    for (const m of group) {
      const k = upath.get(m.unitId)?.join('.') ?? ''
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k)!.push(m)
    }
    const keys = [...buckets.keys()]
    let more = true
    while (more) {
      more = false
      for (const k of keys) {
        const b = buckets.get(k)!
        if (b.length) {
          out.push(b.shift()!)
          more = true
        }
      }
    }
  }
  return out
}

function tierRanksFor(seat: SeatRef, rowIndex: number, rules: RuleSet): string[] | null {
  const byZone = rules.tiers.filter((t) => t.by === 'zone' && t.zoneId === seat.zoneId)
  if (byZone.length) {
    const ids = new Set<string>()
    for (const t of byZone) for (const id of t.rankIds) ids.add(id)
    return [...ids]
  }
  const rowRules = rules.tiers.filter((t) => t.by === 'row' && rowIndex >= (t.from ?? 1) && rowIndex <= (t.to ?? 999))
  if (rowRules.length) {
    const ids = new Set<string>()
    for (const t of rowRules) for (const id of t.rankIds) ids.add(id)
    return [...ids]
  }
  return null
}

export function arrange(input: ArrangeInput): ArrangeResult {
  const { roster, layout, rules } = input
  const warnings: string[] = []
  const memberById = new Map(roster.members.map((m) => [m.id, m]))
  const statuses = input.statuses ?? {}
  const participants = input.participantIds ?? roster.members.filter((m) => m.active).map((m) => m.id)

  const eliminated: string[] = []
  const pool: Member[] = []
  for (const id of participants) {
    const m = memberById.get(id)
    if (!m) {
      eliminated.push(id)
      continue
    }
    const st = statuses[id] ?? 'present'
    if (st === 'leave' || st === 'absent') continue
    pool.push(m)
  }

  const allSeats: SeatRef[] = []
  for (let row = 0; row < layout.sheet.rows; row++) allSeats.push(...seatsInRow(layout.sheet, row))
  const usable = allSeats.filter((s) => !s.disabled)
  const stageSeats = usable.filter((s) => s.stage)
  const hallSeats = usable.filter((s) => !s.stage)

  // 锁定的分配优先落位；请假前移（shift）时不再保留请假者的位置
  const locked = (input.keepLocked ?? []).filter((a) => {
    if (!allSeats.some((s) => s.seatId === a.seatId)) return false
    if (statuses[a.memberId] === 'leave' && rules.podiumLeave === 'shift') return false
    return a.locked || statuses[a.memberId] === 'leave'
  })
  const lockedSeatIds = new Set<string>()
  const lockedMemberIds = new Set<string>()
  const assignments: Assignment[] = []
  for (const a of locked) {
    if (lockedSeatIds.has(a.seatId) || lockedMemberIds.has(a.memberId)) continue
    lockedSeatIds.add(a.seatId)
    lockedMemberIds.add(a.memberId)
    assignments.push({ ...a, status: statuses[a.memberId] ?? a.status })
  }
  const remainingPool = sortCandidates(pool.filter((m) => !lockedMemberIds.has(m.id)), roster, rules)

  // 主席台：按行分组，每行按主席台顺序逐座落位
  const stageQueue: SeatRef[] = []
  const stageRows = new Set(stageSeats.map((s) => s.row))
  for (const row of [...stageRows].sort((a, b) => a - b)) {
    const rowSeats = stageSeats.filter((s) => s.row === row && !lockedSeatIds.has(s.seatId))
    stageQueue.push(...podiumOrder(rowSeats, rules.evenCenterSide))
  }

  const used = new Set<string>(lockedMemberIds)
  const seatToAssignment = new Map(assignments.map((a) => [a.seatId, a]))

  const takeFor = (seat: SeatRef, allowed: string[] | null): Member | null => {
    if (seatToAssignment.has(seat.seatId) || seat.disabled) return null
    const idx = remainingPool.findIndex((m) => !used.has(m.id) && (!allowed || allowed.includes(m.rankId)))
    if (idx < 0) return null
    const m = remainingPool[idx]
    used.add(m.id)
    const a: Assignment = {
      seatId: seat.seatId,
      memberId: m.id,
      status: statuses[m.id] ?? 'present',
      locked: false
    }
    assignments.push(a)
    seatToAssignment.set(seat.seatId, a)
    return m
  }

  // 主席台同样要把「分层规则没勾职级」归一成不限职级，
  // 否则 allowed=[] 会让 takeFor 判定谁都不可用，整块主席台静默空着。
  for (const seat of stageQueue) {
    let allowed = tierRanksFor(seat, 0, rules)
    if (allowed && allowed.length === 0) allowed = null
    takeFor(seat, allowed)
  }

  // 台下：按排从上到下，排号直接取格子行号 + 1
  const mirror = rules.viewpoint === 'podium'
  const hallRows = new Set(hallSeats.map((s) => s.row))
  for (const row of [...hallRows].sort((a, b) => a - b)) {
    const rowSeats = hallSeats.filter((s) => s.row === row && !lockedSeatIds.has(s.seatId))
    const ordered = hallOrder(rowSeats, rules.hallOrder, mirror)
    for (const seat of ordered) {
      let allowed = tierRanksFor(seat, row + 1, rules)
      if (allowed && allowed.length === 0) allowed = null
      takeFor(seat, allowed)
    }
  }

  const unassigned = remainingPool.filter((m) => !used.has(m.id)).map((m) => m.id)

  const freeSeats = usable.length - assignments.filter((a) => a.status !== 'leave').length
  if (freeSeats > 0 && unassigned.length === 0 && participants.length > 0) {
    warnings.push(`还有 ${freeSeats} 个座位空着`)
  }
  if (unassigned.length) warnings.push(`${unassigned.length} 人未排到座位（座位不足或受职级分层限制）`)

  return { assignments, unassigned, warnings }
}

/** 座位索引：seatId → 座位引用（含行列与几何） */
export function seatIndexMap(layout: LayoutPackage): Map<string, SeatRef> {
  const out = new Map<string, SeatRef>()
  for (let row = 0; row < layout.sheet.rows; row++) {
    for (const s of seatsInRow(layout.sheet, row)) out.set(s.seatId, s)
  }
  return out
}

export function applyRulesToProject(project: Project, roster: RosterPlan, layout: LayoutPackage): ArrangeResult {
  return arrange({
    roster,
    layout,
    rules: project.ruleSet,
    statuses: Object.fromEntries(project.assignments.map((a) => [a.memberId, a.status])),
    keepLocked: project.assignments,
    participantIds: project.participantIds.length
      ? project.participantIds
      : roster.members.filter((m) => m.active).map((m) => m.id)
  })
}
