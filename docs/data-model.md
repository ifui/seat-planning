# 数据模型

> 类型定义唯一来源：`src/types.ts`。本文摘录的是当前真实定义，字段说明补充语义与约束。
> 存储层：Dexie 库 `seat-planning-v2`（`src/db.ts`），四张表 `rosters / layouts / projects / snapshots`，另有一张 `settings`（当前未使用）。

---

## 1. 实体关系

```
RosterPlan（名册方案）
  ├─ RankDef[]   职级
  ├─ UnitNode[]  单位（树）
  └─ Member[]    人员

LayoutPackage（布局包）
  ├─ CanvasConfig
  ├─ Sheet（工作表）
  │   ├─ cells: "r:c" → SheetCell
  │   └─ merges: MergeRange[]
  └─ ZoneDef[]   区域

Project（排座项目）
  ├─ rosterPlanId  ──► RosterPlan.id
  ├─ layoutPackageId ──► LayoutPackage.id
  ├─ RuleSet      排座规则
  ├─ Assignment[] 座位 → 人员
  └─ participantIds / unassigned / pendingNames

Snapshot（排座快照）
  └─ projectId + assignments（某次排座前的分配）
```

---

## 2. 名册与组织

```ts
export interface RankDef {
  id: string
  name: string
  shortName?: string
  order: number          // 越小级别越高，排座排序依据
  color: string          // 座位图/图表配色
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
  duty?: string          // 职务：只做展示与筛选，不参与排序
  aliases: string[]      // 导入匹配用
  gender?: 'M' | 'F'
  note?: string
  status: 'present' | 'leave' // 请假者不参与排座、不占座
}

export interface RosterPlan {
  id: string
  name: string
  ranks: RankDef[]
  units: UnitNode[]
  members: Member[]
  createdAt: string      // ISO 字符串
  updatedAt: string
}
```

| 字段 | 约束/说明 |
|---|---|
| `RankDef.order` | 排座时按 `order` 升序（级别高者优先） |
| `Member.status` | `leave` 不进入候选池、不占座；旧数据的 `active:false` 会自动迁移为 `leave` |
| `Member.aliases` | Excel 导入时按姓名/别名匹配已有人员 |
| `Member.duty` | 职务（如主任、处长），导入时按「职务/职位/岗位」列识别；仅用于展示与筛选，不参与排序 |
| `RosterPlan.members` 顺序 | 完全由用户拖拽决定，不做自动排序；作为排座时同职级同单位内的先后依据 |
| `UnitNode.parentId` | `null` 为根；单位树用于展示与筛选，排座按 `unitId` 分组 |

---

## 3. 表格与布局

```ts
export type CellKind = 'seat' | 'podium' | 'block'
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

export interface SheetCell {
  kind: CellKind
  seats?: number         // 仅 seat/podium，1–50（clampSeats 归一化）
  seatIds?: string[]     // 长度 = seats，稳定 id
  disabled?: boolean     // 固定空位：保留占位、不坐人
  tableId?: string       // 同桌编组（绘制连续桌带）
  tableLabel?: string    // 格内左上角小字（如「3 排」）
  zoneId?: string
  role?: BlockRole       // 仅 block
  text?: string          // 块内文字
  style?: CellStyle
  locked?: boolean       // 锁定：不被批量填充/清空覆盖
}

export interface MergeRange {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface Sheet {
  rows: number
  cols: number
  defaultColWidth: number
  defaultRowHeight: number
  colWidths: number[]    // 长度 = cols
  rowHeights: number[]   // 长度 = rows
  frozenRows: number     // 0..5
  frozenCols: number     // 0..5
  originX: number        // 工作表在画布中的左上角偏移
  originY: number
  merges: MergeRange[]   // 互不重叠、不越界
  cells: Record<string, SheetCell>  // 键 "row:col"，稀疏存储
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
```

### 3.1 单元格语义

| `kind` | 坐人 | 说明 |
|---|---|---|
| `seat` | 是 | 普通座位；`seats = 1` 单人位，`2` 双人位，`N` 自定义人数（1–50） |
| `podium` | 是 | 主席台座位；排座走主席台顺序，排号显示「主席台」 |
| `block` | 否 | 特殊块，按 `role` 区分过道/讲台/背景板/标签；不占座号 |

