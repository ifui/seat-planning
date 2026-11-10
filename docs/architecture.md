# 架构说明

> 目标读者：接手维护者。本文描述「代码怎么分层、数据怎么流动、状态存在哪、为什么这样拆」。
> 所有结论以当前代码为准，路径可直接对照。

---

## 1. 总体分层

```
┌─────────────────────────────────────────────────────────────┐
│ App.vue（外壳：左侧导航 + 主区域 + 侧栏）                     │
│   ├─ RosterView.vue      名册与组织                           │
│   ├─ LayoutView.vue      会场布局（表格工作台）               │
│   └─ ProjectView.vue     排座项目                             │
└───────────────┬─────────────────────────────────────────────┘
                │ 读写
┌───────────────▼───────────────┐      ┌──────────────────────┐
│ store.ts（全局单例响应式数据） │◄────►│ db.ts（存储层）       │
│ state / loadAll / save*       │      │ IndexedDB / localStorage │
└───────────────┬───────────────┘      └──────────────────────┘
                │ 纯函数调用
┌───────────────▼─────────────────────────────────────────────┐
│ engine/（无 Vue 依赖的纯逻辑）                                │
│   sheet.ts     工作表模型与几何                              │
│   seating.ts   排座算法                                      │
│   render.ts    Canvas 座位图                                 │
└───────────────┬─────────────────────────────────────────────┘
                │ props / events
┌───────────────▼─────────────────────────────────────────────┐
│ components/ + ui/（视图组件与基础件）                         │
└─────────────────────────────────────────────────────────────┘
```

依赖方向严格单向：`views → store/db/engine`，`components → engine/types`。`engine/*` 不 import Vue，也不 import store，便于在 Node 里用 esbuild 打包做探针测试。

## 2. 模块职责

| 文件/目录 | 职责 | 关键导出/接口 |
|---|---|---|
| `src/types.ts` | 全部领域类型 + `DEFAULT_RULESET` | `Sheet`、`SheetCell`、`LayoutPackage`、`Project`、`RuleSet` 等 |
| `src/db.ts` | Dexie 定义、种子数据、存储模式探测、双后端读写、全量导入导出 | `db`、`buildSeed()`、`openStorage()`、`loadTables()`、`put*()`、`exportAllData()`、`importAllData()` |
| `src/store.ts` | 全局响应式状态与业务级持久化 API | `state`、`loadAll()`、`saveRoster/Layout/Project()`、`remove*()`、`saveSnapshot()`、`rosterOf()`、`layoutOf()` |
| `src/engine/sheet.ts` | 工作表纯函数：几何、稀疏格读写、合并、行列增删、座位投影、批量建座 | `cellRect()`、`cellAt()`、`setCell()`、`addMerge()`、`insertRows()`、`seatsInRow()`、`seatsOfSheet()`、`fillSeats()`、`cloneCell()`、`uid()`、`nowISO()` |
| `src/engine/seating.ts` | 排座：候选排序、主席台顺序、台下顺序、职级分层、锁定/请假排除 | `arrange()`、`applyRulesToProject()`、`seatOrderMap()`、`seatIndexMap()` |
| `src/engine/render.ts` | 把布局 + 分配画到 Canvas（供 PNG 导出） | `renderSeatChart(opts)` |
| `src/views/LayoutView.vue` | 布局工作台：选中布局、编辑工作表/区域、撤销重做、保存、导入导出 | 组合 `SheetToolbar` + `SheetGrid` + `SheetInspector` |
| `src/views/RosterView.vue` / `RankView.vue` / `UnitView.vue` | 名册、职级、单位三块编辑区，各自维护本地草稿与 dirty | 读取/写回 `state.rosters`，单位树与职级供人员选择 |
| `src/components/sheet/*` | 表格编辑器实现 | `SheetGrid`（核心交互）、`SheetCellBox`（单元格渲染）、`SheetToolbar`、`SheetInspector`、`SheetSetupDialog`、`FillDialog` |
| `src/views/ProjectView.vue` | 项目页：选项目、规则、开始排座、座位图、快照、导出、备份 | `runArrange()`、`swapSeats()`、`exportPng()`、`exportExcel()` |
| `src/components/SeatBoard.vue` | 座位图：按 sheet 投影绘制，拖拽换座 | props：`layout/roster/project/seatInfo/...` |
| `src/components/RulesPanel.vue` | 规则面板（视角、台下顺序、单位、分层、主席台请假） | 直接修改传入的 `rules` 对象 |
| `src/composables/useLayoutHistory.ts` | 布局撤销/重做，整表快照 | `historyPush/resetHistory/undo/redo/canUndo/canRedo` |
| `src/ui/*` | 纯展示基础件与图表封装 | `UiButton/UiModal/UiSelect/UiContextMenu/UiChart/UiIcon` |
| `src/App.vue` | 三导航切换、侧栏存储状态提示 | `navItems`、`tab` |

