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

/** 人员在位状态：请假者不参与排座，在排座页单独列出 */
export type MemberStatus = 'present' | 'leave'

export interface Member {
  id: string
  name: string
  unitId: string
  rankId: string
  /** 职务（如主任、处长）：仅用于展示与筛选，不参与排序 */
  duty?: string
  aliases: string[]
  gender?: 'M' | 'F'
  note?: string
  status: MemberStatus
  /** 名册顺序（拖拽排序）：排座时同一职级、同一单位内的最终依据 */
  order?: number
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

/**
 * 特殊块的用途，仅 kind === 'block' 时有效。
 * 现在只产生 'aisle'（过道）与空用途（纯文字块）；
 * 'lectern' / 'backdrop' / 'label' 是旧数据的兼容值，读得到但不再写入。
 * 讲台已改为自由元素（见 LayoutElement），不再占用单元格。
 */
export type BlockRole = 'aisle' | 'lectern' | 'backdrop' | 'label'

export type BorderSide = 'top' | 'right' | 'bottom' | 'left'

export interface CellStyle {
  fill?: string
  stroke?: string
  strokeStyle?: 'solid' | 'dashed' | 'dotted' | 'none'
  strokeWidth?: number
  /** 显式边框：只画列出的边，线型/粗细/颜色取 strokeStyle / strokeWidth / stroke */
  borders?: BorderSide[]
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
  /** kind === 'seat' | 'podium' 时：单人位 1 / 双人位 2 / 自定义任意正整数 */
  seats?: number
  /** 每个座位一个稳定 id，长度 = seats；排座分配按它引用，插删行列不会错位 */
  seatIds?: string[]
  /** 不坐人（保留位置但不能坐人） */
  disabled?: boolean
  /** 同桌编组：相邻同 tableId 的座位格绘制成连续桌带 */
  tableId?: string
  tableLabel?: string
  zoneId?: string
  /** kind === 'block' 时的用途；旧数据可能是 lectern / backdrop / label */
  role?: BlockRole
  /** 块内显示文字 */
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
  /** 自由元素：讲台、人形、箭头、门、话筒等，位于表格之上的独立图层 */
  elements: LayoutElement[]
  createdAt: string
  updatedAt: string
}

// ---------- 自由元素 ----------

/** 元素类型：每个都是独立图形，不占用单元格 */
export type ElementKind =
  | 'podium'
  | 'person'
  | 'arrow'
  | 'door'
  | 'double-door'
  | 'mic'
  | 'plaque'
  | 'screen'
  | 'plant'

/**
 * 锚定方式：
 * - cell：绑定单元格/区域，随行列增删与尺寸变化跟随移动；
 * - free：绝对坐标，不随单元格变化。
 */
export type ElementAnchorMode = 'cell' | 'free'

export interface ElementAnchor {
  mode: ElementAnchorMode
  /** 锚定区域左上角（工作表坐标） */
  row: number
  col: number
  rowSpan: number
  colSpan: number
  /** 元素相对锚定区域的偏移与缩放比例，用于切换锚定方式时保持视觉位置不变 */
  ox: number
  oy: number
  sw: number
  sh: number
}

export interface LayoutElement {
  id: string
  kind: ElementKind
  /** 自由坐标（工作表坐标系，单位与单元格一致） */
  x: number
  y: number
  w: number
  h: number
  /** 旋转角度（度，顺时针） */
  rotation: number
  /** 填充色 */
  color: string
  /** 边框色 */
  stroke: string
  strokeWidth: number
  /** 是否显示边框；讲台等元素默认无边框 */
  bordered: boolean
  /** 元素内文字（桌牌、人形、讲台常用） */
  text: string
  /** 文字字号（工作表单位）；为空时按元素高度自动推算 */
  fontSize?: number
  /** 文字颜色；为空时按元素底色自动取深色/白色 */
  fontColor?: string
  /** 文字字体族（CSS font-family） */
  fontFamily?: string
  /** 文字水平对齐；缺省居中 */
  textAlign?: 'left' | 'center' | 'right'
  /** 文字垂直对齐；缺省居中（人形缺省贴底） */
  textVAlign?: 'top' | 'middle' | 'bottom'
  /** 文字相对元素中心点的水平偏移（工作表单位） */
  textOffsetX?: number
  /** 文字相对元素中心点的垂直偏移（工作表单位） */
  textOffsetY?: number
  /** 层级：数值越大越靠上 */
  zIndex: number
  anchor: ElementAnchor
}

/** 布局预设：保存一份可复用的布局快照，从预设新建时复制并重生成座位 id */
export interface LayoutPreset {
  id: string
  name: string
  note?: string
  /** 内置模板不可删除 */
  builtin?: boolean
  layout: LayoutPackage
  createdAt: string
  updatedAt: string
}

// ---------- 规则与项目 ----------

/** 与会状态：只保留「在位 / 请假」 */
export type AttendStatus = 'present' | 'leave'

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
  /** 主席台朝向口径：left = 左为上（2 号在画布右侧），right = 右为上（镜像） */
  stageSide: 'left' | 'right'
  /** 主席台偶数座时 1 号取左中位还是右中位 */
  evenCenterSide: 'left' | 'right'
  /** 台下填充方向：中间左优先 / 中间右优先 / 从左到右 / 从右到左 */
  hallOrder: 'center-left' | 'center-right' | 'left-to-right' | 'right-to-left'
  /** 单位在座位上的分布：连续 / 交替穿插 */
  unitOrder: 'continuous' | 'interleave'
  /** 每排/区域职级分层 */
  tiers: TierRule[]
  /** 区域人员分配规则：按级别快捷指派 + 手动勾选人员 */
  zoneRules: ZoneRule[]
  /** 同一职级内是否按名单顺序 */
  keepListOrder: boolean
}

