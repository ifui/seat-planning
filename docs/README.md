# 座位编排系统（seat-planning）

> 单文件离线版会场排座工具：维护名册与组织、用 Excel 式工作表绘制会场、按规则自动排座、导出座位图与名单。
> 产物是一个可双击打开的 `index.html`，不依赖服务器、不加载任何外部资源。

---

## 1. 项目是什么

一个面向会务人员的本地排座工具，覆盖四件事：

1. **名册与组织**：职级（含排序与配色）、单位树（支持多级）、人员（支持别名、在位/请假状态）。
2. **会场布局**：用工作表（行=排、列=座）画出会场；每格可设为座位（单人/双人）、主席台座位或特殊块（过道/讲台/背景板/标签），支持合并单元格、区域着色。
3. **排座项目**：把一套名册 + 一个布局组合成一次会议，按规则自动排座，之后可手动换座、锁定、标记缺席/来宾；在位/请假在项目右侧「名单」里切换，请假者不参与排座，并保留排座前快照。
4. **导出**：PNG 座位图（3× 画布）、XLSX 明细、布局 JSON、全量备份 JSON。

核心约束（本项目所有设计都服从它）：

- 交付物是**单个 HTML**，`file://` 双击可用；
- **零外链**：不请求 CDN、字体、图片，所有 JS/CSS/图标内联；
- 排号由表格行决定、座号由行内顺序决定，不做坐标反推。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Vue 3.5 `<script setup>` + TypeScript 5.6 | 参考 `src/main.ts`、`src/App.vue` |
| 构建 | Vite 6 + `vite-plugin-singlefile` | 见 `vite.config.ts`，所有资源内联进单个 HTML |
| 存储 | Dexie 4（IndexedDB）+ localStorage 降级 | 见 `src/db.ts` |
| 表格读写 | SheetJS `xlsx` 0.18 | 参会名单导入（排座项目页）、排座结果明细导出 |
| 图表 | ECharts 5（按需引入 pie/bar + 必要组件） | 见 `src/ui/charts.ts`、`src/ui/components/UiChart.vue` |
| 图标 | 内联 SVG 组件 `src/ui/components/UiIcon.vue` | 无图标字体、无外链 |

## 3. 安装、开发、构建

```bash
cd D:\work\project\seat-planning
npm install
npm run dev        # 本地开发（Vite dev server）
npm run build      # vue-tsc --noEmit 类型检查 + 构建单文件离线包
npm run build:fast # 跳过类型检查，仅构建
npm run preview    # 预览构建产物
npm run desktop:dev   # 桌面端开发（Tauri v1，Rust 1.77.2）
npm run desktop:build # 桌面端安装包（MSI / NSIS）
```

构建产物固定为 `dist/index.html`。当前构建体积约 **1.41 MB（1,407,343 字节）**，实测 `src`/`href` 指向 `http(s)` 的外链数为 0（JS 内部有 SVG/XML 命名空间字符串，不是网络请求）。

## 4. 如何产出与使用离线包

1. `npm run build`；
2. 取 `dist/index.html`，改名为任意名字（例如 `座位编排系统.html`）后分发；
3. 双击用 Edge / Chrome 打开即可，无需联网、无需安装。

数据保存在**打开它的浏览器**里，不写回 HTML 文件：

| 优先级 | 后端 | 触发条件 | 存储位置 |
|---|---|---|---|
| 1 | IndexedDB（Dexie） | 浏览器允许 | 库 `seat-planning-v2`，表 `rosters/layouts/projects/snapshots/settings` |
| 2 | localStorage | IndexedDB 被策略禁用/不可用 | 键 `seat-planning:v2`（单键 JSON） |
| 3 | 内存 | 两者都被禁用 | 数据仅本次页面有效，侧栏会提示 |

侧栏底部会显示当前实际使用的后端。切换浏览器、切换用户目录、清理浏览器数据都会导致数据不可见——**重要数据请用「排座项目 → 导出 → 全量备份」导出 JSON**。

实测结论（Edge 157 / Chromium，`file://`）见 [known-issues.md](./known-issues.md) 与 [changelog.md](./changelog.md)：

- 实测的 Edge 157 在 `file://` 下允许 IndexedDB，刷新、关闭标签页、重启浏览器进程后数据仍在（未测 Chrome/Firefox/Safari）；
- 人为禁用 IndexedDB 后自动降级 localStorage，同样可跨刷新/跨进程保留；同一浏览器 profile 下，把 HTML 复制到另一个目录打开，仍能看到同一份数据（localStorage 按 profile + 源共享）；
- 示例数据的 localStorage 体量约 16 KB，远低于常见 5 MB 配额。

## 5. 目录结构总览