## 3. 数据流

### 3.1 布局：从单元格到座位集合

```
LayoutPackage.sheet（行列 + 稀疏 cells + merges + 宽高）
        │ seatsOfSheet(sheet)
        ▼
SeatRef[]：{ seatId, row, col, index, seatNo, x, y, w, h, stage, zoneId, disabled, tableId }
```

- 每格 `seats: 1 | 2` 展开为 1~2 个 `SeatRef`，`seatId` 来自 `cell.seatIds[i]`；缺失时用 `seat-${row}-${col}-${i+1}` 兜底（**纯函数内兜底，不写回 sheet**，避免响应式死循环）。
- `seatNo` 是该行内从左到右的座位序号；`disabled` 格 `seatNo = 0` 且不占号（`src/engine/sheet.ts` 的 `seatsInRow()`）。
- 排号 = `row + 1`；`stage = kind === 'podium'`。

### 3.2 排座：从座位集合到分配

```
Project.ruleSet + RosterPlan + LayoutPackage
        │ applyRulesToProject(project, roster, layout)
        ▼
ArrangeResult { assignments, unassigned, warnings }
        │ draft.assignments = ...
        ▼
saveProject() → store → db
```

- 输入：项目里已经存在的 `assignments`（用于继承锁定）、`participantIds`（为空则取名册中全部人员，请假者仍会被排除）。
- 输出：`Assignment[]`（每个座位至多一条），未排到的人 id 列表，以及给用户的提示。
- 算法口径见 [seating-rules.md](./seating-rules.md)。

### 3.3 展示与导出

```
assignments + seatIndex（seatId → SeatRef）+ roster
   ├─ SeatBoard.vue        DOM 座位图（可拖拽换座）
   ├─ engine/render.ts     Canvas → PNG（3×）
   └─ SheetJS              XLSX 明细（排号/座号/姓名/职级/单位/状态/锁定/区域）
```

`SeatBoard` 不重新计算排号，直接使用 `seatsInRow()` 的结果，因此表格与座位图的编号天然一致。

## 4. 状态管理与保存语义

### 4.1 全局状态

`src/store.ts` 暴露单一响应式对象：

```ts
export const state = reactive({
  ready: false,
  storage: 'indexeddb' as StorageMode,
  persistent: true,
  rosters: [] as RosterPlan[],
  layouts: [] as LayoutPackage[],
  projects: [] as Project[]
})
```

- `state` 是**只读参考源**：视图不会直接改动 `state` 里的对象，而是克隆一份本地草稿编辑，保存时写回。
- `saveRoster/saveLayout/saveProject` 的流程固定为：更新 `updatedAt` → 写入后端 → `await loadAll()` 重新拉取 → 视图从 `state` 重新取数据。
- `loadAll()` 在首次启动（四张表全空）时调用 `buildSeed()` 写入示例名册、示例布局、示例项目。

### 4.2 布局页的本地状态

`LayoutView.vue`：

- `current = ref<LayoutPackage | null>`：从 `state.layouts` 深拷贝出来的草稿；
- `selection / active`：选区与活动格，属于会话态，不持久化；
- `dirty`：草稿是否修改过，用于标题标记与「保存」按钮；
- `useLayoutHistory`：`resetHistory(snapshot)`、`historyPush(snapshot)`，快照包含 `sheet / zones / canvas`，上限 80 步；
- 保存：`saveLayout(current)`，成功后 `dirty = false`。

> 注意：`SheetGrid` 在拖列宽/行高时直接修改 `props.sheet`（同一对象引用），随后 `emit('commit')`，由父级压入历史。功能可用，但不是严格的单向数据流，见 `known-issues.md`。

### 4.3 项目页的本地状态

`ProjectView.vue`：

- `selectedId` 决定当前项目，`draft = clone(state.projects[i])`；
- 深度 watch `draft` 设置 `dirty`（`loading` 标志用于跳过加载瞬间的误触）；
- 「开始排座」会先写快照，再计算并**立即保存**项目（`status: 'seated'`）；
- 手动换座/改状态只改 `draft`，需要点「保存」才落库；
- 快照列表按 `createdAt` 倒序取前 6 条。

### 4.4 撤销的边界

- 只有布局工作台有撤销/重做（整表快照）；
- 排座项目、名册编辑没有撤销；
- 项目「开始排座」前会自动存一份 `Snapshot`，可在项目页恢复（这是业务级快照，不是 Ctrl+Z）。

## 5. 持久化策略

实现集中在 `src/db.ts`：

