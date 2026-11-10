# 排座规则与算法口径

> 实现：`src/engine/seating.ts`（纯函数 `arrange()`、`applyRulesToProject()`）。
> 座位投影：`src/engine/sheet.ts` 的 `seatsInRow()` / `seatsOfSheet()`。
> 本文所有规则都可在代码里逐条对照；没有实现的能力不会写在这里。

---

## 1. 术语与编号

| 术语 | 定义 | 代码依据 |
|---|---|---|
| 排号 | 表格行索引 + 1；主席台行显示「主席台」，不参与台下排号排序 | `SeatRef.row`，UI 显示 `row + 1` |
| 座号 | 该行内从左到右的座位顺序，1 起；过道/空白/`block` 不占号，`disabled` 也不占号 | `seatsInRow()` 的 `no` |
| 主席台 | `SheetCell.kind === 'podium'` 的格 | `SeatRef.stage` |
| 台下 | 非主席台的可用座位（`seat` 且未 disabled） | `usable.filter(!stage)` |
| 双人位 | 一格 `seats: 2`，展开为两个座位，座号连续 | `seatsInRow()` |
| 自定义位 | 一格 `seats: N`（1–50，任意正整数），展开为 N 个座位 | `seatsInRow()` / `clampSeats()` |
| 禁用位 | `disabled: true`，保留占位、`seatNo = 0`、排座跳过 | `seatsInRow()` / `usable` |
| 锁定 | `Assignment.locked = true`，重排时保留 | `arrange()` 的 `keepLocked` 过滤 |

**排号不受合并/双人位影响**：行号就是排号；双人位只是让同一行多出座位。

---

## 2. 输入与整体流程

```ts
applyRulesToProject(project, roster, layout)
```

1. 候选池 = `participantIds`（空则名册中全部人员）；`Member.status = 'leave'` 与分配状态为 `absent` 的人被排除；
2. 收集全部座位：`seatsOfSheet(sheet)` → 过滤 `disabled` → 拆成主席台 / 台下；
3. 先落位锁定的旧分配（请假者一律不保留）；
4. 候选池按 职级 → 单位 → 名单序 排序（可选交替穿插）；
5. 主席台：按行升序，每行用主席台顺序落位；
6. 台下：按行升序，每行用台下顺序落位；
7. 输出 `assignments / unassigned / warnings`。

座位是「按队列逐座取人」：每取一个座位，从剩余候选池里找**第一个**满足职级限制的人。因此不满足当前座位分层的人会被跳过，但不改变候选池的全局顺序。

---

## 3. 候选排序

```
rank.order 升序
  → 单位路径（unit.order 逐级比较）升序
  → 名册 members 数组顺序
```

| 规则字段 | 取值 | 行为 |
|---|---|---|
| `unitOrder` | `continuous` | 同单位连续（默认） |
| `unitOrder` | `interleave` | **仅当 `keepListOrder = true`** 时生效：在每个职级分组内，按单位轮流取人（round-robin） |
| `keepListOrder` | `false` | 跳过交替逻辑，等价于 continuous |

> `keepListOrder` 当前只用于控制 interleave 是否生效，不改变基础排序（基础排序永远先职级、再单位、再名单序）。

单位路径由 `UnitNode.parentId/order` 逐级拼出（`unitPathOrder()`），支持多级单位。

---

## 4. 主席台落位

先按 `x` 升序（画布从左到右）排列该行可用座位，然后：

### 4.1 奇数个座位（n = 2k+1）

顺序：`k`（正中间）→ `k+1`（右侧第一）→ `k-1`（左侧第一）→ `k+2` → `k-2` → …

即 **1 号居中，2 号在画布右侧、3 号在画布左侧，之后左右交替**。

> 代码注释的口径是「2 号在就座者左侧（画布 x+）」：主席台人员面朝台下，其左手边对应画布右侧。

### 4.2 偶数个座位（n = 2k）

两个中心座位 `k-1`（左中）与 `k`（右中）的先后由 `evenCenterSide` 决定：

| `evenCenterSide` | 第 1 位 | 第 2 位 | 第 3 位 | 第 4 位 | 之后 |
|---|---|---|---|---|---|
| `left`（默认） | `k-1`（左中） | `k`（右中，2 号紧邻 1 号右侧） | `k-2`（1 号另一侧） | `k+1` | 左、右交替向外 |
| `right` | `k`（右中） | `k-1`（左中，2 号紧邻 1 号左侧） | `k+1`（1 号另一侧） | `k-2` | 右、左交替向外 |

> 每一轮固定「一个方向各取一座」，因此 3 号永远回到 1 号的**另一侧**。双人桌时 1、2 号常在同一张桌子上，若继续向 2 号外侧扩，3 号会和 1 号同侧，编号就错了（已修复并有回归断言）。