- **合并区**：`merges` 记录范围，语义由**锚点格**（`row/col` 处）的 `kind` 决定；被合并的内部格不存内容。合并可以是纯视觉（锚点仍是 `seat`，仍坐人），也可以是把整块设为 `block`。
- **双人位/自定义位座号**：`seats: N` 的格在同一行内占 N 个连续座号，左（上）为第一个。
- **`disabled`**：座位存在但不可用；`seatsInRow()` 给它 `seatNo = 0` 且不占号，排座时跳过。
- **`locked`**：布局层面的锁定。当前只在「清空选区」时生效；批量填充、改类型、改样式、分配区域尚未检查（见 [known-issues.md](./known-issues.md) 2.1）。
- **`tableId`**：仅用于绘制同桌桌带与视觉分组，不参与排号。

### 3.2 工作表不变量（`src/engine/sheet.ts`）

1. `colWidths.length === cols`，`rowHeights.length === rows`；越界由 `normalizeSheet()` 修正。
2. `merges` 任意两个范围不重叠、不越界；新建合并必须至少 2 格（`addMerge()` 拒绝 1×1）。注意：删除行列裁剪后可能残留 1×1 合并，见 [known-issues.md](./known-issues.md) 2.4。
3. `seat`/`podium` 格 `seatIds.length === seats`；缺 id 时 `ensureSeatIds()` 补齐，渲染层 (`seatsInRow`) 只读不写。
4. 单元格键固定为 `"row:col"`，行/列均 0 起。
5. 插入/删除行列后，未受影响格的 `seatId` 保持不变；`merges` 会按新坐标平移/裁剪。

---

## 4. 规则与项目

```ts
export type AttendStatus = 'present' | 'leave' | 'absent' | 'guest'

export interface TierRule {
  id: string
  by: 'row' | 'zone'
  from?: number       // by='row'：起始排号（1 起，台下）
  to?: number         // by='row'：结束排号
  zoneId?: string     // by='zone'
  rankIds: string[]   // 该排/区域只允许这些职级
}

export interface ZoneRule {
  id: string
  zoneId: string
  rankIds: string[]         // 指派到该区域的职级（并集）
  excludeRankIds: string[]  // 从该区域排除的职级
  memberIds: string[]       // 手动指定人员（优先级最高）
  enabled: boolean
}

export interface RuleSet {
  evenCenterSide: 'left' | 'right'
  hallOrder: 'center-out' | 'left-to-right' | 'right-to-left'
  unitOrder: 'continuous' | 'interleave'
  tiers: TierRule[]
  zoneRules: ZoneRule[]
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
  // 创建项目时冻结的名册快照；名册后续增删改不自动作用于项目
  rosterSnapshot?: RosterPlan
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
  hallOrder: 'center-out',
  unitOrder: 'continuous',
  tiers: [],
  zoneRules: [],
  keepListOrder: true
}
```

| 字段 | 说明 |
|---|---|
| `participantIds` | 本次参会人员；为空时排座取名册中全部人员（请假者仍会被排除） |
| `unassigned` | 上次排座未排到的人 |
| `pendingNames` | 参会但名册中不存在的人名（保留占位，不参与排座） |
| `status` | `draft` 未排座 / `seated` 已排座 |
| `Assignment.status` | `present` 在位、`absent` 缺席、`guest` 来宾；请假是人员状态，不再写入分配 |
| `Member.status` | `present` 在位、`leave` 请假；排座、统计与右侧请假 tab 均以此为准 |
| `Assignment.locked` | 锁定后重新排座仍保留（座位仍存在时） |
| `Snapshot.label` | 当前固定写入「排座前快照」（`ProjectView.vue` 的 `runArrange()`） |

规则字段的**行为口径**见 [seating-rules.md](./seating-rules.md)。

---

## 5. 最小示例 JSON

### 5.1 布局包（2 行 × 3 列：主席台 + 1 排台下）

