/**
 * 导入名单自适应解析（P0 证据层 + P1 别名 / 人工分配）。
 *
 * 口径见 docs/roster-import-adaptive.md：
 * - 表头在前 8 个非空行里探测，找不到就按内容推断；
 * - 列角色用「表头线索 + 内容特征」打分，分已识别 / 推测 / 待确认三档；
 * - 混排单元格先按分隔符分块，块内逐字符词典最长匹配 + 动态规划；
 * - 分隔符只加一点分，`/ \ > —` 不作切分点，`，、` 与空格两侧都成词才作边界；
 * - 片段按序拼接必须逐字还原原串，拼不回整行阻断；
 * - 多解保留前三候选，领先 ≥ 0.15 才采用并标「推测」；
 * - 职级只做归一，认不出不新建，交人工映射或显式新建。
 */
import type { RankDef, UnitNode } from '../types'
import type { RawSheet } from './rosterImport'
import { nameKey, resolveUnit, splitUnitPath, unitPathOf } from './unitMatch'

export type ImportField = 'name' | 'unit' | 'rank' | 'duty' | 'note'
export type CellField = ImportField | 'unresolved'
export type Confidence = 'high' | 'mid' | 'low'
export type RowStatus = 'ok' | 'guess' | 'review' | 'ignored'
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

export interface CellPart {
  field: CellField
  /** 原文片段（含边界分隔符），回拼校验用 */
  text: string
  /** 展示与落库用的值（去掉分隔符） */
  value: string
  evidence: string
  origin: 'rule' | 'unit-tree' | 'alias' | 'user'
  confidence: Confidence
  unitId?: string
  rankId?: string
  rankKind?: RankMatchKind
  target?: string
}

export interface SplitOption {
  parts: CellPart[]
  score: number
}

