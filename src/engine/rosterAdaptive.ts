/**
 * 导入名单解析（模板导入口径）：
 * - 表头在前 8 个非空行里探测，可用 forceHeader 手动指定；
 * - 列角色用「表头线索 + 内容特征」打分，自动识别后允许界面手动调整；
 * - 数据按列直接取值，不再做单元格内分词切分；
 * - 职级只做归一匹配，认不出不新建，交人工映射或显式新建。
 */
import type { RankDef, UnitNode } from '../types'
import type { RawSheet } from './rosterImport'
import { nameKey, resolveUnit, splitUnitPath } from './unitMatch'

export type ImportField = 'name' | 'unit' | 'rank' | 'duty' | 'note'
export type Confidence = 'high' | 'mid' | 'low'
export type RankMatchKind =
  | 'empty'
  | 'exact'
  | 'alias'
  | 'rule'
  | 'contains'
  | 'suggest'
  | 'duty-word'
  | 'unknown'
  | 'conflict'
  | 'new'

export interface ColumnRole {
  index: number
  label: string
  role: ImportField | 'ignore'
  confidence: Confidence
  score: number
  filled: number
  evidence: string
}

export interface AdaptiveSheet {
  sourceName: string
  sheetName: string
  warnings: string[]
  hasHeader: boolean
  headerIndex: number
  headerLabels: string[]
  dataRows: string[][]
  columns: ColumnRole[]
  nameColumn: number
}

// ---------------------------------------------------------------- 基础工具

