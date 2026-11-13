<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Member, Project, RankDef, RosterPlan, UnitNode } from "../types";
import { removeRoster, saveProject, saveRoster, state } from "../store";
import { nowISO, uid } from "../engine/sheet";
import {
  UiButton,
  UiChart,
  UiIcon,
  UiIconButton,
  UiInput,
  UiSelect,
  UiModal,
  COLOR_PRESETS,
} from "../ui";
import {
  chartAxisText,
  chartColors,
  chartFont,
  chartTooltip,
  type ChartOption,
} from "../ui/charts";
import ImportDialog from "../components/roster/ImportDialog.vue";
import {
  planRankInputs,
  planUnitInputs,
  unitPathOf,
} from "../engine/unitMatch";

const emit = defineEmits<{
  (e: "open-ranks", rosterId: string): void;
  (e: "open-units", rosterId: string): void;
}>();

const selectedId = ref<string>(state.rosters[0]?.id ?? "");
const draft = ref<RosterPlan | null>(null);
const dirty = ref(false);
const toast = ref("");
/** 仅用于表格行的选中高亮，不参与任何业务逻辑。 */
const activeId = ref<string | null>(null);
let loading = false;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

async function load(id: string): Promise<void> {
  if (dirty.value && draft.value && draft.value.id !== id)
    await flushAutosave();
  const found = state.rosters.find((r) => r.id === id);
  loading = true;
  draft.value = found ? clone(found) : null;
  dirty.value = false;
  setTimeout(() => {
    loading = false;
  }, 0);
}

watch(selectedId, (id) => load(id), { immediate: true });
watch(
  draft,
  () => {
    if (draft.value && !loading) markDirty();
  },
  { deep: true },
);

// ---- 自动保存：停止编辑 900ms 后落盘 ----
let autosaveTimer = 0;
let autosaveSeq = 0;

function markDirty(): void {
  dirty.value = true;
  autosaveSeq++;
  const seq = autosaveSeq;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    if (seq !== autosaveSeq || !dirty.value || !draft.value) return;
    try {
      await saveRoster(draft.value);
      if (seq === autosaveSeq) dirty.value = false;
    } catch (e: any) {
      flash(e?.message || "保存失败");
    }
  }, 900);
}

async function flushAutosave(): Promise<void> {
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  if (!dirty.value || !draft.value) return;
  try {
    await saveRoster(draft.value);
    dirty.value = false;
  } catch (e: any) {
    flash(e?.message || "保存失败");
  }
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = "";
}

onMounted(() => window.addEventListener("beforeunload", onBeforeUnload));
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.clearTimeout(autosaveTimer);
  void flushAutosave();
});
watch(
  () => state.rosters.map((r) => r.id).join(","),
  () => {
    if (!state.rosters.some((r) => r.id === selectedId.value))
      selectedId.value = state.rosters[0]?.id ?? "";
    else if (!draft.value) load(selectedId.value);
  },
);

function flash(msg: string): void {
  toast.value = msg;
  setTimeout(() => {
    toast.value = "";
  }, 2200);
}

const rosterOptions = computed(() =>
  state.rosters.map((r) => ({ value: r.id, label: r.name })),
);

const sortedRanks = computed(() =>
  draft.value ? [...draft.value.ranks].sort((a, b) => a.order - b.order) : [],
);

const rankOptions = computed(() =>
  sortedRanks.value.map((r) => ({
    value: r.id,
    label: r.name,
    color: r.color,
  })),
);

interface UnitPath {
  node: UnitNode;
  depth: number;
  pathName: string;
  path: number[];
}