1. **模式探测**（`openStorage()`，只探一次）：
   - 尝试 `db.open()` 并读一次 `db.rosters.count()`；成功 → `'indexeddb'`；
   - 失败则写入/删除一个 localStorage 探针键，成功 → `'local'`；
   - 再失败 → `'memory'`。
2. **读写分派**：`loadTables()` 与 `putRoster/putLayout/putProject/addSnapshot/delete*` 按 `mode` 分支。
   - IndexedDB 模式：直接走 Dexie；
   - localStorage 模式：维护内存 `cache`，每次写后 `localFlush()` 把整个 `Tables` 序列化到 `seat-planning:v2`；
   - 内存模式：只改 `cache`。
3. **全量备份**：`exportAllData()` 输出
   `{ schemaVersion: '2.0', exportedAt, rosters, layouts, projects, snapshots }`；
   `importAllData(json)` 按 `id` 合并 upsert 到当前后端。
4. **单布局 JSON**：由 `LayoutView` 的导出按钮直接序列化 `LayoutPackage`（`schemaVersion: '2.0'`），导入时校验版本并重新生成 id。

为什么不全量备份自动下载：浏览器不允许在无用户手势时静默下载；主路径的数据已经落盘（IndexedDB/localStorage），备份定位为「迁移/防清理」手段。实测数据见 [known-issues.md](./known-issues.md)。

## 6. 渲染策略（LayoutView / SheetGrid）

- **DOM 绝对定位**，不是 Canvas：
  - 只有非空单元格（`cells` 中有值的格）才渲染成组件，空白格交给 SVG 网格线；
  - 每个单元格组件 `SheetCellBox` 接收一个 `CellView`（几何 + 文案 + 颜色），无业务逻辑；
  - 行列坐标由 `colXs/rowYs` 前缀和计算，改宽高只重算，不写回每个格。
- **表头与内容双向同步滚动**：`syncScroll()` 把内容区 `scrollLeft/Top` 同步给列头/行头容器。
- **冻结窗格**：`scrollLeft/scrollTop` 进入响应式状态；`.sg-frozen` 覆盖在滚动区上（`pointer-events: none`），内部三块：
  - `.sg-fz-rows`（冻结行，图层 `translateX(-scrollLeft)`）；
  - `.sg-fz-cols`（冻结列，图层 `translateY(-scrollTop)`）；
  - `.sg-fz-corner`（左上角，不位移）；
  冻结表头由 `.sg-colhead-fz` / `.sg-rowhead-fz` 单独渲染。点击冻结区时，`locate()` 对落在冻结区域内的坐标不再叠加滚动量，从而选中正确的格。
- **网格线**：SVG 一次性绘制行列线，冻结边界用 `is-major` 加粗。
- **滚动条补偿**：`ResizeObserver` + `measureScrollbar()` 测量滚动条厚度，冻结覆盖层避开滚动条。
- **尺寸调整**：表头边界的 `.sg-rz` / `.sg-rh-rz` 监听 `pointerdown`，`pointermove` 直接改 `colWidths/rowHeights`，`pointerup` 发 `commit`。
- **编辑态**：双击/F2 在格上覆盖 `<input>`；若编辑的格位于冻结区，input 渲染在对应冻结图层内，坐标自然对齐。

## 7. 构建与零外链

`vite.config.ts` 使用 `viteSingleFile()`，把 JS、CSS、图标全部内联进 `dist/index.html`。约束检查方式：

```powershell
$f='dist\index.html'; $t=Get-Content $f -Raw
([regex]::Matches($t,'(src|href)\s*=\s*["'']https?://')).Count   # 期望 0
```

图标是 `src/ui/components/UiIcon.vue` 里的内联 `<path>`；字体用系统栈（PingFang SC / Microsoft YaHei），不加载 webfont。

## 8. 关键不变量

1. `merges` 之间不重叠、不越界；合并区内部格不存内容，只认锚点格。
2. `seatIds.length === seats`（`ensureSeatIds()` 维护）；`seatId` 不随行列移动变化。
3. 排号唯一由行决定，座号唯一由行内顺序决定；`disabled` 格不占座号。
4. `sheet.colWidths.length === cols`、`rowHeights.length === rows`（`normalizeSheet()` 保证）。
5. `Assignment` 的 `seatId` 必须存在于当前布局；不存在的分配在排座时会被丢弃。

## 9. 目录依赖速查

```
views/*  →  store.ts / db.ts / engine/* / components/* / ui/*
components/sheet/* → engine/sheet.ts（只读纯函数）/ types.ts
components/SeatBoard.vue → engine/sheet.ts / types.ts
components/RulesPanel.vue → types.ts
engine/* → types.ts（不依赖 Vue / store / db）
db.ts → types.ts / engine/sheet.ts
store.ts → db.ts / types.ts
```