/** 单元格归一：全角不动（保留中文括号），只处理 NBSP、制表/换行与连续空格 */
export function cleanCell(v: unknown): string {
  return String(v ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

const PHONE_RE = /^\+?[\d\s-]{7,}$/
const SEX_RE = /^(男|男性|男士|先生|女|女性|女士|mrs?|ms|m|f|male|female)$/i
const HEADER_WORD_RE =
  /姓名|名字|称呼|人员|成员|员工|参会人|与会人|性别|工作单位|单位|部门|科室|机构|所属|职级|级别|职称|职等|职务|职位|岗位|备注|说明|电话|手机|联系方式|序号|编号|工号/
const HEADER_EXACT_RE =
  /^(姓名|名字|称呼|人员|成员|员工|参会人|与会人|性别|单位|部门|科室|机构|所属|职级|级别|职称|职等|职务|职位|岗位|备注|说明|电话|手机|联系方式|序号|编号|工号)$/

const ORG_SUFFIX_RE =
  /(委员会|管委会|总局|项目部|办公室|分局|中心|公司|集团|车间|街道|局|厅|部|委|办|处|科|室|站|所|队|院|校|镇|乡)$/

function hasUnitSuffix(text: string): boolean {
  const s = cleanCell(text)
  return !!s && ORG_SUFFIX_RE.test(s)
}

const DUTY_POSITIVE = [
  '局长',
  '处长',
  '科长',
  '股长',
  '部长',
  '厅长',
  '所长',
  '站长',
  '队长',
  '组长',
  '书记',
  '主席',
  '秘书长',
  '理事长',
  '经理',
  '总监',
  '董事长',
  '主任',
  '大队长',
  '支队长',
  '中队长',
  '班长'
]
const DUTY_SPECIAL = ['主任科员', '副主任科员', '调研员', '巡视员', '科员', '干事', '专员', '办事员']
const DUTY_GENERIC = ['领导', '负责人', '班子成员', '干部']

const ALL_DUTY = new Set<string>([
  ...DUTY_POSITIVE,
  ...DUTY_POSITIVE.map((w) => `副${w}`),
  ...DUTY_SPECIAL,
  ...DUTY_GENERIC
])

function isDutyWord(text: string): boolean {
  return ALL_DUTY.has(cleanCell(text))
}

function isRankLikeDuty(text: string): boolean {
  const s = cleanCell(text)
  return DUTY_SPECIAL.some((w) => s.endsWith(w))
}

/** 取串尾最长的职务词 */
function dutySuffix(text: string): string {
  const s = cleanCell(text)
  let best = ''
  for (const w of ALL_DUTY) if (s.endsWith(w) && w.length > best.length) best = w
  return best
}

const CHINESE_NAME_RE = /^[\u4e00-\u9fa5·]{2,6}$/
const LATIN_NAME_RE = /^[A-Za-z][A-Za-z.'-]{1,24}$/

function isCleanName(v: string): boolean {
  const s = cleanCell(v)
  if (!s) return false
  if (HEADER_WORD_RE.test(s)) return false
  if (SEX_RE.test(s) || PHONE_RE.test(s)) return false
  if (isDutyWord(s) || isRankLikeDuty(s) || hasUnitSuffix(s)) return false
  return CHINESE_NAME_RE.test(s) || LATIN_NAME_RE.test(s)
}

function isPersonName(v: string): boolean {
  const s = cleanCell(v)
  if (!isCleanName(s)) return false
  return CHINESE_NAME_RE.test(s) || LATIN_NAME_RE.test(s)
}

// ---------------------------------------------------------------- 职级归一

const RANK_LEVEL_SYNONYM: Record<string, string> = {
  科: '乡科级',
  处: '县处级',
  厅: '地厅级',
  部: '省部级'
}

const SYNONYM_PREFIXES: [RegExp, string][] = [
  [/^([正副]?)乡科级/, '$1科级'],
  [/^([正副]?)县处级/, '$1处级'],
  [/^([正副]?)地厅级/, '$1厅级'],
  [/^([正副]?)厅局级/, '$1厅级'],
  [/^([正副]?)省部级/, '$1部级']
]

/** 规则生成归一文本：补「级」、方向重排、层级同义词、去职务后缀 */
export function normalizeRankText(raw: string): string {
  let s = cleanCell(raw).replace(/\s+/g, '')
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(/(非领导职务|领导职务层次|领导职务|职务|职级|级别)$/u, '')
    const m = s.match(/^(.+?级)(正职|副职)$/u)
    if (m) s = (m[2] === '正职' ? '正' : '副') + m[1]
    s = s.replace(/^([正副])([科处局厅部])$/u, '$1$2级')
    for (const [re, to] of SYNONYM_PREFIXES) s = s.replace(re, to)
    if (s === before) break
  }
  return s
}

function editDistance(a: string, b: string): number {
  const s = [...a]
  const t = [...b]
  let prev: number[] = Array.from({ length: t.length + 1 }, (_, j) => j)
  for (let i = 1; i <= s.length; i++) {
    const cur: number[] = [i]
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[t.length]
}

export interface RankMatch {
  kind: RankMatchKind
  input: string
  target: string
  rankId: string
  evidence: string
  candidates: { id: string; name: string }[]
}

const EMPTY_RANK: RankMatch = {
  kind: 'empty',
  input: '',
  target: '',
  rankId: '',
  evidence: '',
  candidates: []
}

/**
 * 职级匹配顺序：名称完全一致 → 别名 → 规则变体 → 唯一包含 → 相似建议（只提示）。
 * 认不出时不会新建，由调用方交人工映射或显式新建。
 */
export function matchRank(ranks: RankDef[], input: string): RankMatch {
  const raw = cleanCell(input)
  if (!raw) return { ...EMPTY_RANK }
  const key = nameKey(raw)

  const exact = ranks.filter((r) => nameKey(r.name) === key)
  if (exact.length === 1)
    return { kind: 'exact', input: raw, target: exact[0].name, rankId: exact[0].id, evidence: `职级：${exact[0].name}`, candidates: [] }
  if (exact.length > 1)
    return {
      kind: 'conflict',
      input: raw,
      target: raw,
      rankId: '',
      evidence: '同名职级不止一个',
      candidates: exact.map((r) => ({ id: r.id, name: r.name }))
    }

  const alias = ranks.filter((r) => (r.aliases ?? []).some((a) => nameKey(a) === key))
  if (alias.length === 1)
    return {
      kind: 'alias',
      input: raw,
      target: alias[0].name,
      rankId: alias[0].id,
      evidence: `别名：${raw} → ${alias[0].name}`,
      candidates: []
    }
  if (alias.length > 1)
    return {
      kind: 'conflict',
      input: raw,
      target: raw,
      rankId: '',
      evidence: '别名指向多个职级',
      candidates: alias.map((r) => ({ id: r.id, name: r.name }))
    }

  const norm = nameKey(normalizeRankText(raw))
  const ruled = ranks.filter(
    (r) =>
      nameKey(normalizeRankText(r.name)) === norm ||
      (r.aliases ?? []).some((a) => nameKey(normalizeRankText(a)) === norm)
  )
  if (ruled.length === 1)
    return {
      kind: 'rule',
      input: raw,
      target: ruled[0].name,
      rankId: ruled[0].id,
      evidence: `规则：${raw} → ${ruled[0].name}`,
      candidates: []
    }
  if (ruled.length > 1)
    return {
      kind: 'conflict',
      input: raw,
      target: raw,
      rankId: '',
      evidence: '多种写法都指向已有职级',
      candidates: ruled.map((r) => ({ id: r.id, name: r.name }))
    }

  // 只允许「已有职级名出现在输入里」，反向包含会把「调研员」并进「副调研员」
  const direction = (s: string): string => (s.includes('正') ? '正' : s.includes('副') ? '副' : '')
  const contained = norm.length >= 2
    ? ranks.filter((r) => {
        const k = nameKey(normalizeRankText(r.name))
        if (k.length < 2 || !norm.includes(k)) return false
        // 正 / 副 不一致时不做包含归一，避免副级被降成正级
        const dIn = direction(norm)
        if (dIn && dIn !== direction(k)) return false
        // 只容忍「享受 / 相当 / 待遇」这类修饰，其余多出来的字一律不归一
        const extra = norm.replace(k, '')
        return /^(?:享受|相当|参照|按|级别|职级|待遇|标准|非领导职务|领导职务)*$/.test(extra)
      })
    : []
  if (contained.length === 1)
    return {
      kind: 'contains',
      input: raw,
      target: contained[0].name,
      rankId: contained[0].id,
      evidence: `包含关系：${raw} 含 ${contained[0].name}`,
      candidates: []
    }

  if (isRankLikeDuty(raw))
    return { kind: 'duty-word', input: raw, target: raw, rankId: '', evidence: '职级化职务，按职务处理', candidates: [] }

  const near = ranks
    .map((r) => ({ r, d: editDistance(norm, nameKey(normalizeRankText(r.name))) }))
    .filter((x) => x.d <= 1)
    .map((x) => ({ id: x.r.id, name: x.r.name }))
  if (near.length)
    return {
      kind: 'suggest',
      input: raw,
      target: raw,
      rankId: '',
      evidence: `相近职级：${near.map((x) => x.name).join('、')}`,
      candidates: near
    }

  return { kind: 'unknown', input: raw, target: raw, rankId: '', evidence: '未识别', candidates: [] }
}

// ---------------------------------------------------------------- 表头与列角色

function headerHit(cell: string): number {
  const s = cleanCell(cell)
  if (!s || s.length > 10) return 0
  if (HEADER_EXACT_RE.test(s)) return 2
  if (HEADER_WORD_RE.test(s)) return 1
  return 0
}

/** 在前 8 个非空行里找表头，找不到返回 -1（不猜表头） */
function detectHeaderRow(rows: string[][]): number {
  let best = -1
  let bestScore = 0
  const limit = Math.min(rows.length, 8)
  for (let i = 0; i < limit; i++) {
    const row = rows[i]
    let score = 0
    for (const cell of row) {
      score += headerHit(cell)
      if (isPersonName(cell)) score -= 1
      if (PHONE_RE.test(cleanCell(cell))) score -= 1
    }
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return bestScore >= 3 ? best : -1
}

function headerHint(label: string, role: ImportField): number {
  const s = cleanCell(label)
  if (!s) return 0
  if (role === 'name') return /姓名|名字|称呼|人员|成员|员工|参会人|与会人/.test(s) ? 1 : 0
  if (role === 'unit') return /单位|部门|科室|机构|所属/.test(s) ? 1 : 0
  if (role === 'rank') return /职级|级别|职称|职等/.test(s) ? 1 : 0
  if (role === 'duty') return /职务|职位|岗位/.test(s) ? 1 : 0
  return /备注|说明|电话|手机|联系方式/.test(s) ? 1 : 0
}

function looksLikeUnit(text: string, units: UnitNode[]): boolean {
  const s = cleanCell(text)
  if (!s || isDutyWord(s)) return false
  if (resolveUnit(units, s).kind === 'existing') return true
  const segs = splitUnitPath(s)
  if (segs.length > 1) return segs.every((x) => hasUnitSuffix(x) && !dutySuffix(x))
  return hasUnitSuffix(s) && !dutySuffix(s)
}

function valueScore(role: ImportField, v: string, units: UnitNode[], ranks: RankDef[]): number {
  const s = cleanCell(v)
  if (!s) return 0
  if (role === 'name') return isPersonName(s) ? 1 : 0
  if (role === 'unit') {
    if (looksLikeUnit(s, units)) return 1
    return hasUnitSuffix(s) ? 0.55 : 0
  }
  if (role === 'rank') {
    const m = matchRank(ranks, s)
    if (m.rankId) return 1
    if (/级|职/.test(s)) return 0.5
    return 0
  }
  if (role === 'duty') {
    if (isDutyWord(s) || isRankLikeDuty(s)) return 1
    if (dutySuffix(s)) return 0.8
    return 0
  }
  if (PHONE_RE.test(s)) return 1
  return s.length >= 10 ? 0.55 : 0.1
}

const ROLE_LIST: ImportField[] = ['name', 'unit', 'rank', 'duty', 'note']

function inferColumns(
  labels: string[],
  dataRows: string[][],
  units: UnitNode[],
  ranks: RankDef[]
): ColumnRole[] {
  const base = labels.map((label, index) => {
    const values = dataRows
      .map((r) => cleanCell(r[index] ?? ''))
      .filter(Boolean)
      .slice(0, 60)
    const scores: Record<ImportField, number> = { name: 0, unit: 0, rank: 0, duty: 0, note: 0 }
    for (const role of ROLE_LIST) {
      const content = values.length
        ? values.reduce((sum, v) => sum + valueScore(role, v, units, ranks), 0) / values.length
        : 0
      scores[role] = Math.min(1, content * 0.6 + headerHint(label, role) * 0.4)
    }
    return { index, label, values, scores }
  })

  const columns: ColumnRole[] = base.map((c) => ({
    index: c.index,
    label: c.label,
    role: 'ignore',
    confidence: 'low',
    score: 0,
    filled: c.values.length,
    evidence: ''
  }))

  const taken = new Set<number>()
  const assign = (role: ImportField): void => {
    let best = -1
    let bestScore = 0
    for (const c of base) {
      if (taken.has(c.index)) continue
      if (c.scores[role] > bestScore) {
        bestScore = c.scores[role]
        best = c.index
      }
    }
    if (best < 0) return
    // 表头明确写了「单位」，即使单元格是「单位+职务」混排也优先按单位列处理
    const need =
      role === 'unit' && headerHint(base[best].label, 'unit') > 0 ? 0.4 : 0.5
    if (bestScore < need) return
    taken.add(best)
    const col = columns[best]
    col.role = role
    col.score = bestScore
    const others = ROLE_LIST.filter((r) => r !== role).map((r) => base[best].scores[r])
    const margin = bestScore - Math.max(0, ...others)
    col.confidence = bestScore >= 0.75 && margin >= 0.2 ? 'high' : 'mid'
    col.evidence = headerHint(base[best].label, role) > 0 ? '表头 + 内容特征' : '内容特征'
  }

  assign('name')
  assign('unit')
  assign('rank')
  assign('duty')

  // 备注不独占：电话、说明等多列都可以落到备注
  for (const c of base) {
    if (taken.has(c.index)) continue
    if (c.scores.note >= 0.5 || headerHint(c.label, 'note') > 0) {
      taken.add(c.index)
      const col = columns[c.index]
      col.role = 'note'
      col.score = c.scores.note
      col.confidence = c.scores.note >= 0.75 ? 'high' : 'mid'
      col.evidence = headerHint(c.label, 'note') > 0 ? '表头 + 内容特征' : '内容特征'
    }
  }

  return columns
}

export interface BuildOptions {
  /** 用户手动指定的列角色（下标对应列，未指定为 undefined） */
  roles?: (ImportField | 'ignore')[]
  /** true = 首行强制作表头；false = 强制无表头；缺省按自动探测 */
  forceHeader?: boolean
}

/** 读取完原始表后做表头探测 + 列角色推断 */
export function buildAnalysis(
  raw: RawSheet,
  units: UnitNode[],
  ranks: RankDef[],
  options: BuildOptions = {}
): AdaptiveSheet {
  const cleaned = raw.rows.map((r) => r.map(cleanCell)).filter((r) => r.some((c) => c.length > 0))
  if (!cleaned.length) throw new Error('文件中没有可读取的数据行')
  const width = Math.max(1, ...cleaned.map((r) => r.length))
  const rows = cleaned.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''))
  let headerIndex = detectHeaderRow(rows)
  if (options.forceHeader === true) headerIndex = 0
  else if (options.forceHeader === false) headerIndex = -1
  const hasHeader = headerIndex >= 0
  const headerLabels = hasHeader
    ? rows[headerIndex].map((c, i) => c || `第 ${i + 1} 列`)
    : Array.from({ length: width }, (_, i) => `第 ${i + 1} 列`)
  const dataRows = hasHeader ? rows.slice(headerIndex + 1) : rows
  const columns = inferColumns(headerLabels, dataRows, units, ranks)

  const roles = options.roles
  if (roles) {
    columns.forEach((col, i) => {
      const role = roles[i]
      if (!role || role === col.role) return
      col.role = role
      col.score = 1
      col.confidence = 'high'
      col.evidence = '手动指定'
    })
  }

  return {
    sourceName: raw.sourceName,
    sheetName: raw.sheetName,
    warnings: raw.warnings,
    hasHeader,
    headerIndex,
    headerLabels,
    dataRows,
    columns,
    nameColumn: columns.findIndex((c) => c.role === 'name')
  }
}