### 4.3 主席台的行与分层

- 多个主席台行时，按行号升序逐行落位（先上排后下排），候选池共享；
- 主席台调用 `tierRanksFor(seat, 0, rules)`：传入排号 `0`，因此**按排号的分层规则不会作用于主席台**；只有 `by: 'zone'` 且命中该格 `zoneId` 的分层规则会生效；
- 分层结果为空数组时按「不限职级」处理（这是必须的兜底，否则整块主席台会静默空着）。

---

## 5. 台下落位

```ts
hallOrder(rowSeats, rules.hallOrder, rules.evenCenterSide)
```

1. 该行座位按 `x` 升序；
2. 再按 `hallOrder` 取序：

| `hallOrder` | 座位顺序（x 升序之后） |
|---|---|
| `center-out`（默认） | 与主席台同一套 `centerOutOrder()`：1 号居中，2 号在其右侧，3 号在另一侧，左右交替 |
| `left-to-right` | 直接从左到右 |
| `right-to-left` | 从右到左 |

> 主席台与台下使用同一口径，没有「视角镜像」这个开关：编号只由座位自身的左右关系决定，不因观察视角而反转。

行顺序永远按表格行号升序；「第几排」就是行号 + 1。

---

## 6. 职级分层（tiers）

```ts
TierRule { id, by: 'row' | 'zone', from?, to?, zoneId?, rankIds[] }
```

| 判定 | 规则 |
|---|---|
| 区域优先 | 先找 `by='zone' && zoneId === seat.zoneId` 的规则；命中则**只**用这些规则 |
| 再按排号 | 没有区域规则时，找 `by='row'` 且 `from ≤ 排号 ≤ to`（`from` 缺省 1，`to` 缺省 999） |
| 合并方式 | 命中的所有规则的 `rankIds` 取并集 |
| 空集合 | 视为不限职级（`allowed = null`） |
| 无规则 | 不限职级 |
| 不匹配 | 该座位只能从 `rankIds` 包含的人里取；取不到就空着，并计入 `unassigned`/空位提示 |

排号口径：主席台固定传 `0`（不命中按排规则）；台下传 `row + 1`。

---

## 6.1 区域人员分配（zoneRules）

```ts
ZoneRule { id, zoneId, rankIds[], excludeRankIds[], memberIds[], enabled }
```

一个区域可以配置多条规则：`rankIds`、`excludeRankIds`、`memberIds` 都取并集。

| 优先级 | 配置 | 行为 |
|---|---|---|
| 1（最高） | `memberIds` 手动勾选人员 | 先于所有人落位：按「主席台行 → 台下排 → 居中向两侧」的顺序，占该区域第一个空座；不受职级限制 |
| 2 | `rankIds`（区域级别规则） | 该区域座位只从这些职级取人，**覆盖**同区域的职级分层规则 |
| 3 | `excludeRankIds` | 从该区域的可用职级中剔除；即使沿用了分层规则也会被剔除 |
| 4 | `tiers`（职级分层） | 区域没有级别规则时继续生效 |

冲突提示（写入 `warnings`）：

- 同一人被手动指定到多个区域 → 按第一个区域落位并提示；
- 手动指定的人不在本次排座名单（请假/未选）→ 忽略并提示；
- 区域座位已满仍有人被指定 → 提示「区域座位不足」；
- 区域级别规则在候选池里匹配不到人 → 提示；
- 区域同时配了级别规则与职级分层规则 → 提示「按区域规则优先」。

---

## 7. 锁定、请假、缺席

| 场景 | 行为 |
|---|---|
| `Assignment.locked = true` | 重排时原座位、原人员保留（前提：该 `seatId` 仍存在于当前布局） |
| `Member.status = 'leave'` | 不进入候选池、不占座；重排后其旧分配被清除 |
| `Member.status = 'present'` | 正常参与排座 |
| `Assignment.status = 'absent'` | 不保留；该人员也不进入候选池 |
| 重新切回在位 | 下次排座重新进入候选池 |
| 锁定人员 | 从候选池移除，不会重复安排 |
| 座位被删除 | 对应锁定分配静默丢弃（不会报错） |

`statuses` 由 `applyRulesToProject` 从 `Member.status` 生成，再用项目里 `absent/guest/leave` 的旧分配覆盖。请假状态属于人员而非座位，因此在「排座项目 → 名单」里切换即可生效。

---

## 8. 座位容量与座号

