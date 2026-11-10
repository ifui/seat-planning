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

/**
 * 居中向两侧的座序：1 号居中，2 号在 1 号右手边的画布方向（x+），3 号在左侧，
 * 之后左右交替向外。主席台与台下统一使用这一口径，不因「视角」设置而反转。
 *
 * 偶数个座位时两个中心位的先后由 evenCenterSide 决定：
 * left = 1 号取左中位（2 号紧邻其右侧），right = 1 号取右中位（2 号紧邻其左侧）。
 * 3 号必须落在 1 号的另一侧——双人桌时 1、2 号常同属一张桌子，
 * 若继续向 #2 外侧取座，3 号会跑到 1 号同一侧，编号就乱了。
 */
export function centerOutOrder(seats: SeatRef[], evenCenterSide: 'left' | 'right' = 'left'): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  const n = list.length
  if (!n) return []
  const out: SeatRef[] = []
  let l = 0
  let r = 0
  /** 下一座是否先取右侧；3 号始终回到 2 号的对侧 */
  let rightFirst = true
  if (n % 2 === 1) {
    const c = (n - 1) / 2
    out.push(list[c])
    l = c - 1
    r = c + 1
  } else {
    const cL = n / 2 - 1
    const cR = n / 2
    if (evenCenterSide === 'right') {
      out.push(list[cR])
      out.push(list[cL])
      rightFirst = true
    } else {
      out.push(list[cL])
      out.push(list[cR])
      rightFirst = false
    }
    l = cL - 1
    r = cR + 1
  }
  /**
   * 每一轮同时向外扩左右各一座，因此奇偶两种起点刚好形成
   * 右-左-右-左（1 号居中 / 字位在右）与 左-右-左-右（1 号取左中位）的交替。
   */
  while (l >= 0 || r < n) {
    if (rightFirst) {
      if (r < n) out.push(list[r++])
      if (l >= 0) out.push(list[l--])
    } else {
      if (l >= 0) out.push(list[l--])
      if (r < n) out.push(list[r++])
    }
  }
  return out
}

/** 台下横向顺序：center-out 与主席台同口径；左右向模式按画布方向直接取座 */
export function hallOrder(
  seats: SeatRef[],
  mode: RuleSet['hallOrder'],
  evenCenterSide: 'left' | 'right' = 'left'
): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  if (!list.length) return []
  if (mode === 'left-to-right') return list
  if (mode === 'right-to-left') return [...list].reverse()
  return centerOutOrder(list, evenCenterSide)
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

interface ZoneAllow {
  /** 区域规则指定的职级；null 表示区域未限定职级（只做了人员/排除配置） */
  ranks: string[] | null
  /** 区域排除的职级 */
  exclude: Set<string>
  /** 区域手动指定的人员 */
  members: Set<string>
}

/** 汇总某区域的分配规则（多条规则取并集） */
function zoneAllowFor(zoneId: string | undefined, rules: RuleSet): ZoneAllow | null {
  if (!zoneId) return null
  const list = (rules.zoneRules ?? []).filter((r) => r.enabled && r.zoneId === zoneId)
  if (!list.length) return null
  const ranks = new Set<string>()
  const exclude = new Set<string>()
  const members = new Set<string>()
  for (const r of list) {
    for (const id of r.rankIds) ranks.add(id)
    for (const id of r.excludeRankIds) exclude.add(id)
    for (const id of r.memberIds) members.add(id)
  }
  const effective = [...ranks].filter((id) => !exclude.has(id))
  return { ranks: effective.length ? effective : null, exclude, members }
}

interface SeatAllow {
  ranks: string[] | null
  exclude?: Set<string>
}

/**
 * 座位的可用职级。优先级：区域级别规则 > 职级分层规则；
 * 区域规则只配了排除级别时，分层规则继续生效，但要剔除被排除的职级。
 */
