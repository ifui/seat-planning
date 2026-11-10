# 已知问题、限制与风险

> 核对基线：提交 `c32b635`（表格化重构 + 持久化 + XLSX 导出）。
> 实测环境：Windows 10/11、Microsoft Edge 157（Chromium 内核，headless 与有头均验证）、`file://` 打开最终构建产物。
> 本文件只记录在代码里能对应上的问题，以及本轮实际跑出来的数据；推算项会明确标注「推算」。

---

## 1. 数据与持久化（优先处理）

当前三级存储：IndexedDB → localStorage → 内存（[src/db.ts](../src/db.ts) `openStorage`）。实测 Edge 157 在 `file://` 下允许 IndexedDB，默认走 IndexedDB；人为让 IndexedDB 打开失败后会自动落到 localStorage，两种模式都能跨刷新、跨浏览器进程保留数据。其他内核的 `file://` 策略可能不同。以下风险仍存在。

| # | 问题 | 影响 | 代码位置 | 现有缓解 |
|---|------|------|----------|----------|
| 1.1 | **只有点「保存」才落库，关闭页面不自动保存** | 编辑中的布局/名册/项目未保存就关页面、刷新或切换对象，改动直接丢失。没有 `beforeunload` 或自动保存定时器。 | [LayoutView.vue](../src/views/LayoutView.vue#L104-L109)、[ProjectView.vue](../src/views/ProjectView.vue#L299-L303)、[RosterView.vue](../src/views/RosterView.vue#L100)、[RankView.vue](../src/views/RankView.vue#L63)、[UnitView.vue](../src/views/UnitView.vue#L103) | 页头显示「未保存」；用户需手动保存 |
| 1.2 | **切换布局/项目/名册不做 dirty 确认** | 未保存草稿被直接覆盖，且无提示。 | [LayoutView.vue](../src/views/LayoutView.vue#L64-L74) `selectLayout`；[ProjectView.vue](../src/views/ProjectView.vue#L41) `watch(selectedId, …)`；[RosterView.vue](../src/views/RosterView.vue#L29)、[RankView.vue](../src/views/RankView.vue#L35)、[UnitView.vue](../src/views/UnitView.vue#L35) 同模式 | 仅「重新载入」有确认（[LayoutView.vue](../src/views/LayoutView.vue#L97-L102)） |
| 1.3 | **localStorage 超限后静默转内存，界面不更新** | `setItem` 抛异常时只把内部 `mode` 改成 `memory`，`state.storage` / `state.persistent` 仍是加载时的快照，侧栏继续显示「数据保存在本机浏览器 localStorage」。用户以为已保存，刷新后数据消失。 | [db.ts](../src/db.ts#L80-L87)、[store.ts](../src/store.ts#L35-L37)、[App.vue](../src/App.vue#L62-L75) | 无。只能靠用户主动导出备份 |
| 1.4 | **IndexedDB 写入期失败不降级** | 启动探测通过后，后续 `put` 抛错会直接失败，不会转 localStorage。典型场景：配额耗尽、隐私策略中途收回权限。 | [db.ts](../src/db.ts#L90-L108) 只探测一次；[db.ts](../src/db.ts#L139-L203) 写入无 catch | 无 |
| 1.5 | **数据绑定浏览器 profile，不随 HTML 文件走** | 实测同一 Edge profile 下，把 HTML 复制到另一个目录打开，localStorage 数据仍可见；但换电脑、换浏览器、换 profile、清站点数据都会得到空库。 | localStorage 按浏览器 profile 存储 | README 已说明；需用户自行「全量备份」带走 |
| 1.6 | **多窗口/多标签无同步** | 没有监听 `storage` 事件，两个窗口同时改同一项目时后写覆盖先写。 | 全局搜索无 `addEventListener('storage')` | 无 |
| 1.7 | **全量备份导入是「合并」不是「替换」** | 同 id 覆盖，不同 id 保留；导入前不做 schema 校验。一个结构合法但内容不对的 JSON 也会提示「备份已导入」。 | [db.ts](../src/db.ts#L325-L343)、[ProjectView.vue](../src/views/ProjectView.vue#L654-L666) | 解析失败会提示；语义正确性无保护 |
| 1.8 | **布局 JSON 与全量备份入口不同** | 布局页「导出」只导出单个 `LayoutPackage`（不含名册/项目）；全量备份只在排座项目页。用户容易拿错文件。 | [LayoutView.vue](../src/views/LayoutView.vue#L111-L119)、[ProjectView.vue](../src/views/ProjectView.vue#L620-L652) | README 区分说明 |
| 1.9 | **排座快照只增不减** | 每次排座前若已有分配就写一条快照，界面只看最近 6 条，旧快照永久保留在库里，长期使用会推高 localStorage 体积。 | [ProjectView.vue](../src/views/ProjectView.vue#L387-L399)、[ProjectView.vue](../src/views/ProjectView.vue#L670-L674) | 无清理入口 |

### 已实测的持久化结论

| 场景 | 结果 |
|------|------|
| IndexedDB 可用（`file://`，Edge 157） | 排座后刷新、关闭浏览器进程再打开，「已就座」仍为 30 |
| `file://` 强制 IndexedDB 失败 | 自动降级 localStorage；排座 0→30；刷新、进程重启后仍为 30 |
| 种子数据 localStorage 体积 | `localStorage['seat-planning:v2']` = **16,197 字符（约 16 KB）** |
| localStorage 配额 | Chromium 约 5 MB（未做压测，以浏览器实现为准）；按 16 KB/种子库估算余量充足，但大布局 + 多项目 + 快照仍可能触顶 → 见 1.3 |
| 同 profile 跨文件路径 | HTML 复制到 `%TEMP%` 另一目录打开，仍读到同一份数据 |
| 不同浏览器/不同机器 | 不共享，必须导出备份 |

> 结论：`file://` 下「关掉页面重开数据还在」已成立，但**只在用户点过保存的前提下**。1.1 / 1.2 是当前最接近「产品硬伤」的剩余项。

---

## 2. 数据一致性与规则缺陷

| # | 问题 | 影响 | 代码位置 |
|---|------|------|----------|
| 2.1 | **`locked` 语义不统一** | `SheetCell.locked` 注释写「不被批量填充/清空覆盖」，但只有「清空」检查它；改类型、改样式、分配区域、整表填充座位都不检查。锁定格仍会被覆盖。 | 注释 [types.ts](../src/types.ts#L79-L80)；唯一检查 [LayoutView.vue](../src/views/LayoutView.vue#L323-L331)；未检查：[LayoutView.vue](../src/views/LayoutView.vue#L240-L302) `setType/patchCell/patchStyle/assignZone`、[sheet.ts](../src/engine/sheet.ts#L425) `fillSeats` |
| 2.2 | **未知参会人静默丢弃** | `participantIds` 里不在名册的 id 只进 `eliminated`，不进入 `unassigned`，也不产生 warning；`pendingNames` 根本不参与排座。Excel 导入的「待处理 N 人」之后没有任何后续入口。 | [seating.ts](../src/engine/seating.ts#L182-L193)、[seating.ts](../src/engine/seating.ts#L267-L275)；`pendingNames` 仅写入 [ProjectView.vue](../src/views/ProjectView.vue#L505-L509) |
| 2.3 | ~~「空位」统计把请假座也算空~~ | 已修复（ADR-20）：请假改为人员状态，不占座；空位 = 可用座位 − 已就座。 | [seating.ts](../src/engine/seating.ts)、[ProjectView.vue](../src/views/ProjectView.vue) |
| 2.4 | **删行/删列后可能留下 1×1 合并区** | 裁剪后只过滤 `rowSpan > 0` / `colSpan > 0`，会留下 `rowSpan=1` 或 `colSpan=1` 的「假合并」；它继续占用 `merges`，还会参与 `addMerge` 的重叠判断，导致后续合并被误判为冲突。若锚点行/列被删，锚点内容也被删但合并仍在。 | [sheet.ts](../src/engine/sheet.ts#L320-L341)、[sheet.ts](../src/engine/sheet.ts#L358-L379)、[sheet.ts](../src/engine/sheet.ts#L249) `addMerge` |
| 2.5 | **双人位没有「同桌同单位」约束** | 双人位只是两个独立 `seatId`，`tableId/tableLabel` 仅用于绘制连续桌带；算法不保证同一桌两人同单位，也不提供「同桌绑定」。 | [sheet.ts](../src/engine/sheet.ts#L381) `seatsInRow`、[seating.ts](../src/engine/seating.ts#L254-L265) |
| 2.6 | **换座不做职级/区域/单位校验** | 项目页拖拽换座只检查锁定，不检查目标座位是否满足职级分层或区域规则，可以把人拖进不符合规则的座位。 | [ProjectView.vue](../src/views/ProjectView.vue#L413-L446) |

---

## 3. 交互与功能缺口

| # | 问题 | 说明 | 代码位置 |
|---|------|------|----------|
| 3.1 | 剪贴板只在内存 | 复制内容存在模块变量里，关页面即失效；不支持系统剪贴板、跨标签、跨文件；粘贴越界部分静默跳过，不提示。 | [LayoutView.vue](../src/views/LayoutView.vue#L344-L391) |
| 3.2 | 填充能力有限 | 只有「向下填充」「向右填充」，且都是复制首行/首列；没有向上/向左、序列填充、拖拽填充柄。空选区或单行选区会提示先扩大选区。 | [LayoutView.vue](../src/views/LayoutView.vue#L393-L433)、[sheet.ts](../src/engine/sheet.ts#L425) |
| 3.3 | 撤销只覆盖布局 | 只有布局编辑有撤销/重做，且是整表 JSON 快照，上限 80 份；名册、单位、职级、排座项目均无撤销。300×100 大表时 80 份快照内存压力明显。 | [useLayoutHistory.ts](../src/composables/useLayoutHistory.ts#L22-L40) |
| 3.4 | 冻结行列上限 5 | `frozenRows/frozenCols` 在 `createSheet` 被 clamp 到 0~5，对话框也不允许更大。冻结只影响编辑器显示，不进入 PNG/XLSX。 | [sheet.ts](../src/engine/sheet.ts#L69-L70)、[sheet.ts](../src/engine/sheet.ts#L239-L240) |
| 3.5 | `SheetGrid` 直接改 props | 拖动列宽/行高时直接写 `props.sheet.colWidths/rowHeights`，再 `emit('commit')`；单向数据流不纯，未来做多视图同步或撤销会更难。 | [SheetGrid.vue](../src/components/sheet/SheetGrid.vue#L304-L333) |
| 3.6 | 导图超出画布上限时静默失败 | `exportPng` 用 3× scale，`toBlob` 返回 `null` 时直接 `return`，无任何提示。按默认 120×64 格、300×100 表推算，CSS 尺寸约 36,000×6,400，3× 后约 108,000×19,200，远超 Chromium 单边约 32,767 px 的画布限制（推算，未实测导出）。 | [ProjectView.vue](../src/views/ProjectView.vue#L553-L564)、[render.ts](../src/engine/render.ts#L46-L59) |
| 3.7 | XLSX 能力边界 | 只导出明细（排号/座号/姓名/职级/单位/状态/锁定/区域），无样式、无座位图、无合并；不能反向导入排座结果。 | [ProjectView.vue](../src/views/ProjectView.vue#L568-L607) |
| 3.8 | 参会名单 Excel 导入规则很窄 | 只读第一个工作表；只取第一列或表头含「姓名/名字/人员」的列；按姓名/别名精确匹配；不导入单位、职级，不做模糊匹配。 | [ProjectView.vue](../src/views/ProjectView.vue#L471-L512) |
| 3.9 | 没有多选区/整表缩放/打印 | 只支持单一矩形选区；无缩放比例控制、无打印样式、无 PDF 导出。 | [LayoutView.vue](../src/views/LayoutView.vue#L148-L155) |

---

## 4. 性能与容量

以下为本轮在最终构建产物上实测的结果（Edge 157 headless，Windows，`file://`）：

| 场景 | 规模 | 结果 |
|------|------|------|
| 拖动列宽（种子布局） | 8×9，63 格 | 10 步共 **5 ms** |
| 拖动列宽（全填） | 300×100，30,000 座位 | 10 步共 **5,791 ms** |
| 滚动 | 30,000 座位 | 30 帧 **499 ms**（约 60 fps） |
| 全选后填充 → 渲染完成 | 30,000 格 | **7,223 ms** |
| 单 HTML 产物 | 内联 Vue/ECharts/XLSX | **1,353,480 字节（约 1.29 MB）** |

结论与上限：

- 常规会场（几十到几百座）交互无感；**接近 300×100 上限时拖动列宽、批量填充明显卡顿**。
- 渲染是「每格一个 DOM 节点」的绝对定位方案，没有虚拟滚动；30,000 座位时节点数量级很大，这是卡顿主因。
- 布局上限 300 行 × 100 列（[sheet.ts](../src/engine/sheet.ts#L3-L4)），插删行列单次最多 100 行 / 50 列。
- 导出 PNG 的时间与内存随表面面积线性增长，大表有失败风险（见 3.6）。
- 撤销 80 份整表快照与 localStorage 5 MB 配额叠加，是长期使用的主要容量风险（见 1.3、1.9、3.3）。

---

## 5. 兼容性与环境

| # | 项 | 状态 / 风险 |
|---|----|-------------|
| 5.1 | 浏览器覆盖 | **仅实测 Edge 157（Chromium）**。Firefox、Safari、国产双核浏览器未测；不同内核的 `file://` IndexedDB/localStorage 策略可能不同，可能直接落入内存模式。 |
| 5.2 | 操作系统 | 仅在 Windows 上实测；macOS/Linux 的 `file://` 存储行为未验证。 |
| 5.3 | 移动端/触屏 | 未做适配与测试。 |
| 5.4 | 存储清理 | 用户清理浏览器缓存/站点数据会清空 IndexedDB 与 localStorage；双击 HTML 迁移到新机器不会带数据。 |
| 5.5 | 依赖版本 | `xlsx` 固定在 0.18.5（npm 社区版），`echarts` 5.6、`dexie` 4.0、`vite` 6.0。依赖未做定期升级与安全公告跟踪。 |
| 5.6 | 离线包校验 | 已核对 `src`/`href` 指向 `http(s)` 的引用数为 0；但未做「断网 + 强缓存禁用」的完整手工回归。 |

---

## 6. 未实现能力

- 排座结果与布局之间没有双向联动：改布局后旧 `seatId` 失效，项目里的分配会被当成无效座位丢弃，没有迁移或告警。
- 没有「同桌/同区域必须同单位」的硬约束，也没有冲突检测（同一人重复分配、同一座位重复分配靠赋值顺序覆盖）。
- 没有多方案对比、批量排座、排座结果差异视图。
- 没有用户/权限/协作，没有服务端，所有数据只在本机浏览器。
- 没有数据版本迁移机制：只认 `schemaVersion: '2.0'`，未来字段变更需要手写迁移。
- 没有自动化测试入库：本轮验证脚本在 `.probe/` 下且被 `.gitignore` 排除，仓库内没有 `vitest`/`playwright` 用例。
- 没有错误上报/日志面板，异常多表现为 `flash/toast` 一句话。

---

## 7. 潜在风险

1. **数据丢失是最大风险**：未保存关闭（1.1）、切换覆盖（1.2）、localStorage 超限静默降级（1.3）三条路径都没有强制拦截。
2. **`file://` 存储行为是浏览器实现细节**：实测 Edge 157 允许 IndexedDB，但不能保证其他内核或未来版本同样允许；收紧时会落到 localStorage，再收紧就只剩内存，届时应改用本地静态服务器或打包为桌面壳。
3. **合并区残留**会随时间累积脏数据，表现为「明明没合并却提示重叠」。
4. **大表 + 大快照 + 大备份**：localStorage 是同步 API，接近 5 MB 时主线程会出现明显卡顿。
5. **旧快照引用已删除人员**：恢复快照后可能得到 `memberId` 不存在的分配，界面显示为空位，但没有校验提示。
6. **导入文件不受信**：`importAllData` 与布局导入只做浅校验，异常结构可能写进库并影响后续渲染。

---

## 8. 建议下一步（按优先级）

### P0：先把「丢数据」堵住

1. 给 `selectLayout` / `watch(selectedId)` / 名册/职级/单位切换加 dirty 确认，或提供「自动保存草稿」。
2. 增加防抖自动保存（布局、项目、名册），并在 `beforeunload` 时提示未保存。
3. `localFlush` 失败时把真实存储状态回写到 `store.state.storage/persistent`，界面立即显示「已降级为内存，请导出备份」。
4. IndexedDB 写入失败时自动降级 localStorage，并提示。

### P1：修语义与脏数据

5. 统一 `locked`：在 `setType/patchCell/patchStyle/assignZone/fillSeats/clearSelection` 全部检查。
6. `deleteRows/deleteCols` 裁剪后清理 `rowSpan===1 || colSpan===1` 的合并，并处理锚点被删的情况。
7. 排座结果中显式返回并展示「未知/未匹配人员」，把 `pendingNames` 纳入界面流程。
8. ~~修正「空位」统计，把请假占用的座位排除在空位之外。~~ 已完成（ADR-20）。
9. 拖拽换座时校验目标座位的职级/区域限制，或给出警告。

### P2：性能与导出

10. 大表虚拟滚动，或超过阈值时切换为 Canvas 渲染。
11. PNG 导出前按画布上限计算并限制 scale，失败时明确提示；或分页导出。
12. 快照保留策略（如只保留最近 N 条）与清理入口。
13. 撤销改为增量补丁或限制大表快照数量。

### P3：工程化

14. 引入 Vitest（算法/模型）+ Playwright（`file://` 交互）用例，把 `.probe` 里的验证固化进仓库。
15. 做 Firefox/Safari/macOS 的存储与交互矩阵测试。
16. 明确 `schemaVersion` 升级与迁移策略，导入时做结构校验。

---

## 9. 本轮验证覆盖说明

已验证：

- 持久化：IndexedDB、localStorage 降级、刷新、浏览器进程重启、同 profile 跨路径。
- 交互 18 项：拖动列宽/行高、右键菜单、双击编辑、复制粘贴、Ctrl+R 填充、冻结行列（含冻结区点击定位）、视角镜像、拖拽换座、导出 PNG、导出 XLSX（SheetJS 反解）、全量备份/导入、布局 JSON 导出/导入、保存后刷新仍在。
- 性能 4 个场景（见第 4 节）。

未验证：

- Firefox/Safari、macOS/Linux、移动端、触屏。
- localStorage 真正写满 5 MB 的降级表现（只做了代码路径推断）。
- 300×100 表的 PNG 导出（只做了尺寸推算）。
- 多窗口并发写、浏览器强杀进程时的最后写入完整性。
- 大体量名册（数千人）导入与排座。
