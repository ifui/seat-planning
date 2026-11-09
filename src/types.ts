// ---------- 名册与组织 ----------

export interface RankDef {
  id: string
  name: string
  shortName?: string
  order: number
  color: string
}

export interface UnitNode {
  id: string
  name: string
  parentId: string | null
  order: number
  code?: string
}

export interface Member {
  id: string
  name: string
  unitId: string
  rankId: string
  aliases: string[]
  gender?: 'M' | 'F'
  note?: string
  active: boolean
}

export interface RosterPlan {
  id: string
  name: string
  ranks: RankDef[]
  units: UnitNode[]
  members: Member[]
  createdAt: string
  updatedAt: string
}

// ---------- 布局 ----------

export type ElementType = 'table' | 'hostTable' | 'podium' | 'lectern' | 'aisle' | 'zone' | 'label' | 'shape'
export type ShapeKind = 'rect' | 'square' | 'circle' | 'diamond' | 'triangle'

export interface Seat {
  id: string
  index: number
  x: number
  y: number
  w: number
  h: number
  disabled?: boolean
}

export interface ElementStyle {
  fill?: string
  stroke?: string
  radius?: number
  opacity?: number
  textColor?: string
  /** 文字字体族（存完整 CSS font-family 栈，便于离线使用系统字体） */
  fontFamily?: string
  /** 文字字号（px） */
  fontSize?: number
  /** 文字字重 300/400/500/600/700 */
  fontWeight?: number
  /** 文字水平对齐 */
  textAlign?: 'left' | 'center' | 'right'
}

/** 元素在网格单元内的对齐方式：fill 铺满、center 居中、start/end 靠左/靠右（靠上/靠下） */
export type GridAlign = 'fill' | 'center' | 'start' | 'end'

/** 元素在网格中的归属：锚点行列 + 跨格数 */
export interface CellRef {
  /** 行号，0 起 */
  row: number
  /** 列号，0 起 */
  col: number
  /** 纵向跨几格，默认 1 */
  rowSpan?: number
  /** 横向跨几格，默认 1 */
  colSpan?: number
}

/**
 * 布局网格：先定行列，元素放进格子。
 * 排/列号由格子自身决定，排座直接读行列号，不再从坐标反推。
 */
export interface GridConfig {
  rows: number
  cols: number
  colWidth: number
  rowHeight: number
  /** 单列覆写宽度（长度 = cols，缺省用 colWidth） */
  colWidths?: number[]
  /** 单行覆写高度（长度 = rows，缺省用 rowHeight） */
  rowHeights?: number[]
  originX: number
  originY: number
  /** 元素入格后四周留白 */
  padding: number
  /** 合并单元格：锚点 + 跨度；被合并区域按一个格子处理 */
  merges: CellRef[]
}

export interface BaseElement {
  id: string
  type: ElementType
  x: number
  y: number
  w: number
  h: number
  rotation?: number
  z?: number
  locked?: boolean
  /** 所属图层分组 id，为空表示未分组 */
  groupId?: string
  style?: ElementStyle
  /** 画布上直接显示的文字（讲解台、标注、区域、图形） */
  text?: string
  /** 图形元素的形状，仅 type === 'shape' 时有效 */
  shape?: ShapeKind
  /** 所属网格单元；为空表示游离元素（不参与网格排号，仍按坐标排） */
  cell?: CellRef
  /** 入格后在单元内的对齐方式，默认 fill */
  align?: GridAlign
  /** 入格后单元格留白，覆盖网格默认 padding */
  pad?: number
}

export interface SeatingElement extends BaseElement {
  type: 'table' | 'hostTable' | 'lectern'
  capacity: 1 | 2
  seats: Seat[]
  zoneId?: string
  label?: string
  arrangeMode?: 'podium' | 'normal'
}

export interface ZoneDef {
  id: string
  name: string
  color: string
  ruleTag?: 'podium' | 'front' | 'vip' | 'staff' | 'other'
}