```json
{
  "schemaVersion": "2.0",
  "id": "layout-demo",
  "name": "最小示例",
  "canvas": { "width": 1280, "height": 880, "background": "#FFFFFF" },
  "zones": [
    { "id": "zone-stage", "name": "主席台", "color": "#DCE4EE", "ruleTag": "podium" },
    { "id": "zone-hall", "name": "普通席", "color": "#F7F8FA", "ruleTag": "other" }
  ],
  "sheet": {
    "rows": 2,
    "cols": 3,
    "defaultColWidth": 120,
    "defaultRowHeight": 64,
    "colWidths": [120, 120, 120],
    "rowHeights": [64, 64],
    "frozenRows": 0,
    "frozenCols": 0,
    "originX": 0,
    "originY": 0,
    "merges": [],
    "cells": {
      "0:0": { "kind": "podium", "seats": 1, "seatIds": ["seat-0-0-1"], "zoneId": "zone-stage", "tableId": "table-stage", "tableLabel": "主席台" },
      "0:1": { "kind": "podium", "seats": 1, "seatIds": ["seat-0-1-1"], "zoneId": "zone-stage", "tableId": "table-stage", "tableLabel": "主席台" },
      "0:2": { "kind": "podium", "seats": 1, "seatIds": ["seat-0-2-1"], "zoneId": "zone-stage", "tableId": "table-stage", "tableLabel": "主席台" },
      "1:0": { "kind": "seat", "seats": 2, "seatIds": ["seat-1-0-1", "seat-1-0-2"], "zoneId": "zone-hall", "tableId": "table-1-0", "tableLabel": "2 排" },
      "1:1": { "kind": "block", "role": "aisle", "text": "过道" },
      "1:2": { "kind": "seat", "seats": 2, "seatIds": ["seat-1-2-1", "seat-1-2-2"], "zoneId": "zone-hall", "tableId": "table-1-2", "tableLabel": "2 排" }
    }
  },
  "createdAt": "2026-11-09T10:00:00.000Z",
  "updatedAt": "2026-11-09T10:00:00.000Z"
}
```

> 该示例中的 `seatId` 仅为演示。实际新建格子时由 `ensureSeatIds()` 用 `uid('seat')` 生成；`seatsInRow()` 对缺失 id 的兜底格式是 `seat-${row}-${col}-${index+1}`。

### 5.2 名册（截取）

```json
{
  "id": "roster-demo",
  "name": "示例名册",
  "ranks": [
    { "id": "rank-1", "name": "正处级", "order": 0, "color": "#2F5D8A" },
    { "id": "rank-2", "name": "副处级", "order": 1, "color": "#4A7BA7" }
  ],
  "units": [
    { "id": "u-root", "name": "局机关", "parentId": null, "order": 0 },
    { "id": "u-office", "name": "办公室", "parentId": "u-root", "order": 0 }
  ],
  "members": [
    { "id": "m-1", "name": "张建国", "unitId": "u-office", "rankId": "rank-1", "aliases": [], "status": "present" }
  ],
  "createdAt": "2026-11-09T10:00:00.000Z",
  "updatedAt": "2026-11-09T10:00:00.000Z"
}
```

### 5.3 项目

```json
{
  "id": "proj-demo",
  "name": "示例会议",
  "rosterPlanId": "roster-demo",
  "layoutPackageId": "layout-demo",
  "ruleSet": {
    "evenCenterSide": "left",
    "hallOrder": "center-out",
    "unitOrder": "continuous",
    "tiers": [],
    "zoneRules": [],
    "keepListOrder": true
  },
  "assignments": [
    { "seatId": "seat-0-1-1", "memberId": "m-1", "status": "present", "locked": false }
  ],
  "participantIds": [],
  "unassigned": [],
  "pendingNames": [],
  "status": "seated",
  "createdAt": "2026-11-09T10:00:00.000Z",
  "updatedAt": "2026-11-09T10:00:00.000Z"
}
```

---

## 6. 全量备份格式

`src/db.ts` 的 `exportAllData()`：

```json
{
  "schemaVersion": "2.0",
  "exportedAt": "2026-11-09T10:00:00.000Z",
  "rosters": [],
  "layouts": [],
  "projects": [],
  "snapshots": []
}
```

`importAllData()` 按 `id` 做 upsert（同 id 覆盖、新 id 追加），不删除本地已有数据；导入后 UI 提示刷新页面查看。

---

## 7. 命名与兼容

- schema 版本统一为字符串 `'2.0'`（`LayoutPackage.schemaVersion`、备份 `schemaVersion`）。
- 不兼容 v1（自由画布 `elements/zones`）数据，也没有迁移代码；旧库 `seat-planning` 不会被读取。
- 布局导入只接受 `schemaVersion === '2.0'` 且含 `sheet` 的对象；导入时重新分配 `id`，避免覆盖已有布局。