const unitPaths = computed<UnitPath[]>(() => {
  if (!draft.value) return [];
  const byId = new Map(draft.value.units.map((u) => [u.id, u]));
  const pathOf = (u: UnitNode): string => {
    const names: string[] = [u.name];
    let p = u.parentId ? byId.get(u.parentId) : undefined;
    let guard = 0;
    while (p && guard++ < 20) {
      names.unshift(p.name);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return names.join(" / ");
  };
  const orderOf = (u: UnitNode): number[] => {
    const out: number[] = [u.order];
    let p = u.parentId ? byId.get(u.parentId) : undefined;
    let guard = 0;
    while (p && guard++ < 20) {
      out.unshift(p.order);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return out;
  };
  const depthOf = (u: UnitNode): number => {
    let d = 0;
    let p = u.parentId ? byId.get(u.parentId) : undefined;
    let guard = 0;
    while (p && guard++ < 20) {
      d++;
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return d;
  };
  return [...draft.value.units]
    .map((u) => ({
      node: u,
      depth: depthOf(u),
      pathName: pathOf(u),
      path: orderOf(u),
    }))
    .sort((a, b) => {
      const n = Math.min(a.path.length, b.path.length);
      for (let i = 0; i < n; i++)
        if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
      return a.path.length - b.path.length;
    });
});

const unitOptions = computed(() =>
  unitPaths.value.map((u) => ({ value: u.node.id, label: u.pathName })),
);

const rankColor = (id: string): string =>
  draft.value?.ranks.find((r) => r.id === id)?.color ?? "#939b9a";
const rankName = (id: string): string =>
  draft.value?.ranks.find((r) => r.id === id)?.name ?? "未定级";
const unitName = (id: string): string =>
  draft.value?.units.find((u) => u.id === id)?.name ?? "未分配";

async function save(): Promise<void> {
  if (!draft.value) return;
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  try {
    await saveRoster(draft.value);
    dirty.value = false;
    flash("名册已保存");
  } catch (e: any) {
    flash(e?.message || "保存失败");
  }
}

async function createPlan(): Promise<void> {
  const base = state.rosters[0];
  const plan: RosterPlan = {
    id: uid("roster"),
    name: `名册方案${state.rosters.length + 1}`,
    ranks: base
      ? clone(base.ranks)
      : [{ id: uid("rank"), name: "一级", order: 0, color: "#3D5A6C" }],
    units: base
      ? clone(base.units)
      : [{ id: uid("unit"), name: "机关", parentId: null, order: 0 }],
    members: [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  try {
    await saveRoster(plan);
  } catch (e: any) {
    flash(e?.message || "新建名册失败");
    return;
  }
  selectedId.value = plan.id;
  flash("已新建名册方案");
}

// ---- 重命名 ----
const renameOpen = ref(false);
const renameValue = ref("");

function openRename(): void {
  if (!draft.value) return;
  renameValue.value = draft.value.name;
  renameOpen.value = true;
}

function confirmRename(): void {
  if (!draft.value) return;
  const name = renameValue.value.trim();
  if (!name) return;
  draft.value.name = name;
  renameOpen.value = false;
  flash("名称已修改，记得保存");
}

// ---- 删除方案 ----
const confirmState = ref<{
  open: boolean;
  title: string;
  desc: string;
  points?: string[];
  action: () => void;
}>({
  open: false,
  title: "",
  desc: "",
  points: [],
  action: () => {},
});

function ask(
  title: string,
  desc: string,
  action: () => void,
  points: string[] = [],
): void {
  confirmState.value = { open: true, title, desc, points, action };
}

function runConfirm(): void {
  confirmState.value.action();
  confirmState.value.open = false;
}

function askDeletePlan(): void {
  if (!draft.value) return;
  if (state.rosters.length <= 1) {
    flash("至少保留一套名册方案");
    return;
  }
  ask(
    "删除名册方案",
    `「${draft.value.name}」将被删除。已创建的排座项目保留自己的名册快照，不受影响；之后新建项目将无法再选择它。`,
    async () => {
      autosaveSeq++;
      window.clearTimeout(autosaveTimer);
      dirty.value = false;
      await removeRoster(draft.value!.id);
      selectedId.value = state.rosters[0]?.id ?? "";
      flash("已删除");
    },
  );
}

// ---- 人员筛选 ----
const search = ref("");
const filterUnit = ref<string | undefined>();
const filterRank = ref<string | undefined>();
const filterDuty = ref<string | undefined>();

const dutyOptions = computed(() => {
  const set = new Set<string>();
  for (const m of draft.value?.members ?? [])
    if (m.duty?.trim()) set.add(m.duty.trim());
  return [...set]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((d) => ({ value: d, label: d }));
});

/** 职级顺序索引：按职级定义 order 升序，未匹配到职级的人排最后 */
const rankOrderIndex = computed(() => {
  const map = new Map<string, number>();
  sortedRanks.value.forEach((r, i) => map.set(r.id, i));
  return map;
});

/**
 * 列表展示顺序。默认按职级序列（同级沿用 member.order），
 * 用户拖拽过后 manualOrder = true，完全以 member.order 为准。
 * 仅在展示层排序，不改写数据；排座仍读 member.order。
 */
const baseList = computed(() => {
  const d = draft.value;
  if (!d) return [];
  if (d.manualOrder) return d.members;
  const idx = rankOrderIndex.value;
  return [...d.members].sort((a, b) => {
    const ra = idx.get(a.rankId) ?? Number.MAX_SAFE_INTEGER;
    const rb = idx.get(b.rankId) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || (a.order ?? 0) - (b.order ?? 0);
  });
});

const visibleMembers = computed(() => {
  if (!draft.value) return [];
  const q = search.value.trim();
  return baseList.value.filter((m) => {
    if (filterUnit.value && m.unitId !== filterUnit.value) return false;
    if (filterRank.value && m.rankId !== filterRank.value) return false;
    if (filterDuty.value && (m.duty ?? "") !== filterDuty.value) return false;
    if (q && !m.name.includes(q) && !(m.duty ?? "").includes(q)) return false;
    return true;
  });
});

const rankCounts = computed(() => {
  const map = new Map<string, number>();
  for (const m of draft.value?.members ?? [])
    map.set(m.rankId, (map.get(m.rankId) ?? 0) + 1);
  return sortedRanks.value.map((r) => ({ rank: r, count: map.get(r.id) ?? 0 }));
});

const hasFilter = computed(
  () =>
    !!search.value.trim() ||
    !!filterUnit.value ||
    !!filterRank.value ||
    !!filterDuty.value,
);

/** 单位人数按人数降序；超过 6 个单位时收成前 5 + 其他，避免条形图过长。 */
const unitRows = computed(() => {
  const map = new Map<string, number>();
  for (const m of draft.value?.members ?? [])
    map.set(m.unitId, (map.get(m.unitId) ?? 0) + 1);
  const rows = [...map.entries()].map(([id, count]) => ({
    id,
    label: unitName(id),
    path:
      unitPaths.value.find((u) => u.node.id === id)?.pathName ?? unitName(id),
    count,
  }));
  rows.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"),
  );
  if (rows.length > 6) {
    const rest = rows.slice(5);
    rows.splice(5, rest.length, {
      id: "__other",
      label: `其他 ${rest.length} 个单位`,
      path: `其他 ${rest.length} 个单位`,
      count: rest.reduce((n, r) => n + r.count, 0),
    });
  }
  return rows;
});

const rankChartHeight = computed(() => {
  const n = rankCounts.value.filter((r) => r.count > 0).length;
  return n ? Math.min(210, Math.max(96, n * 30 + 8)) : 96;
});
const unitChartHeight = computed(() => {
  const n = unitRows.value.length;
  return n ? Math.min(200, Math.max(110, n * 28 + 8)) : 96;
});

/** 职级分布：按职级序列自上而下，沿用职级定义色，条形与表格圆点一一对应。 */
const rankChart = computed<ChartOption | null>(() => {
  const rows = rankCounts.value.filter((r) => r.count > 0);
  if (!rows.length) return null;
  return {
    animationDuration: 320,
    grid: { left: 0, right: 20, top: 6, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: "axis",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(74, 124, 123, .06)" },
      },
      formatter: "{b}<br/>{c} 人",
    },
    xAxis: {
      type: "value",
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.rank.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        ...chartAxisText,
        width: 62,
        overflow: "truncate",
        ellipsis: "…",
      },
    },
    series: [
      {
        type: "bar",
        data: rows.map((r) => ({
          value: r.count,
          itemStyle: { color: r.rank.color },
        })),
        barWidth: 9,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        showBackground: true,
        backgroundStyle: {
          color: chartColors.bgHover,
          borderRadius: [0, 4, 4, 0],
        },
        label: {
          show: true,
          position: "right",
          distance: 6,
          color: chartColors.muted,
          fontSize: 11,
          fontFamily: chartFont,
        },
      },
    ],
  };
});

/** 单位人数：横向条形，长名称截断、完整路径进 tooltip。 */
const unitChart = computed<ChartOption | null>(() => {
  if (!unitRows.value.length) return null;
  const rows = unitRows.value;
  return {
    animationDuration: 320,
    grid: { left: 0, right: 20, top: 6, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: "axis",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(74, 124, 123, .06)" },
      },
      formatter: (p: any) => {
        const row = rows[(Array.isArray(p) ? p[0] : p).dataIndex];
        return `${row.path}<br/>${row.count} 人`;
      },
    },
    xAxis: {
      type: "value",
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        ...chartAxisText,
        width: 66,
        overflow: "truncate",
        ellipsis: "…",
      },
    },
    series: [
      {
        type: "bar",
        data: rows.map((r) => r.count),
        barWidth: 9,
        itemStyle: { color: chartColors.primary, borderRadius: [0, 4, 4, 0] },
        showBackground: true,
        backgroundStyle: {
          color: chartColors.bgHover,
          borderRadius: [0, 4, 4, 0],
        },
        label: {
          show: true,
          position: "right",
          distance: 6,
          color: chartColors.muted,
          fontSize: 11,
          fontFamily: chartFont,
        },
      },
    ],
  };
});

function clearFilters(): void {
  search.value = "";
  filterUnit.value = undefined;
  filterRank.value = undefined;
  filterDuty.value = undefined;
}

