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
  /**
   * 固定座位：seatId → memberId。
   * 绑定人员先落座并占位，不再参与其他座位排序；优先级高于区域与职级规则。
   */
  fixedSeats?: Record<string, string>
}

export interface ArrangeResult {
  assignments: Assignment[]
  unassigned: string[]
  warnings: string[]
}

/**
 * 编号的统一底层：先定 1 号锚点，再按 firstSide 指定的方向交替向外。
 * 主席台与台下是两种相反视角，必须由 stageOrder / hallOrder 各自换算后再调用，
 * 不能把同一个左右参数直接套到两处。
 */
function centerOut(
  seats: SeatRef[],
  firstSide: 'left' | 'right',
  evenCenterSide: 'left' | 'right'
): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  const n = list.length
  if (!n) return []
  const pivot = n % 2 === 1 ? (n - 1) / 2 : evenCenterSide === 'right' ? n / 2 : n / 2 - 1
  const out: SeatRef[] = [list[pivot]]
  let l = pivot - 1
  let r = pivot + 1
  while (l >= 0 || r < n) {
    if (firstSide === 'left') {
      if (l >= 0) out.push(list[l--])
      if (r < n) out.push(list[r++])
    } else {
      if (r < n) out.push(list[r++])
      if (l >= 0) out.push(list[l--])
    }
  }
  return out
}

/**
 * 主席台座序。主席台人员面朝观众（画布下方），他们自己的左手在画布右侧：
 * 「左为上」= 2 号在画布右侧紧邻 1 号；「右为上」= 镜像，2 号在画布左侧。
 * 偶数座时 1 号取左中位还是右中位由 evenCenterSide 决定。
 */
export function stageOrder(
  seats: SeatRef[],
  side: RuleSet['stageSide'],
  evenCenterSide: RuleSet['evenCenterSide'] = 'right'
): SeatRef[] {
  return centerOut(seats, side === 'left' ? 'right' : 'left', evenCenterSide)
}

/**
 * 台下座序。台下是观众视角，画布左侧就是观众左手：
 * 「中间左优先」= 2 号紧邻 1 号左侧，「中间右优先」= 2 号紧邻右侧，之后交替向外。
 * 偶数座时 1 号取两个中位里偏左的一个，保证「2 号紧邻 1 号」连续。
 */
