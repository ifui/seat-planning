import type {
  Assignment, AttendStatus, BaseElement, LayoutPackage, Member, Project, RosterPlan, RuleSet, SeatingElement, TierRule
} from '../types'
import { isSeatingElement } from '../types'
import { collectSeats, type AbsSeat } from './geometry'
import { seatRowsFor } from './grid'

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
export function podiumOrder(seats: AbsSeat[], evenCenterSide: 'left' | 'right' = 'left'): AbsSeat[] {
  const list = [...seats].sort((a, b) => a.cx - b.cx)
  const n = list.length
  if (!n) return []
  const out: AbsSeat[] = []
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
export function hallOrder(seats: AbsSeat[], mode: RuleSet['hallOrder'], mirror = false): AbsSeat[] {
  const list = [...seats].sort((a, b) => a.cx - b.cx)
  if (mirror) list.reverse()
  const n = list.length
  if (!n) return []
  if (mode === 'left-to-right') return list
  if (mode === 'right-to-left') return [...list].reverse()
  const out: AbsSeat[] = []
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

  // 交替穿插：同一职级内，各单位轮流取人
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

function tierRanksFor(seat: AbsSeat, rowIndex: number, rules: RuleSet): string[] | null {
  const rulesByZone = rules.tiers.filter((t) => t.by === 'zone' && t.zoneId === seat.zoneId)
  if (rulesByZone.length) {
    const ids = new Set<string>()
    for (const t of rulesByZone) for (const id of t.rankIds) ids.add(id)
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
    if (!m) { eliminated.push(id); continue }
    const st = statuses[id] ?? 'present'
    if (st === 'leave' || st === 'absent') { continue }
    pool.push(m)
  }

  const allSeats = collectSeats(layout)
  const stageSeats = allSeats.filter((s) => s.stage)
  const hallSeats = allSeats.filter((s) => !s.stage)

  // 锁定的分配优先落位；请假前移（shift）时不再保留请假者的位置
  const locked = (input.keepLocked ?? []).filter((a) => {
    if (statuses[a.memberId] === 'leave' && rules.podiumLeave === 'shift') return false
    return allSeats.some((s) => s.seat.id === a.seatId) && (a.locked || statuses[a.memberId] === 'leave')
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

  // 主席台：按主席台顺序逐座落位（有网格时排号来自格子，不再按坐标聚类）
  const stageRows = seatRowsFor(layout, stageSeats.filter((s) => !lockedSeatIds.has(s.seat.id)))
  const stageQueue: AbsSeat[] = []
  for (const row of stageRows) stageQueue.push(...podiumOrder(row.seats, rules.evenCenterSide))

  const used = new Set<string>(lockedMemberIds)
  const seatToAssignment = new Map(assignments.map((a) => [a.seatId, a]))

  const takeFor = (seat: AbsSeat, allowed: string[] | null): Member | null => {
    if (seatToAssignment.has(seat.seat.id)) return null
    if (statuses && rules.podiumLeave === 'hold' && seat.stage) {
      // 留空：已被锁定的请假席位由 locked 逻辑处理
    }
    const idx = remainingPool.findIndex((m) => !used.has(m.id) && (!allowed || allowed.includes(m.rankId)))
    if (idx < 0) return null
    const m = remainingPool[idx]
    used.add(m.id)
    const a: Assignment = {
      seatId: seat.seat.id,
      memberId: m.id,
      status: statuses[m.id] ?? 'present',
      locked: false
    }
    assignments.push(a)
    seatToAssignment.set(seat.seat.id, a)
    return m
  }

  // 主席台同样要把「分层规则没勾职级」归一成不限职级。
  // 否则 allowed=[] 会让 takeFor 判定谁都不可用，整块主席台静默空着。
  for (const seat of stageQueue) {
    let allowed = tierRanksFor(seat, 0, rules)
    if (allowed && allowed.length === 0) allowed = null
    takeFor(seat, allowed)
  }

  // 台下：按排从上到下，逐排使用规则。有网格时 rowIndex 直接取格子行号 + 1
  const mirror = rules.viewpoint === 'podium'
  const hallRows = seatRowsFor(layout, hallSeats.filter((s) => !lockedSeatIds.has(s.seat.id)))
  hallRows.forEach((row) => {
    const ordered = hallOrder(row.seats, rules.hallOrder, mirror)
    for (const seat of ordered) {
      let allowed = tierRanksFor(seat, row.rowIndex, rules)
      if (allowed && allowed.length === 0) allowed = null
      takeFor(seat, allowed)
    }
  })
  if (layout.grid) {
    const stray = allSeats.filter((s) => s.gridRow === undefined).length
    if (stray > 0) warnings.push(`有 ${stray} 个座位未入网格，已按坐标排到网格之后`)
  }

  const unassigned = remainingPool.filter((m) => !used.has(m.id)).map((m) => m.id)

  const totalSeats = allSeats.length
  const freeSeats = totalSeats - assignments.filter((a) => a.status !== 'leave').length
  if (freeSeats > 0 && unassigned.length === 0 && participants.length > 0) {
    warnings.push(`还有 ${freeSeats} 个座位空着`)
  }
  if (unassigned.length) warnings.push(`${unassigned.length} 人未排到座位（座位不足或受职级分层限制）`)

  return { assignments, unassigned, warnings }
}

export function seatIndexMap(layout: LayoutPackage): Map<string, { seatId: string; element: BaseElement }> {
  const out = new Map<string, { seatId: string; element: BaseElement }>()
  for (const el of layout.elements) {
    if (!isSeatingElement(el)) continue
    for (const s of el.seats) out.set(s.id, { seatId: s.id, element: el })
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