// ---- 拖拽排序：名册顺序完全由用户决定，不做任何自动排序 ----
const dragId = ref<string | null>(null);
const dropTarget = ref<{ id: string; after: boolean } | null>(null);

/** 增删或拖拽后把 order 重编为连续序号，排座直接读取这个顺序 */
function reindexMembers(): void {
  draft.value?.members.forEach((m, i) => {
    m.order = i;
  });
}

function onDragStart(id: string, e: DragEvent): void {
  if (hasFilter.value) {
    e.preventDefault();
    return;
  }
  dragId.value = id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  }
}

function onDragOver(id: string, e: DragEvent): void {
  if (!dragId.value || dragId.value === id) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = { id, after: e.clientY > rect.top + rect.height / 2 };
}

function onDrop(): void {
  const target = dropTarget.value;
  const d = draft.value;
  if (!d || !dragId.value || !target) {
    onDragEnd();
    return;
  }
  // 默认视图按职级排序：拖拽前先把数组落成当前可见顺序，
  // 再按落点插入，保证「拖到哪就是哪」；之后改为手动顺序。
  const wasAuto = !d.manualOrder;
  if (wasAuto) {
    d.members = [...baseList.value];
    d.manualOrder = true;
  }
  const from = d.members.findIndex((m) => m.id === dragId.value);
  if (from < 0) {
    onDragEnd();
    return;
  }
  const [moved] = d.members.splice(from, 1);
  let to = d.members.findIndex((m) => m.id === target.id);
  if (to < 0) to = d.members.length;
  else if (target.after) to += 1;
  d.members.splice(to, 0, moved);
  reindexMembers();
  flash(
    wasAuto
      ? `已切换为手动顺序，并调整「${moved.name}」的位置`
      : `已调整「${moved.name}」的顺序`,
  );
  onDragEnd();
}

/** 恢复默认：按职级序列展示（不改动 member.order，去掉手动标记即可） */
function resetSortOrder(): void {
  if (!draft.value) return;
  draft.value.manualOrder = false;
  flash("已恢复按职级排序");
}

function onDragEnd(): void {
  dragId.value = null;
  dropTarget.value = null;
}

// ---- 人员编辑 ----
const memberOpen = ref(false);
const editingId = ref<string | null>(null);
const form = ref({
  name: "",
  unitId: "" as string,
  rankId: "" as string,
  duty: "",
  aliases: "",
});

function openAddMember(): void {
  if (!draft.value) return;
  editingId.value = null;
  form.value = {
    name: "",
    unitId: draft.value.units[0]?.id ?? "",
    rankId: sortedRanks.value[sortedRanks.value.length - 1]?.id ?? "",
    duty: "",
    aliases: "",
  };
  memberOpen.value = true;
}

function openEditMember(m: Member): void {
  editingId.value = m.id;
  form.value = {
    name: m.name,
    unitId: m.unitId,
    rankId: m.rankId,
    duty: m.duty ?? "",
    aliases: m.aliases.join("、"),
  };
  memberOpen.value = true;
}

function submitMember(): void {
  if (!draft.value) return;
  const f = form.value;
  if (!f.name.trim()) {
    flash("请填写姓名");
    return;
  }
  if (!f.unitId || !f.rankId) {
    flash("请选择单位与职级");
    return;
  }
  const aliases = f.aliases
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const duty = f.duty.trim() || undefined;
  if (editingId.value) {
    const m = draft.value.members.find((x) => x.id === editingId.value);
    if (m)
      Object.assign(m, {
        name: f.name.trim(),
        unitId: f.unitId,
        rankId: f.rankId,
        duty,
        aliases,
      });
    flash("人员已更新，记得保存");
  } else {
    draft.value.members.push({
      id: uid("m"),
      name: f.name.trim(),
      unitId: f.unitId,
      rankId: f.rankId,
      duty,
      aliases,
      status: "present",
    });
    reindexMembers();
    flash("人员已添加，记得保存");
  }
  memberOpen.value = false;
}

function askDeleteMember(m: Member): void {
  ask("移除人员", `确定从名册中移除「${m.name}」？已排座项目不受影响。`, () => {
    if (!draft.value) return;
    draft.value.members = draft.value.members.filter((x) => x.id !== m.id);
    reindexMembers();
  });
}

// ---- 批量模式与多选 ----
/** 默认列表保持干净：进入批量模式才显示复选框、拖拽手柄与批量操作条 */
const batchMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
let anchorId: string | null = null;

function enterBatch(): void {
  batchMode.value = true;
  clearSelection();
}

function exitBatch(): void {
  batchMode.value = false;
  clearSelection();
}

const allVisibleSelected = computed(
  () =>
    visibleMembers.value.length > 0 &&
    visibleMembers.value.every((m) => selectedIds.value.has(m.id)),
);
const someVisibleSelected = computed(() =>
  visibleMembers.value.some((m) => selectedIds.value.has(m.id)),
);

function clearSelection(): void {
  selectedIds.value = new Set();
  anchorId = null;
}

function toggleOne(m: Member): void {
  const next = new Set(selectedIds.value);
  if (next.has(m.id)) next.delete(m.id);
  else next.add(m.id);
  selectedIds.value = next;
  anchorId = m.id;
}

/** Shift 连选：以最近一次点击为锚点，按当前可见列表连续选中 */
function selectRange(m: Member, additive: boolean): void {
  const list = visibleMembers.value.map((v) => v.id);
  const a = anchorId ? list.indexOf(anchorId) : -1;
  const b = list.indexOf(m.id);
  if (a < 0 || b < 0) {
    toggleOne(m);
    return;
  }
  const [s, e] = a < b ? [a, b] : [b, a];
  const next = additive ? new Set(selectedIds.value) : new Set<string>();
  for (let i = s; i <= e; i++) next.add(list[i]);
  selectedIds.value = next;
}

/**
 * 行点击只负责定位当前行；批量模式下切换该行选中（Shift 连选）。
 * 复选框单元格已 @click.stop，不会走到这里，也不会改写选中集合。
 */
function onRowClick(m: Member, e: MouseEvent): void {
  activeId.value = m.id;
  if (!batchMode.value) return;
  if (e.shiftKey && anchorId) {
    selectRange(m, true);
    return;
  }
  toggleOne(m);
}

/** 复选框单元格空白处点击：等同于勾选该行 */
function onCheckCellClick(m: Member, e: MouseEvent): void {
  if (e.shiftKey && anchorId) {
    selectRange(m, true);
    return;
  }
  toggleOne(m);
}

/**
 * 复选框的选中状态以原生 change 为准，不拦截默认行为。
 *
 * 曾经的写法是单元格 @click.prevent + :checked 受控，结果「状态已选、复选框没勾上」：
 * Chrome 在派发 click 之前就把 checked 切成新值（pre-click activation），
 * 我们在处理器里 preventDefault 后，浏览器会在事件派发返回之后（宏任务阶段）
 * 回滚到旧值；而 Vue 的渲染队列在微任务里已经执行并把 checked 写回 true，
 * 紧接着就被这次回滚覆盖——所以状态（已选 N 人、行高亮）是对的，DOM 勾选是错的。
 * 因此这里彻底不 preventDefault：原生切换 → change 回写状态 → Vue 只做幂等回显。
 */
