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

// ---------- 表格化布局 ----------

/** 单元格类型：座位 / 主席台座位 / 特殊块（不坐人） */
export type CellKind = 'seat' | 'podium' | 'block'

/** 特殊块的用途，仅 kind === 'block' 时有效 */
export type BlockRole = 'aisle' | 'lectern' | 'backdrop' | 'label'

export interface CellStyle {
  fill?: string
  stroke?: string
  radius?: number
  textColor?: string
  fontSize?: number
  fontWeight?: number
  textAlign?: 'left' | 'center' | 'right'
}

/**
 * 单元格。单元格可以是「座位」（单人位/双人位），
 * 也可以是「特殊块」——合并后整块占位、不坐人（过道、讲台、背景板、标签）。
 */
export interface SheetCell {
  kind: CellKind
  /** kind === 'seat' | 'podium' 时：单人位 1 / 双人位 2 */
  seats?: 1 | 2
  /** 每个座位一个稳定 id，长度 = seats；排座分配按它引用，插删行列不会错位 */
  seatIds?: string[]
  /** 固定空位（保留但不能坐人） */
  disabled?: boolean
  /** 同桌编组：相邻同 tableId 的座位格绘制成连续桌带 */
  tableId?: string
  tableLabel?: string
  zoneId?: string
  /** kind === 'block' 时的用途 */
  role?: BlockRole
  /** 块内显示文字（讲台、背景板、标签） */
  text?: string
  style?: CellStyle
  /** 锁定：不再被批量填充/清空覆盖 */
  locked?: boolean
}

export interface MergeRange {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

/**
 * 工作表：行列先定，内容稀疏存在 cells 里。
 * 排号 = 行，座号 = 行内座位格顺序，均由格子自身决定。
 */
export interface Sheet {
  rows: number
  cols: number
  defaultColWidth: number
  defaultRowHeight: number
  /** 逐列宽度，长度 = cols */
  colWidths: number[]
  /** 逐行高度，长度 = rows */
  rowHeights: number[]
  /** 表头行/列数（冻结显示行号列号） */
  frozenRows: number
  frozenCols: number
  /** 工作表左上角在画布中的位置 */
  originX: number
  originY: number
  /** 合并区：被合并的内部格不存内容，只存锚点 */
  merges: MergeRange[]
  /** 稀疏单元格，键 "row:col" */
  cells: Record<string, SheetCell>
}

export interface CanvasConfig {
  width: number
  height: number
  background: string
}

export interface ZoneDef {
  id: string
  name: string
  color: string
  ruleTag?: 'podium' | 'front' | 'vip' | 'staff' | 'other'
}

export interface LayoutPackage {
  schemaVersion: '2.0'
  id: string
  name: string
  canvas: CanvasConfig
  sheet: Sheet
  zones: ZoneDef[]
  createdAt: string
  updatedAt: string
}

// ---------- 规则与项目 ----------

export type AttendStatus = 'present' | 'leave' | 'absent' | 'guest'

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

export interface Assignment {
  seatId: string
  memberId: string
  status: AttendStatus
  locked: boolean
  note?: string
}

export interface Project {
  id: string
  name: string
  rosterPlanId: string
  layoutPackageId: string
  ruleSet: RuleSet
  assignments: Assignment[]
  participantIds: string[]
  unassigned: string[]
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