/**
 * 区域分配规则。优先级：手动勾选人员 > 区域级别规则 > 职级分层规则。
 * 一个区域可以有多条规则，职级取并集、排除取并集。
 */
export interface ZoneRule {
  id: string
  zoneId: string
  /** 指派到该区域的职级 */
  rankIds: string[]
  /** 从该区域排除的职级（优先级高于 rankIds） */
  excludeRankIds: string[]
  /** 手动指定的人员，优先级最高 */
  memberIds: string[]
  enabled: boolean
}

export interface Assignment {
  seatId: string
  memberId: string
  status: AttendStatus
  note?: string
}

/**
 * 项目对布局的覆盖层：同一份布局可以被多个会议复用，但「本次会议停用哪些座位」
 * 与「本次会议怎么分区」只属于当前项目，全部存在这里，不写回布局。
 *
 * 引用键统一使用「单元格第一个座位的稳定 id」（anchor seat id）：
 * 插入/删除行列时座位 id 随单元格移动，引用不会像 "行:列" 那样错位；
 * 单元格被删除或不再是座位时，引用在下次加载时清理并提示。
 */
export interface ProjectSeatOverlay {
  /** 项目内区域定义，只对当前项目生效 */
  zones: ZoneDef[]
  /** 本次会议停用的单元格（anchor seat id） */
  disabledCells: string[]
  /** 单元格 → 区域（anchor seat id → zoneId） */
  cellZones: Record<string, string>
  /**
   * 固定座位：seatId → memberId。
   * 指定某个位置固定给某人，该人不参与其他座位的排序。
   * 与 disabledCells / cellZones 不同，这里按「座位」记录而不是单元格锚点：
   * 同一桌的多个座位可以分别固定给不同的人；seatId 随插删行列稳定移动。
   */
  fixedSeats?: Record<string, string>
  /** 上次对齐的布局，用于识别布局被编辑或切换 */
  layoutPackageId?: string
  layoutUpdatedAt?: string
}

export interface Project {
  id: string
  name: string
  rosterPlanId: string
  layoutPackageId: string
  /**
   * 冻结的名册快照：项目创建时复制。
   * 之后名册的增删改不会自动影响本项目，需要时在项目里「手动更新」。
   */
  rosterSnapshot?: RosterPlan
  ruleSet: RuleSet
  /** 排座图是否显示座位序号；缺省视为显示（兼容旧数据） */
  showSeatNumbers?: boolean
  /** 座位下方是否显示职级；缺省显示 */
  showRank?: boolean
  /** 座位下方是否显示职务；缺省隐藏 */
  showDuty?: boolean
  /** 座位下方是否显示单位；缺省隐藏 */
  showUnit?: boolean
  /**
   * 本项目的桌容量覆盖：cellKey（"行:列"）→ 该桌坐几人。
   * 缺省沿用布局里的旧 seats 字段；布局页不再提供容量设置。
   */
  seatCapacity?: Record<string, number>
  /** 项目对布局的覆盖层：本次会议的区域与停用座位 */
  seatOverlay?: ProjectSeatOverlay
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
  stageSide: 'left',
  evenCenterSide: 'right',
  hallOrder: 'center-left',
  unitOrder: 'continuous',
  tiers: [],
  zoneRules: [],
  keepListOrder: true
}