let checkShift = false;

function onCheckClickMods(e: MouseEvent): void {
  checkShift = e.shiftKey;
}

function onCheckChange(m: Member, e: Event): void {
  const input = e.target as HTMLInputElement;
  const shift = checkShift;
  checkShift = false;
  if (shift && anchorId && anchorId !== m.id) {
    selectRange(m, true);
    // 范围选择一定包含本次点击行；原生刚把它取反，按最终状态同步回来
    input.checked = selectedIds.value.has(m.id);
    return;
  }
  const next = new Set(selectedIds.value);
  if (input.checked) next.add(m.id);
  else next.delete(m.id);
  selectedIds.value = next;
  anchorId = m.id;
}

function toggleAllVisible(): void {
  const next = new Set(selectedIds.value);
  if (allVisibleSelected.value)
    for (const m of visibleMembers.value) next.delete(m.id);
  else for (const m of visibleMembers.value) next.add(m.id);
  selectedIds.value = next;
  anchorId = null;
}

/** 删除/筛选后清理已不存在的选中项 */
watch(visibleMembers, () => {
  if (!draft.value) {
    clearSelection();
    return;
  }
  const alive = new Set(draft.value.members.map((m) => m.id));
  const next = new Set([...selectedIds.value].filter((id) => alive.has(id)));
  if (next.size !== selectedIds.value.size) selectedIds.value = next;
});

/** 删除影响说明：请假、项目座位、固定座位、快照口径 */
function deleteImpact(ids: Set<string>): string[] {
  const d = draft.value;
  if (!d) return [];
  const picked = d.members.filter((m) => ids.has(m.id));
  if (!picked.length) return [];
  const leave = picked.filter((m) => m.status === "leave").length;
  const projects = state.projects.filter(
    (p) => p.rosterPlanId === d.id || p.rosterSnapshot?.id === d.id,
  );
  let seatRefs = 0;
  let fixedRefs = 0;
  let liveCount = 0;
  for (const p of projects) {
    seatRefs += p.assignments.filter((a) => ids.has(a.memberId)).length;
    fixedRefs += Object.values(p.seatOverlay?.fixedSeats ?? {}).filter((mid) =>
      ids.has(mid),
    ).length;
    if (!p.rosterSnapshot) liveCount++;
  }
  const points: string[] = [];
  if (leave)
    points.push(
      `${picked.length} 人中有 ${leave} 人处于请假状态，请假记录随人员一并移除。`,
    );
  if (projects.length) {
    points.push(
      `涉及 ${projects.length} 个排座项目、${seatRefs} 个座位分配、${fixedRefs} 个固定座位引用。`,
    );
    points.push(
      "这些项目各自保留创建时的名册快照（历史副本），已排座位与名单不会被改动。",
    );
    if (liveCount)
      points.push(
        `未冻结快照的 ${liveCount} 个项目会同步解除这些人员的座位分配、固定座位与参会名单引用。`,
      );
  } else {
    points.push("当前没有排座项目引用这套名册。");
  }
  points.push("名册方案本身保留，删除后不可撤销。");
  return points;
}

/** 批量删除统一入口：表格多选与重名查重共用同一套影响说明与清理逻辑 */
function askDeleteMembers(ids: Set<string>): void {
  const d = draft.value;
  if (!d) return;
  const alive = new Set(
    [...ids].filter((id) => d.members.some((m) => m.id === id)),
  );
  if (!alive.size) return;
  const live: Project[] = state.projects.filter(
    (p) =>
      (p.rosterPlanId === d.id || p.rosterSnapshot?.id === d.id) &&
      !p.rosterSnapshot,
  );
  ask(
    "批量移除人员",
    `将从「${d.name}」移出 ${alive.size} 人。`,
    async () => {
      d.members = d.members.filter((m) => !alive.has(m.id));
      reindexMembers();
      await saveRoster(d);
      dirty.value = false;
      for (const p of live) {
        p.assignments = p.assignments.filter((a) => !alive.has(a.memberId));
        p.participantIds = p.participantIds.filter((id) => !alive.has(id));
        p.unassigned = p.unassigned.filter((id) => !alive.has(id));
        const fixed = p.seatOverlay?.fixedSeats;
        if (fixed) {
          for (const seat of Object.keys(fixed))
            if (alive.has(fixed[seat])) delete fixed[seat];
        }
        await saveProject(p);
      }
      selectedIds.value = new Set();
      anchorId = null;
      dupSelected.value = new Set(
        [...dupSelected.value].filter((id) =>
          d.members.some((m) => m.id === id),
        ),
      );
      flash(`已移除 ${alive.size} 人`);
    },
    deleteImpact(alive),
  );
}

function askDeleteSelected(): void {
  if (!selectedIds.value.size) return;
  askDeleteMembers(new Set(selectedIds.value));
}

// ---- 查找重复名字 ----
interface DupRow {
  member: Member;
  /** 本组内还有同单位的同名记录 */
  sameUnit: boolean;
  /** 同单位里默认保留的那一个（名册顺序最靠前） */
  keeper: boolean;
}
interface DupGroup {
  name: string;
  rows: DupRow[];
  unitCount: number;
}

const dupOpen = ref(false);
const dupExpanded = ref<Set<string>>(new Set());
const dupSelected = ref<Set<string>>(new Set());

/**
 * 按姓名分组。组内按名册 order 排好后，每个单位只保留第一个人：
 * 同单位重复默认保留 order 最靠前的那位，其余默认勾选待处理；
 * 同名不同单位视为不同的人，各自保留、默认不勾。
 */
const dupGroups = computed<DupGroup[]>(() => {
  const members = draft.value?.members ?? [];
  const byName = new Map<string, Member[]>();
  for (const m of members) {
    const key = m.name.trim();
    if (!key) continue;
    const arr = byName.get(key);
    if (arr) arr.push(m);
    else byName.set(key, [m]);
  }
  const groups: DupGroup[] = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const unitCount = new Map<string, number>();
    for (const m of sorted)
      unitCount.set(m.unitId, (unitCount.get(m.unitId) ?? 0) + 1);
    const kept = new Set<string>();
    const rows = sorted.map((m) => {
      const keeper = !kept.has(m.unitId);
      kept.add(m.unitId);
      return {
        member: m,
        sameUnit: (unitCount.get(m.unitId) ?? 0) > 1,
        keeper,
      };
    });
    groups.push({ name, rows, unitCount: unitCount.size });
  }
  return groups.sort(
    (a, b) =>
      b.rows.length - a.rows.length || a.name.localeCompare(b.name, "zh-CN"),
  );
});

const dupTotal = computed(() =>
  dupGroups.value.reduce((n, g) => n + g.rows.length, 0),
);

