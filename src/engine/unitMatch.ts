import type { RankDef, UnitNode } from '../types'

/**
 * 单位 / 职级的统一「名称口径」与共享解析器。
 *
 * 硬约束：单位名称在整棵树内唯一（不分层级），职级名称在同名册内唯一。
 * 因此解析短名时一旦命中即为确定结果，不会出现「同名叶子取第一个」的串号。
 *
 * 归一化：全角转半角（NFKC）、NBSP 转空格、内部空白折叠、去首尾空白；
 * 大小写不敏感仅用于匹配 key（ASCII 及全角字母经 NFKC 后统一小写），
 * 落库名称保留用户输入的大小写形式。
 */

export function normalizeName(v: unknown): string {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 匹配用的键：在归一化基础上再忽略大小写 */
export function nameKey(v: unknown): string {
  return normalizeName(v).toLowerCase()
}

/** 路径分隔符：/ \ > ＞（全角已被 NFKC 转半角） › 〉 → */
const PATH_SPLIT_RE = /\s*(?:\/|\\|>|＞|›|〉|→)\s*/

export function splitUnitPath(v: unknown): string[] {
  return normalizeName(v)
    .split(PATH_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 单位全路径，形如「局机关 / 办公室」 */
export function unitPathOf(
  units: UnitNode[],
  unit: UnitNode | string | null | undefined,
): string {
  if (!unit) return ''
  const byId = new Map(units.map((u) => [u.id, u]))
  const node = typeof unit === 'string' ? byId.get(unit) : unit
  if (!node) return ''
  const names: string[] = [node.name]
  let p = node.parentId ? byId.get(node.parentId) : undefined
  let guard = 0
  while (p && guard++ < 50) {
    names.unshift(p.name)
    p = p.parentId ? byId.get(p.parentId) : undefined
  }
  return names.join(' / ')
}

export interface UnitCandidate {
  id: string
  path: string
}

export interface UnitResolution {
  /** empty：这一行没有填单位；existing：命中已有单位；new：将新建；conflict：同名单位不止一个 */
  kind: 'empty' | 'existing' | 'new' | 'conflict'
  /** 归一化后的原始输入 */
  input: string
  /** 命中的单位名 / 将要新建的单位名 */
  name: string
  /** 确定的单位 id；新建时为临时 id（plan 内有效） */
  unitId: string
  /** 已存在单位的全路径 */
  path: string
  /** existing：按路径命中还是按短名命中 */
  via?: 'path' | 'name'
  /** new：将要挂到的父单位 id（null = 根级） */
  parentId?: string | null
  /** new：父单位全路径，根级为空串 */
  parentPath?: string
  /** conflict：同名候选 */
  candidates?: UnitCandidate[]
}

/**
 * 解析一行单位输入。
 *
 * 1. 先按路径逐级匹配（根 → 叶子），全段命中即命中；
 * 2. 路径不成立时用最后一段按名称全局匹配（名称唯一，命中即确定）；
 * 3. 都没命中则新建：父级取路径里已命中的最深前缀，单段时取用户指定的归入单位；
 * 4. 只有历史遗留的重名数据才会判定为 conflict，交用户处理。
 */
export function resolveUnit(
  units: UnitNode[],
  input: unknown,
  fallbackParentId?: string | null,
): UnitResolution {
  const raw = normalizeName(input)
  if (!raw) {
    return {
      kind: 'empty',
      input: '',
      name: '',
      unitId: fallbackParentId ?? '',
      path: '',
    }
  }
  const segments = splitUnitPath(raw)
  if (!segments.length) {
    return {
      kind: 'empty',
      input: raw,
      name: '',
      unitId: fallbackParentId ?? '',
      path: '',
    }
  }

  const byId = new Map(units.map((u) => [u.id, u]))
  const matched: UnitNode[] = []
  let parentId: string | null = null
  let brokeAt = -1
  let levelConflict: UnitNode[] | null = null

  for (let i = 0; i < segments.length; i++) {
    const key = segments[i].toLowerCase()
    const pool = units.filter(
      (u) => u.parentId === parentId && nameKey(u.name) === key,
    )
    if (pool.length === 1) {
      matched.push(pool[0])
      parentId = pool[0].id
      continue
    }
    if (pool.length > 1) levelConflict = pool
    brokeAt = i
    break
  }

  if (levelConflict) {
    return {
      kind: 'conflict',
      input: raw,
      name: levelConflict[0].name,
      unitId: '',
      path: '',
      via: 'path',
      candidates: levelConflict.map((u) => ({
        id: u.id,
        path: unitPathOf(units, u.id),
      })),
    }
  }

  if (brokeAt === -1) {
    const hit = matched[matched.length - 1]
    return {
      kind: 'existing',
      input: raw,
      name: hit.name,
      unitId: hit.id,
      path: unitPathOf(units, hit.id),
      via: 'path',
    }
  }

  // 路径不成立：按最后一段短名匹配（名称唯一，命中即确定）
  const lastKey = segments[segments.length - 1].toLowerCase()
  const named = units.filter((u) => nameKey(u.name) === lastKey)
  if (named.length === 1) {
    return {
      kind: 'existing',
      input: raw,
      name: named[0].name,
      unitId: named[0].id,
      path: unitPathOf(units, named[0].id),
      via: 'name',
    }
  }
  if (named.length > 1) {
    return {
      kind: 'conflict',
      input: raw,
      name: named[0].name,
      unitId: '',
      path: '',
      via: 'name',
      candidates: named.map((u) => ({
        id: u.id,
        path: unitPathOf(units, u.id),
      })),
    }
  }

  const prefix = matched[matched.length - 1]
  const resolvedParentId = prefix ? prefix.id : (fallbackParentId ?? null)
  const parentNode = resolvedParentId ? byId.get(resolvedParentId) : undefined
  return {
    kind: 'new',
    input: raw,
    name: segments[segments.length - 1],
    unitId: '',
    path: '',
    via: prefix ? 'path' : undefined,
    parentId: resolvedParentId ?? null,
    parentPath: parentNode ? unitPathOf(units, parentNode.id) : '',
  }
}

export interface PlannedUnit {
  tempId: string
  name: string
  parentId: string | null
  /** 父单位全路径，根级为空串 */
  parentPath: string
}

/**
 * 批量解析单位输入。
 * 新增单位用临时 id 参与后续行匹配，因此「先新建 A / B，再写 A / B」能正确命中。
 */
export function planUnitInputs(
  units: UnitNode[],
  inputs: unknown[],
  fallbackParentId?: string | null,
): { items: UnitResolution[]; newUnits: PlannedUnit[]; conflicts: number } {
  const working: UnitNode[] = units.map((u) => ({ ...u }))
  const newUnits: PlannedUnit[] = []
  let seq = 0

  const items = inputs.map((raw) => {
    const res = resolveUnit(working, raw, fallbackParentId)
    if (res.kind !== 'new') return res
    const tempId = `__new_unit_${seq++}`
    const parentId = res.parentId ?? null
    const order =
      Math.max(
        -1,
        ...working.filter((u) => u.parentId === parentId).map((u) => u.order),
      ) + 1
    working.push({ id: tempId, name: res.name, parentId, order })
    newUnits.push({
      tempId,
      name: res.name,
      parentId,
      parentPath: parentId ? unitPathOf(working, parentId) : '',
    })
    return { ...res, unitId: tempId }
  })

  return {
    items,
    newUnits,
    conflicts: items.filter((i) => i.kind === 'conflict').length,
  }
}

export interface RankResolution {
  kind: 'empty' | 'existing' | 'new' | 'conflict'
  input: string
  name: string
  rankId: string
  candidates?: { id: string; name: string }[]
}

export interface PlannedRank {
  tempId: string
  name: string
  order: number
}

/** 职级解析：口径与单位一致（归一化 + 唯一性），只是没有层级与路径 */
export function planRankInputs(
  ranks: RankDef[],
  inputs: unknown[],
): { items: RankResolution[]; newRanks: PlannedRank[]; conflicts: number } {
  const working: RankDef[] = ranks.map((r) => ({ ...r }))
  const newRanks: PlannedRank[] = []
  let seq = 0
  let order = Math.max(-1, ...working.map((r) => r.order)) + 1

  const items: RankResolution[] = inputs.map((raw) => {
    const name = normalizeName(raw)
    if (!name) return { kind: 'empty', input: '', name: '', rankId: '' }
    const key = name.toLowerCase()
    const hits = working.filter((r) => nameKey(r.name) === key)
    if (hits.length === 1)
      return { kind: 'existing', input: name, name: hits[0].name, rankId: hits[0].id }
    if (hits.length > 1)
      return {
        kind: 'conflict',
        input: name,
        name,
        rankId: '',
        candidates: hits.map((r) => ({ id: r.id, name: r.name })),
      }
    const tempId = `__new_rank_${seq++}`
    working.push({ id: tempId, name, order, color: '' })
    newRanks.push({ tempId, name, order })
    order++
    return { kind: 'new', input: name, name, rankId: tempId }
  })

  return {
    items,
    newRanks,
    conflicts: items.filter((i) => i.kind === 'conflict').length,
  }
}

export interface UnitDuplicateGroup {
  key: string
  name: string
  nodes: UnitNode[]
}

/** 已存在的重名单位分组（仅用于提示与人工处理，不做静默合并） */
export function duplicateUnitGroups(units: UnitNode[]): UnitDuplicateGroup[] {
  const map = new Map<string, UnitNode[]>()
  for (const u of units) {
    const key = nameKey(u.name)
    if (!key) continue
    const list = map.get(key)
    if (list) list.push(u)
    else map.set(key, [u])
  }
  const out: UnitDuplicateGroup[] = []
  for (const [key, nodes] of map) {
    if (nodes.length < 2) continue
    out.push({
      key,
      name: nodes[0].name,
      nodes: [...nodes].sort((a, b) =>
        unitPathOf(units, a.id).localeCompare(unitPathOf(units, b.id), 'zh-CN'),
      ),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export interface RankDuplicateGroup {
  key: string
  name: string
  ranks: RankDef[]
}

export function duplicateRankGroups(ranks: RankDef[]): RankDuplicateGroup[] {
  const map = new Map<string, RankDef[]>()
  for (const r of ranks) {
    const key = nameKey(r.name)
    if (!key) continue
    const list = map.get(key)
    if (list) list.push(r)
    else map.set(key, [r])
  }
  const out: RankDuplicateGroup[] = []
  for (const [key, list] of map) {
    if (list.length < 2) continue
    out.push({ key, name: list[0].name, ranks: list })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function countNames(list: { name: string }[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of list) {
    const key = nameKey(item.name)
    if (!key) continue
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

/**
 * 相对上一版数据「新引入」的重名名称。
 * 历史遗留的重名不做静默修改，因此只有数量比上一版更多时才判定为新增冲突，
 * 这样既能在所有写入路径上拦截新的重名，又不会把旧数据锁死。
 */
export function introducedDuplicates(
  next: { name: string }[],
  prev: { name: string }[],
): string[] {
  const before = countNames(prev)
  const after = countNames(next)
  const out: string[] = []
  for (const [key, count] of after) {
    if (count > 1 && count > (before.get(key) ?? 0)) {
      const hit = next.find((x) => nameKey(x.name) === key)
      out.push(hit ? normalizeName(hit.name) : key)
    }
  }
  return out
}

/** 统一的重名错误文案：说明与哪个已有名称冲突 */
export function duplicateMessage(units: string[], ranks: string[]): string {
  const parts: string[] = []
  if (units.length) parts.push(`单位名称重名：${units.join('、')}`)
  if (ranks.length) parts.push(`职级名称重名：${ranks.join('、')}`)
  return `${parts.join('；')}。单位名称必须全树唯一，请先改名或合并。`
}