```
seat-planning/
├─ index.html                 入口 HTML（构建时被内联）
├─ vite.config.ts             Vite + singlefile 配置
├─ package.json
├─ docs/                      接手文档（本目录）
├─ src/
│  ├─ main.ts                 挂载 Vue
│  ├─ App.vue                 三栏外壳与三个导航（名册与组织/会场布局/排座项目）
│  ├─ types.ts                全部领域类型与 DEFAULT_RULESET
│  ├─ db.ts                   Dexie 定义、种子数据、存储层（IndexedDB/localStorage/memory）、全量导入导出
│  ├─ store.ts                全局响应式数据（state）与持久化 API（loadAll/save*/remove*）
│  ├─ engine/
│  │  ├─ sheet.ts             工作表模型：稀疏单元格、合并、行列增删、座位投影、批量填充、uid/nowISO
│  │  ├─ seating.ts           排座算法：排序、主席台顺序、台下顺序、职级分层、锁定/请假排除
│  │  └─ render.ts            Canvas 座位图绘制（PNG 导出）
│  ├─ views/
│  │  ├─ RosterView.vue       名册与人员（人员列表、状态、入口）
│  │  ├─ RankView.vue         职级管理（名称、排序、配色）
│  │  ├─ UnitView.vue         单位树管理
│  │  ├─ LayoutView.vue       会场布局工作台（表格编辑器）
│  │  └─ ProjectView.vue      排座项目（座位图、概览、列表、规则、导出）
│  ├─ components/
│  │  ├─ sheet/               表格编辑器组件（网格、单元格、工具栏、属性面板、对话框）
│  │  ├─ project/SeatBoardPane.vue  项目页座位图外壳
│  │  ├─ SeatBoard.vue        座位图（按 sheet 投影）
│  │  ├─ RulesPanel.vue       规则面板
│  │  └─ ...
│  ├─ composables/
│  │  └─ useLayoutHistory.ts  布局撤销/重做（整表快照，上限 80）
│  └─ ui/                     基础件：UiButton/UiModal/UiSelect/UiContextMenu/UiChart/UiIcon 等
└─ dist/                      构建产物（git 忽略）
```

完整模块职责见 [architecture.md](./architecture.md)。

## 6. 常用操作速查

**画布局**

- 单击选中、拖拽框选、Shift 扩选；方向键/Tab/Enter 移动，F2 或双击编辑，Delete 清空；
- `Ctrl+C / Ctrl+V` 复制粘贴，`Ctrl+D` 向下填充、`Ctrl+R` 向右填充，`Ctrl+Z / Ctrl+Y` 撤销重做，`Ctrl+A` 全选；
- 拖表头边界改列宽/行高；工具栏可合并/拆分、设为座位/主席台/特殊块、设单双人位；
- 在行号 / 列标上右键：上下/左右插入 1 条或自定义 N 条（1–50），以及删除当前行/列；删除会二次确认并列出受影响项目的已排人员；
- 「表格设置」里可改行列数与冻结行/列（最多各 5）；
- 右键菜单提供同一批单元格操作。

**排座**

- 选项目 → 「开始排座」；排座前会自动存一份快照；
- 规则面板可切换台下顺序、视角（观众/主席台）、单位连续/交替、职级分层；请假人员在「名单」里切换，排座时自动跳过，切换为请假会立即从当前座位安排中移出；
- 座位图支持拖拽换座；点击座位会在其上方/下方弹出详情卡片，可改状态、锁定、清空或安排空位。

**导出**

- 导出 PNG：3× 座位图；导出 Excel：排号/座号（按排座顺序）/姓名/职级/单位/状态/锁定/区域；
- 布局页「导出」得到单布局 JSON；项目页「全量备份」得到名册+布局+项目+快照的 JSON。

## 7. 验证方式

仓库内没有单元测试框架，验证靠两类手段：

- **类型与构建**：`npm run build`（含 `vue-tsc --noEmit`）；
- **浏览器实测**：`.probe/` 下的 Node + CDP 脚本（Edge headless）。这些脚本只在本机使用，已被 `.gitignore` 忽略，不随仓库交付。

已实测通过的交互（本轮验收，18 项）：拖动列宽/行高、右键菜单、双击编辑、复制粘贴、Ctrl+R 填充、冻结行列（含冻结区点击定位）、视角镜像、拖拽换座、导出 PNG、导出 XLSX（并用 SheetJS 反解校验）、全量备份与导入、布局 JSON 导出与导入、保存后刷新仍在。明细见 [changelog.md](./changelog.md)。

## 8. 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | 分层、模块职责、数据流、状态与持久化、渲染策略 |
| [data-model.md](./data-model.md) | 全部实体字段、TS 摘录、最小示例 JSON、不变式 |
| [seating-rules.md](./seating-rules.md) | 排座算法口径与可执行规则表 |
| [decisions.md](./decisions.md) | ADR：关键技术与产品决策 |
| [changelog.md](./changelog.md) | 迭代日志与每轮需求落地情况 |
| [known-issues.md](./known-issues.md) | 已知缺陷、限制、风险与下一步 |
| [desktop-packaging.md](./desktop-packaging.md) | 桌面端打包：体积、WebView2 分发模式、Win7 支持与部署检查单 |