export interface ColumnRole {
  index: number
  label: string
  role: ImportField | 'ignore'
  confidence: Confidence
  score: number
  extras: ImportField[]
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

export interface RowCellAnalysis {
  column: number
  role: ImportField
  raw: string
  options: SplitOption[]
  choice: number
}

export interface AdaptiveRow {
  line: number
  cells: RowCellAnalysis[]
  parts: CellPart[]
  name: string
  unit: string
  rankText: string
  rankId: string
  rankKind: RankMatchKind
  duty: string
  note: string
  unresolved: string[]
  multiUnit: boolean
  hierarchyUp: boolean
  ambiguous: boolean
  reconstructFail: boolean
  /** 从文件解析出的原始单位 / 职级文本，用于判断别名回写 */
  originalUnit: string
  originalRank: string
  issues: string[]
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

const LEVEL_WORDS: { level: number; words: string[] }[] = [
  { level: 1, words: ['总局', '部', '委', '办'] },
  { level: 2, words: ['分局', '厅', '局', '委员会', '管委会'] },
  { level: 3, words: ['中心', '处', '室', '站', '所', '队', '院', '校'] },
  { level: 4, words: ['科', '股', '组'] },
  { level: 5, words: ['项目部', '公司', '集团', '车间', '街道', '镇', '乡'] }
]

/** 机构层级：办公室 / 委员会 / 管委会 算后缀但不占固定层级 */
function levelOf(text: string): number | null {
  const s = cleanCell(text)
  if (!s) return null
  if (/(办公室|委员会|管委会)$/.test(s)) return null
  let best = ''
  for (const g of LEVEL_WORDS) {
    for (const w of g.words) if (s.endsWith(w) && w.length > best.length) best = w
  }
  if (!best) return null
  for (const g of LEVEL_WORDS) if (g.words.includes(best)) return g.level
  return null
}

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

/**
 * 整串只是职务 / 职级化职务，而不是「单位 + 职务」连写。
 * 「省厅人事处主任科员」结尾虽是主任科员，但前缀是单位，必须继续切分。
 */
function isPureDutyText(text: string): boolean {
  const s = cleanCell(text)
  if (!s) return false
  if (isDutyWord(s)) return true
  if (!isRankLikeDuty(s)) return false
  let word = ''
  for (const w of DUTY_SPECIAL) if (s.endsWith(w) && w.length > word.length) word = w
  const prefix = s.slice(0, s.length - word.length)
  return !prefix || !hasUnitSuffix(prefix)
}

/** 取串尾最长的职务词 */
function dutySuffix(text: string): string {
  const s = cleanCell(text)
  let best = ''
  for (const w of ALL_DUTY) if (s.endsWith(w) && w.length > best.length) best = w
  return best
}

const SURNAMES =
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'

function isSurname(ch: string): boolean {
  return !!ch && SURNAMES.includes(ch)
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
  if (CHINESE_NAME_RE.test(s)) return true
  return LATIN_NAME_RE.test(s)
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

/** 职级名可接受的规则变体（正科 / 科级正职 / 乡科级正职 …） */
function rankVariants(name: string): string[] {
  const n = cleanCell(name).replace(/\s+/g, '')
  const out = new Set<string>()
  const m = n.match(/^([正副])([科处局厅部])级$/)
  if (m) {
    out.add(`${m[1]}${m[2]}`)
    out.add(`${m[2]}级${m[1] === '正' ? '正职' : '副职'}`)
    const syn = RANK_LEVEL_SYNONYM[m[2]]
    if (syn) out.add(`${syn}${m[1] === '正' ? '正职' : '副职'}`)
  }
  out.delete(n)
  return [...out]
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
    extras: [],
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
    const hinted = ROLE_LIST.filter((r) => r !== role && headerHint(base[best].label, r) > 0)
    col.extras = hinted.slice(0, 2)
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
  const headerIndex = detectHeaderRow(rows)
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

// ---------------------------------------------------------------- 词典

interface DictWord {
  text: string
  field: 'unit' | 'rank' | 'duty' | 'org'
  score: number
  evidence: string
  origin: 'rule' | 'unit-tree' | 'alias'
  unitId?: string
  rankId?: string
  rankKind?: RankMatchKind
  target?: string
  levels?: (number | null)[]
}

function unitPathSegments(units: UnitNode[], id: string): string[] {
  const byId = new Map(units.map((u) => [u.id, u]))
  const out: string[] = []
  let cur = byId.get(id)
  let guard = 0
  while (cur && guard++ < 50) {
    out.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out
}

function buildDict(units: UnitNode[], ranks: RankDef[]): DictWord[] {
  const map = new Map<string, DictWord>()
  const put = (w: DictWord): void => {
    const cur = map.get(w.text)
    if (!cur || w.score > cur.score) map.set(w.text, w)
  }

  for (const u of units) {
    const segs = unitPathSegments(units, u.id)
    const path = unitPathOf(units, u.id)
    const levels = segs.map(levelOf)
    if (segs.length > 1) {
      put({
        text: segs.join(''),
        field: 'unit',
        score: 1,
        evidence: `单位树：${path}`,
        origin: 'unit-tree',
        unitId: u.id,
        target: path,
        levels
      })
      put({
        text: segs.join('/'),
        field: 'unit',
        score: 1,
        evidence: `单位树：${path}`,
        origin: 'unit-tree',
        unitId: u.id,
        target: path,
        levels
      })
    }
    put({
      text: cleanCell(u.name),
      field: 'unit',
      score: 0.95,
      evidence: `单位树：${path}`,
      origin: 'unit-tree',
      unitId: u.id,
      target: path,
      levels: [levelOf(u.name)]
    })
    for (const a of u.aliases ?? []) {
      const t = cleanCell(a)
      if (!t) continue
      put({
        text: t,
        field: 'unit',
        score: 0.95,
        evidence: `单位别名：${t} → ${path}`,
        origin: 'alias',
        unitId: u.id,
        target: path,
        levels: [levelOf(u.name)]
      })
    }
  }

  for (const r of ranks) {
    put({
      text: cleanCell(r.name),
      field: 'rank',
      score: 0.9,
      evidence: `职级：${r.name}`,
      origin: 'rule',
      rankId: r.id,
      rankKind: 'exact',
      target: r.name
    })
    for (const a of r.aliases ?? []) {
      const t = cleanCell(a)
      if (!t) continue
      put({
        text: t,
        field: 'rank',
        score: 0.9,
        evidence: `职级别名：${t} → ${r.name}`,
        origin: 'alias',
        rankId: r.id,
        rankKind: 'alias',
        target: r.name
      })
    }
    for (const v of rankVariants(r.name)) {
      put({
        text: v,
        field: 'rank',
        score: 0.88,
        evidence: `规则：${v} → ${r.name}`,
        origin: 'rule',
        rankId: r.id,
        rankKind: 'rule',
        target: r.name
      })
    }
  }

  const rankTexts = new Set([...map.values()].filter((w) => w.field === 'rank').map((w) => w.text))
  for (const w of [...DUTY_POSITIVE, ...DUTY_SPECIAL, ...DUTY_GENERIC]) {
    if (rankTexts.has(w)) continue
    put({ text: w, field: 'duty', score: 0.8, evidence: '职务词', origin: 'rule' })
    if (DUTY_POSITIVE.includes(w)) {
      const v = `副${w}`
      if (!rankTexts.has(v)) put({ text: v, field: 'duty', score: 0.8, evidence: '职务词（副职）', origin: 'rule' })
    }
  }
  for (const g of LEVEL_WORDS) {
    for (const w of g.words) put({ text: w, field: 'org', score: 0.6, evidence: '机构层级词', origin: 'rule' })
  }

  return [...map.values()].sort((a, b) => b.text.length - a.text.length)
}

// ---------------------------------------------------------------- 逐字符 DP

interface Token {
  start: number
  end: number
  kind: 'unit' | 'rank' | 'duty' | 'org' | 'name' | 'gap' | 'note'
  score: number
  text: string
  value: string
  evidence: string
  origin: 'rule' | 'unit-tree' | 'alias'
  confidence: Confidence
  unitId?: string
  rankId?: string
  rankKind?: RankMatchKind
  target?: string
  levels?: (number | null)[]
}

const BLOCK_SEP_RE = /[\s，,、;；|]/
const CONNECT_RE = /[\/\\>＞›〉→\-—–]/

function wordToken(w: DictWord, start: number): Token {
  const confidence: Confidence =
    w.field === 'unit' ? 'high' : w.field === 'rank' ? (w.rankKind === 'rule' ? 'mid' : 'high') : w.field === 'duty' ? 'high' : 'low'
  return {
    start,
    end: start + w.text.length,
    kind: w.field,
    score: w.score,
    text: w.text,
    value: w.text,
    evidence: w.evidence,
    origin: w.origin,
    confidence,
    unitId: w.unitId,
    rankId: w.rankId,
    rankKind: w.rankKind,
    target: w.target,
    levels: w.levels
  }
}

/** 括号内容先摘出：先判职级，再判单位，再判职务，其余归备注 */
function bracketToken(text: string, i: number, units: UnitNode[], ranks: RankDef[]): Token | null {
  const ch = text[i]
  if (ch !== '（' && ch !== '(') return null
  const close = ch === '（' ? '）' : ')'
  const j = text.indexOf(close, i + 1)
  if (j <= i + 1) return null
  const inner = cleanCell(text.slice(i + 1, j))
  const full = text.slice(i, j + 1)
  const m = matchRank(ranks, inner)
  if (m.rankId)
    return {
      start: i,
      end: j + 1,
      kind: 'rank',
      score: 0.92,
      text: full,
      value: inner,
      evidence: `括号内职级：${inner}`,
      origin: 'rule',
      confidence: m.kind === 'exact' ? 'high' : 'mid',
      rankId: m.rankId,
      rankKind: m.kind,
      target: m.target
    }
  const unit = resolveUnit(units, inner)
  if (unit.kind === 'existing')
    return {
      start: i,
      end: j + 1,
      kind: 'unit',
      score: 0.9,
      text: full,
      value: inner,
      evidence: `括号内单位：${unit.path}`,
      origin: 'unit-tree',
      confidence: 'high',
      unitId: unit.unitId
    }
  if (inner && hasUnitSuffix(inner) && !dutySuffix(inner))
    return {
      start: i,
      end: j + 1,
      kind: 'unit',
      score: 0.7,
      text: full,
      value: inner,
      evidence: '括号内单位后缀',
      origin: 'rule',
      confidence: 'low'
    }
  if (inner && (isDutyWord(inner) || isRankLikeDuty(inner)))
    return {
      start: i,
      end: j + 1,
      kind: 'duty',
      score: 0.8,
      text: full,
      value: inner,
      evidence: '括号内职务',
      origin: 'rule',
      confidence: 'high'
    }
  return {
    start: i,
    end: j + 1,
    kind: 'note',
    score: 0.1,
    text: full,
    value: inner,
    evidence: '括号补充',
    origin: 'rule',
    confidence: 'mid'
  }
}

function gapToken(text: string, i: number): Token {
  const ch = text[i]
  return {
    start: i,
    end: i + 1,
    kind: 'gap',
    score: CONNECT_RE.test(ch) ? -0.02 : -0.5,
    text: ch,
    value: /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch) ? ch : '',
    evidence: '未归类',
    origin: 'rule',
    confidence: 'low'
  }
}

/** 合并未归类片段：紧邻机构后缀的并入单位候选，连续 gap 合成一段 */
function tidyTokens(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const tk of tokens) {
    const prev = out[out.length - 1]
    if (tk.kind === 'org' && prev && prev.kind === 'gap' && prev.end === tk.start && /^[\u4e00-\u9fa5]{1,6}$/.test(prev.text)) {
      out[out.length - 1] = {
        start: prev.start,
        end: tk.end,
        kind: 'unit',
        score: prev.score + tk.score,
        text: prev.text + tk.text,
        value: prev.text + tk.text,
        evidence: '机构后缀',
        origin: 'rule',
        confidence: 'mid'
      }
      continue
    }
    const digitGap =
      prev && prev.kind === 'gap' && prev.end === tk.start && /^[一二三四五六七八九十百0-9]+级?$/.test(prev.text)
    if (digitGap && tk.kind === 'rank') {
      // 「四级」+「主任科员」→ 整段职级原文，丢掉单段匹配才能交人工决定
      out[out.length - 1] = {
        start: prev.start,
        end: tk.end,
        kind: 'rank',
        score: prev.score + tk.score,
        text: prev.text + tk.text,
        value: prev.text + tk.text,
        evidence: '职级层级',
        origin: 'rule',
        confidence: 'mid',
        rankKind: 'unknown'
      }
      continue
    }
    if (digitGap && tk.kind === 'duty' && isRankLikeDuty(tk.text)) {
      out[out.length - 1] = {
        start: prev.start,
        end: tk.end,
        kind: 'duty',
        score: prev.score + tk.score,
        text: prev.text + tk.text,
        value: prev.text + tk.text,
        evidence: '职级化职务',
        origin: 'rule',
        confidence: 'high'
      }
      continue
    }
    if (tk.kind === 'gap' && prev && prev.kind === 'gap' && prev.end === tk.start) {
      out[out.length - 1] = {
        ...prev,
        end: tk.end,
        text: prev.text + tk.text,
        score: prev.score + tk.score,
        value: /[\u4e00-\u9fa5A-Za-z0-9]/.test(prev.text + tk.text) ? prev.text + tk.text : ''
      }
      continue
    }
    // 没有前缀的完整机构词（办公室 / 秘书科 / 委员会）本身就是单位候选
    if (tk.kind === 'org' && tk.text.length >= 2) {
      out.push({
        ...tk,
        kind: 'unit',
        evidence: '机构名',
        confidence: 'mid'
      })
      continue
    }
    out.push(tk)
  }
  return out
}

function toPart(tk: Token): CellPart {
  const field: CellField = tk.kind === 'gap' || tk.kind === 'org' ? 'unresolved' : tk.kind
  return {
    field,
    text: tk.text,
    value: tk.value,
    evidence: tk.evidence,
    origin: tk.origin,
    confidence: tk.confidence,
    unitId: tk.unitId,
    rankId: tk.rankId,
    rankKind: tk.rankKind,
    target: tk.target
  }
}

interface Step {
  pos: number
  score: number
  tokens: Token[]
  usedName: boolean
  usedRank: boolean
  usedDuty: boolean
  last: Token['kind'] | ''
  lastLevel: number | null
}

function pruneSteps(list: Step[]): Step[] {
  if (list.length <= 1) return list
  const byKey = new Map<string, Step[]>()
  for (const st of list) {
    const key = `${st.usedName ? 1 : 0}${st.usedRank ? 1 : 0}${st.usedDuty ? 1 : 0}|${st.last}|${st.lastLevel ?? ''}`
    const arr = byKey.get(key)
    if (arr) arr.push(st)
    else byKey.set(key, [st])
  }
  const out: Step[] = []
  for (const arr of byKey.values()) {
    arr.sort((a, b) => b.score - a.score)
    out.push(...arr.slice(0, 3))
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 36)
}

interface SplitCtx {
  dict: DictWord[]
  units: UnitNode[]
  ranks: RankDef[]
  /** 已单独指定姓名列时，其余单元格不再猜姓名，避免「卫生健」被当成姓名 */
  hasName: boolean
}

/** 单块文本的 k-best DP：逐字符推进，词典最长匹配 + 约束 + 语境加分 */
function dpBlock(text: string, ctx: SplitCtx, allowName: boolean, nameHigh: boolean): SplitOption[] {
  const n = text.length
  if (!n) return []
  const tokensAt: Token[][] = Array.from({ length: n }, () => [])

  for (let i = 0; i < n; i++) {
    for (const w of ctx.dict) {
      if (w.text && text.startsWith(w.text, i)) tokensAt[i].push(wordToken(w, i))
    }
    const br = bracketToken(text, i, ctx.units, ctx.ranks)
    if (br) tokensAt[i].push(br)
    if (allowName && isSurname(text[i])) {
      let len = 1
      while (len < 3 && i + len < n && /[\u4e00-\u9fa5]/.test(text[i + len])) len++
      for (let L = len; L >= 1; L--) {
        const seg = text.slice(i, i + L)
        tokensAt[i].push({
          start: i,
          end: i + L,
          kind: 'name',
          score: (L === 1 ? 0.35 : L === 2 ? 0.5 : 0.45) + (nameHigh ? 0.1 : 0),
          text: seg,
          value: seg,
          evidence: '姓氏',
          origin: 'rule',
          confidence: L >= 2 ? (nameHigh ? 'high' : 'mid') : 'low'
        })
      }
    }
    tokensAt[i].push(gapToken(text, i))
  }

  // 已知词内部不能有边界（主任科员 / 调研员 等整词不被切开）
  const blocked: boolean[] = new Array(n + 1).fill(false)
  for (let i = 0; i < n; i++) {
    for (const tk of tokensAt[i]) {
      if ((tk.kind === 'unit' || tk.kind === 'rank' || tk.kind === 'duty') && tk.end - tk.start >= 3) {
        for (let p = tk.start + 1; p < tk.end; p++) blocked[p] = true
      }
    }
  }
  for (let i = 0; i < n; i++) {
    tokensAt[i] = tokensAt[i].filter((tk) => {
      if (tk.kind === 'gap') return !blocked[i]
      return !blocked[tk.start] && !blocked[tk.end]
    })
  }

  const buckets: Step[][] = Array.from({ length: n + 1 }, () => [])
  buckets[0].push({ pos: 0, score: 0, tokens: [], usedName: false, usedRank: false, usedDuty: false, last: '', lastLevel: null })

  for (let pos = 0; pos < n; pos++) {
    const list = pruneSteps(buckets[pos])
    buckets[pos] = list
    if (!list.length) continue
    for (const st of list) {
      for (const tk of tokensAt[pos]) {
        if (tk.kind === 'name' && st.usedName) continue
        if (tk.kind === 'rank' && st.usedRank) continue
        if (tk.kind === 'duty' && st.usedDuty) continue
        if (tk.kind === 'unit' && st.last === 'duty') continue
        let score = st.score + tk.score
        let lastLevel = st.lastLevel
        if (tk.kind === 'unit') {
          const lv = tk.levels ? [...tk.levels].reverse().find((x) => x != null) ?? null : null
          if (lv != null) {
            if (st.lastLevel != null) score += lv >= st.lastLevel ? 0.1 : -0.5
            lastLevel = lv
          }
          if (tk.end === n && ORG_SUFFIX_RE.test(tk.text)) score += 0.2
        }
        if (tk.kind === 'duty' && st.last === 'unit') score += 0.1
        if (tk.kind !== 'gap' && tk.start > 0 && CONNECT_RE.test(text[tk.start - 1])) score += 0.05
        buckets[tk.end].push({
          pos: tk.end,
          score,
          tokens: [...st.tokens, tk],
          usedName: st.usedName || tk.kind === 'name',
          usedRank: st.usedRank || tk.kind === 'rank',
          usedDuty: st.usedDuty || tk.kind === 'duty',
          last: tk.kind,
          lastLevel
        })
      }
    }
  }

  const finals = buckets[n].slice().sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  const options: SplitOption[] = []
  for (const st of finals) {
    const merged = tidyTokens(st.tokens)
    const sig = merged.map((t) => `${t.kind}:${t.text}`).join('|')
    if (seen.has(sig)) continue
    seen.add(sig)
    options.push({ parts: merged.map(toPart), score: st.score })
    if (options.length >= 3) break
  }
  if (!options.length)
    return [
      {
        parts: [
          {
            field: 'unresolved',
            text,
            value: text,
            evidence: '未归类',
            origin: 'rule',
            confidence: 'low'
          }
        ],
        score: 0
      }
    ]
  return options
}

interface Segment {
  kind: 'block' | 'sep'
  text: string
}

/** 分隔符只分块，不决定切分；`/ \ > —` 留在块内交给路径与层级解析 */
function splitSegments(text: string): Segment[] {
  const out: Segment[] = []
  let buf = ''
  for (const ch of text) {
    if (BLOCK_SEP_RE.test(ch)) {
      if (buf) {
        out.push({ kind: 'block', text: buf })
        buf = ''
      }
      const last = out[out.length - 1]
      if (last && last.kind === 'sep') last.text += ch
      else out.push({ kind: 'sep', text: ch })
    } else {
      buf += ch
    }
  }
  if (buf) out.push({ kind: 'block', text: buf })
  return out
}

function optionSignature(opt: SplitOption): string {
  return opt.parts.map((p) => `${p.field}:${p.text}`).join('|')
}

function splitCell(text: string, ctx: SplitCtx, allowName: boolean, nameHigh: boolean): SplitOption[] {
  const segments = splitSegments(text)
  let combos: SplitOption[] = [{ parts: [], score: 0 }]
  let leading = ''

  for (const seg of segments) {
    if (seg.kind === 'sep') {
      if (combos.length && combos[0].parts.length) {
        combos = combos.map((c) => {
          const parts = [...c.parts]
          const last = { ...parts[parts.length - 1] }
          last.text = last.text + seg.text
          parts[parts.length - 1] = last
          return { parts, score: c.score + 0.05 }
        })
      } else {
        leading += seg.text
      }
      continue
    }
    const opts = dpBlock(seg.text, ctx, allowName, nameHigh)
    const next: SplitOption[] = []
    for (const combo of combos) {
      for (const opt of opts) {
        next.push({ parts: [...combo.parts, ...opt.parts], score: combo.score + opt.score })
      }
    }
    next.sort((a, b) => b.score - a.score)
    const seen = new Set<string>()
    combos = []
    for (const opt of next) {
      const sig = optionSignature(opt)
      if (seen.has(sig)) continue
      seen.add(sig)
      combos.push(opt)
      if (combos.length >= 3) break
    }
  }

  if (leading) {
    combos = combos.map((c) => {
      if (!c.parts.length) return c
      const parts = [...c.parts]
      parts[0] = { ...parts[0], text: leading + parts[0].text }
      return { ...c, parts }
    })
  }
  return combos.length
    ? combos
    : [
        {
          parts: [{ field: 'unresolved', text, value: text, evidence: '未归类', origin: 'rule', confidence: 'low' }],
          score: 0
        }
      ]
}

// ---------------------------------------------------------------- 单元格归类

function singlePart(
  field: CellField,
  text: string,
  value: string,
  evidence: string,
  confidence: Confidence
): SplitOption {
  return { parts: [{ field, text, value, evidence, origin: 'rule', confidence }], score: 5 }
}

/** 直接当单位用的条件：整格就是一个单位 / 路径，没有职务词、没有分块分隔符 */
function directUnitPart(raw: string, units: UnitNode[]): CellPart | null {
  const s = cleanCell(raw)
  if (!s) return null
  if (/[\s，,、;；|]/.test(s)) return null
  if (dutySuffix(s) && !hasUnitSuffix(s)) return null
  const res = resolveUnit(units, s)
  if (res.kind === 'existing')
    return {
      field: 'unit',
      text: s,
      value: s,
      evidence: `命中单位：${res.path}`,
      origin: 'unit-tree',
      confidence: 'high',
      unitId: res.unitId
    }
  const segs = splitUnitPath(s)
  const pathLike = segs.length > 1 || /[\/\\>＞›〉→—–]/.test(s)
  if (pathLike && segs.length > 1 && segs.every((x) => hasUnitSuffix(x) && !dutySuffix(x)))
    return { field: 'unit', text: s, value: s, evidence: '单位路径', origin: 'rule', confidence: 'mid' }
  if (!pathLike && hasUnitSuffix(s) && !dutySuffix(s))
    return { field: 'unit', text: s, value: s, evidence: '机构后缀', origin: 'rule', confidence: 'mid' }
  return null
}

function analyzeCellForRole(raw: string, role: ImportField, ctx: SplitCtx): SplitOption[] {
  if (role === 'note') return [singlePart('note', raw, raw, '备注列', 'high')]

  if (role === 'name') {
    if (isCleanName(raw)) return [singlePart('name', raw, raw, '姓名列', 'high')]
    return splitCell(raw, ctx, true, true)
  }

  if (role === 'unit') {
    const p = directUnitPart(raw, ctx.units)
    if (p) return [{ parts: [p], score: 5 }]
    return splitCell(raw, ctx, !ctx.hasName, false)
  }

  if (role === 'rank') {
    const m = matchRank(ctx.ranks, raw)
    if (m.rankId)
      return [
        {
          parts: [
            {
              field: 'rank',
              text: raw,
              value: raw,
              evidence: m.evidence,
              origin: m.kind === 'alias' ? 'alias' : 'rule',
              confidence: m.kind === 'exact' || m.kind === 'alias' ? 'high' : 'mid',
              rankId: m.rankId,
              rankKind: m.kind,
              target: m.target
            }
          ],
          score: 5
        }
      ]
    if (m.kind === 'duty-word' && isPureDutyText(raw))
      return [singlePart('duty', raw, raw, m.evidence, 'high')]
    const opts = splitCell(raw, ctx, !ctx.hasName, false)
    const useful = opts[0].parts.some((p) => p.field === 'rank' || p.field === 'unit' || p.field === 'duty')
    if (useful) return opts
    return [
      {
        parts: [
          {
            field: 'rank',
            text: raw,
            value: raw,
            evidence: m.evidence,
            origin: 'rule',
            confidence: 'low',
            rankKind: m.kind === 'suggest' ? 'suggest' : 'unknown'
          }
        ],
        score: 0
      }
    ]
  }

  // duty
  if (isPureDutyText(raw)) return [singlePart('duty', raw, raw, '职务列', 'high')]
  return splitCell(raw, ctx, !ctx.hasName, false)
}

// ---------------------------------------------------------------- 行组装

function ancestryOf(byId: Map<string, UnitNode>, id: string): string[] {
  const out: string[] = []
  let cur = byId.get(id)
  let guard = 0
  while (cur && guard++ < 50) {
    out.unshift(cur.id)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out
}

function checkHierarchy(text: string): boolean {
  const segs = splitUnitPath(text)
  if (segs.length < 2) return false
  let prev: number | null = null
  for (const seg of segs) {
    const lv = levelOf(seg)
    if (lv == null) continue
    if (prev != null && lv < prev) return true
    prev = lv
  }
  return false
}

function combineUnits(
  units: UnitNode[],
  parts: CellPart[]
): { text: string; multi: boolean; hierarchyUp: boolean } {
  if (!parts.length) return { text: '', multi: false, hierarchyUp: false }
  if (parts.length === 1) {
    return { text: parts[0].value, multi: false, hierarchyUp: checkHierarchy(parts[0].value) }
  }

  const byId = new Map(units.map((u) => [u.id, u]))
  const ids = parts.map((p) => p.unitId ?? '')
  if (ids.every(Boolean)) {
    const chains = ids.map((id) => ancestryOf(byId, id))
    let sameChain = true
    for (let i = 1; i < ids.length; i++) {
      if (!chains[i].includes(ids[i - 1]) && !chains[i - 1].includes(ids[i])) sameChain = false
    }
    if (sameChain) {
      const deepest = ids[ids.length - 1]
      return { text: unitPathOf(units, deepest), multi: false, hierarchyUp: false }
    }
  }

  let ascending = true
  for (let i = 1; i < parts.length; i++) {
    const a = levelOf(parts[i - 1].value)
    const b = levelOf(parts[i].value)
    if (a == null || b == null || b <= a) ascending = false
  }
  if (ascending) {
    return { text: parts.map((p) => p.value).join('/'), multi: false, hierarchyUp: false }
  }

  return { text: parts[0].value, multi: true, hierarchyUp: false }
}

function deriveFields(
  parts: CellPart[],
  units: UnitNode[],
  ranks: RankDef[]
): {
  name: string
  unit: string
  rankText: string
  rankId: string
  rankKind: RankMatchKind
  duty: string
  note: string
  unresolved: string[]
  multiUnit: boolean
  hierarchyUp: boolean
} {
  let name = ''
  let rankText = ''
  let rankId = ''
  let rankKind: RankMatchKind = 'empty'
  let duty = ''
  const notes: string[] = []
  const unresolved: string[] = []
  const unitParts: CellPart[] = []

  for (const p of parts) {
    if (p.field === 'name') {
      if (!name && p.value) name = p.value
    } else if (p.field === 'unit') {
      if (p.value) unitParts.push(p)
    } else if (p.field === 'rank') {
      if (rankId) continue
      if (p.rankId) {
        rankId = p.rankId
        rankText = p.target || p.value
        rankKind = p.rankKind ?? 'exact'
      } else if (!rankText) {
        // 数字层级合并出的整段职级不再拆开重匹配，交人工映射
        if (p.rankKind === 'unknown') {
          rankText = p.value
          rankKind = 'unknown'
          continue
        }
        const m = matchRank(ranks, p.value)
        if (m.rankId) {
          rankId = m.rankId
          rankText = m.target
          rankKind = m.kind
        } else {
          rankText = p.value
          rankKind = m.kind
        }
      }
    } else if (p.field === 'duty') {
      if (duty) continue
      // 主任科员 / 调研员 一类「职级化职务」按职级处理：能归一就归一，认不出则待确认
      if (isRankLikeDuty(p.value) && !rankId) {
        const m = matchRank(ranks, p.value)
        if (m.rankId) {
          rankId = m.rankId
          rankText = m.target
          rankKind = m.kind
        } else {
          rankText = p.value
          rankKind = 'unknown'
        }
      } else if (p.value) {
        duty = p.value
      }
    } else if (p.field === 'note') {
      if (p.value) notes.push(p.value)
    } else if (p.value) {
      unresolved.push(p.value)
    }
  }

  const merged = combineUnits(units, unitParts)
  return {
    name,
    unit: merged.text,
    rankText,
    rankId,
    rankKind,
    duty,
    note: notes.join('；'),
    unresolved,
    multiUnit: merged.multi,
    hierarchyUp: merged.hierarchyUp
  }
}

function buildIssues(row: AdaptiveRow): string[] {
  const out: string[] = []
  if (!row.name) out.push('缺少姓名，可手填或跳过该行')
  if (row.name.length === 1) out.push('姓名可能不完整，请补全或改选切法')
  if (row.reconstructFail) out.push('切分无法逐字拼回原文，已阻断该行')
  if (row.multiUnit) out.push(`一格出现多个单位：${row.unit}，请选择其一`)
  if (row.hierarchyUp) out.push('单位层级写反（由低到高），请确认')
  if (row.ambiguous) out.push('切分存在两种以上可能，请选择切法')
  if (row.rankKind === 'unknown') out.push(`职级未识别：${row.rankText}，请映射已有职级或显式新建`)
  if (row.rankKind === 'suggest') out.push(`职级「${row.rankText}」只找到相近写法，请手动确认`)
  if (row.rankKind === 'conflict') out.push(`职级「${row.rankText}」对应多个已有职级，请手动选择`)
  if (row.unresolved.length) out.push(`未归类文本：${row.unresolved.join('、')}`)
  return out
}

/** 三档状态：已识别 / 推测 / 待确认（忽略由界面单独处理） */
export function rowStatusOf(row: AdaptiveRow): RowStatus {
  if (!row.name) return 'review'
  if (row.reconstructFail || row.multiUnit || row.hierarchyUp) return 'review'
  if (row.rankKind === 'unknown' || row.rankKind === 'suggest' || row.rankKind === 'conflict') return 'review'
  if (row.ambiguous || row.unresolved.length) return 'review'
  // 空片段只是连接符（/ \ —— 等），不参与三档判定
  const parts = row.parts.filter((p) => p.value)
  // 存在多解但首选领先够大：仍是推断结果，标「推测」而非「已识别」
  const multiCut = row.cells.some((c) => c.options.length > 1)
  if (row.rankKind === 'rule' || row.rankKind === 'contains') return 'guess'
  if (multiCut) return 'guess'
  if (parts.some((p) => p.confidence === 'mid')) return 'guess'
  if (parts.some((p) => p.confidence === 'low')) return 'review'
  return 'ok'
}

/** 重新按当前选中的切法组装行字段 */
export function rebuildRow(row: AdaptiveRow, units: UnitNode[], ranks: RankDef[]): void {
  const parts: CellPart[] = []
  for (const cell of row.cells) {
    const opt = cell.options[cell.choice] ?? cell.options[0]
    if (opt) parts.push(...opt.parts)
  }
  row.parts = parts
  applyParts(row, units, ranks)
  row.ambiguous = row.cells.some((c) => {
    if (c.options.length < 2) return false
    return c.options[0].score - c.options[1].score < 0.15
  })
  row.reconstructFail = !row.cells.every((c) => {
    const opt = c.options[c.choice] ?? c.options[0]
    return !opt || opt.parts.map((p) => p.text).join('') === c.raw
  })
  row.issues = buildIssues(row)
}

/** 按当前 parts 重新推导字段（界面手动改片段 / 改行值后调用） */
export function applyParts(row: AdaptiveRow, units: UnitNode[], ranks: RankDef[]): void {
  const d = deriveFields(row.parts, units, ranks)
  row.name = d.name
  row.unit = d.unit
  row.rankText = d.rankText
  row.rankId = d.rankId
  row.rankKind = d.rankKind
  row.duty = d.duty
  row.note = d.note
  row.unresolved = d.unresolved
  row.multiUnit = d.multiUnit
  row.hierarchyUp = d.hierarchyUp
  row.issues = buildIssues(row)
}

/** 手动编辑行字段后刷新提示文案 */
export function refreshRowIssues(row: AdaptiveRow): void {
  row.issues = buildIssues(row)
}

/** 解析整个数据区 */
export function parseRows(sheet: AdaptiveSheet, units: UnitNode[], ranks: RankDef[]): AdaptiveRow[] {
  const active = sheet.columns.filter((c) => c.role !== 'ignore')
  const ctx: SplitCtx = {
    dict: buildDict(units, ranks),
    units,
    ranks,
    hasName: sheet.columns.some((c) => c.role === 'name')
  }
  const out: AdaptiveRow[] = []

  sheet.dataRows.forEach((cells, i) => {
    if (!active.some((c) => cleanCell(cells[c.index] ?? ''))) return
    const line = sheet.headerIndex >= 0 ? sheet.headerIndex + 2 + i : i + 1
    const rowCells: RowCellAnalysis[] = []
    for (const col of active) {
      const raw = cleanCell(cells[col.index] ?? '')
      if (!raw) continue
      rowCells.push({
        column: col.index,
        role: col.role as ImportField,
        raw,
        options: analyzeCellForRole(raw, col.role as ImportField, ctx),
        choice: 0
      })
    }
    if (!rowCells.length) return
    const row: AdaptiveRow = {
      line,
      cells: rowCells,
      parts: [],
      name: '',
      unit: '',
      rankText: '',
      rankId: '',
      rankKind: 'empty',
      duty: '',
      note: '',
      unresolved: [],
      multiUnit: false,
      hierarchyUp: false,
      ambiguous: false,
      reconstructFail: false,
      originalUnit: '',
      originalRank: '',
      issues: []
    }
    rebuildRow(row, units, ranks)
    row.originalUnit = row.unit
    row.originalRank = row.rankText
    out.push(row)
  })

  // 重名决策前移：文件内同名同单位在这里标出来
  const seen = new Map<string, number>()
  for (const row of out) {
    if (!row.name) continue
    const key = `${row.name}\u0000${row.unit}`
    const prev = seen.get(key)
    if (prev) row.issues.push(`与第 ${prev} 行同名同单位，导入时默认跳过`)
    else seen.set(key, row.line)
  }
  return out
}

/** 供界面判断别名回写时复用：单位输入是否命中已有实体 */
export function resolveUnitInput(units: UnitNode[], input: string): ReturnType<typeof resolveUnit> {
  return resolveUnit(units, input)
}