export function hallOrder(seats: SeatRef[], mode: RuleSet['hallOrder']): SeatRef[] {
  const list = [...seats].sort((a, b) => a.x - b.x)
  if (!list.length) return []
  if (mode === 'left-to-right') return list
  if (mode === 'right-to-left') return [...list].reverse()
  return centerOut(list, mode === 'center-right' ? 'right' : 'left', 'left')
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
  /** 名册顺序优先取显式 order，旧数据回落到数组位置 */
  const seq = (m: Member): number => m.order ?? listIdx.get(m.id) ?? 0
  const base = [...members].sort((a, b) => {
    const ra = rankOrder.get(a.rankId) ?? 999
    const rb = rankOrder.get(b.rankId) ?? 999
    if (ra !== rb) return ra - rb
    const pa = upath.get(a.unitId) ?? []
    const pb = upath.get(b.unitId) ?? []
    const c = cmpPath(pa, pb)
    if (c !== 0) return c
    return seq(a) - seq(b)
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
      ? stageOrder(seats, rules.stageSide, rules.evenCenterSide)
      : hallOrder(seats, rules.hallOrder)
    ordered.forEach((s, i) => out.set(s.seatId, i + 1))
  }
  return out
}

/** 固定座位提示用的座位名：主席台 / 第 N 排第 M 座 */
function seatText(seat: SeatRef | undefined): string {
  if (!seat) return '未知座位'
  return seat.stage ? `主席台第 ${seat.index} 座` : `第 ${seat.row + 1} 排第 ${seat.seatNo || seat.index} 座`
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

  const assignments: Assignment[] = []
  const seatIndex = new Map(allSeats.map((s) => [s.seatId, s]))
  const seatSeq = new Map(allSeats.map((s, i) => [s.seatId, i]))
  const used = new Set<string>()
  const seatToAssignment = new Map<string, Assignment>()
  const fixedMemberSeat = new Map<string, string>()

  // 固定座位优先级最高：先落位并占座，这批人随后从候选池剔除。
  // 按座位在布局中的先后处理，保证「同一人被绑多个座位」时的取舍是确定的。
  const fixedEntries = Object.entries(input.fixedSeats ?? {})
    .filter(([, memberId]) => !!memberId)
    .sort((a, b) => (seatSeq.get(a[0]) ?? 1e9) - (seatSeq.get(b[0]) ?? 1e9))
  for (const [seatId, memberId] of fixedEntries) {
    const seat = seatIndex.get(seatId)
    const m = memberById.get(memberId)
    if (!seat) {
      warnings.push('固定座位已不存在，对应绑定已失效；请在座位详情中重新指定')
      continue
    }
    const label = seatText(seat)
    if (!m) {
      warnings.push(`固定座位「${label}」引用的人员不在名册中，绑定已失效`)
      continue
    }
    const st = statuses[m.id] ?? m.status
    if (st === 'leave') {
      warnings.push(`「${m.name}」已请假，固定座位「${label}」本次未安排`)
      continue
    }
    if (!participants.includes(m.id)) {
      warnings.push(`「${m.name}」不在本次排座名单，固定座位「${label}」未生效`)
      continue
    }
    if (seat.disabled) {
      warnings.push(`固定座位「${label}」本次不坐人，「${m.name}」将按规则参与其他座位排序`)
      continue
    }
    const prev = fixedMemberSeat.get(m.id)
    if (prev) {
      warnings.push(
        `「${m.name}」被固定到多个座位（「${seatText(seatIndex.get(prev))}」与「${label}」），仅保留前者`
      )
      continue
    }
    if (!pool.some((p) => p.id === m.id)) continue
    const a: Assignment = { seatId, memberId: m.id, status: st }
    assignments.push(a)
    used.add(m.id)
    seatToAssignment.set(seatId, a)
    fixedMemberSeat.set(m.id, seatId)
  }

  const remainingPool = sortCandidates(
    pool.filter((m) => !used.has(m.id)),
    roster,
    rules
  )

  // 主席台：按行分组，每行按主席台顺序逐座落位
  const stageQueue: SeatRef[] = []
  const stageRows = new Set(stageSeats.map((s) => s.row))
  for (const row of [...stageRows].sort((a, b) => a - b)) {
    const rowSeats = stageSeats.filter((s) => s.row === row)
    stageQueue.push(...stageOrder(rowSeats, rules.stageSide, rules.evenCenterSide))
  }

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
      status: statuses[m.id] ?? 'present'
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
        ...stageOrder(
          stageSeats.filter((s) => s.row === row),
          rules.stageSide,
          rules.evenCenterSide
        )
      )
    }
    const hallRowsSorted = [...new Set(hallSeats.map((s) => s.row))].sort((a, b) => a - b)
    for (const row of hallRowsSorted) {
      orderedSeats.push(
        ...hallOrder(
          hallSeats.filter((s) => s.row === row),
          rules.hallOrder
        )
      )
    }
    /** 区域总座位数与当前剩余空位，用于给出准确提示 */
    const zoneTotal = (zoneId: string): number => usable.filter((s) => s.zoneId === zoneId).length
    const zoneFree = (zoneId: string): number =>
      orderedSeats.filter((s) => s.zoneId === zoneId && !seatToAssignment.has(s.seatId)).length
    // 区域指定人员之间也要遵守排座顺序（职级 → 单位 → 名册序），
    // 不能按 rules.zoneRules.memberIds 的存储顺序落位，否则会绕过名册拖拽顺序
    const candidatePos = new Map(remainingPool.map((m, i) => [m.id, i]))
    const manualIds = [...manualZones.keys()].sort(
      (a, b) => (candidatePos.get(a) ?? 1e9) - (candidatePos.get(b) ?? 1e9)
    )
    for (const memberId of manualIds) {
      const zones = manualZones.get(memberId)!
      const m = memberById.get(memberId)
      if (fixedMemberSeat.has(memberId)) {
        if (m) warnings.push(`「${m.name}」同时被固定座位与区域指定，按固定座位落位`)
        continue
      }
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
      const name = zoneName.get(zoneId) ?? zoneId
      const seat = orderedSeats.find((s) => s.zoneId === zoneId && !seatToAssignment.has(s.seatId))
      if (!seat) {
        const total = zoneTotal(zoneId)
        warnings.push(
          total
            ? `区域「${name}」座位不足：仅剩 ${zoneFree(zoneId)} 个空位（共 ${total} 座），未能安排「${m.name}」`
            : `区域「${name}」没有任何座位，未能安排「${m.name}」；请在布局中把座位分配到这个区域`
        )
        continue
      }
      const a: Assignment = {
        seatId: seat.seatId,
        memberId: m.id,
        status: statuses[m.id] ?? 'present'
      }
      assignments.push(a)
      seatToAssignment.set(seat.seatId, a)
      used.add(m.id)
    }
  }

  // 规则自检：级别规则没匹配到人、区域规则与分层规则重叠、区域没有座位
  for (const z of layout.zones ?? []) {
    const allow = zoneAllowFor(z.id, rules)
    if (!allow) continue
    if (!usable.some((s) => s.zoneId === z.id)) {
      warnings.push(`区域「${z.name}」没有可排座位，级别规则未生效；请在布局中把座位分配到这个区域`)
      continue
    }
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
    const rowSeats = hallSeats.filter((s) => s.row === row)
    const ordered = hallOrder(rowSeats, rules.hallOrder)
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
    fixedSeats: project.seatOverlay?.fixedSeats,
    participantIds: project.participantIds.length
      ? project.participantIds
      : roster.members.filter((m) => m.status === 'present').map((m) => m.id)
  })
}