/** 默认勾选口径：每个单位保留 1 人，其余勾选待处理 */
const dupDefaultIds = computed(
  () =>
    new Set(
      dupGroups.value.flatMap((g) =>
        g.rows.filter((r) => !r.keeper).map((r) => r.member.id),
      ),
    ),
);

const allDupSelectedMarked = computed(() => {
  const d = draft.value;
  if (!d || !dupSelected.value.size) return false;
  const picked = d.members.filter((m) => dupSelected.value.has(m.id));
  return picked.length > 0 && picked.every((m) => m.duplicateMark);
});

function openDuplicates(): void {
  dupExpanded.value = new Set(dupGroups.value.slice(0, 3).map((g) => g.name));
  dupSelected.value = new Set(dupDefaultIds.value);
  dupOpen.value = true;
}

function toggleDupGroup(name: string): void {
  const next = new Set(dupExpanded.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  dupExpanded.value = next;
}

function toggleDupMember(id: string): void {
  const next = new Set(dupSelected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  dupSelected.value = next;
}

function toggleDupGroupSelect(g: DupGroup): void {
  const ids = g.rows.map((r) => r.member.id);
  const next = new Set(dupSelected.value);
  if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
  else for (const id of ids) next.add(id);
  dupSelected.value = next;
}

async function markDupSelected(): Promise<void> {
  const d = draft.value;
  if (!d || !dupSelected.value.size) return;
  const mark = !allDupSelectedMarked.value;
  let n = 0;
  for (const m of d.members) {
    if (!dupSelected.value.has(m.id)) continue;
    m.duplicateMark = mark ? true : undefined;
    n++;
  }
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  await saveRoster(d);
  dirty.value = false;
  flash(mark ? `已标记 ${n} 人为疑似重名` : `已取消 ${n} 人的重名标记`);
}

/** 查重里的删除复用表格多选的影响说明，确认后自动关掉查重弹窗 */
function askDeleteDuplicates(): void {
  if (!dupSelected.value.size) return;
  askDeleteMembers(new Set(dupSelected.value));
}

// 删除或筛选后同步清理查重弹窗里已失效的勾选
watch(dupGroups, (groups) => {
  const alive = new Set(groups.flatMap((g) => g.rows.map((r) => r.member.id)));
  const next = new Set([...dupSelected.value].filter((id) => alive.has(id)));
  if (next.size !== dupSelected.value.size) dupSelected.value = next;
});

// ---- 批量添加 ----
const batchOpen = ref(false);
const batchText = ref("");
const batchUnit = ref("");
const batchRank = ref("");
const batchDuty = ref("");

function openBatch(): void {
  if (!draft.value) return;
  batchText.value = "";
  batchUnit.value = draft.value.units[0]?.id ?? "";
  batchRank.value = sortedRanks.value[sortedRanks.value.length - 1]?.id ?? "";
  batchDuty.value = "";
  batchOpen.value = true;
}

function submitBatch(): void {
  if (!draft.value) return;
  const names = batchText.value
    .split(/[\n,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    flash("没有可添加的姓名");
    return;
  }
  if (!batchUnit.value || !batchRank.value) {
    flash("请选择单位与职级");
    return;
  }
  const duty = batchDuty.value.trim() || undefined;
  for (const name of names) {
    draft.value.members.push({
      id: uid("m"),
      name,
      unitId: batchUnit.value,
      rankId: batchRank.value,
      duty,
      aliases: [],
      status: "present",
    });
  }
  batchOpen.value = false;
  reindexMembers();
  flash(`已加入 ${names.length} 人，记得保存`);
}

// ---- 文件批量导入 ----
const importOpen = ref(false);
/** 导入结果：成功数与跳过的重名名单，避免静默丢弃 */
const importResult = ref<{
  imported: number;
  skipped: { name: string; unit: string }[];
  extras: string[];
} | null>(null);
/** 新增职级的默认色轮：取统一预设里的非浅色项，避免职级色条过淡 */
const RANK_PALETTE = COLOR_PRESETS.slice(1);

function openImport(): void {
  if (!draft.value) return;
  importOpen.value = true;
}

/**
 * 文件导入：与 ImportDialog 预览共用 planUnitInputs / planRankInputs，
 * 因此「预览显示将新建 N 个」与实际写入完全一致，不会出现静默归入根单位。
 */
async function handleImport(payload: {
  rows: {
    name: string;
    unit: string;
    rank: string;
    duty: string;
    note: string;
  }[];
  targetUnitId: string;
  allowDuplicate: boolean;
}): Promise<void> {
  if (!draft.value || !payload.rows.length) return;
  const d = draft.value;
  const rootId =
    d.units.find((u) => u.parentId === null)?.id ?? d.units[0]?.id ?? "";
  const fallbackUnit = payload.targetUnitId || rootId;

  const unitPlan = planUnitInputs(
    d.units,
    payload.rows.map((r) => r.unit),
    fallbackUnit,
  );
  const rankPlan = planRankInputs(
    d.ranks,
    payload.rows.map((r) => r.rank),
  );
  if (unitPlan.conflicts || rankPlan.conflicts) {
    flash("单位或职级存在重名，已停止导入，请按预览提示修正");
    return;
  }

  // 先落单位：父级可能引用同一批里的临时单位，按创建顺序换成真实 id
  const unitIdMap = new Map<string, string>();
  for (const nu of unitPlan.newUnits) {
    const id = uid("unit");
    unitIdMap.set(nu.tempId, id);
    const parentId = nu.parentId
      ? (unitIdMap.get(nu.parentId) ?? nu.parentId)
      : null;
    const order =
      Math.max(
        -1,
        ...d.units.filter((u) => u.parentId === parentId).map((u) => u.order),
      ) + 1;
    d.units.push({ id, name: nu.name, parentId, order });
  }

  const rankIdMap = new Map<string, string>();
  const rankStart = Math.max(-1, ...d.ranks.map((r) => r.order)) + 1;
  rankPlan.newRanks.forEach((nr, i) => {
    const id = uid("rank");
    rankIdMap.set(nr.tempId, id);
    d.ranks.push({
      id,
      name: nr.name,
      order: rankStart + i,
      color: RANK_PALETTE[(rankStart + i) % RANK_PALETTE.length],
    });
  });

  let fallbackRank = [...d.ranks].sort((a, b) => b.order - a.order)[0];
  if (!fallbackRank) {
    fallbackRank = {
      id: uid("rank"),
      name: "未定级",
      order: 0,
      color: RANK_PALETTE[0],
    };
    d.ranks.push(fallbackRank);
  }

  /** 重名口径：姓名完全一致 + 归属同一单位（按 unitId 判定，避免同名不同单位被误杀） */
  const dupKey = (name: string, unitId: string): string =>
    `${name.trim()}\u0000${unitId}`;
  const seen = new Map<string, Member>();
  for (const m of d.members) seen.set(dupKey(m.name, m.unitId), m);

  const skipped: { name: string; unit: string }[] = [];
  let imported = 0;
  payload.rows.forEach((row, i) => {
    const resolved = unitPlan.items[i];
    const unitId = resolved?.unitId
      ? (unitIdMap.get(resolved.unitId) ?? resolved.unitId)
      : fallbackUnit;
    if (
      !payload.allowDuplicate &&
      unitId &&
      seen.has(dupKey(row.name, unitId))
    ) {
      skipped.push({
        name: row.name,
        unit: unitPathOf(d.units, unitId) || "未分单位",
      });
      return;
    }
    const rankRes = rankPlan.items[i];
    const rankId = rankRes?.rankId
      ? (rankIdMap.get(rankRes.rankId) ?? rankRes.rankId)
      : fallbackRank.id;
    const member: Member = {
      id: uid("m"),
      name: row.name,
      unitId,
      rankId,
      duty: row.duty.trim() || undefined,
      aliases: [],
      note: row.note || undefined,
      status: "present",
    };
    d.members.push(member);
    seen.set(dupKey(member.name, member.unitId), member);
    imported++;
  });

  reindexMembers();
  try {
    await saveRoster(d);
    dirty.value = false;
  } catch (e: any) {
    flash(e?.message || "保存失败");
    return;
  }
  const extras = [
    unitPlan.newUnits.length
      ? `新建单位 ${unitPlan.newUnits.length} 个`
      : "",
    rankPlan.newRanks.length
      ? `新建职级 ${rankPlan.newRanks.length} 个`
      : "",
  ].filter(Boolean);
  importResult.value = { imported, skipped, extras };
  flash(
    `已导入 ${imported} 人${skipped.length ? `，跳过重名 ${skipped.length} 人` : ""}`,
  );
}
</script>

<template>
  <header class="page-head roster-head">
    <div class="page-head-main">
      <div class="page-eyebrow">名册与组织</div>
      <h1 class="page-title">{{ draft?.name ?? "名册方案" }}</h1>
    </div>
    <div class="head-actions roster-head-actions">
      <div class="roster-plan">
        <div class="roster-plan-select">
          <UiSelect
            v-model="selectedId"
            :options="rosterOptions"
            placeholder="选择方案"
            size="sm"
          />
        </div>
        <UiIconButton
          icon="edit"
          :size="15"
          title="重命名方案"
          @click="openRename"
        />
      </div>
      <span class="roster-head-sep" aria-hidden="true" />
      <UiIconButton
        icon="plus"
        :size="15"
        title="新建方案"
        aria-label="新建方案"
        @click="createPlan"
      />
      <UiIconButton
        icon="trash"
        :size="15"
        title="删除当前方案"
        danger
        @click="askDeletePlan"
      />
      <button class="btn sm primary" :disabled="!dirty" @click="save">
        {{ dirty ? "保存改动" : "已保存" }}
      </button>
    </div>
  </header>

  <div v-if="!draft" class="roster-blank">
    <UiIcon name="users" :size="24" />
    <div class="roster-blank-title">还没有名册方案</div>
    <button class="btn sm primary" @click="createPlan">新建方案</button>
  </div>

  <template v-else>
    <div class="workspace roster-workspace">
      <section class="roster-panel">
        <div class="roster-panel-head">
          <div class="roster-panel-heading">
            <h2 class="roster-panel-title">人员名册</h2>
          </div>
          <div class="roster-panel-actions">
            <button class="btn sm" @click="openDuplicates">
              <UiIcon name="search" :size="13" />查找重名
            </button>
            <button class="btn sm" @click="openImport">
              <UiIcon name="import" :size="13" />批量导入
            </button>
            <button class="btn sm" @click="openBatch">
              <UiIcon name="paste" :size="13" />批量粘贴
            </button>
            <button class="btn sm primary" @click="openAddMember">
              <UiIcon name="plus" :size="13" />新增人员
            </button>
          </div>
        </div>

        <div class="roster-toolbar">
          <div class="roster-filter">
            <div class="roster-search">
              <UiIcon name="search" :size="13" />
              <input
                v-model="search"
                class="roster-search-input"
                placeholder="搜索姓名 / 职务"
                aria-label="搜索姓名或职务"
              />
              <button
                v-if="search"
                type="button"
                class="roster-search-clear"
                title="清空搜索"
                @click="search = ''"
              >
                <UiIcon name="close" :size="11" />
              </button>
            </div>
            <div class="roster-filter-unit">
              <UiSelect
                v-model="filterUnit"
                :options="[{ value: '', label: '全部单位' }, ...unitOptions]"
                placeholder="全部单位"
                size="sm"
              />
            </div>
            <div class="roster-filter-rank">
              <UiSelect
                v-model="filterRank"
                :options="[{ value: '', label: '全部职级' }, ...rankOptions]"
                placeholder="全部职级"
                size="sm"
              />
            </div>
            <div class="roster-filter-duty">
              <UiSelect
                v-model="filterDuty"
                :options="[{ value: '', label: '全部职务' }, ...dutyOptions]"
                placeholder="全部职务"
                size="sm"
              />
            </div>
            <button v-if="hasFilter" class="btn ghost xs" @click="clearFilters">
              清除筛选
            </button>
          </div>
          <div class="roster-toolbar-meta">
            <template v-if="batchMode">
              <div class="roster-bulk">
                <template v-if="selectedIds.size">
                  <span
                    >已选 <b>{{ selectedIds.size }}</b> 人</span
                  >
                  <button class="btn ghost xs" @click="clearSelection">
                    取消选择
                  </button>
                  <button class="btn danger xs" @click="askDeleteSelected">
                    <UiIcon name="trash" :size="12" />删除所选
                  </button>
                </template>
                <span v-else class="roster-bulk-hint"
                  >勾选人员后可批量删除</span
                >
                <button class="btn ghost xs" @click="exitBatch">
                  退出批量
                </button>
              </div>
            </template>
            <template v-else>
              <button
                v-if="draft.manualOrder"
                class="btn ghost xs roster-sort-reset"
                title="当前为手动拖拽顺序，点击恢复按职级序列展示"
                @click="resetSortOrder"
              >
                手动顺序 · 恢复按职级
              </button>
              <button
                class="btn ghost xs"
                title="进入批量模式后可勾选并批量删除"
                @click="enterBatch"
              >
                批量操作
              </button>
            </template>
          </div>
        </div>

        <div class="roster-table-wrap">
          <table class="roster-table" aria-label="人员名册">
            <colgroup>
              <col v-if="batchMode" style="width: 34px" />
              <col v-if="!batchMode" style="width: 30px" />
              <col style="width: 26%" />
              <col />
              <col style="width: 16%" />
              <col style="width: 17%" />
              <col v-if="!batchMode" style="width: 96px" />
            </colgroup>
            <thead>
              <tr>
                <th v-if="batchMode" scope="col" class="roster-check-head">
                  <input
                    type="checkbox"
                    class="roster-check"
                    :checked="allVisibleSelected"
                    :indeterminate="!allVisibleSelected && someVisibleSelected"
                    :title="allVisibleSelected ? '取消全选' : '全选当前列表'"
                    aria-label="全选当前列表"
                    @click.stop
                    @change="toggleAllVisible"
                  />
                </th>
                <th
                  v-if="!batchMode"
                  scope="col"
                  class="roster-drag-head"
                  title="拖拽调整顺序"
                >
                  <UiIcon name="grip" :size="12" />
                </th>
                <th scope="col">姓名</th>
                <th scope="col">单位</th>
                <th scope="col">职务</th>
                <th scope="col">职级</th>
                <th v-if="!batchMode" scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in visibleMembers"
                :key="m.id"
                class="roster-row"
                :class="{
                  selected: activeId === m.id,
                  'is-checked': selectedIds.has(m.id),
                  'is-dragging': dragId === m.id,
                  'drop-before': dropTarget?.id === m.id && !dropTarget.after,
                  'drop-after': dropTarget?.id === m.id && dropTarget.after,
                }"
                :draggable="!hasFilter && !batchMode"
                @click="onRowClick(m, $event)"
                @dblclick="!batchMode && openEditMember(m)"
                @dragstart="onDragStart(m.id, $event)"
                @dragover="onDragOver(m.id, $event)"
                @drop.prevent="onDrop"
                @dragend="onDragEnd"
              >
                <td
                  v-if="batchMode"
                  class="roster-check-cell"
                  @click.stop="onCheckCellClick(m, $event)"
                >
                  <input
                    type="checkbox"
                    class="roster-check"
                    :checked="selectedIds.has(m.id)"
                    :aria-label="`选择 ${m.name}`"
                    @click.stop="onCheckClickMods($event)"
                    @change="onCheckChange(m, $event)"
                  />
                </td>
                <td v-if="!batchMode" class="roster-drag-cell">
                  <UiIcon
                    name="grip"
                    :size="13"
                    class="roster-grip"
                    :class="{ 'is-off': hasFilter }"
                    :title="hasFilter ? '清除筛选后可拖拽排序' : '拖拽调整顺序'"
                  />
                </td>
                <td>
                  <div class="roster-name">
                    <span class="roster-name-text">{{ m.name }}</span>
                    <span
                      v-if="m.duplicateMark"
                      class="roster-dup-tag"
                      title="已标记为疑似重名"
                      >重名</span
                    >
                    <span v-if="m.aliases.length" class="roster-alias">{{
                      m.aliases.join("、")
                    }}</span>
                  </div>
                </td>
                <td class="roster-unit" :title="unitName(m.unitId)">
                  {{ unitName(m.unitId) }}
                </td>
                <td class="roster-duty" :title="m.duty || ''">
                  {{ m.duty || "—" }}
                </td>
                <td>
                  <span class="roster-rank">
                    <span
                      class="dot"
                      :style="{ background: rankColor(m.rankId) }"
                    />{{ rankName(m.rankId) }}
                  </span>
                </td>
                <td v-if="!batchMode">
                  <div class="roster-actions">
                    <UiIconButton
                      icon="edit"
                      :size="14"
                      :title="`编辑 ${m.name}`"
                      @click.stop="openEditMember(m)"
                    />
                    <UiIconButton
                      icon="trash"
                      :size="14"
                      danger
                      :title="`移出 ${m.name}`"
                      @click.stop="askDeleteMember(m)"
                    />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!visibleMembers.length" class="roster-empty">
            <UiIcon :name="hasFilter ? 'search' : 'users'" :size="22" />
            <div class="roster-empty-title">
              {{ hasFilter ? "没有匹配的人员" : "名册里还没有人员" }}
            </div>
            <p v-if="hasFilter" class="roster-empty-desc">
              换个关键字，或清除筛选后再试。
            </p>
            <div class="roster-empty-actions">
              <button v-if="hasFilter" class="btn sm" @click="clearFilters">
                清除筛选
              </button>
              <template v-else>
                <button class="btn sm" @click="openImport">批量导入</button>
                <button class="btn sm" @click="openBatch">批量粘贴</button>
                <button class="btn sm primary" @click="openAddMember">
                  新增人员
                </button>
              </template>
            </div>
          </div>
        </div>

        <div class="roster-foot">
          <span
            >共 <b>{{ draft.members.length }}</b> 人</span
          >
        </div>
      </section>

      <div class="panel roster-side">
        <section class="card tight">
          <div class="section-label" style="margin-bottom: 8px">组织配置</div>
          <button
            class="roster-org-row"
            @click="draft && emit('open-ranks', draft.id)"
          >
            <div class="grow">
              <div class="roster-org-name">职级序列</div>
            </div>
            <UiIcon name="chevronRight" :size="12" class="chev" />
          </button>
          <button
            class="roster-org-row"
            @click="draft && emit('open-units', draft.id)"
          >
            <div class="grow">
              <div class="roster-org-name">单位编制序列</div>
            </div>
            <UiIcon name="chevronRight" :size="12" class="chev" />
          </button>
        </section>

        <section class="card tight">
          <div class="card-head">
            <div class="card-title">结构概览</div>
            <span class="caption">{{ draft.members.length }} 人</span>
          </div>
          <div class="chart-block">
            <div class="chart-title">
              <span>职级分布</span>
              <span class="caption">按职级序列</span>
            </div>
            <UiChart
              :option="rankChart"
              :height="rankChartHeight"
              empty-text="暂无人员数据"
            />
          </div>
          <div class="chart-block">
            <div class="chart-title">
              <span>单位人数</span>
              <span class="caption">按人数排序</span>
            </div>
            <UiChart
              :option="unitChart"
              :height="unitChartHeight"
              empty-text="暂无单位数据"
            />
          </div>
        </section>
      </div>
    </div>
  </template>

  <!-- 重命名 -->
  <UiModal v-model="renameOpen" title="重命名名册方案">
    <div class="field">
      <label>方案名称</label>
      <UiInput
        v-model="renameValue"
        placeholder="如：名册方案一"
        @keyup.enter="confirmRename"
      />
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="renameOpen = false">取消</UiButton>
      <UiButton variant="primary" @click="confirmRename">保存名称</UiButton>
    </template>
  </UiModal>

  <!-- 人员新增/编辑 -->
  <UiModal v-model="memberOpen" :title="editingId ? '编辑人员' : '新增人员'">
    <div class="field">
      <label>姓名</label>
      <UiInput
        v-model="form.name"
        placeholder="人员姓名"
        @keyup.enter="submitMember"
      />
    </div>
    <div class="field-row">
      <div class="field">
        <label>单位</label>
        <UiSelect
          v-model="form.unitId"
          :options="unitOptions"
          placeholder="选择单位"
        />
      </div>
      <div class="field">
        <label>职级</label>
        <UiSelect
          v-model="form.rankId"
          :options="rankOptions"
          placeholder="选择职级"
        />
      </div>
    </div>
    <div class="field">
      <label>职务（可留空）</label>
      <UiInput v-model="form.duty" placeholder="如：主任、处长、副主任" />
    </div>
    <div class="field">
      <label>别名（用于 Excel 姓名匹配，用逗号分隔）</label>
      <UiInput v-model="form.aliases" placeholder="如：老张、张处" />
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="memberOpen = false">取消</UiButton>
      <UiButton variant="primary" @click="submitMember">{{
        editingId ? "保存修改" : "添加人员"
      }}</UiButton>
    </template>
  </UiModal>

  <!-- 批量添加 -->
  <UiModal
    v-model="batchOpen"
    title="批量添加人员"
    description="姓名用换行、逗号或空格分隔"
  >
    <div class="field">
      <label>姓名列表</label>
      <textarea
        v-model="batchText"
        class="textarea"
        rows="5"
        placeholder="张三、李四、王五…"
      />
    </div>
    <div class="field-row">
      <div class="field">
        <label>统一单位</label>
        <UiSelect
          v-model="batchUnit"
          :options="unitOptions"
          placeholder="选择单位"
        />
      </div>
      <div class="field">
        <label>统一职级</label>
        <UiSelect
          v-model="batchRank"
          :options="rankOptions"
          placeholder="选择职级"
        />
      </div>
    </div>
    <div class="field">
      <label>统一职务（可留空）</label>
      <UiInput v-model="batchDuty" placeholder="如：主任、处长" />
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="batchOpen = false">取消</UiButton>
      <UiButton variant="primary" @click="submitBatch">加入名册</UiButton>
    </template>
  </UiModal>

  <!-- 文件批量导入 -->
  <ImportDialog
    v-model="importOpen"
    :unit-options="unitOptions"
    :units="draft?.units ?? []"
    :ranks="sortedRanks"
    :default-unit-id="
      draft?.units.find((u) => u.parentId === null)?.id ??
      draft?.units[0]?.id ??
      ''
    "
    @import="handleImport"
  />

  <!-- 导入结果：跳过的重名必须可见 -->
  <UiModal
    :model-value="!!importResult"
    title="导入结果"
    width="460px"
    @update:model-value="
      (v: boolean) => {
        if (!v) importResult = null;
      }
    "
  >
    <div v-if="importResult" class="import-result">
      <div class="import-result-line">
        成功导入 <b>{{ importResult.imported }}</b> 人
        <span v-if="importResult.skipped.length"
          >，跳过 <b class="warn">{{ importResult.skipped.length }}</b> 人</span
        >
      </div>
      <p v-if="importResult.extras.length" class="import-result-extra">
        {{ importResult.extras.join("，") }}
      </p>
      <div v-if="importResult.skipped.length" class="import-skip">
        <div class="import-skip-title">
          已跳过：重名 <span>（姓名一致 + 同单位）</span>
        </div>
        <ul>
          <li v-for="(s, i) in importResult.skipped" :key="i">
            <span class="import-skip-name">{{ s.name }}</span>
            <span class="import-skip-unit">{{ s.unit }}</span>
          </li>
        </ul>
      </div>
    </div>
    <template #footer>
      <UiButton variant="primary" @click="importResult = null">知道了</UiButton>
    </template>
  </UiModal>

  <!-- 查找重复名字 -->
  <UiModal
    v-model="dupOpen"
    title="查找重复名字"
    description="按姓名分组；同名同单位默认只保留名册顺序最靠前的 1 人，其余勾选待处理；同名不同单位视为不同的人，默认不勾选。"
    width="560px"
  >
    <div class="dup-summary">
      <span v-if="dupGroups.length">
        共 <b>{{ dupGroups.length }}</b> 组重名，涉及 <b>{{ dupTotal }}</b> 人
      </span>
      <span v-else>没有重名人员</span>
      <span
        >已选 <b>{{ dupSelected.size }}</b> 人</span
      >
    </div>
    <div v-if="!dupGroups.length" class="dup-empty">
      <UiIcon name="check" :size="20" />
      <div>当前名册没有同名人员</div>
    </div>
    <ul v-else class="dup-list">
      <li
        v-for="g in dupGroups"
        :key="g.name"
        class="dup-group"
        :class="{ open: dupExpanded.has(g.name) }"
      >
        <div class="dup-group-head">
          <button
            type="button"
            class="dup-group-toggle"
            @click="toggleDupGroup(g.name)"
          >
            <UiIcon name="chevronRight" :size="12" class="dup-chevron" />
            <span class="dup-name">{{ g.name }}</span>
            <span class="dup-meta"
              >{{ g.rows.length }} 人 · {{ g.unitCount }} 个单位</span
            >
          </button>
          <button
            type="button"
            class="btn ghost xs"
            @click="toggleDupGroupSelect(g)"
          >
            {{
              g.rows.every((r) => dupSelected.has(r.member.id))
                ? "取消本组"
                : "选中本组"
            }}
          </button>
        </div>
        <ul v-if="dupExpanded.has(g.name)" class="dup-members">
          <li v-for="r in g.rows" :key="r.member.id" class="dup-member">
            <input
              type="checkbox"
              class="roster-check"
              :checked="dupSelected.has(r.member.id)"
              :aria-label="`选择 ${r.member.name}`"
              @change="toggleDupMember(r.member.id)"
            />
            <span class="dup-unit" :title="unitName(r.member.unitId)">{{
              unitName(r.member.unitId)
            }}</span>
            <span class="dup-rank">{{ rankName(r.member.rankId) }}</span>
            <span v-if="r.keeper && r.sameUnit" class="dup-tag keep"
              >默认保留</span
            >
            <span v-else-if="r.sameUnit" class="dup-tag">待处理</span>
            <span v-else class="dup-tag">不同单位</span>
            <span v-if="r.member.status === 'leave'" class="dup-tag leave"
              >请假</span
            >
            <span v-if="r.member.duplicateMark" class="dup-tag marked"
              >已标记</span
            >
          </li>
        </ul>
      </li>
    </ul>
    <template #footer>
      <UiButton variant="ghost" @click="dupOpen = false">关闭</UiButton>
      <UiButton
        variant="ghost"
        :disabled="!dupSelected.size"
        @click="markDupSelected"
      >
        {{ allDupSelectedMarked ? "取消标记" : "标记所选" }}
      </UiButton>
      <UiButton
        variant="danger"
        :disabled="!dupSelected.size"
        @click="askDeleteDuplicates"
        >删除所选</UiButton
      >
    </template>
  </UiModal>

  <!-- 确认 -->
  <UiModal
    v-model="confirmState.open"
    :title="confirmState.title"
    :description="confirmState.desc"
    width="400px"
  >
    <template #footer>
      <UiButton variant="ghost" @click="confirmState.open = false"
        >取消</UiButton
      >
      <UiButton variant="danger" @click="runConfirm">确认删除</UiButton>
    </template>
    <ul v-if="confirmState.points?.length" class="confirm-points">
      <li v-for="(p, i) in confirmState.points" :key="i">{{ p }}</li>
    </ul>
  </UiModal>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