function allowForSeat(seat: SeatRef, rowIndex: number, rules: RuleSet): SeatAllow | null {
  const zone = zoneAllowFor(seat.zoneId, rules)
  if (zone?.ranks) return { ranks: zone.ranks, exclude: zone.exclude }
  const tier = tierRanksFor(seat, rowIndex, rules)
  return { ranks: tier && tier.length ? tier : null, exclude: zone?.exclude }
}

/** 座位编号：每排按排座算法的先后编号（中间 1 号、左右交替向外），与落座顺序一致 */
export function seatOrderMap(layout: LayoutPackage, rules: RuleSet): Map<string, number> {
  const out = new Map<string, number>()
  for (let row = 0; row < layout.sheet.rows; row++) {
    const seats = seatsInRow(layout.sheet, row).filter((s) => !s.disabled)
    if (!seats.length) continue
    const ordered = seats[0].stage
      ? centerOutOrder(seats, rules.evenCenterSide)
      : hallOrder(seats, rules.hallOrder, rules.evenCenterSide)
    ordered.forEach((s, i) => out.set(s.seatId, i + 1))
  }
  return out
}

export function arrange(input: ArrangeInput): ArrangeResult {
  const { roster, layout, rules } = input
  const warnings: string[] = []
  const memberById = new Map(roster.members.map((m) => [m.id, m]))
  const statuses = input.statuses ?? {}
  const participants = input.participantIds ?? roster.members.filter((m) => m.status === 'present').map((m) => m.id)

  const eliminated: string[] = []
  const pool: Member[] = []
  for (const id of participants) {
    const m = memberById.get(id)
    if (!m) {
      eliminated.push(id)
      continue
    }
    const st = statuses[id] ?? m.status
    if (st === 'leave') continue
    pool.push(m)
  }

  const allSeats: SeatRef[] = []
  for (let row = 0; row < layout.sheet.rows; row++) allSeats.push(...seatsInRow(layout.sheet, row))
  const usable = allSeats.filter((s) => !s.disabled)
  const stageSeats = usable.filter((s) => s.stage)
  const hallSeats = usable.filter((s) => !s.stage)

  // 锁定的分配优先落位；请假者不占座，任何状态下都不保留其座位
  const locked = (input.keepLocked ?? []).filter((a) => {
    if (!allSeats.some((s) => s.seatId === a.seatId)) return false
    const member = memberById.get(a.memberId)
    if (!member || member.status === 'leave') return false
    return !!a.locked
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
    stageQueue.push(...centerOutOrder(rowSeats, rules.evenCenterSide))
  }

  const used = new Set<string>(lockedMemberIds)
  const seatToAssignment = new Map(assignments.map((a) => [a.seatId, a]))

  const takeFor = (seat: SeatRef, allow: SeatAllow | null): Member | null => {
    if (seatToAssignment.has(seat.seatId) || seat.disabled) return null
    const idx = remainingPool.findIndex(
      (m) =>
        !used.has(m.id) &&
        (!allow?.ranks || allow.ranks.includes(m.rankId)) &&
        !(allow?.exclude && allow.exclude.has(m.rankId))
    )
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

  const zoneName = new Map((layout.zones ?? []).map((z) => [z.id, z.name]))

  // 区域手动指定的人员先落位：优先级最高，不吃职级限制
  {
    const manualZones = new Map<string, string[]>()
    for (const r of rules.zoneRules ?? []) {
      if (!r.enabled) continue
      for (const id of r.memberIds) {
        const arr = manualZones.get(id) ?? []
        arr.push(r.zoneId)
        manualZones.set(id, arr)
      }
    }
    // 区域内的落位顺序与编号一致：主席台在前，再按排、按居中向两侧
    const orderedSeats: SeatRef[] = []
    const stageRowsSorted = [...new Set(stageSeats.map((s) => s.row))].sort((a, b) => a - b)
    for (const row of stageRowsSorted) {
      orderedSeats.push(
        ...centerOutOrder(
          stageSeats.filter((s) => s.row === row && !lockedSeatIds.has(s.seatId)),
          rules.evenCenterSide
        )
      )
    }
    const hallRowsSorted = [...new Set(hallSeats.map((s) => s.row))].sort((a, b) => a - b)
    for (const row of hallRowsSorted) {
      orderedSeats.push(
        ...hallOrder(
          hallSeats.filter((s) => s.row === row && !lockedSeatIds.has(s.seatId)),
          rules.hallOrder,
          rules.evenCenterSide
        )
      )
    }
    for (const [memberId, zones] of manualZones) {
      const m = memberById.get(memberId)
      if (!m || used.has(m.id)) continue
      const target = [...new Set(zones)]
      if (target.length > 1) {
        warnings.push(`「${m.name}」被同时指定到多个区域，按第一个区域落位`)
      }
      if (!pool.some((p) => p.id === m.id)) {
        warnings.push(`「${m.name}」不在本次排座名单内，区域指定已忽略`)
        continue
      }
      const zoneId = target[0]
      const seat = orderedSeats.find((s) => s.zoneId === zoneId && !seatToAssignment.has(s.seatId))
      if (!seat) {
        warnings.push(`区域「${zoneName.get(zoneId) ?? zoneId}」座位不足，未能安排「${m.name}」`)
        continue
      }
      const a: Assignment = {
        seatId: seat.seatId,
        memberId: m.id,
        status: statuses[m.id] ?? 'present',
        locked: false
      }
      assignments.push(a)
      seatToAssignment.set(seat.seatId, a)
      used.add(m.id)
    }
  }

  // 规则自检：级别规则没匹配到人、区域规则与分层规则重叠
  for (const z of layout.zones ?? []) {
    const allow = zoneAllowFor(z.id, rules)
    if (!allow) continue
    if (allow.ranks) {
      const hit = pool.filter((m) => allow.ranks!.includes(m.rankId) && !allow.exclude.has(m.rankId))
      if (!hit.length) warnings.push(`区域「${z.name}」的级别规则没有匹配到可排人员`)
    }
    const hasRankRule = (rules.zoneRules ?? []).some(
      (r) => r.enabled && r.zoneId === z.id && (r.rankIds.length > 0 || r.excludeRankIds.length > 0)
    )
    if (hasRankRule && rules.tiers.some((t) => t.by === 'zone' && t.zoneId === z.id)) {
      warnings.push(`区域「${z.name}」同时配置了区域级别规则与职级分层规则，按区域规则优先`)
    }
  }

  // 主席台同样要把「分层规则没勾职级」归一成不限职级，
  // 否则 allowed=[] 会让 takeFor 判定谁都不可用，整块主席台静默空着。
  for (const seat of stageQueue) {
    takeFor(seat, allowForSeat(seat, 0, rules))
  }

  // 台下：按排从上到下，排号直接取格子行号 + 1
  const hallRows = new Set(hallSeats.map((s) => s.row))
  for (const row of [...hallRows].sort((a, b) => a - b)) {
    const rowSeats = hallSeats.filter((s) => s.row === row && !lockedSeatIds.has(s.seatId))
    const ordered = hallOrder(rowSeats, rules.hallOrder, rules.evenCenterSide)
    for (const seat of ordered) {
      takeFor(seat, allowForSeat(seat, row + 1, rules))
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
  const statuses: Record<string, AttendStatus> = {}
  for (const m of roster.members) statuses[m.id] = m.status
  for (const a of project.assignments) if (a.status !== 'present') statuses[a.memberId] = a.status
  return arrange({
    roster,
    layout,
    rules: project.ruleSet,
    statuses,
    keepLocked: project.assignments,
    participantIds: project.participantIds.length
      ? project.participantIds
      : roster.members.filter((m) => m.status === 'present').map((m) => m.id)
  })
}