export interface CanvasConfig {
  width: number
  height: number
  background: string
  /** 旧版栅格配置，仅为兼容已保存/导入的布局包，画布不再渲染栅格 */
  grid?: { size: number; visible: boolean }
}

/** 图层分组：成员通过 BaseElement.groupId 关联 */
export interface LayerGroup {
  id: string
  name: string
  /** 图层列表中是否折叠 */
  collapsed?: boolean
  /** 锁定分组等同锁定组内全部元素 */
  locked?: boolean
}

export interface LayoutPackage {
  schemaVersion: '1.0'
  id: string
  name: string
  canvas: CanvasConfig
  zones: ZoneDef[]
  elements: BaseElement[]
  groups?: LayerGroup[]
  /** 布局网格；为空表示自由布局（旧数据即此形态） */
  grid?: GridConfig
  createdAt: string
  updatedAt: string
}

export function isSeatingElement(e: BaseElement): e is SeatingElement {
  return e.type === 'table' || e.type === 'hostTable' || e.type === 'lectern'
}

export function isShapeElement(e: BaseElement): e is BaseElement & { type: 'shape'; shape: ShapeKind } {
  return e.type === 'shape'
}

/** 支持就地编辑文字的元素类型 */
export function hasEditableText(e: BaseElement): boolean {
  return e.type === 'label' || e.type === 'podium' || e.type === 'zone' || e.type === 'shape' || e.type === 'aisle'
}

/** 元素显示的文案（图形/标注用 text，区域用 name，其余用 label） */
export function elementText(e: BaseElement): string {
  const any = e as any
  return any.text ?? any.label ?? any.name ?? ''
}

// ---------- 规则与项目 ----------

export type AttendStatus = 'present' | 'leave' | 'absent' | 'guest'

export interface Assignment {
  seatId: string
  memberId: string
  status: AttendStatus
  locked: boolean
  note?: string
}

export interface TierRule {
  id: string
  /** row：按台下排号（1 起）；zone：按区域 */
  by: 'row' | 'zone'
  from?: number
  to?: number
  zoneId?: string
  rankIds: string[]
}

export interface RuleSet {
  /** 主席台奇偶处理：偶数时 1 号居中偏左（就座者视角） */
  evenCenterSide: 'left' | 'right'
  /** 主席台人员请假时：留空位 / 后续前移补位 */
  podiumLeave: 'hold' | 'shift'
  /** 台下横向填充方向 */
  hallOrder: 'center-out' | 'left-to-right' | 'right-to-left'
  /** 视角：观众视角（默认）从左往右；主席台视角左右镜像，读数时换算 */
  viewpoint: 'audience' | 'podium'
  /** 单位在座位上的分布：连续 / 交替穿插 */
  unitOrder: 'continuous' | 'interleave'
  /** 每排/区域职级分层 */
  tiers: TierRule[]
  /** 同一职级内是否按名单顺序 */
  keepListOrder: boolean
}

export interface Project {
  id: string
  name: string
  rosterPlanId: string
  layoutPackageId: string
  ruleSet: RuleSet
  assignments: Assignment[]
  /** 本项目的参会名单（不填则默认全名册在位人员） */
  participantIds: string[]
  /** 名单中未安排座位的人员（含库外新建/忽略决定） */
  unassigned: string[]
  /** Excel 导入后待确认的库外姓名 */
  pendingNames: string[]
  status: 'draft' | 'seated'
  createdAt: string
  updatedAt: string
}

export interface Snapshot {
  id: string
  projectId: string
  createdAt: string
  label: string
  assignments: Assignment[]
}

export const DEFAULT_RULESET: RuleSet = {
  evenCenterSide: 'left',
  podiumLeave: 'hold',
  hallOrder: 'center-out',
  viewpoint: 'audience',
  unitOrder: 'continuous',
  tiers: [],
  keepListOrder: true
}