- 一格 `seats: N`（默认 1，上限 50）→ 展开为 N 个 `SeatRef`，`index` 分别为 1…N；
- `SheetInspector` 与操作栏都提供「单人位 / 双人位 / 自定义 N 人」，布局页与排座项目共用同一份数据；
- `SeatRef.seatNo` 是该排内从左到右的物理序号（固定空位为 0），只用于内部；界面、详情卡片与 Excel 导出显示的是 `seatOrderMap()` 按排座顺序生成的编号（中间 1、左右交替向外）；
- 同一格内的 N 个座位左右并排，中间留 4~8px 缝隙（`gap = clamp(w*0.04, 4, 8)`）；
- 主席台同样支持自定义容量（`kind: 'podium', seats: N`）；
- 合并区里的锚点是 `seat/podium` 时，座位按合并后的**整块矩形**展开，座号仍按行内顺序计；容量与合并块大小无关，互不限制。

---

## 9. 空位、禁用与过道

| 概念 | 数据表达 | 排座行为 |
|---|---|---|
| 空白格 | `cells` 无该键 | 不生成座位，不占号，不参与绘制 |
| 过道 | `kind: 'block', role: 'aisle'` | 不生成座位、不占号 |
| 讲台/背景板/标签 | `kind: 'block', role: 'lectern' \| 'backdrop' \| 'label'` | 同上 |
| 固定空位 | `kind: 'seat', disabled: true` | 生成 `SeatRef` 但 `seatNo = 0`，排座跳过，占位保留 |
| 纯视觉合并 | 锚点 `kind: 'seat'` + `merges` | 仍坐人；座位矩形取合并后矩形 |
| 合并成特殊块 | 锚点 `kind: 'block'` | 整块不坐人 |

---

## 10. 输出与提示

```ts
ArrangeResult {
  assignments: Assignment[]   // 每座位最多一条
  unassigned: string[]        // 候选池里没排到的人
  warnings: string[]          // 给 UI 的提示
}
```

提示规则（`arrange()` 末尾）：

- `freeSeats = 可用座位数 - 非请假分配数`；
- `freeSeats > 0 && unassigned.length === 0 && participants.length > 0` → 「还有 N 个座位空着」；
- `unassigned.length > 0` → 「N 人未排到座位（座位不足或受职级分层限制）」。

注意：`participantIds` 中不在名册里的 id 会被丢弃（`eliminated`），不计入 `unassigned`。

---

## 11. 规则字段速查

| UI 字段（`RuleSet`） | 可选值 | 影响 |
|---|---|---|
| `evenCenterSide` | `left` / `right` | 偶数座时 1 号取左中位还是右中位 |
| `hallOrder` | `center-out` / `left-to-right` / `right-to-left` | 台下每行取座方向 |
| `unitOrder` | `continuous` / `interleave` | 同职级内单位是否连续 |
| `tiers` | `TierRule[]` | 按排/区域限定职级 |
| `zoneRules` | `ZoneRule[]` | 区域人员分配（手动勾选 + 级别快捷指派 + 排除） |
| `keepListOrder` | `boolean` | 是否允许 interleave 生效（false 时强制连续） |

---

## 12. 用示例数据走一遍

种子布局（`src/db.ts` 的 `seedLayout()`）：

- 8 行 × 9 列；第 1 行 9 个主席台单人位；第 3 列（索引 2）为过道；第 3~8 行其余 8 格为双人位；
- 台下座位 = 6 排 × 8 格 × 2 = 96；可用座位合计 9 + 96 = 105；
- 名册 30 人，默认规则（center-out / continuous / 无分层）：
  - 主席台 9 人：1 号在第 5 列（正中），2 号在第 6 列，3 号在第 4 列，之后左右交替；
  - 台下从第 3 行开始，每行从中间向两侧取座；第 3 行坐满 16 人后进入第 4 行，剩 5 人；
  - 结果 105 行明细中，30 行有姓名，其余为「空位」。
- 导出 Excel 得到 105 条明细（含 9 个主席台 + 96 个台下座位），表头为
  `排号 / 座号 / 姓名 / 职级 / 单位 / 状态 / 锁定 / 区域`。

---

## 13. 边界与注意事项

1. **跳人效应**：`takeFor` 取「第一个满足限制的人」，当分层跳过某些人时，后面座位可能继续跳过同一批人，直到出现匹配限制的座位。这符合「按职级分层」的预期，但也意味着单位连续性会被分层打断。
2. **分层空集**：`rankIds: []` 被当作「不限」，不是「谁都不能坐」。
3. **锁定优先**：锁定分配先占座，主席台/台下取座时都排除这些座位；因此锁定可能打乱主席台的奇偶落位。
4. **视角不改变编号**：编号只由座位左右关系决定，没有镜像开关；主席台与台下同口径。
5. **重新排座会丢弃非锁定、非请假的旧分配**（重新计算），需要保留的手动调整必须勾选锁定。
