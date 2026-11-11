<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import * as XLSX from "xlsx";
import type {
  Assignment,
  AttendStatus,
  Member,
  Project,
  ProjectSeatOverlay,
  RosterPlan,
  ZoneDef,
} from "../types";
import { DEFAULT_RULESET } from "../types";
import {
  getSnapshot,
  layoutOf,
  listSnapshots,
  removeProject,
  removeSnapshots,
  rosterOf,
  saveProject,
  saveSnapshot,
  state,
} from "../store";
import {
  applyRulesToProject,
  seatIndexMap,
  seatOrderMap,
} from "../engine/seating";
import {
  anchorSeatIdOfCell,
  applySeatCapacity,
  applySeatOverlay,
  cellAt,
  clampSeats,
  keyOf,
  nowISO,
  pruneSeatOverlay,
  seatsOfSheet,
  sheetSize,
  uid,
  type SeatRef,
} from "../engine/sheet";
import { renderSeatChart } from "../engine/render";
import { preferences } from "../preferences";
import SeatBoardPane from "../components/project/SeatBoardPane.vue";
import RulesPanel from "../components/RulesPanel.vue";
import ImportDialog from "../components/roster/ImportDialog.vue";
import {
  COLOR_PRESETS,
  UiChart,
  UiColorPicker,
  UiSelect,
  UiModal,
  UiNumberInput,
  UiIcon as Icon,
} from "../ui";
import {
  chartAxisText,
  chartColors,
  chartFont,
  chartTooltip,
  type ChartOption,
} from "../ui/charts";

const sideTab = ref<
  "overview" | "props" | "list" | "leave" | "rules" | "export"
>("list");

const selectedId = ref<string>(state.projects[0]?.id ?? "");
const draft = ref<Project | null>(null);
const dirty = ref(false);
const toast = ref("");
const warnings = ref<string[]>([]);
const selectedSeat = ref<string | null>(null);
/** 换座后短暂高亮两个座位，便于确认交换对象 */
const swapFlash = ref<string[]>([]);
let swapTimer = 0;
const CARD_W = 268;
const seatAnchor = ref<HTMLElement | null>(null);
const popoverEl = ref<HTMLElement | null>(null);
const popoverPos = ref({ left: 0, top: 0, above: false, arrow: CARD_W / 2 });
let popRaf = 0;
const busy = ref(false);
let loading = false;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

async function load(id: string): Promise<void> {
  if (dirty.value && draft.value && draft.value.id !== id)
    await flushAutosave();
  const found = state.projects.find((p) => p.id === id);
  loading = true;
  draft.value = found ? clone(found) : null;
  if (draft.value && !draft.value.ruleSet.zoneRules)
    draft.value.ruleSet.zoneRules = [];
  // 旧项目没有主席台朝向字段：补默认「左为上」；旧的「中间向两侧」归一为「中间左优先」
  if (draft.value && !draft.value.ruleSet.stageSide)
    draft.value.ruleSet.stageSide = "left";
  if (
    draft.value &&
    (draft.value.ruleSet.hallOrder as string) === "center-out"
  ) {
    draft.value.ruleSet.hallOrder = "center-left";
  }
  // 旧项目没有序号开关字段，默认显示以保持原有观感
  if (draft.value && draft.value.showSeatNumbers === undefined)
    draft.value.showSeatNumbers = true;
  // 信息行默认只显示职级，职务与单位由用户按需打开
  if (draft.value && draft.value.showRank === undefined)
    draft.value.showRank = true;
  if (draft.value && draft.value.showDuty === undefined)
    draft.value.showDuty = false;
  if (draft.value && draft.value.showUnit === undefined)
    draft.value.showUnit = false;
  // 覆盖层是项目自带数据：老项目首次打开时补空壳，不做布局旧区域迁移
  if (draft.value) ensureOverlay();
  selectedSeat.value = null;
  seatAnchor.value = null;
  warnings.value = [];
  const overlayNote = draft.value ? syncOverlayToLayout() : "";
  if (overlayNote) warnings.value = [overlayNote];
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
    await saveProject(draft.value);
    if (seq === autosaveSeq) dirty.value = false;
  }, 900);
}

async function flushAutosave(): Promise<void> {
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  if (!dirty.value || !draft.value) return;
  await saveProject(draft.value);
  dirty.value = false;
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = "";
}

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("scroll", schedulePlace, true);
  window.addEventListener("wheel", schedulePlace, {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", schedulePlace);
  document.addEventListener("pointerdown", onDocPointer, true);
  window.addEventListener("keydown", onEsc);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  window.removeEventListener("scroll", schedulePlace, true);
  window.removeEventListener("wheel", schedulePlace, true);
  window.removeEventListener("resize", schedulePlace);
  document.removeEventListener("pointerdown", onDocPointer, true);
  window.removeEventListener("keydown", onEsc);
  if (popRaf) cancelAnimationFrame(popRaf);
  window.clearTimeout(swapTimer);
  window.clearTimeout(autosaveTimer);
  window.clearTimeout(flashTimer);
  void flushAutosave();
});
watch(
  () => state.projects.map((p) => p.id).join(","),
  () => {
    if (!state.projects.some((p) => p.id === selectedId.value))
      selectedId.value = state.projects[0]?.id ?? "";
  },
);

let flashTimer = 0;
function flash(msg: string): void {
  toast.value = msg;
  // 上一条提示的定时器必须清掉，否则会把新提示提前擦除
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    toast.value = "";
  }, 2600);
}

const roster = computed(() =>
  draft.value ? rosterOf(draft.value) : undefined,
);

/** 覆盖层的唯一合成入口：布局 + 项目桌容量 + 项目区域/停用 */
const layout = computed(() => {
  const base = draft.value ? layoutOf(draft.value) : undefined;
  if (!base) return undefined;
  const overlay = draft.value?.seatOverlay;
  const sheet = applySeatOverlay(
    applySeatCapacity(base.sheet, draft.value?.seatCapacity),
    overlay,
  );
  return { ...base, zones: overlay?.zones ?? [], sheet };
});

function defaultOverlay(): ProjectSeatOverlay {
  return { zones: [], disabledCells: [], cellZones: {}, fixedSeats: {} };
}

/** 补齐覆盖层字段；老项目没有该字段时按空覆盖层处理 */
function ensureOverlay(): ProjectSeatOverlay {
  const project = draft.value!;
  if (!project.seatOverlay) project.seatOverlay = defaultOverlay();
  const overlay = project.seatOverlay;
  if (!Array.isArray(overlay.zones)) overlay.zones = [];
  if (!Array.isArray(overlay.disabledCells)) overlay.disabledCells = [];
  if (!overlay.cellZones || typeof overlay.cellZones !== "object")
    overlay.cellZones = {};
  if (!overlay.fixedSeats || typeof overlay.fixedSeats !== "object")
    overlay.fixedSeats = {};
  return overlay;
}

/**
 * 把覆盖层对齐到当前布局：
 * - 换了布局 → 保留区域定义，清空停用与区域归属（它们只对原布局的座位 id 有效）；
 * - 布局被编辑 → 按 anchor seat id 保留仍存在的引用，失效的清理并提示。
 */
function syncOverlayToLayout(): string {
  if (!draft.value) return "";
  const base = layoutOf(draft.value);
  if (!base) return "";
  const overlay = ensureOverlay();
  let note = "";
  if (overlay.layoutPackageId && overlay.layoutPackageId !== base.id) {
    const lost =
      overlay.disabledCells.length +
      Object.keys(overlay.cellZones).length +
      Object.keys(overlay.fixedSeats ?? {}).length;
    overlay.disabledCells = [];
    overlay.cellZones = {};
    overlay.fixedSeats = {};
    if (lost)
      note = `已切换会场布局：${lost} 处不坐人 / 区域归属 / 固定座位已重置，区域定义保留`;
  }
  const composed = applySeatCapacity(base.sheet, draft.value.seatCapacity);
  const pruned = pruneSeatOverlay(composed, overlay);
  const layoutChanged =
    !!overlay.layoutUpdatedAt && overlay.layoutUpdatedAt !== base.updatedAt;
  overlay.disabledCells = pruned.disabledCells;
  overlay.cellZones = pruned.cellZones;
  overlay.fixedSeats = pruned.fixedSeats;
  overlay.zones = pruned.zones;
  overlay.layoutPackageId = base.id;
  overlay.layoutUpdatedAt = base.updatedAt;
  if (
    !note &&
    layoutChanged &&
    (pruned.removedDisabled || pruned.removedZones || pruned.removedFixedSeats)
  ) {
    const parts = [
      pruned.removedDisabled ? `${pruned.removedDisabled} 个不坐人格` : "",
      pruned.removedZones ? `${pruned.removedZones} 处区域归属` : "",
      pruned.removedFixedSeats ? `${pruned.removedFixedSeats} 处固定座位` : "",
    ].filter(Boolean);
    note = `会场布局已更新：${parts.join("、")}已失效并清理`;
  }
  return note;
}

watch(
  () => `${layout.value?.id ?? ""}|${layout.value?.updatedAt ?? ""}`,
  () => {
    if (!draft.value || loading || !layout.value) return;
    const note = syncOverlayToLayout();
    if (note) {
      warnings.value = [note];
      flash(note);
    }
  },
);

const memberById = computed(
  () => new Map((roster.value?.members ?? []).map((m) => [m.id, m])),
);
/**
 * 展示/导出用名册：成员、单位沿用项目创建时的快照（保证历史排座不随名册增删变化），
 * 职级标识色只影响展示，统一取当前名册同 id 职级的颜色，
 * 让名册、座位图、图例与导出图片的标识色始终一致。
 */
const displayRoster = computed(() => {
  const base = roster.value;
  if (!base) return undefined;
  const live =
    state.rosters.find((r) => r.id === draft.value?.rosterPlanId)?.ranks ?? [];
  const liveColor = new Map(live.map((r) => [r.id, r.color]));
  return {
    ...base,
    ranks: base.ranks.map((r) => {
      const color = liveColor.get(r.id);
      return color ? { ...r, color } : r;
    }),
  };
});
const rankById = computed(
  () => new Map((displayRoster.value?.ranks ?? []).map((r) => [r.id, r])),
);
const unitById = computed(
  () => new Map((roster.value?.units ?? []).map((u) => [u.id, u])),
);
function memberHint(m: Member): string {
  const rank = rankById.value.get(m.rankId)?.name ?? "未定级";
  const unit = unitById.value.get(m.unitId)?.name;
  return unit ? `${rank} · ${unit}` : rank;
}

const seatInfo = computed(() => {
  const out: Record<
    string,
    {
      name: string;
      rankName: string;
      unitName: string;
      duty: string;
      color: string;
      status: string;
    }
  > = {};
  if (!draft.value) return out;
  for (const a of draft.value.assignments) {
    const m = memberById.value.get(a.memberId);
    if (!m || m.status === "leave") continue;
    // 布局固定空位与不坐人都不显示人员
    if (seatIndex.value.get(a.seatId)?.disabled) continue;
    const r = rankById.value.get(m.rankId);
    out[a.seatId] = {
      name: m.name,
      rankName: r?.name ?? "未定级",
      unitName: unitById.value.get(m.unitId)?.name ?? "",
      duty: m.duty ?? "",
      color: r?.color ?? "#8a979d",
      status: a.status,
    };
  }
  return out;
});

const allSeats = computed<SeatRef[]>(() =>
  layout.value ? seatsOfSheet(layout.value.sheet) : [],
);
const seatIndex = computed(() =>
  layout.value ? seatIndexMap(layout.value) : new Map<string, SeatRef>(),
);
const seatOrder = computed(() =>
  layout.value && draft.value
    ? seatOrderMap(layout.value, draft.value.ruleSet)
    : new Map<string, number>(),
);
/** 点选座位时记下它所在的桌，座位 id 因容量变化失效后仍能定位 */
const pickedCell = ref<{ row: number; col: number } | null>(null);

function seatLabel(seatId: string): string {
  const s = seatIndex.value.get(seatId);
  if (!s) {
    // 座位槽被增删后旧 id 可能已不存在，用点选时记下的桌兜底
    const p = pickedCell.value;
    if (!p || !layout.value) return "座位";
    const cell = cellAt(layout.value.sheet, p.row, p.col);
    return cell?.kind === "podium" ? "主席台" : `第 ${p.row + 1} 排`;
  }
  const no = seatOrder.value.get(seatId);
  return `${s.stage ? "主席台" : `第 ${s.row + 1} 排`}${no ? ` · ${no} 号` : ""}`;
}
const totalSeats = computed(
  () => allSeats.value.filter((s) => !s.disabled).length,
);
const disabledSeats = computed(
  () => allSeats.value.filter((s) => s.disabled).length,
);
/** 本次会议停用：覆盖层里记录的单元格（anchor seat id） */
const projectDisabledAnchors = computed(
  () => new Set(draft.value?.seatOverlay?.disabledCells ?? []),
);
function seatIsProjectDisabled(seat: SeatRef): boolean {
  if (!layout.value) return false;
  const anchor = anchorSeatIdOfCell(
    cellAt(layout.value.sheet, seat.row, seat.col),
    seat.row,
    seat.col,
  );
  return !!anchor && projectDisabledAnchors.value.has(anchor);
}
const projectDisabledSeatIds = computed(() => {
  const out = new Set<string>();
  for (const seat of allSeats.value) {
    if (seat.disabled && seatIsProjectDisabled(seat)) out.add(seat.seatId);
  }
  return out;
});
const participants = computed(() => {
  if (!draft.value || !roster.value) return [] as Member[];
  const ids = draft.value.participantIds.length
    ? draft.value.participantIds
    : roster.value.members.map((m) => m.id);
  return ids
    .map((id) => memberById.value.get(id))
    .filter((m): m is Member => !!m);
});
const presentMembers = computed(() =>
  participants.value.filter((m) => m.status === "present"),
);
const leaveMembers = computed(() =>
  participants.value.filter((m) => m.status === "leave"),
);

// ---- 名单搜索与座位定位 ----
const boardPaneRef = ref<InstanceType<typeof SeatBoardPane> | null>(null);
const rosterQuery = ref("");
const focusedSeat = ref<string | null>(null);
const filteredParticipants = computed(() => {
  const q = rosterQuery.value.trim().toLowerCase();
  if (!q) return participants.value;
  return participants.value.filter((m) => {
    const rank = rankById.value.get(m.rankId)?.name ?? "";
    const unit = unitById.value.get(m.unitId)?.name ?? "";
    return [m.name, rank, unit, m.duty ?? ""].some((s) =>
      s.toLowerCase().includes(q),
    );
  });
});

/** 点名单里的人：左侧座位图高亮并平滑滚动到该座位 */
function focusMember(m: Member): void {
  const a = draft.value?.assignments.find((x) => x.memberId === m.id);
  if (!a) {
    flash(`「${m.name}」还没有座位`);
    return;
  }
  closeSeatCard();
  focusedSeat.value = a.seatId;
  boardPaneRef.value?.scrollToSeat(a.seatId);
}
const assignedCount = computed(() => {
  if (!draft.value) return 0;
  return draft.value.assignments.filter(
    (a) =>
      memberById.value.get(a.memberId)?.status !== "leave" &&
      !seatIndex.value.get(a.seatId)?.disabled,
  ).length;
});
const leaveCount = computed(() => leaveMembers.value.length);
/** 座位序号开关：缺省显示，兼容旧项目 */
const showSeatNumbers = computed(() => draft.value?.showSeatNumbers !== false);
/** 座位下方信息开关：职级缺省显示，职务/单位缺省关闭 */
const showRank = computed(() => draft.value?.showRank !== false);
const showDuty = computed(() => draft.value?.showDuty === true);
const showUnit = computed(() => draft.value?.showUnit === true);
const emptySeats = computed(() =>
  Math.max(0, totalSeats.value - assignedCount.value),
);

// ---- 会场概览图表 ----
const usedSeats = computed(() => assignedCount.value);

const STATUS_META: { key: AttendStatus; label: string; color: string }[] = [
  { key: "present", label: "在位", color: chartColors.success },
  { key: "leave", label: "请假", color: chartColors.warning },
];

const statusCounts = computed(() => {
  const counts: Record<AttendStatus, number> = { present: 0, leave: 0 };
  for (const a of draft.value?.assignments ?? []) {
    if (memberById.value.get(a.memberId)?.status === "leave") continue;
    counts[a.status]++;
  }
  counts.leave = leaveMembers.value.length;
  return counts;
});

/** 座位使用率：请假者不占座，只统计已就座与空位。 */
const usageChart = computed<ChartOption | null>(() => {
  if (!totalSeats.value) return null;
  const rate = Math.round((usedSeats.value / totalSeats.value) * 100);
  const data = [
    {
      value: assignedCount.value,
      name: "已就座",
      itemStyle: { color: chartColors.success },
    },
    {
      value: emptySeats.value,
      name: "空位",
      itemStyle: { color: chartColors.border },
    },
  ].filter((d) => d.value > 0);
  return {
    animationDuration: 320,
    title: {
      text: `${rate}%`,
      subtext: "座位使用率",
      left: "center",
      top: "30%",
      itemGap: 2,
      textStyle: {
        color: chartColors.textPrimary,
        fontSize: 18,
        fontWeight: 600,
        fontFamily: chartFont,
      },
      subtextStyle: {
        color: chartColors.muted,
        fontSize: 11,
        fontFamily: chartFont,
      },
    },
    tooltip: {
      ...chartTooltip,
      trigger: "item",
      formatter: "{b}：{c} 个（{d}%）",
    },
    legend: {
      bottom: 0,
      left: "center",
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: {
        color: chartColors.textSecondary,
        fontSize: 11,
        fontFamily: chartFont,
      },
    },
    series: [
      {
        type: "pie",
        radius: ["54%", "76%"],
        center: ["50%", "40%"],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
        emphasis: { scaleSize: 3 },
        data,
      },
    ],
  };
});

/** 顶栏座位构成：已就座 / 空位 / 请假 / 不坐人 的堆叠占比 */
const mixChart = computed<ChartOption | null>(() => {
  const total =
    assignedCount.value +
    emptySeats.value +
    leaveCount.value +
    disabledSeats.value;
  if (!total) return null;
  const segs = [
    {
      name: "已就座",
      value: assignedCount.value,
      color: chartColors.success,
      labelColor: "#ffffff",
    },
    {
      name: "空位",
      value: emptySeats.value,
      color: "#cfdcdb",
      labelColor: "#415a59",
    },
    {
      name: "请假",
      value: leaveCount.value,
      color: chartColors.warning,
      labelColor: "#ffffff",
    },
    {
      name: "不坐人",
      value: disabledSeats.value,
      color: chartColors.muted,
      labelColor: "#ffffff",
    },
  ];
  const pct = (v: number): number => Math.round((v / total) * 100);
  return {
    animationDuration: 320,
    grid: { left: 0, right: 0, top: 3, bottom: 3 },
    tooltip: {
      ...chartTooltip,
      trigger: "item",
      formatter: (p: any) =>
        `${p.name}：${p.value}（${pct(Number(p.value))}%）`,
    },
    xAxis: { type: "value", max: total, show: false },
    yAxis: { type: "category", data: [""], show: false },
    series: segs.map((s) => ({
      type: "bar",
      name: s.name,
      stack: "mix",
      barWidth: 20,
      data: [s.value],
      itemStyle: { color: s.color },
      label: {
        show: s.value > 0 && s.value / total >= 0.1,
        position: "inside",
        color: s.labelColor,
        fontSize: 10,
        fontFamily: chartFont,
        formatter: () => String(s.value),
      },
    })),
  };
});

const statusChart = computed<ChartOption | null>(() => {
  const data = STATUS_META.map((s) => ({
    value: statusCounts.value[s.key],
    name: s.label,
    itemStyle: { color: s.color },
  })).filter((d) => d.value > 0);
  if (!data.length) return null;
  return {
    animationDuration: 320,
    tooltip: {
      ...chartTooltip,
      trigger: "item",
      formatter: "{b}：{c} 人（{d}%）",
    },
    legend: {
      bottom: 0,
      left: "center",
      icon: "circle",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: {
        color: chartColors.textSecondary,
        fontSize: 11,
        fontFamily: chartFont,
      },
    },
    series: [
      {
        type: "pie",
        radius: ["52%", "74%"],
        center: ["50%", "42%"],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: chartColors.bgPanel, borderWidth: 2 },
        emphasis: { scaleSize: 3 },
        data,
      },
    ],
  };
});

/** 区域就座：按布局分区汇总可用座位与已占用座位（请假者不占座）。 */
const zoneStats = computed(() => {
  if (!layout.value) return [];
  const cap = new Map<string, number>();
  const occ = new Map<string, number>();
  const seatZone = new Map<string, string>();
  for (const s of allSeats.value) {
    if (s.disabled) continue;
    const zid = s.zoneId ?? "__none";
    cap.set(zid, (cap.get(zid) ?? 0) + 1);
    seatZone.set(s.seatId, zid);
  }
  for (const a of draft.value?.assignments ?? []) {
    const zid = seatZone.get(a.seatId);
    if (zid) occ.set(zid, (occ.get(zid) ?? 0) + 1);
  }
  const rows = layout.value.zones
    .filter((z) => cap.has(z.id))
    .map((z) => ({
      id: z.id,
      name: z.name,
      total: cap.get(z.id) ?? 0,
      occupied: occ.get(z.id) ?? 0,
    }));
  if (cap.has("__none")) {
    rows.push({
      id: "__none",
      name: "未分区",
      total: cap.get("__none") ?? 0,
      occupied: occ.get("__none") ?? 0,
    });
  }
  return rows;
});

const zoneChartHeight = computed(() => {
  const n = zoneStats.value.length;
  return n ? Math.min(200, Math.max(88, n * 30 + 8)) : 88;
});

const zoneChart = computed<ChartOption | null>(() => {
  const rows = zoneStats.value;
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.total));
  return {
    animationDuration: 320,
    grid: { left: 0, right: 42, top: 4, bottom: 0, containLabel: true },
    tooltip: {
      ...chartTooltip,
      trigger: "axis",
      axisPointer: {
        type: "shadow",
        shadowStyle: { color: "rgba(74, 124, 123, .06)" },
      },
      formatter: (p: any) => {
        const row = rows[(Array.isArray(p) ? p[0] : p).dataIndex];
        return `${row.name}<br/>已就座 ${row.occupied} / 可用 ${row.total}`;
      },
    },
    xAxis: {
      type: "value",
      max,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...chartAxisText, color: chartColors.muted },
      splitLine: { lineStyle: { color: chartColors.borderSoft } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((r) => r.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        ...chartAxisText,
        width: 52,
        overflow: "truncate",
        ellipsis: "…",
      },
    },
    series: [
      {
        type: "bar",
        data: rows.map((r) => r.occupied),
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
          formatter: (p: any) => {
            const row = rows[p.dataIndex];
            return `${row.occupied}/${row.total}`;
          },
        },
      },
    ],
  };
});

const selectedAssignment = computed<Assignment | undefined>(() =>
  draft.value && selectedSeat.value
    ? draft.value.assignments.find((a) => a.seatId === selectedSeat.value)
    : undefined,
);
const selectedMember = computed(() => {
  const a = selectedAssignment.value;
  return a ? memberById.value.get(a.memberId) : undefined;
});
const selectedSeatDisabled = computed(() => {
  if (!selectedSeat.value) return false;
  return !!seatIndex.value.get(selectedSeat.value)?.disabled;
});
/** 当前座位是否被本项目本次会议停用（可一键恢复） */
const selectedSeatStopped = computed(
  () =>
    !!selectedSeat.value &&
    projectDisabledSeatIds.value.has(selectedSeat.value),
);
/** 布局固定空位：属于会场布局本身，不提供「座位状态」切换 */
const selectedSeatFixed = computed(
  () => selectedSeatDisabled.value && !selectedSeatStopped.value,
);

// ---- 座位详情卡片：锚定在座位上方/下方，随滚动与缩放跟随 ----
function placeSeatCard(): void {
  const el = seatAnchor.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const gap = 10;
  // 卡片高度随「座位状态」与人员信息变化，按实测高度决定朝上/朝下并夹在视口内
  const cardH = popoverEl.value?.offsetHeight ?? 190;
  const roomBelow = window.innerHeight - r.bottom - 8;
  const roomAbove = r.top - 8;
  const above = roomBelow < cardH + gap && roomAbove > roomBelow;
  const left = Math.min(
    Math.max(8, r.left + r.width / 2 - CARD_W / 2),
    window.innerWidth - CARD_W - 8,
  );
  const arrow = Math.min(
    Math.max(14, r.left + r.width / 2 - left),
    CARD_W - 14,
  );
  const rawTop = above ? r.top - gap - cardH : r.bottom + gap;
  const topEdge = Math.max(8, Math.min(rawTop, window.innerHeight - cardH - 8));
  popoverPos.value = {
    left,
    // above 时容器再用 translateY(-100%) 上移，这里始终传边缘坐标
    top: above ? topEdge + cardH : topEdge,
    above,
    arrow,
  };
}

function schedulePlace(): void {
  if (popRaf) return;
  popRaf = requestAnimationFrame(() => {
    popRaf = 0;
    placeSeatCard();
  });
}

// 切换座位状态或人员后卡片高度会变化，重新贴合锚点
watch(
  [
    selectedSeat,
    () => selectedSeatDisabled.value,
    () => selectedAssignment.value?.memberId ?? "",
  ],
  () => {
    if (selectedSeat.value) void nextTick(placeSeatCard);
  },
);

function pickSeat(
  seatId: string,
  el: HTMLElement,
  row?: number,
  col?: number,
): void {
  if (selectedSeat.value === seatId && seatAnchor.value === el) {
    closeSeatCard();
    return;
  }
  if (Number.isFinite(row) && Number.isFinite(col)) {
    pickedCell.value = { row: row as number, col: col as number };
    // 单选单元格同样作为属性面板的作用对象
    cellSelection.value = [keyOf(row as number, col as number)];
    focusedZoneId.value = "";
    sideTab.value = "props";
  }
  selectedSeat.value = seatId;
  seatAnchor.value = el;
  placeSeatCard();
  void nextTick(() => {
    // 首次渲染前量不到真实高度，渲染后按实际高度重新定位
    placeSeatCard();
    popoverEl.value?.focus({ preventScroll: true });
  });
}

function closeSeatCard(): void {
  selectedSeat.value = null;
  seatAnchor.value = null;
}

function onDocPointer(e: PointerEvent): void {
  const t = e.target as HTMLElement | null;
  // 点页面空白处取消名单里的人员高亮；点其他人员则切换选中
  if (focusedSeat.value && !t?.closest(".member-row")) focusedSeat.value = null;
  if (!selectedSeat.value) return;
  if (
    !t ||
    t.closest(".seat-popover") ||
    t.closest(".sb-seat") ||
    t.closest(".ui-select-panel") ||
    t.closest(".umodal")
  )
    return;
  closeSeatCard();
}

function onEsc(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // 先清掉画布框选，再考虑关闭座位详情
  if (cellSelection.value.length) {
    cellSelection.value = [];
    focusedZoneId.value = "";
    e.preventDefault();
    return;
  }
  if (!selectedSeat.value) return;
  const el = seatAnchor.value;
  closeSeatCard();
  if (el?.isConnected) el.focus({ preventScroll: true });
}

// ---- 选区、区域与停用：属性面板的唯一数据源 ----
const cellSelection = ref<string[]>([]);
const capCustom = ref(1);
const batchCap = ref(1);
const focusedZoneId = ref("");
const selectionKeys = computed(() => [...new Set(cellSelection.value)]);
const selectionSeatIds = computed(() =>
  selectionKeys.value.flatMap((k) => seatIdsOfCell(k)),
);
const selectionAnchors = computed(() =>
  selectionKeys.value
    .map((k) => {
      const [r, c] = k.split(":").map(Number);
      return anchorSeatIdOfCell(
        layout.value ? cellAt(layout.value.sheet, r, c) : undefined,
        r,
        c,
      );
    })
    .filter((id): id is string => !!id),
);
/** 选区容量分布：如 { 1: 3, 2: 5 } */
const selectionCaps = computed<Record<number, number>>(() => {
  const out: Record<number, number> = {};
  if (!layout.value) return out;
  for (const key of selectionKeys.value) {
    const [r, c] = key.split(":").map(Number);
    const n = clampSeats(cellAt(layout.value.sheet, r, c)?.seats ?? 1);
    out[n] = (out[n] ?? 0) + 1;
  }
  return out;
});
/** 容量一致时返回该值，混合时返回 0 */
const selectionCapMixed = computed(() => {
  const keys = Object.keys(selectionCaps.value);
  return keys.length === 1 ? Number(keys[0]) : 0;
});
const selectionCapText = computed(() =>
  Object.entries(selectionCaps.value)
    .map(([n, count]) => `${n} 人 × ${count} 格`)
    .join(" · "),
);
watch(
  selectionCapMixed,
  (v) => {
    if (v) batchCap.value = v;
  },
  { immediate: true },
);

const selectionOccupied = computed(() => {
  if (!draft.value) return 0;
  const ids = new Set(selectionSeatIds.value);
  return draft.value.assignments.filter((a) => ids.has(a.seatId)).length;
});
const selectionStopped = computed(
  () =>
    selectionAnchors.value.filter((a) => projectDisabledAnchors.value.has(a))
      .length,
);

// ---- 项目区域 ----
const overlayZones = computed<ZoneDef[]>(
  () => draft.value?.seatOverlay?.zones ?? [],
);
const zoneById = computed(
  () => new Map(overlayZones.value.map((z) => [z.id, z])),
);
const zoneSeatCount = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const seat of allSeats.value) {
    if (seat.disabled || !seat.zoneId) continue;
    out[seat.zoneId] = (out[seat.zoneId] ?? 0) + 1;
  }
  return out;
});
const zoneHighlight = computed(() => {
  const z = zoneById.value.get(focusedZoneId.value);
  return z ? { id: z.id, color: z.color } : null;
});
function toggleZoneFocus(id: string): void {
  if (focusedZoneId.value === id) {
    focusedZoneId.value = "";
    return;
  }
  focusedZoneId.value = id;
  // 没有任何单元格归属时画布没有可高亮的格子，必须给出明确反馈
  const owned = Object.values(
    draft.value?.seatOverlay?.cellZones ?? {},
  ).includes(id);
  if (!owned) {
    const name = zoneById.value.get(id)?.name ?? "该区域";
    flash(`「${name}」暂无单元格，先框选座位格再归入区域`);
  }
}

/** 选区里所有格子的区域一致时返回该区域，否则为空 */
const selectionZoneId = computed(() => {
  const zones = draft.value?.seatOverlay?.cellZones ?? {};
  const ids = new Set(
    selectionAnchors.value.map((a) => zones[a]).filter(Boolean),
  );
  return ids.size === 1 ? [...ids][0] : "";
});
const selectionZoneMixed = computed(() => {
  const zones = draft.value?.seatOverlay?.cellZones ?? {};
  const ids = new Set(
    selectionAnchors.value.map((a) => zones[a]).filter(Boolean),
  );
  return ids.size > 1;
});
const zoneSelectOptions = computed(() => [
  {
    value: "",
    label: selectionZoneMixed.value ? "多个区域（选择以统一）" : "未分配区域",
  },
  ...overlayZones.value.map((z) => ({ value: z.id, label: z.name })),
]);

function zoneNameOf(id: string): string {
  return zoneById.value.get(id)?.name ?? "未分配区域";
}

/** 把当前选区归入某个区域（'') 表示清除归属） */
function setSelectionZone(zoneId: string): void {
  const anchors = selectionAnchors.value;
  if (!anchors.length) {
    flash("先框选或点选座位格");
    return;
  }
  const overlay = ensureOverlay();
  for (const anchor of anchors) {
    if (zoneId) overlay.cellZones[anchor] = zoneId;
    else delete overlay.cellZones[anchor];
  }
  flash(
    zoneId
      ? `已将 ${anchors.length} 个座位格归入「${zoneNameOf(zoneId)}」`
      : `已清除 ${anchors.length} 个座位格的区域归属`,
  );
}

/** 把座位格设为不坐人：已有人员时先确认，确认后移入未排座名单 */
function stopAnchors(anchors: string[], seatIds: Set<string>): void {
  if (!draft.value) return;
  const overlay = ensureOverlay();
  const fresh = anchors.filter((a) => !overlay.disabledCells.includes(a));
  if (!fresh.length) {
    flash("所选座位格已经是「不坐人」");
    return;
  }
  const hits = draft.value.assignments.filter((a) => seatIds.has(a.seatId));
  if (!hits.length) {
    applyStopAnchors(fresh, seatIds);
    return;
  }
  const names = hits
    .slice(0, 4)
    .map((a) => memberById.value.get(a.memberId)?.name ?? "未知")
    .join("、");
  confirmState.value = {
    open: true,
    title: "设为「不坐人」",
    desc: `所选 ${fresh.length} 个座位格已有 ${hits.length} 位人员落座（${names}${hits.length > 4 ? " 等" : ""}）。设为「不坐人」后这些人员会移入未排座名单，座位不参与排座、导出与打印。`,
    okText: "确认并移出",
    action: () => applyStopAnchors(fresh, seatIds),
  };
}

function applyStopAnchors(anchors: string[], seatIds: Set<string>): void {
  if (!draft.value) return;
  const overlay = ensureOverlay();
  for (const anchor of anchors) {
    if (!overlay.disabledCells.includes(anchor))
      overlay.disabledCells.push(anchor);
  }
  const removed = draft.value.assignments.filter((a) => seatIds.has(a.seatId));
  if (removed.length) {
    draft.value.assignments = draft.value.assignments.filter(
      (a) => !seatIds.has(a.seatId),
    );
    for (const a of removed) {
      if (!draft.value.unassigned.includes(a.memberId))
        draft.value.unassigned.push(a.memberId);
    }
  }
  flash(
    `${
      removed.length
        ? `已将 ${anchors.length} 个座位格设为「不坐人」，${removed.length} 位人员已移入未排座名单`
        : `已将 ${anchors.length} 个座位格设为「不坐人」`
    }${
      [...seatIds].some((id) => overlay.fixedSeats?.[id])
        ? "；固定座位绑定保留，但本次不生效"
        : ""
    }`,
  );
}

/** 选区批量设为不坐人 */
function stopSelectedCells(): void {
  const anchors = selectionAnchors.value;
  if (!anchors.length) {
    flash("先框选或点选座位格");
    return;
  }
  stopAnchors(anchors, new Set(selectionSeatIds.value));
}

/** 选区批量恢复为坐人 */
function restoreSelectedCells(): void {
  const overlay = ensureOverlay();
  const anchors = selectionAnchors.value;
  const hit = anchors.filter((a) => overlay.disabledCells.includes(a));
  if (!hit.length) {
    flash("所选座位格已经是「坐人」");
    return;
  }
  overlay.disabledCells = overlay.disabledCells.filter((a) => !hit.includes(a));
  flash(`已将 ${hit.length} 个座位格设为「坐人」`);
}

/** 座位详情卡：切换当前格坐人 / 不坐人 */
function setSelectedSeatOccupiable(seated: boolean): void {
  const p = selectedCellPos.value;
  if (!p || !layout.value || !draft.value) return;
  const anchor = anchorSeatIdOfCell(
    cellAt(layout.value.sheet, p.row, p.col),
    p.row,
    p.col,
  );
  if (!anchor) return;
  if (seated) {
    const overlay = ensureOverlay();
    if (!overlay.disabledCells.includes(anchor)) return;
    overlay.disabledCells = overlay.disabledCells.filter((a) => a !== anchor);
    flash("该座位已恢复为「坐人」，可重新排座");
    return;
  }
  stopAnchors([anchor], new Set(seatIdsOfCell(selectedCellKey.value)));
}

// ---- 区域管理：新建 / 编辑 / 删除（仅在当前项目内） ----
const zoneEditOpen = ref(false);
const zoneForm = ref<{ id: string; name: string; color: string }>({
  id: "",
  name: "",
  color: COLOR_PRESETS[0],
});

function openZoneCreate(): void {
  const n = overlayZones.value.length;
  zoneForm.value = {
    id: "",
    name: `区域 ${n + 1}`,
    color: COLOR_PRESETS[n % COLOR_PRESETS.length],
  };
  zoneEditOpen.value = true;
}

function openZoneEdit(id: string): void {
  const z = zoneById.value.get(id);
  if (!z) return;
  zoneForm.value = { id: z.id, name: z.name, color: z.color };
  zoneEditOpen.value = true;
}

function saveZone(): void {
  if (!draft.value) return;
  const name = zoneForm.value.name.trim();
  if (!name) {
    flash("请填写区域名称");
    return;
  }
  const overlay = ensureOverlay();
  if (zoneForm.value.id) {
    const z = overlay.zones.find((v) => v.id === zoneForm.value.id);
    if (!z) return;
    z.name = name;
    z.color = zoneForm.value.color;
  } else {
    overlay.zones.push({ id: uid("zone"), name, color: zoneForm.value.color });
  }
  zoneEditOpen.value = false;
  flash(
    zoneForm.value.id ? "区域已更新" : "区域已创建，可在座位图框选后归入该区域",
  );
}

function askDeleteZone(id: string): void {
  const z = zoneById.value.get(id);
  if (!z) return;
  confirmState.value = {
    open: true,
    title: "删除区域",
    desc: `删除「${z.name}」后，该区域的归属与区域规则会一并清除；座位与人员安排不受影响。`,
    okText: "删除区域",
    action: () => deleteZone(id),
  };
}

function deleteZone(id: string): void {
  if (!draft.value) return;
  const overlay = ensureOverlay();
  const name = overlay.zones.find((z) => z.id === id)?.name ?? "区域";
  overlay.zones = overlay.zones.filter((z) => z.id !== id);
  for (const [anchor, zoneId] of Object.entries(overlay.cellZones)) {
    if (zoneId === id) delete overlay.cellZones[anchor];
  }
  draft.value.ruleSet.zoneRules = (draft.value.ruleSet.zoneRules ?? []).filter(
    (r) => r.zoneId !== id,
  );
  draft.value.ruleSet.tiers = draft.value.ruleSet.tiers.filter(
    (t) => !(t.by === "zone" && t.zoneId === id),
  );
  if (focusedZoneId.value === id) focusedZoneId.value = "";
  flash(`已删除区域「${name}」`);
}

const selectedSeatRef = computed(() =>
  selectedSeat.value ? seatIndex.value.get(selectedSeat.value) : undefined,
);
/** 座位 id 失效时回落到点选时记录的桌，保证「应用」始终作用在用户点的那一格 */
const selectedCellPos = computed(() => {
  const s = selectedSeatRef.value;
  if (s) return { row: s.row, col: s.col };
  return pickedCell.value;
});
const selectedCellKey = computed(() => {
  const p = selectedCellPos.value;
  return p ? keyOf(p.row, p.col) : "";
});
const selectedCellSeats = computed(() => {
  const p = selectedCellPos.value;
  if (!p || !layout.value) return 1;
  return clampSeats(cellAt(layout.value.sheet, p.row, p.col)?.seats ?? 1);
});
watch(
  selectedCellSeats,
  (v) => {
    capCustom.value = v;
  },
  { immediate: true },
);

/** 容量变化后座位槽可能被重排：旧 id 失效时把选中态移到该桌第一个座位，卡片不脱锚 */
watch(allSeats, () => {
  if (!selectedSeat.value) return;
  if (seatIndex.value.has(selectedSeat.value)) return;
  const p = pickedCell.value;
  if (!p) return;
  const first = allSeats.value.find((s) => s.row === p.row && s.col === p.col);
  if (!first) {
    closeSeatCard();
    return;
  }
  selectedSeat.value = first.seatId;
  void nextTick(() => {
    const el = document.querySelector(
      `.board-card [data-seat-id="${CSS.escape(first.seatId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    seatAnchor.value = el;
    placeSeatCard();
  });
});

/** 指定格当前包含的座位 id（合并区按锚点归属） */
function seatIdsOfCell(key: string): string[] {
  if (!layout.value) return [];
  return seatsOfSheet(layout.value.sheet)
    .filter((s) => keyOf(s.row, s.col) === key)
    .map((s) => s.seatId);
}

function sameCaps(
  a?: Record<string, number>,
  b?: Record<string, number>,
): boolean {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a ?? {})[k] === (b ?? {})[k]);
}

/**
 * 设置若干张桌的容量：重排座位槽，保留仍存在的已落座人员；
 * 被裁掉的座位若有人，自动移出并明确提示，不静默丢弃。
 */
function setCapacity(keys: string[], nRaw: number): void {
  if (!draft.value || !layout.value) return;
  const n = clampSeats(nRaw);
  const targets = [...new Set(keys.filter(Boolean))];
  if (!targets.length) {
    flash("没有定位到座位所在的桌，请重新点选");
    return;
  }
  const before = new Set(targets.flatMap(seatIdsOfCell));
  const base = layoutOf(draft.value);
  const prevCaps = { ...(draft.value.seatCapacity ?? {}) };
  const caps = { ...prevCaps };
  let touched = 0;
  for (const key of targets) {
    const cell = base?.sheet.cells[key];
    if (!cell || (cell.kind !== "seat" && cell.kind !== "podium")) continue;
    touched++;
    if (clampSeats(cell.seats ?? 1) === n) delete caps[key];
    else caps[key] = n;
  }
  if (!touched) {
    flash("这张桌不能在排座项目里设置人数");
    return;
  }
  const changed = !sameCaps(prevCaps, caps);
  draft.value.seatCapacity = caps;
  const after = new Set(targets.flatMap(seatIdsOfCell));
  const lost = new Set([...before].filter((id) => !after.has(id)));
  const removed = lost.size
    ? draft.value.assignments.filter((a) => lost.has(a.seatId))
    : [];
  if (removed.length) {
    draft.value.assignments = draft.value.assignments.filter(
      (a) => !lost.has(a.seatId),
    );
    const names = removed
      .slice(0, 3)
      .map((a) => memberById.value.get(a.memberId)?.name ?? "未知")
      .join("、");
    flash(
      `容量改为 ${n} 人，${removed.length} 位已落座人员被移出：${names}${removed.length > 3 ? " 等" : ""}`,
    );
    return;
  }
  flash(
    targets.length > 1
      ? `已把 ${targets.length} 个座位格设为每桌 ${n} 人`
      : changed
        ? `本桌容量已设为 ${n} 人`
        : `本桌已是 ${n} 人`,
  );
}

/** 详情卡预设按钮：写入数字框并立即应用 */
function applyPreset(n: number): void {
  capCustom.value = n;
  setCapacity([selectedCellKey.value], n);
}

/** 详情卡「应用」：读取数字框，越界自动收敛后立即重算该格座位槽 */
function applyCapacityFromCard(): void {
  const raw = Number(capCustom.value);
  const n = clampSeats(
    Number.isFinite(raw) && raw > 0 ? raw : selectedCellSeats.value,
  );
  capCustom.value = n;
  setCapacity([selectedCellKey.value], n);
}

/** 属性面板：批量设置选区容量 */
function applySelectionCapacity(): void {
  if (!selectionKeys.value.length) {
    flash("先框选或点选座位格");
    return;
  }
  setCapacity(selectionKeys.value, batchCap.value);
}

function toggleCell(key: string): void {
  const i = cellSelection.value.indexOf(key);
  if (i >= 0) cellSelection.value.splice(i, 1);
  else cellSelection.value.push(key);
  if (cellSelection.value.length) sideTab.value = "props";
}

/** 框选结果：不按 Ctrl 替换选区，按住 Ctrl 追加 */
function selectCells(keys: string[], append: boolean): void {
  if (!append) {
    cellSelection.value = [...new Set(keys)];
    if (!keys.length) focusedZoneId.value = "";
    else sideTab.value = "props";
    return;
  }
  const set = new Set(cellSelection.value);
  for (const k of keys) set.add(k);
  cellSelection.value = [...set];
  if (cellSelection.value.length) sideTab.value = "props";
}

function clearCellSelection(): void {
  cellSelection.value = [];
  focusedZoneId.value = "";
}
const unseatedMembers = computed(() => {
  if (!draft.value) return [] as Member[];
  const seated = new Set(draft.value.assignments.map((a) => a.memberId));
  return presentMembers.value.filter((m) => !seated.has(m.id));
});
/** 空位人员选择：搜索 + 固定高度内部滚动（仅此处长列表例外） */
const seatQuery = ref("");
const seatCandidates = computed(() => {
  const q = seatQuery.value.trim().toLowerCase();
  if (!q) return unseatedMembers.value;
  return unseatedMembers.value.filter((m) => {
    const rank = rankById.value.get(m.rankId)?.name ?? "";
    const unit = unitById.value.get(m.unitId)?.name ?? "";
    return [m.name, rank, unit, m.duty ?? ""].some((s) =>
      s.toLowerCase().includes(q),
    );
  });
});
const projectOptions = computed(() =>
  state.projects.map((p) => ({ value: p.id, label: p.name })),
);
const rosterOptions = computed(() =>
  state.rosters.map((r) => ({ value: r.id, label: r.name })),
);
const layoutOptions = computed(() =>
  state.layouts.map((l) => ({ value: l.id, label: l.name })),
);

// ---- 固定座位：指定某个位置固定给某人，此人不参与其他座位排序 ----
const fixedSeats = computed<Record<string, string>>(
  () => draft.value?.seatOverlay?.fixedSeats ?? {},
);
/** 固定绑定按座位在布局中的先后排序，与排座算法的取舍保持一致 */
const sortedFixedSeats = computed(() =>
  Object.entries(fixedSeats.value)
    .filter(([, memberId]) => !!memberId)
    .sort((a, b) => {
      const sa = seatIndex.value.get(a[0]);
      const sb = seatIndex.value.get(b[0]);
      return (
        (sa?.row ?? 9999) - (sb?.row ?? 9999) ||
        (sa?.col ?? 9999) - (sb?.col ?? 9999) ||
        (sa?.index ?? 0) - (sb?.index ?? 0)
      );
    }),
);
/** 人员 → 固定座位（同一人只取座位顺序里的第一个，冲突由 fixedIssues 提示） */
const fixedSeatOfMember = computed(() => {
  const out = new Map<string, string>();
  for (const [seatId, memberId] of sortedFixedSeats.value) {
    if (!out.has(memberId)) out.set(memberId, seatId);
  }
  return out;
});
function fixedSeatOf(m: Member): string {
  return fixedSeatOfMember.value.get(m.id) ?? "";
}
const selectedFixedMemberId = computed(() =>
  selectedSeat.value ? fixedSeats.value[selectedSeat.value] : undefined,
);
const selectedFixedMember = computed(() => {
  const id = selectedFixedMemberId.value;
  return id ? memberById.value.get(id) : undefined;
});
/** 卡片当前展示的人员：优先本次安排，其次固定绑定（请假未落座时仍可见） */
const cardMember = computed(
  () => selectedMember.value ?? selectedFixedMember.value,
);
/** 当前固定座位在详情卡里需要提示的失效原因 */
const selectedFixedIssue = computed(() => {
  const m = selectedFixedMember.value;
  if (!m) return "";
  if (selectedSeatDisabled.value) return "该座位不坐人，固定暂不生效";
  if (m.status === "leave") return "该人员已请假，固定保留但暂不落座";
  if (!participants.value.some((p) => p.id === m.id))
    return "该人员不在本次排座名单，固定暂不生效";
  return "";
});
// 卡片内容变化会改变高度，重新贴合锚点
watch(
  [
    selectedSeat,
    () => cardMember.value?.id ?? "",
    () => !!selectedAssignment.value,
  ],
  () => {
    if (selectedSeat.value) void nextTick(placeSeatCard);
  },
);
const fixedEntries = computed(() =>
  sortedFixedSeats.value.map(([seatId, memberId]) => {
    const member = memberById.value.get(memberId);
    return {
      seatId,
      memberId,
      name: member?.name ?? "未知人员",
      seatLabel: seatLabel(seatId),
    };
  }),
);
/** 固定绑定的可见冲突：请假 / 失联 / 座位失效 / 一人多座 */
const fixedIssues = computed(() => {
  const out = new Set<string>();
  const seen = new Map<string, string>();
  for (const [seatId, memberId] of sortedFixedSeats.value) {
    if (!memberId) continue;
    const seat = seatIndex.value.get(seatId);
    const label = seat ? seatLabel(seatId) : "已失效的座位";
    if (!seat) {
      out.add("有固定座位已失效（座位槽被删除），请解除或重新设置");
      continue;
    }
    if (seat.disabled) out.add(`固定座位「${label}」不坐人，固定暂不生效`);
    const m = memberById.value.get(memberId);
    if (!m) {
      out.add(`固定座位「${label}」引用的人员不在名册中`);
      continue;
    }
    if (m.status === "leave")
      out.add(`「${m.name}」已请假，固定座位「${label}」暂不生效`);
    if (!participants.value.some((p) => p.id === m.id))
      out.add(`「${m.name}」不在本次排座名单，固定座位「${label}」暂不生效`);
    const prev = seen.get(m.id);
    if (prev) {
      out.add(
        `「${m.name}」被固定到多个座位（${prev} 与 ${label}），排座时仅保留前者`,
      );
    } else {
      seen.set(m.id, label);
    }
  }
  return [...out];
});

/** 写入固定绑定并立即把人员落到该座；替换、换座、请假等结果都明确提示 */
function applyFixedBinding(seatId: string, memberId: string): void {
  if (!draft.value) return;
  const overlay = ensureOverlay();
  const member = memberById.value.get(memberId);
  const seat = seatIndex.value.get(seatId);
  if (!member) {
    flash("该人员不在当前名册快照中，无法固定");
    return;
  }
  if (!seat) {
    flash("座位已失效，请重新选择");
    return;
  }
  if (seat.disabled) {
    flash("该座位不坐人，不能固定人员");
    return;
  }
  const oldSeat = fixedSeatOfMember.value.get(memberId);
  if (oldSeat && oldSeat !== seatId) delete overlay.fixedSeats![oldSeat];
  const prevMemberId = overlay.fixedSeats![seatId];
  const prevMember =
    prevMemberId && prevMemberId !== memberId
      ? memberById.value.get(prevMemberId)
      : undefined;
  overlay.fixedSeats![seatId] = memberId;

  const displaced = draft.value.assignments.find(
    (a) => a.seatId === seatId && a.memberId !== memberId,
  );
  draft.value.assignments = draft.value.assignments.filter(
    (a) => a.seatId !== seatId && a.memberId !== memberId,
  );
  draft.value.unassigned = draft.value.unassigned.filter(
    (id) => id !== memberId,
  );
  if (member.status !== "leave") {
    draft.value.assignments.push({
      seatId,
      memberId,
      status: "present",
    });
  }
  if (
    displaced &&
    displaced.memberId !== memberId &&
    !draft.value.unassigned.includes(displaced.memberId)
  ) {
    draft.value.unassigned.push(displaced.memberId);
  }

  const notes: string[] = [];
  if (prevMember) notes.push(`已解除「${prevMember.name}」在该座位的固定`);
  if (oldSeat && oldSeat !== seatId)
    notes.push(`「${member.name}」原固定座位已解除`);
  if (member.status === "leave")
    notes.push(`「${member.name}」当前请假，固定保留但暂不落座`);
  if (displaced && displaced.memberId !== memberId) {
    const dn = memberById.value.get(displaced.memberId)?.name ?? "未知人员";
    notes.push(`原座位人员「${dn}」已移入未排座`);
  }
  flash(
    `已将「${member.name}」固定到「${seatLabel(seatId)}」${
      notes.length ? "；" + notes.join("；") : ""
    }`,
  );
}

/** 详情卡里的锁是固定/解除固定的唯一入口 */
function toggleFixedSeat(): void {
  const seatId = selectedSeat.value;
  if (!seatId) return;
  if (selectedFixedMember.value) {
    unbindFixedSeat();
    return;
  }
  const memberId = selectedMember.value?.id;
  if (!memberId) return;
  applyFixedBinding(seatId, memberId);
}

/** 详情卡里解除当前座位的固定 */
function unbindFixedSeat(): void {
  const seatId = selectedSeat.value;
  if (!draft.value || !seatId) return;
  const overlay = ensureOverlay();
  const memberId = overlay.fixedSeats![seatId];
  if (!memberId) return;
  delete overlay.fixedSeats![seatId];
  const name = memberById.value.get(memberId)?.name ?? "该人员";
  flash(`已解除「${name}」的固定`);
}

function focusFixedSeat(seatId: string): void {
  if (!seatIndex.value.has(seatId)) {
    flash("该固定座位已失效，请解除后重新设置");
    return;
  }
  closeSeatCard();
  focusedSeat.value = seatId;
  boardPaneRef.value?.scrollToSeat(seatId);
}

function removeFixedSeat(seatId: string): void {
  if (!draft.value) return;
  const overlay = ensureOverlay();
  const memberId = overlay.fixedSeats![seatId];
  if (!memberId) return;
  delete overlay.fixedSeats![seatId];
  flash(
    `已解除「${memberById.value.get(memberId)?.name ?? "该人员"}」的固定；当前座位安排保留`,
  );
}

async function save(): Promise<void> {
  if (!draft.value) return;
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  await saveProject(draft.value);
  dirty.value = false;
  flash("项目已保存");
}

// ---- 新建 / 重命名 / 删除 ----
const createOpen = ref(false);
const createForm = ref({ name: "", rosterPlanId: "", layoutPackageId: "" });

function openCreate(): void {
  if (!state.rosters.length || !state.layouts.length) {
    flash("需要至少一套名册和一个布局");
    return;
  }
  createForm.value = {
    name: `排座项目 ${state.projects.length + 1}`,
    rosterPlanId: roster.value?.id ?? state.rosters[0].id,
    layoutPackageId: layout.value?.id ?? state.layouts[0].id,
  };
  createOpen.value = true;
}

async function createProject(): Promise<void> {
  const name = createForm.value.name.trim();
  if (!name) {
    flash("请填写项目名称");
    return;
  }
  if (!createForm.value.rosterPlanId || !createForm.value.layoutPackageId) {
    flash("请选择名册与布局");
    return;
  }
  const sourceRoster = state.rosters.find(
    (r) => r.id === createForm.value.rosterPlanId,
  );
  if (!sourceRoster) {
    flash("所选名册不存在");
    return;
  }
  const p: Project = {
    id: uid("proj"),
    name,
    rosterPlanId: createForm.value.rosterPlanId,
    layoutPackageId: createForm.value.layoutPackageId,
    rosterSnapshot: clone(sourceRoster),
    ruleSet: clone(DEFAULT_RULESET),
    seatOverlay: defaultOverlay(),
    assignments: [],
    participantIds: [],
    unassigned: [],
    pendingNames: [],
    status: "draft",
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  await saveProject(p);
  createOpen.value = false;
  selectedId.value = p.id;
  flash("项目已创建");
}

/** 显式切换名册来源：重新冻结快照并清空旧分配，避免新旧人员混用 */
function changeRosterSource(id: string): void {
  if (!draft.value || !id || id === draft.value.rosterPlanId) return;
  const live = state.rosters.find((r) => r.id === id);
  if (!live) return;
  draft.value.rosterPlanId = id;
  draft.value.rosterSnapshot = clone(live);
  draft.value.assignments = [];
  draft.value.participantIds = [];
  draft.value.unassigned = [];
  draft.value.pendingNames = [];
  draft.value.status = "draft";
  flash("已切换名册来源，名单与排座结果已重置");
}

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
  if (!name) {
    flash("请填写项目名称");
    return;
  }
  draft.value.name = name;
  renameOpen.value = false;
  flash("名称已修改，记得保存");
}

const confirmState = ref<{
  open: boolean;
  title: string;
  desc: string;
  okText?: string;
  action: () => void;
}>({
  open: false,
  title: "",
  desc: "",
  action: () => {},
});

function askDelete(): void {
  if (!draft.value) return;
  const id = draft.value.id;
  const name = draft.value.name;
  confirmState.value = {
    open: true,
    title: "删除排座项目",
    desc: `「${name}」及其排座结果将被删除，此操作不可撤销。`,
    action: async () => {
      autosaveSeq++;
      window.clearTimeout(autosaveTimer);
      dirty.value = false;
      await removeProject(id);
      selectedId.value = state.projects[0]?.id ?? "";
      flash("项目已删除");
    },
  };
}

/** 清空本项目全部座位：先把当前结果存快照，人员回到未排座名单，在位/请假与名册不动 */
async function clearAllSeats(): Promise<void> {
  if (!draft.value) return;
  const d = draft.value;
  const fixed = fixedSeats.value;
  const kept = d.assignments.filter((a) => !!fixed[a.seatId]);
  const cleared = d.assignments.length - kept.length;
  await saveSnapshot({
    id: uid("snap"),
    projectId: d.id,
    createdAt: nowISO(),
    label: "清空前快照",
    assignments: clone(d.assignments),
  });
  d.assignments = kept;
  const keptMembers = new Set(kept.map((a) => a.memberId));
  d.unassigned = presentMembers.value
    .filter((m) => !keptMembers.has(m.id))
    .map((m) => m.id);
  d.status = "draft";
  warnings.value = [];
  await saveProject(d);
  await loadSnaps();
  dirty.value = false;
  flash(
    `已清空 ${cleared} 个座位${
      kept.length ? `，保留 ${kept.length} 个固定座位` : ""
    }，其余人员已回到未排座名单`,
  );
}

function askClearSeats(): void {
  if (!draft.value) return;
  const count = draft.value.assignments.length;
  if (!count) {
    flash("当前没有座位安排可清空");
    return;
  }
  const fixedCount = draft.value.assignments.filter(
    (a) => !!fixedSeats.value[a.seatId],
  ).length;
  confirmState.value = {
    open: true,
    title: "清空全部座位",
    desc: `将清空「${draft.value.name}」的 ${count} 个座位安排${
      fixedCount ? `，保留 ${fixedCount} 个固定座位` : ""
    }。其余人员回到未排座名单。`,
    okText: "确认清空",
    action: clearAllSeats,
  };
}

function runConfirm(): void {
  confirmState.value.action();
  confirmState.value.open = false;
}

// ---- 排座 ----
/**
 * force=false 时，名册与本项目快照存在未确认差异就先弹确认面板：
 * 快照是历史记录，不能在排座时被悄悄改写，由用户选择「先更新」还是「按快照排」。
 */
async function runArrange(force = false): Promise<void> {
  if (!draft.value || !roster.value || !layout.value) return;
  if (!force && rosterDiff.value.length) {
    arrangeDiffOpen.value = true;
    return;
  }
  const ids = draft.value.participantIds.length
    ? draft.value.participantIds
    : roster.value.members.map((m) => m.id);
  if (!ids.length) {
    flash("名册中没有可排座人员，请先维护名册或勾选参会人员");
    return;
  }
  if (!seatsOfSheet(layout.value.sheet).some((s) => !s.disabled)) {
    flash("当前布局没有可用座位，请先在布局页添加座位");
    return;
  }
  busy.value = true;
  try {
    if (draft.value.assignments.length) {
      await saveSnapshot({
        id: uid("snap"),
        projectId: draft.value.id,
        createdAt: nowISO(),
        label: "排座前快照",
        assignments: clone(draft.value.assignments),
      });
    }
    const res = applyRulesToProject(draft.value, roster.value, layout.value);
    draft.value.assignments = res.assignments;
    draft.value.unassigned = res.unassigned;
    draft.value.status = "seated";
    warnings.value = res.warnings;
    await saveProject(draft.value);
    await loadSnaps();
    dirty.value = false;
    flash(
      `已排出 ${res.assignments.length} 个座位，请假 ${leaveMembers.value.length} 人不参与排座`,
    );
  } finally {
    busy.value = false;
  }
}

function seatDisabled(id: string): boolean {
  return !!seatIndex.value.get(id)?.disabled;
}

function swapSeats(a: string, b: string): void {
  if (!draft.value) return;
  if (fixedSeats.value[a] || fixedSeats.value[b]) {
    flash("固定座位不能移动人员，请先解除固定");
    return;
  }
  if (seatDisabled(a) || seatDisabled(b)) {
    flash("该座位为不坐人，不能移动人员");
    return;
  }
  const aa = draft.value.assignments.find((x) => x.seatId === a);
  const bb = draft.value.assignments.find((x) => x.seatId === b);
  if (aa && bb) {
    const m = aa.memberId;
    aa.memberId = bb.memberId;
    bb.memberId = m;
    const s = aa.status;
    aa.status = bb.status;
    bb.status = s;
  } else if (aa) {
    aa.seatId = b;
  } else if (bb) {
    bb.seatId = a;
  }
  swapFlash.value = [a, b];
  window.clearTimeout(swapTimer);
  swapTimer = window.setTimeout(() => {
    swapFlash.value = [];
  }, 950);
}

/** 在位 / 请假：只改本项目快照，不影响总名册与其它项目。 */
async function setMemberStatus(
  m: Member,
  status: Member["status"],
): Promise<void> {
  if (m.status === status) return;
  const snap = draft.value?.rosterSnapshot;
  if (!draft.value || !snap) return;
  const target = snap.members.find((x) => x.id === m.id);
  if (!target) return;
  target.status = status;
  if (status === "leave") {
    draft.value.assignments = draft.value.assignments.filter(
      (a) => a.memberId !== m.id,
    );
  }
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  await saveProject(draft.value);
  dirty.value = false;
  const fixedSeat = fixedSeatOf(m);
  flash(
    status === "leave"
      ? `「${m.name}」已请假，并已从座位移出${
          fixedSeat ? "；固定座位绑定保留但暂不生效" : ""
        }`
      : `「${m.name}」已恢复在位，可重新排座`,
  );
}

/** 座位详情里的与会状态：点一下立即切换并保存 */
async function setStatus(s: AttendStatus): Promise<void> {
  const a = selectedAssignment.value;
  if (!a || a.status === s || !draft.value) return;
  a.status = s;
  autosaveSeq++;
  window.clearTimeout(autosaveTimer);
  await saveProject(draft.value);
  dirty.value = false;
}

function clearSeat(): void {
  if (!draft.value || !selectedSeat.value) return;
  const fixedId = fixedSeats.value[selectedSeat.value];
  if (fixedId) {
    const name = memberById.value.get(fixedId)?.name ?? "该人员";
    flash(`该座位已固定给「${name}」，请先解除固定再清空座位`);
    return;
  }
  draft.value.assignments = draft.value.assignments.filter(
    (a) => a.seatId !== selectedSeat.value,
  );
}

function seatMember(memberId: string): void {
  if (!draft.value || !selectedSeat.value || !memberId) return;
  if (selectedSeatDisabled.value) {
    flash("该座位为不坐人，不能移动人员");
    return;
  }
  if (fixedSeats.value[selectedSeat.value]) {
    flash("该座位已固定给其他人员，请先解除固定");
    return;
  }
  const existing = draft.value.assignments.find(
    (a) => a.seatId === selectedSeat.value,
  );
  if (existing) existing.memberId = memberId;
  else
    draft.value.assignments.push({
      seatId: selectedSeat.value,
      memberId,
      status: "present",
    });
}

/** 空位选择人员：安排后清空搜索，卡片切换到人员视图 */
function pickSeatMember(memberId: string): void {
  seatMember(memberId);
  seatQuery.value = "";
}

// ---- 名单 ----

// ---- 手动添加人员：对话框录入，单个回车添加，支持逗号 / 顿号 / 换行分隔批量添加 ----
const addOpen = ref(false);
const addText = ref("");
const addRankId = ref("");
const addUnitId = ref("");
const addDuty = ref("");
const addInputEl = ref<HTMLTextAreaElement | null>(null);

const addRankOptions = computed(() => {
  const base = [{ value: "", label: "级别（可留空）" }];
  if (!roster.value) return base;
  const ranks = [...roster.value.ranks].sort((a, b) => a.order - b.order);
  return [...base, ...ranks.map((r) => ({ value: r.id, label: r.name }))];
});
const addUnitOptions = computed(() => {
  const base = [{ value: "", label: "单位（可留空）" }];
  if (!roster.value) return base;
  return [
    ...base,
    ...roster.value.units.map((u) => ({ value: u.id, label: u.name })),
  ];
});

const snapUnitOptions = computed(() =>
  (roster.value?.units ?? []).map((u) => ({ value: u.id, label: u.name })),
);
const snapUnitNames = computed(() =>
  (roster.value?.units ?? []).map((u) => u.name),
);
const snapRankNames = computed(() =>
  (roster.value?.ranks ?? []).map((r) => r.name),
);
const snapRootUnitId = computed(
  () =>
    roster.value?.units.find((u) => u.parentId === null)?.id ??
    roster.value?.units[0]?.id ??
    "",
);

function openAdd(): void {
  addText.value = "";
  addDuty.value = "";
  addOpen.value = true;
  void nextTick(() => addInputEl.value?.focus());
}

function splitNames(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，、;；\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function onAddKey(e: KeyboardEvent): void {
  if (e.isComposing) return;
  e.preventDefault();
  void submitAdd();
}

async function submitAdd(): Promise<void> {
  const snap = draft.value?.rosterSnapshot;
  if (!draft.value || !snap) return;
  const names = splitNames(addText.value);
  if (!names.length) return;
  const unitId = addUnitId.value || snap.units[0]?.id;
  const rankId =
    addRankId.value || [...snap.ranks].sort((a, b) => b.order - a.order)[0]?.id;
  if (!unitId || !rankId) {
    flash("名册里至少需要一个单位和一个职级");
    return;
  }

  const wasEmpty = !draft.value.participantIds.length;
  const touched: string[] = [];
  const duty = addDuty.value.trim() || undefined;
  let created = 0;
  for (const name of names) {
    const hit = snap.members.find(
      (m) => m.name === name || m.aliases.includes(name),
    );
    if (hit) {
      touched.push(hit.id);
      continue;
    }
    const member: Member = {
      id: uid("m"),
      name,
      unitId,
      rankId,
      duty,
      aliases: [],
      status: "present",
      order: snap.members.length,
    };
    snap.members.push(member);
    touched.push(member.id);
    created++;
  }
  // 名单为空时表示「全名册参与」，新增后仍保持全员在名单内
  draft.value.participantIds = wasEmpty
    ? snap.members.map((m) => m.id)
    : [...new Set([...draft.value.participantIds, ...touched])];
  addText.value = "";
  addDuty.value = "";
  addOpen.value = false;
  flash(
    created
      ? `已添加 ${created} 人并加入参会名单`
      : `已加入参会名单：${names.join("、")}`,
  );
}

// ---- 导入名册：复用名册页的批量导入（文件解析 / 字段映射 / 预览修正） ----
const importOpen = ref(false);

function handleProjectImport(payload: {
  rows: {
    name: string;
    gender: "" | "M" | "F";
    unit: string;
    rank: string;
    duty: string;
    note: string;
  }[];
  targetUnitId: string;
}): void {
  const snap = draft.value?.rosterSnapshot;
  if (!draft.value || !snap || !payload.rows.length) return;
  const rootId =
    snap.units.find((u) => u.parentId === null)?.id ?? snap.units[0]?.id ?? "";
  const fallbackRank = [...snap.ranks].sort((a, b) => b.order - a.order)[0];
  const wasEmpty = !draft.value.participantIds.length;
  const createdIds: string[] = [];
  let newRanks = 0;
  for (const row of payload.rows) {
    const unitName = row.unit.trim();
    const unitId =
      (unitName ? snap.units.find((u) => u.name === unitName)?.id : "") ||
      payload.targetUnitId ||
      rootId;
    let rankId = fallbackRank?.id ?? "";
    const rankName = row.rank.trim();
    if (rankName) {
      const exact = snap.ranks.find((r) => r.name === rankName);
      if (exact) rankId = exact.id;
      else {
        const order = Math.max(0, ...snap.ranks.map((r) => r.order)) + 1;
        const created = {
          id: uid("rank"),
          name: rankName,
          order,
          color: "#8a979d",
        };
        snap.ranks.push(created);
        rankId = created.id;
        newRanks++;
      }
    }
    const member: Member = {
      id: uid("m"),
      name: row.name,
      unitId,
      rankId,
      duty: row.duty.trim() || undefined,
      aliases: [],
      gender: row.gender || undefined,
      note: row.note || undefined,
      status: "present",
      order: snap.members.length,
    };
    snap.members.push(member);
    createdIds.push(member.id);
  }
  draft.value.participantIds = wasEmpty
    ? snap.members.map((m) => m.id)
    : [...new Set([...draft.value.participantIds, ...createdIds])];
  importOpen.value = false;
  flash(
    `已导入 ${payload.rows.length} 人${newRanks ? `，新建职级 ${newRanks} 个` : ""}`,
  );
}

// ---- 手动更新名册快照：与当前名册比对，逐项选择应用 ----
type DiffKind =
  | "name"
  | "unit"
  | "rank"
  | "duty"
  | "removed"
  | "added"
  | "order";
interface RosterDiffItem {
  key: string;
  kind: DiffKind;
  memberId: string;
  name: string;
  from: string;
  to: string;
  /** 聚合项的明细（如顺序调整后的完整姓名序列），默认折叠 */
  detail?: string[];
}
const DIFF_META: Record<DiffKind, { label: string; icon: string }> = {
  name: { label: "姓名变更", icon: "edit" },
  unit: { label: "单位变更", icon: "host" },
  rank: { label: "职级调整", icon: "up" },
  duty: { label: "职务变更", icon: "label" },
  removed: { label: "已不在名册", icon: "warning" },
  added: { label: "新增人员", icon: "plus" },
  order: { label: "顺序调整", icon: "grip" },
};
const DIFF_ORDER: DiffKind[] = [
  "name",
  "unit",
  "rank",
  "duty",
  "removed",
  "added",
  "order",
];

const liveRoster = computed(() => {
  const id = draft.value?.rosterPlanId;
  return id ? state.rosters.find((r) => r.id === id) : undefined;
});

/** 当前名册 vs 项目快照的差异；未应用的差异会一直提示 */
const rosterDiff = computed<RosterDiffItem[]>(() => {
  const snap = draft.value?.rosterSnapshot;
  const live = liveRoster.value;
  if (!draft.value || !snap || !live) return [];
  const liveById = new Map(live.members.map((m) => [m.id, m]));
  const snapById = new Map(snap.members.map((m) => [m.id, m]));
  const unitName = (r: RosterPlan, id: string): string =>
    r.units.find((u) => u.id === id)?.name ?? "未定单位";
  const rankName = (r: RosterPlan, id: string): string =>
    r.ranks.find((x) => x.id === id)?.name ?? "未定级";
  const items: RosterDiffItem[] = [];
  for (const m of snap.members) {
    const cur = liveById.get(m.id);
    if (!cur) {
      items.push({
        key: `removed:${m.id}`,
        kind: "removed",
        memberId: m.id,
        name: m.name,
        from: memberHint(m),
        to: "名册中已移除",
      });
      continue;
    }
    // 姓名、职级、单位、职务都会显示在座位图 / 名单 / 导出里，任何一项变化都要能被检测到
    if ((cur.name ?? "") !== (m.name ?? "")) {
      items.push({
        key: `name:${m.id}`,
        kind: "name",
        memberId: m.id,
        name: cur.name,
        from: m.name,
        to: cur.name,
      });
    }
    if (cur.unitId !== m.unitId) {
      items.push({
        key: `unit:${m.id}`,
        kind: "unit",
        memberId: m.id,
        name: cur.name,
        from: unitName(snap, m.unitId),
        to: unitName(live, cur.unitId),
      });
    }
    if (cur.rankId !== m.rankId) {
      items.push({
        key: `rank:${m.id}`,
        kind: "rank",
        memberId: m.id,
        name: cur.name,
        from: rankName(snap, m.rankId),
        to: rankName(live, cur.rankId),
      });
    }
    const oldDuty = (m.duty ?? "").trim();
    const newDuty = (cur.duty ?? "").trim();
    if (oldDuty !== newDuty) {
      items.push({
        key: `duty:${m.id}`,
        kind: "duty",
        memberId: m.id,
        name: cur.name,
        from: oldDuty || "未填写",
        to: newDuty || "未填写",
      });
    }
  }
  for (const m of live.members) {
    if (snapById.has(m.id)) continue;
    items.push({
      key: `added:${m.id}`,
      kind: "added",
      memberId: m.id,
      name: m.name,
      from: "名册中新增",
      to: `${rankName(live, m.rankId)} · ${unitName(live, m.unitId)}`,
    });
  }
  // 顺序：只比较双方都存在的成员，纯排序变化也要用户确认
  const snapCommon = snap.members
    .filter((m) => liveById.has(m.id))
    .map((m) => m.id);
  const liveCommon = live.members
    .filter((m) => snapById.has(m.id))
    .map((m) => m.id);
  if (snapCommon.join("|") !== liveCommon.join("|")) {
    items.push({
      key: "order",
      kind: "order",
      memberId: "",
      name: "名册顺序",
      from: "快照顺序",
      to: `当前顺序（${liveCommon.length} 人）`,
      // 聚合项：只在展开时列出完整顺序，避免一次铺开几十行
      detail: live.members.filter((m) => snapById.has(m.id)).map((m) => m.name),
    });
  }
  return items;
});

const diffGroups = computed(() =>
  DIFF_ORDER.map((kind) => ({
    kind,
    label: DIFF_META[kind].label,
    icon: DIFF_META[kind].icon,
    items: rosterDiff.value.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length),
);

const diffOpen = ref(false);
/** 「开始排座」时存在未确认差异的确认面板 */
const arrangeDiffOpen = ref(false);
const diffPick = ref<Record<string, boolean>>({});
/** 聚合项明细的展开状态，默认全部收起 */
const diffDetail = ref<Record<string, boolean>>({});
const diffPickedCount = computed(
  () => rosterDiff.value.filter((it) => diffPick.value[it.key]).length,
);
const diffAllPicked = computed(
  () =>
    rosterDiff.value.length > 0 &&
    diffPickedCount.value === rosterDiff.value.length,
);

async function toggleDiffDetail(key: string): Promise<void> {
  diffDetail.value[key] = !diffDetail.value[key];
  if (!diffDetail.value[key]) return;
  // 明细可能落在滚动区之外，展开后滚到可视范围，避免点了没反应
  await nextTick();
  document
    .querySelector<HTMLElement>(`[data-diff-detail="${key}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function openRosterDiff(): void {
  diffPick.value = Object.fromEntries(
    rosterDiff.value.map((it) => [it.key, true]),
  );
  diffDetail.value = {};
  diffOpen.value = true;
}

/** 从排座确认面板进入手动更新 */
function updateRosterBeforeArrange(): void {
  arrangeDiffOpen.value = false;
  openRosterDiff();
}

/** 用户确认按冻结快照排座 */
function arrangeWithSnapshot(): void {
  arrangeDiffOpen.value = false;
  void runArrange(true);
}

function toggleDiffAll(): void {
  const next = !diffAllPicked.value;
  diffPick.value = Object.fromEntries(
    rosterDiff.value.map((it) => [it.key, next]),
  );
}

async function applyRosterDiff(): Promise<void> {
  const snap = draft.value?.rosterSnapshot;
  const live = liveRoster.value;
  if (!draft.value || !snap || !live) return;
  const picked = rosterDiff.value.filter((it) => diffPick.value[it.key]);
  if (!picked.length) {
    diffOpen.value = false;
    return;
  }
  const liveById = new Map(live.members.map((m) => [m.id, m]));
  const removed = new Set<string>();
  for (const it of picked) {
    if (it.kind === "order") continue;
    const cur = liveById.get(it.memberId);
    if (it.kind === "removed") {
      removed.add(it.memberId);
      continue;
    }
    if (!cur) continue;
    if (it.kind === "added") {
      if (!snap.members.some((m) => m.id === cur.id))
        snap.members.push(clone(cur));
      if (
        draft.value.participantIds.length &&
        !draft.value.participantIds.includes(cur.id)
      ) {
        draft.value.participantIds.push(cur.id);
      }
    } else {
      const target = snap.members.find((m) => m.id === it.memberId);
      if (!target) continue;
      if (it.kind === "name") target.name = cur.name;
      if (it.kind === "unit") target.unitId = cur.unitId;
      if (it.kind === "rank") target.rankId = cur.rankId;
      if (it.kind === "duty")
        target.duty = (cur.duty ?? "").trim() || undefined;
    }
  }
  if (picked.some((it) => it.kind === "order")) {
    const pos = new Map(live.members.map((m, i) => [m.id, i]));
    snap.members = [...snap.members].sort(
      (a, b) =>
        (pos.get(a.id) ?? snap.members.length) -
        (pos.get(b.id) ?? snap.members.length),
    );
    snap.members.forEach((m, i) => {
      m.order = i;
    });
    if (draft.value.participantIds.length) {
      const order = new Map(snap.members.map((m, i) => [m.id, i]));
      draft.value.participantIds = [...draft.value.participantIds].sort(
        (a, b) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6),
      );
    }
  }
  if (removed.size) {
    snap.members = snap.members.filter((m) => !removed.has(m.id));
    draft.value.assignments = draft.value.assignments.filter(
      (a) => !removed.has(a.memberId),
    );
    draft.value.participantIds = draft.value.participantIds.filter(
      (id) => !removed.has(id),
    );
    draft.value.unassigned = draft.value.unassigned.filter(
      (id) => !removed.has(id),
    );
  }
  // 职级/单位定义同步为最新，保证名称与排序一致
  snap.ranks = clone(live.ranks);
  snap.units = clone(live.units);
  diffOpen.value = false;
  // 只有影响排序/人员集合的变更才需要重排；姓名、职务只改显示
  const needArrange = picked.some((it) =>
    ["rank", "unit", "added", "removed", "order"].includes(it.kind),
  );
  if (needArrange) warnings.value = ["名册快照已更新，建议重新排座"];
  flash(
    `已应用 ${picked.length} 项名册变更${needArrange ? "，建议重新排座" : "，座位与名单显示已同步"}`,
  );
}

// ---- 导出 ----
/** 初始值取自设置中心的全局偏好；本次导出内改动只影响当前会话 */
const exportScale = ref<2 | 3 | 4>(preferences.exportScale);
const paper = ref<"landscape" | "portrait">(preferences.paper);
const exportScaleOptions = [
  { value: 2, label: "2× 清晰" },
  { value: 3, label: "3× 高清" },
  { value: 4, label: "4× 超清" },
];
const paperOptions = [
  { value: "landscape", label: "A4 横向" },
  { value: "portrait", label: "A4 纵向" },
];

/** 控制像素上限，避免大布局导出成空白画布 */
function chartCanvas(scale: number): {
  canvas: HTMLCanvasElement;
  scale: number;
} {
  const layoutNow = layout.value!;
  const size = sheetSize(layoutNow.sheet);
  const fit = Math.min(12000 / (size.w + 128), 12000 / (size.h + 164), 4);
  const used = Math.max(0.5, Math.min(scale, fit));
  const subtitleParts = [`共 ${assignedCount.value} 人就座`];
  if (disabledSeats.value)
    subtitleParts.push(`${disabledSeats.value} 个不坐人`);
  const canvas = renderSeatChart({
    layout: layoutNow,
    roster: displayRoster.value!,
    assignments: draft.value!.assignments,
    title: draft.value!.name,
    subtitle: `${roster.value!.name} · ${subtitleParts.join(" · ")}`,
    showSeatNumbers: showSeatNumbers.value,
    showRank: showRank.value,
    showDuty: showDuty.value,
    showUnit: showUnit.value,
    seatNumbers: seatOrder.value,
    fixedSeats: fixedSeats.value,
    scale: used,
  });
  return { canvas, scale: used };
}

function exportPng(): void {
  if (!draft.value || !layout.value || !roster.value) return;
  const { canvas, scale } = chartCanvas(exportScale.value);
  if (scale < exportScale.value)
    flash(`画幅较大，已按 ${scale.toFixed(1)}× 输出`);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.value!.name.replace(/\s+/g, "-")}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
}

const STATUS_LABEL: Record<AttendStatus, string> = {
  present: "在位",
  leave: "请假",
};

/** 导出排座结果明细：排号/座号来自工作表，人员信息来自名册 */
function exportExcel(): void {
  if (!draft.value || !layout.value || !roster.value) return;
  const bySeat = new Map(draft.value.assignments.map((a) => [a.seatId, a]));
  const zoneName = (id?: string) =>
    layout.value!.zones.find((z) => z.id === id)?.name ?? "";
  const unitName = (id?: string) =>
    roster.value!.units.find((u) => u.id === id)?.name ?? "";
  const rows: (string | number)[][] = [
    ["排号", "座号", "姓名", "职级", "单位", "状态", "区域"],
  ];
  const noOf = (seat: SeatRef): number =>
    seatOrder.value.get(seat.seatId) ?? seat.seatNo;
  const seats = [...allSeats.value].sort(
    (a, b) => a.row - b.row || noOf(a) - noOf(b),
  );
  for (const s of seats) {
    const zone = zoneName(s.zoneId);
    if (s.disabled) {
      rows.push([
        s.stage ? "主席台" : s.row + 1,
        "",
        "不坐人",
        "",
        "",
        "不可用",
        zone,
      ]);
      continue;
    }
    const a = bySeat.get(s.seatId);
    const m = a ? memberById.value.get(a.memberId) : undefined;
    rows.push([
      s.stage ? "主席台" : s.row + 1,
      noOf(s),
      m?.name ?? "",
      m ? (rankById.value.get(m.rankId)?.name ?? "未定级") : "",
      m ? unitName(m.unitId) : "",
      a ? STATUS_LABEL[a.status] : "空位",
      zone,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 8 },
    { wch: 6 },
    { wch: 10 },
    { wch: 10 },
    { wch: 14 },
    { wch: 8 },
    { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "排座结果");
  const buf = XLSX.write(wb, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer;
  const url = URL.createObjectURL(
    new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${draft.value.name.replace(/\s+/g, "-")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/** 一键导出当前项目在位人员名单：请假人员不导出 */
function exportPresentRoster(): void {
  if (!draft.value || !layout.value || !roster.value) return;
  const bySeat = new Map(draft.value.assignments.map((a) => [a.seatId, a]));
  const zoneName = (id?: string) =>
    layout.value!.zones.find((z) => z.id === id)?.name ?? "";
  const unitName = (id?: string) =>
    roster.value!.units.find((u) => u.id === id)?.name ?? "";
  const noOf = (seat: SeatRef): number =>
    seatOrder.value.get(seat.seatId) ?? seat.seatNo;
  const rows: (string | number)[][] = [
    ["姓名", "职级", "单位", "职务", "座位号", "区域"],
  ];
  const seats = [...allSeats.value].sort(
    (a, b) => a.row - b.row || noOf(a) - noOf(b),
  );
  for (const s of seats) {
    if (s.disabled) continue;
    const a = bySeat.get(s.seatId);
    const m = a ? memberById.value.get(a.memberId) : undefined;
    if (!a || !m || m.status === "leave" || a.status === "leave") continue;
    rows.push([
      m.name,
      rankById.value.get(m.rankId)?.name ?? "未定级",
      unitName(m.unitId),
      m.duty ?? "",
      `${s.stage ? "主席台" : `${s.row + 1} 排`} ${noOf(s)} 号`,
      zoneName(s.zoneId),
    ]);
  }
  if (rows.length === 1) {
    flash("当前没有在位人员");
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 10 },
    { wch: 10 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "在位人员");
  const buf = XLSX.write(wb, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer;
  const url = URL.createObjectURL(
    new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${draft.value.name.replace(/\s+/g, "-")}-在位人员名单.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
  flash(`已导出 ${rows.length - 1} 位在位人员`);
}

function printChart(): void {
  if (!draft.value || !layout.value || !roster.value) return;
  const { canvas } = chartCanvas(2);
  const url = canvas.toDataURL("image/png");
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${draft.value.name}</title>` +
      `<style>@page{size:A4 ${paper.value};margin:8mm}html,body{margin:0;padding:0}img{width:100%;height:auto}</style>` +
      `</head><body><img src="${url}" onload="window.focus()"></body></html>`,
  );
  doc.close();
  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 800);
  }, 400);
}

// ---- 快照恢复 ----
const snapshots = ref<
  { id: string; createdAt: string; label: string; seats: number }[]
>([]);
/** 勾选待删除的快照 */
const snapSelected = ref<string[]>([]);
async function loadSnaps(): Promise<void> {
  snapSelected.value = [];
  if (!draft.value) return;
  const list = await listSnapshots(draft.value.id);
  snapshots.value = list
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      label: s.label,
      seats: s.assignments.length,
    }));
}
watch(selectedId, () => loadSnaps(), { immediate: true });
// 排座会新增快照、切回导出页时需要重新读取
watch(sideTab, (t) => {
  if (t === "export") void loadSnaps();
});

function toggleSnap(id: string): void {
  const i = snapSelected.value.indexOf(id);
  if (i >= 0) snapSelected.value.splice(i, 1);
  else snapSelected.value.push(id);
}

/** 表头全选：全部选中时再点取消，部分选中显示半选 */
const snapAllChecked = computed(
  () =>
    snapshots.value.length > 0 &&
    snapSelected.value.length === snapshots.value.length,
);
const snapSomeChecked = computed(
  () =>
    snapSelected.value.length > 0 &&
    snapSelected.value.length < snapshots.value.length,
);

function toggleAllSnaps(): void {
  snapSelected.value = snapAllChecked.value
    ? []
    : snapshots.value.map((s) => s.id);
}

/** 删除选中的快照：只影响历史版本，当前排座结果与实体数据不动 */
function askDeleteSnaps(): void {
  const ids = [...snapSelected.value];
  if (!ids.length) return;
  confirmState.value = {
    open: true,
    title: "删除历史快照",
    desc: `将删除选中的 ${ids.length} 个历史快照，删除后无法再恢复到这些版本；当前排座结果与名册、布局、项目数据不受影响。`,
    action: async () => {
      await removeSnapshots(ids);
      await loadSnaps();
      flash(`已删除 ${ids.length} 个历史快照`);
    },
  };
}

async function restoreSnap(id: string): Promise<void> {
  if (!draft.value) return;
  const s = await getSnapshot(id);
  if (!s) return;
  draft.value.assignments = clone(s.assignments);
  flash("已恢复该版本（记得保存）");
}
</script>

<template>
  <header class="page-head compact">
    <div class="page-head-main">
      <div class="page-eyebrow">排座项目</div>
      <div class="title-row">
        <h1 class="page-title">{{ draft?.name ?? "排座项目" }}</h1>
        <span v-if="dirty" class="save-dot">未保存</span>
      </div>
    </div>
    <div class="head-actions">
      <div style="width: 168px">
        <UiSelect
          v-model="selectedId"
          :options="projectOptions"
          placeholder="选择项目"
          size="sm"
        />
      </div>
      <button class="btn sm" @click="openCreate">
        <Icon name="plus" />新建
      </button>
      <button class="btn sm" :disabled="!draft" @click="openRename">
        <Icon name="edit" />重命名
      </button>
      <button
        class="icon-btn"
        title="删除项目"
        :disabled="!draft"
        style="color: var(--danger)"
        @click="askDelete"
      >
        <Icon name="trash" />
      </button>
      <button class="btn sm primary" :disabled="!dirty" @click="save">
        <Icon name="save" />{{ dirty ? "保存项目" : "已保存" }}
      </button>
    </div>
  </header>

  <div v-if="!draft" class="empty">还没有排座项目，点「新建项目」。</div>

  <template v-else-if="!roster || !layout">
    <div class="empty">当前项目引用的名册或布局已被删除，请重新选择。</div>
  </template>

  <template v-else>
    <div class="project-stage">
      <section class="project-setup">
        <div class="field">
          <label>名册方案</label>
          <UiSelect
            :model-value="draft.rosterPlanId"
            :options="rosterOptions"
            size="sm"
            @update:model-value="changeRosterSource"
          />
        </div>
        <div class="field">
          <label>会场布局</label>
          <UiSelect
            v-model="draft.layoutPackageId"
            :options="layoutOptions"
            size="sm"
          />
        </div>
        <div class="field setup-status">
          <label>项目状态</label>
          <div class="status-line">
            <span class="tag" :class="{ copper: draft.status === 'seated' }">{{
              draft.status === "seated" ? "已排座" : "草稿"
            }}</span>
            <span v-if="disabledSeats" class="tag"
              >不坐人 {{ disabledSeats }}</span
            >
            <span class="caption">{{ participants.length }} 人在名单</span>
          </div>
        </div>
        <div class="setup-grow">
          <button
            class="btn"
            :disabled="busy || !draft.assignments.length"
            @click="askClearSeats"
          >
            <Icon name="trash" />清空座位
          </button>
          <button class="btn primary" :disabled="busy" @click="runArrange()">
            <Icon name="render" />{{ busy ? "排座中…" : "开始排座" }}
          </button>
        </div>
      </section>

      <div class="project-metrics">
        <div class="pm-head">
          <span class="pm-title">座位构成</span>
          <span class="pm-rate"
            >使用率<b
              >{{
                totalSeats ? Math.round((assignedCount / totalSeats) * 100) : 0
              }}%</b
            ></span
          >
        </div>
        <UiChart
          :option="mixChart"
          :height="40"
          empty-text="布局里还没有座位数据"
        />
        <div class="pm-legend">
          <span class="pm-item"
            ><i class="pm-dot is-filled" />已就座
            <b>{{ assignedCount }}</b></span
          >
          <span class="pm-item"
            ><i class="pm-dot is-empty" />空位 <b>{{ emptySeats }}</b></span
          >
          <span class="pm-item"
            ><i class="pm-dot is-leave" />请假 <b>{{ leaveCount }}</b></span
          >
          <span class="pm-item"
            ><i class="pm-dot is-disabled" />不坐人
            <b>{{ disabledSeats }}</b></span
          >
          <span class="pm-total"
            >可用座位 <b>{{ totalSeats }}</b
            ><em>·</em>名单 <b>{{ participants.length }}</b></span
          >
        </div>
      </div>

      <div class="project-alert" :class="{ 'is-quiet': !warnings.length }">
        <template v-if="warnings.length">
          <Icon name="warning" :size="14" />
          <span class="pa-text">{{ warnings.join(" · ") }}</span>
        </template>
        <span v-else class="pa-text">暂无排座提醒</span>
        <div class="pa-toggles">
          <label class="pa-toggle" title="排座图与导出图片是否显示座位序号">
            <input v-model="draft.showSeatNumbers" type="checkbox" />
            <span>座位序号</span>
          </label>
          <label class="pa-toggle" title="座位下方显示职级">
            <input v-model="draft.showRank" type="checkbox" />
            <span>职级</span>
          </label>
          <label class="pa-toggle" title="座位下方显示职务">
            <input v-model="draft.showDuty" type="checkbox" />
            <span>职务</span>
          </label>
          <label class="pa-toggle" title="座位下方显示单位">
            <input v-model="draft.showUnit" type="checkbox" />
            <span>单位</span>
          </label>
        </div>
      </div>

      <div class="project-body">
        <div class="board-wrap">
          <SeatBoardPane
            ref="boardPaneRef"
            :layout="layout"
            :rules="draft.ruleSet"
            :seat-info="seatInfo"
            :selected-seat-id="selectedSeat"
            :highlight-seat-ids="swapFlash"
            :focus-seat-id="focusedSeat"
            :show-seat-numbers="showSeatNumbers"
            :show-rank="showRank"
            :show-duty="showDuty"
            :show-unit="showUnit"
            :selected-cells="cellSelection"
            :zone-highlight="zoneHighlight"
            :fixed-seats="fixedSeats"
            @pick="pickSeat"
            @swap="swapSeats"
            @cell-pick="toggleCell"
            @cell-select="selectCells"
            @clear-selection="clearCellSelection"
          />
        </div>

        <aside class="project-side">
          <div class="side-tabs">
            <button
              class="tab"
              :class="{ active: sideTab === 'overview' }"
              @click="sideTab = 'overview'"
            >
              概览
            </button>
            <button
              class="tab"
              :class="{ active: sideTab === 'props' }"
              @click="sideTab = 'props'"
            >
              选区
            </button>
            <button
              class="tab"
              :class="{ active: sideTab === 'list' }"
              @click="sideTab = 'list'"
            >
              名单
            </button>
            <button
              class="tab"
              :class="{ active: sideTab === 'leave' }"
              @click="sideTab = 'leave'"
            >
              请假
            </button>
            <button
              class="tab"
              :class="{ active: sideTab === 'rules' }"
              @click="sideTab = 'rules'"
            >
              规则
            </button>
            <button
              class="tab"
              :class="{ active: sideTab === 'export' }"
              @click="sideTab = 'export'"
            >
              导出
            </button>
          </div>

          <div class="project-side-body">
            <section v-if="sideTab === 'overview'" class="side-section">
              <div class="side-head">
                <span class="side-title">会场概览</span>
                <span class="caption">随排座更新</span>
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>座位使用率</span>
                  <span class="caption"
                    >{{ usedSeats }} / {{ totalSeats }} 席</span
                  >
                </div>
                <UiChart
                  :option="usageChart"
                  :height="176"
                  empty-text="布局里还没有可用座位"
                />
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>参会状态</span>
                  <span class="caption"
                    >{{ draft.assignments.length }} 条安排</span
                  >
                </div>
                <UiChart
                  :option="statusChart"
                  :height="164"
                  empty-text="还没有安排人员"
                />
              </div>

              <div class="chart-block">
                <div class="chart-title">
                  <span>区域就座</span>
                  <span class="caption">已就座 / 可用</span>
                </div>
                <UiChart
                  :option="zoneChart"
                  :height="zoneChartHeight"
                  empty-text="布局里没有可用座位"
                />
              </div>

            </section>

            <!-- 选区属性：单选单元格或多选共用，框选结果直接作用于此 -->
            <section
              v-else-if="sideTab === 'props'"
              class="side-section props-section"
            >
              <div class="side-head">
                <span class="side-title">选区属性</span>
                <div class="side-head-actions">
                  <span v-if="selectionKeys.length" class="caption"
                    >已选 {{ selectionKeys.length }} 格</span
                  >
                  <button
                    v-if="selectionKeys.length"
                    type="button"
                    class="insp-btn"
                    title="清除选择（Esc）"
                    @click="clearCellSelection"
                  >
                    清空选择
                  </button>
                </div>
              </div>

              <template v-if="selectionKeys.length">
                <section class="insp-sec">
                  <div class="insp-title">选区概况</div>
                  <div class="bp-stats">
                    <span
                      >座位 <b>{{ selectionSeatIds.length }}</b></span
                    >
                    <span
                      >已落座 <b>{{ selectionOccupied }}</b></span
                    >
                    <span
                      >不坐人 <b>{{ selectionStopped }}</b></span
                    >
                  </div>
                  <p class="bp-note">容量：{{ selectionCapText || "—" }}</p>
                </section>

                <section class="insp-sec">
                  <div class="insp-title">座位容量</div>
                  <div class="bp-cap">
                    <button
                      type="button"
                      class="sp-cap-btn"
                      :class="{ on: batchCap === 1 }"
                      @click="batchCap = 1"
                    >
                      单人
                    </button>
                    <button
                      type="button"
                      class="sp-cap-btn"
                      :class="{ on: batchCap === 2 }"
                      @click="batchCap = 2"
                    >
                      双人
                    </button>
                    <UiNumberInput
                      v-model="batchCap"
                      :min="1"
                      :max="12"
                      size="sm"
                    />
                    <button
                      type="button"
                      class="sp-cap-btn"
                      @click="applySelectionCapacity"
                    >
                      应用
                    </button>
                  </div>
                </section>
              </template>

              <section class="insp-sec">
                <div class="insp-title">所属区域</div>
                <template v-if="selectionKeys.length">
                  <UiSelect
                    :model-value="selectionZoneId"
                    :options="zoneSelectOptions"
                    size="sm"
                    @update:model-value="setSelectionZone"
                  />
                </template>
                <div v-if="overlayZones.length" class="bp-zones">
                  <div
                    v-for="z in overlayZones"
                    :key="z.id"
                    class="bp-zone"
                    :class="{ 'is-on': focusedZoneId === z.id }"
                    role="button"
                    tabindex="0"
                    :title="`在画布上高亮「${z.name}」，再点一次取消`"
                    @click="toggleZoneFocus(z.id)"
                    @keydown.enter.prevent="toggleZoneFocus(z.id)"
                    @keydown.space.prevent="toggleZoneFocus(z.id)"
                  >
                    <button
                      type="button"
                      class="bp-zone-color"
                      :style="{ background: z.color }"
                      :title="`修改「${z.name}」的颜色`"
                      aria-label="修改区域颜色"
                      @click.stop="openZoneEdit(z.id)"
                    />
                    <span>{{ z.name }}</span>
                    <em>{{ zoneSeatCount[z.id] ?? 0 }}</em>
                    <button
                      type="button"
                      class="bp-zone-edit"
                      title="修改区域名称与颜色"
                      aria-label="编辑区域"
                      @click.stop="openZoneEdit(z.id)"
                    >
                      ✎
                    </button>
                  </div>
                </div>
                <p v-else class="bp-note">还没有区域，先新建一个。</p>
                <div class="bp-actions">
                  <button
                    type="button"
                    class="insp-btn"
                    @click="openZoneCreate"
                  >
                    ＋ 新建区域
                  </button>
                  <button
                    v-if="focusedZoneId"
                    type="button"
                    class="insp-btn"
                    @click="focusedZoneId = ''"
                  >
                    取消高亮
                  </button>
                </div>
              </section>

              <section v-if="selectionKeys.length" class="insp-sec">
                <div class="insp-title">座位状态</div>
                <div class="bp-cap">
                  <button
                    type="button"
                    class="sp-cap-btn"
                    :class="{ on: !selectionStopped }"
                    :aria-pressed="!selectionStopped"
                    @click="restoreSelectedCells"
                  >
                    坐人
                  </button>
                  <button
                    type="button"
                    class="sp-cap-btn"
                    :class="{ on: selectionStopped > 0 }"
                    :aria-pressed="selectionStopped > 0"
                    @click="stopSelectedCells"
                  >
                    不坐人
                  </button>
                </div>
              </section>
            </section>

            <section
              v-else-if="sideTab === 'list'"
              class="side-section is-list"
            >
              <div class="side-head">
                <span class="side-title">参会名单</span>
                <div class="side-head-actions">
                  <span class="tag">{{ participants.length }} 人</span>
                  <button
                    type="button"
                    class="side-sync"
                    :class="{ 'has-diff': rosterDiff.length }"
                    title="对比当前名册，手动更新本项目快照"
                    @click="openRosterDiff"
                  >
                    <Icon name="rotate" :size="12" />手动更新<span
                      v-if="rosterDiff.length"
                      class="side-sync-count"
                      >{{ rosterDiff.length }}</span
                    >
                  </button>
                </div>
              </div>

              <div class="list-tools">
                <label class="member-search">
                  <Icon name="search" :size="12" />
                  <input
                    v-model="rosterQuery"
                    type="search"
                    placeholder="搜索姓名 / 单位 / 职级 / 职务"
                  />
                  <button
                    v-if="rosterQuery"
                    type="button"
                    class="ms-clear"
                    aria-label="清空搜索"
                    @click="rosterQuery = ''"
                  >
                    ×
                  </button>
                </label>
                <button type="button" class="btn sm primary" @click="openAdd">
                  <Icon name="plus" :size="12" />添加人员
                </button>
                <button type="button" class="btn sm" @click="importOpen = true">
                  <Icon name="import" :size="12" />导入名册
                </button>
              </div>

              <div v-if="rosterDiff.length" class="roster-stale">
                <Icon name="warning" :size="12" />
                <span>名册已变化，{{ rosterDiff.length }} 项待更新</span>
                <button
                  type="button"
                  class="roster-stale-link"
                  @click="openRosterDiff"
                >
                  查看差异
                </button>
              </div>

              <div class="member-list">
                <div
                  v-for="m in filteredParticipants"
                  :key="m.id"
                  class="member-row is-clickable"
                  role="button"
                  tabindex="0"
                  :class="{
                    'is-leave': m.status === 'leave',
                    'is-focus':
                      focusedSeat &&
                      draft.assignments.some(
                        (a) => a.memberId === m.id && a.seatId === focusedSeat,
                      ),
                  }"
                  @click="focusMember(m)"
                  @keydown.enter.prevent="focusMember(m)"
                >
                  <span
                    class="dot"
                    :style="{
                      background: rankById.get(m.rankId)?.color ?? '#c9d1d4',
                    }"
                  />
                  <span class="member-name">{{ m.name }}</span>
                  <span class="member-hint" :title="memberHint(m)">{{
                    memberHint(m)
                  }}</span>
                  <span
                    v-if="m.duty"
                    class="member-duty"
                    :title="`职务：${m.duty}`"
                    >{{ m.duty }}</span
                  >
                  <span
                    v-if="fixedSeatOf(m)"
                    class="tag ok"
                    :title="`位置已固定：${seatLabel(fixedSeatOf(m))}`"
                    >固定</span
                  >
                  <span
                    v-if="
                      m.status !== 'leave' &&
                      unseatedMembers.some((u) => u.id === m.id)
                    "
                    class="tag warn"
                    >未排</span
                  >
                  <span class="grow" />
                  <div
                    class="status-toggle"
                    role="group"
                    :aria-label="`${m.name} 状态`"
                  >
                    <button
                      type="button"
                      class="st-btn"
                      :class="{ on: m.status === 'present' }"
                      @click.stop="setMemberStatus(m, 'present')"
                    >
                      在位
                    </button>
                    <button
                      type="button"
                      class="st-btn leave"
                      :class="{ on: m.status === 'leave' }"
                      @click.stop="setMemberStatus(m, 'leave')"
                    >
                      请假
                    </button>
                  </div>
                </div>
                <div v-if="!filteredParticipants.length" class="caption">
                  {{
                    participants.length
                      ? "没有匹配的人员，换个关键词试试。"
                      : "名单为空，点击「添加人员」或「导入名册」开始。"
                  }}
                </div>
              </div>
              <p class="caption member-note">请假后立即移出座位。</p>

              <p
                v-if="unseatedMembers.length"
                class="caption"
                style="margin-top: 10px"
              >
                未排到座位：{{ unseatedMembers.map((m) => m.name).join("、") }}
              </p>
            </section>

            <section v-else-if="sideTab === 'leave'" class="side-section">
              <div class="side-head">
                <span class="side-title">请假人员</span>
                <span class="tag warn">{{ leaveMembers.length }} 人</span>
              </div>

              <div class="member-list" style="margin-top: 10px">
                <div
                  v-for="m in leaveMembers"
                  :key="m.id"
                  class="member-row is-leave"
                >
                  <span
                    class="dot"
                    :style="{
                      background: rankById.get(m.rankId)?.color ?? '#c9d1d4',
                    }"
                  />
                  <span class="member-name">{{ m.name }}</span>
                  <span class="grow" />
                  <button
                    type="button"
                    class="btn xs"
                    @click="setMemberStatus(m, 'present')"
                  >
                    恢复在位
                  </button>
                </div>
                <div v-if="!leaveMembers.length" class="side-empty">
                  <Icon name="users" :size="20" />
                  <p>暂无请假人员。</p>
                </div>
              </div>
            </section>

            <section
              v-else-if="sideTab === 'rules'"
              class="side-section rules-section"
            >
              <div class="side-head">
                <span class="side-title">排座规则</span>
              </div>
              <div class="zone-manage fixed-manage">
                <div class="zm-head">
                  <span class="zm-title">固定座位</span>
                  <span class="tag">{{ fixedEntries.length }} 处</span>
                </div>
                <div v-if="fixedEntries.length" class="fixed-list">
                  <div
                    v-for="f in fixedEntries"
                    :key="f.seatId"
                    class="fixed-item"
                  >
                    <span class="fixed-seat">{{ f.seatLabel }}</span>
                    <span class="fixed-name">{{ f.name }}</span>
                    <button
                      type="button"
                      class="zm-act"
                      title="定位到该座位"
                      @click="focusFixedSeat(f.seatId)"
                    >
                      ◎
                    </button>
                    <button
                      type="button"
                      class="zm-act"
                      title="解除固定"
                      @click="removeFixedSeat(f.seatId)"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <p v-else class="caption">还没有固定座位。</p>
                <ul v-if="fixedIssues.length" class="fixed-issues">
                  <li v-for="(issue, i) in fixedIssues" :key="i">
                    {{ issue }}
                  </li>
                </ul>
              </div>
              <div class="zone-manage">
                <div class="zm-head">
                  <span class="zm-title">区域</span>
                  <button type="button" class="btn xs" @click="openZoneCreate">
                    <Icon name="plus" :size="11" />新建
                  </button>
                </div>

                <div v-if="overlayZones.length" class="zm-list">
                  <div
                    v-for="z in overlayZones"
                    :key="z.id"
                    class="zm-item"
                    :class="{ 'is-on': focusedZoneId === z.id }"
                    @click="toggleZoneFocus(z.id)"
                  >
                    <i :style="{ background: z.color }" />
                    <span class="zm-name">{{ z.name }}</span>
                    <em>{{ zoneSeatCount[z.id] ?? 0 }} 座</em>
                    <button
                      type="button"
                      class="zm-act"
                      title="编辑区域名称与颜色"
                      @click.stop="openZoneEdit(z.id)"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      class="zm-act"
                      title="删除区域"
                      @click.stop="askDeleteZone(z.id)"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <p v-else class="caption">还没有区域。</p>
              </div>
              <RulesPanel
                :rules="draft.ruleSet"
                :ranks="roster.ranks"
                :layout="layout"
                :members="roster.members"
                :units="roster.units"
              />
            </section>

            <section v-else class="side-section">
              <div class="side-head">
                <span class="side-title">导出与备份</span>
              </div>
              <div class="export-opts">
                <label class="export-opt">
                  <span>图片清晰度</span>
                  <UiSelect
                    v-model="exportScale"
                    :options="exportScaleOptions"
                    size="sm"
                  />
                </label>
                <label class="export-opt">
                  <span>打印纸张</span>
                  <UiSelect v-model="paper" :options="paperOptions" size="sm" />
                </label>
              </div>
              <div class="export-grid">
                <button class="btn" @click="exportPng">
                  <Icon name="image" />导出 PNG
                </button>
                <button class="btn" @click="exportExcel">
                  <Icon name="table" />导出 Excel
                </button>
                <button class="btn" @click="exportPresentRoster">
                  <Icon name="users" />在位人员名单
                </button>
                <button class="btn" @click="printChart">
                  <Icon name="print" />直接打印
                </button>
              </div>
              <section v-if="snapshots.length" class="snap-section">
                <div class="snap-sec-head">
                  <span class="snap-sec-title">历史快照</span>
                  <span class="snap-sec-count">{{ snapshots.length }}</span>
                </div>
                <div class="snap-tools">
                  <label class="snap-all" title="选中当前列表的全部快照">
                    <input
                      type="checkbox"
                      :checked="snapAllChecked"
                      :indeterminate.prop="snapSomeChecked"
                      @change="toggleAllSnaps"
                    />
                    全选
                  </label>
                  <span class="snap-picked"
                    >已选 <b>{{ snapSelected.length }}</b> /
                    {{ snapshots.length }}</span
                  >
                  <button
                    class="btn sm snap-del"
                    :disabled="!snapSelected.length"
                    @click="askDeleteSnaps"
                  >
                    <Icon name="trash" :size="12" />删除所选
                  </button>
                </div>
                <div class="snap-list">
                  <label
                    v-for="s in snapshots"
                    :key="s.id"
                    class="snap-row"
                    :class="{ 'is-on': snapSelected.includes(s.id) }"
                  >
                    <input
                      type="checkbox"
                      :checked="snapSelected.includes(s.id)"
                      @change="toggleSnap(s.id)"
                    />
                    <span class="snap-body">
                      <span class="snap-line">
                        <span class="snap-label" :title="s.label">{{
                          s.label
                        }}</span>
                        <span class="snap-seats">{{ s.seats }} 座</span>
                      </span>
                      <span class="snap-time">
                        <Icon name="clock" :size="11" />
                        {{ s.createdAt.slice(5, 16).replace("T", " ") }}
                      </span>
                    </span>
                    <button
                      class="btn xs snap-restore"
                      @click.stop.prevent="restoreSnap(s.id)"
                    >
                      恢复
                    </button>
                  </label>
                </div>
              </section>
            </section>
          </div>
        </aside>
      </div>
    </div>
  </template>

  <!-- 新建项目 -->
  <UiModal v-model="createOpen" title="新建排座项目" width="480px">
    <div class="field">
      <label>项目名称</label>
      <input
        v-model="createForm.name"
        class="input"
        @keyup.enter="createProject"
      />
    </div>
    <div class="field">
      <label>名册方案</label>
      <UiSelect
        v-model="createForm.rosterPlanId"
        :options="rosterOptions"
        placeholder="选择名册"
      />
    </div>
    <div class="field">
      <label>会场布局</label>
      <UiSelect
        v-model="createForm.layoutPackageId"
        :options="layoutOptions"
        placeholder="选择布局"
      />
    </div>
    <template #footer>
      <button class="btn" @click="createOpen = false">取消</button>
      <button class="btn primary" @click="createProject">创建项目</button>
    </template>
  </UiModal>

  <!-- 重命名 -->
  <UiModal
    v-model="renameOpen"
    title="重命名项目"
  >
    <div class="field">
      <label>项目名称</label>
      <input v-model="renameValue" class="input" @keyup.enter="confirmRename" />
    </div>
    <template #footer>
      <button class="btn" @click="renameOpen = false">取消</button>
      <button class="btn primary" @click="confirmRename">保存名称</button>
    </template>
  </UiModal>

  <!-- 区域编辑：只属于当前项目 -->
  <UiModal
    v-model="zoneEditOpen"
    :title="zoneForm.id ? '编辑区域' : '新建区域'"
  >
    <div class="field">
      <label>区域名称</label>
      <input
        v-model="zoneForm.name"
        class="input"
        maxlength="20"
        @keyup.enter="saveZone"
      />
    </div>
    <div class="field">
      <label>标识颜色</label>
      <UiColorPicker v-model="zoneForm.color" custom-label="自定义区域颜色" />
    </div>
    <template #footer>
      <button class="btn" @click="zoneEditOpen = false">取消</button>
      <button class="btn primary" @click="saveZone">保存区域</button>
    </template>
  </UiModal>

  <!-- 删除确认 -->
  <UiModal
    v-model="confirmState.open"
    :title="confirmState.title"
    :description="confirmState.desc"
    width="400px"
  >
    <template #footer>
      <button class="btn" @click="confirmState.open = false">取消</button>
      <button class="btn danger" @click="runConfirm">
        {{ confirmState.okText ?? "确认删除" }}
      </button>
    </template>
  </UiModal>

  <!-- 手动更新名册快照 -->
  <UiModal
    v-model="diffOpen"
    title="手动更新名册"
    description="勾选要同步的变更，未勾选的保持不变。"
    width="600px"
  >
    <div v-if="!rosterDiff.length" class="diff-empty">
      <span class="diff-empty-art"><Icon name="check" :size="16" /></span>
      <b>名册与快照一致</b>
      <span class="diff-empty-note">当前没有需要同步的变更。</span>
    </div>
    <template v-else>
      <div class="diff-head">
        <label class="diff-all">
          <input
            type="checkbox"
            :checked="diffAllPicked"
            @change="toggleDiffAll"
          />
          <span>全选</span>
        </label>
        <span class="diff-count"
          >共 {{ rosterDiff.length }} 项 · 已选
          <b>{{ diffPickedCount }}</b></span
        >
      </div>
      <div class="diff-groups">
        <section v-for="g in diffGroups" :key="g.kind" class="diff-group">
          <header class="diff-group-head">
            <Icon :name="g.icon" :size="12" />
            <span class="diff-group-label">{{ g.label }}</span>
            <span class="diff-group-count">{{ g.items.length }}</span>
          </header>
          <div v-for="it in g.items" :key="it.key" class="diff-item">
            <label class="diff-main">
              <input v-model="diffPick[it.key]" type="checkbox" />
              <span class="diff-name" :title="it.name">{{ it.name }}</span>
              <span class="diff-change">
                <span class="diff-from" :title="it.from">{{ it.from }}</span>
                <span class="diff-arrow">→</span>
                <span class="diff-to" :title="it.to">{{ it.to }}</span>
              </span>
            </label>
            <template v-if="it.detail?.length">
              <button
                type="button"
                class="diff-more"
                :class="{ on: diffDetail[it.key] }"
                :aria-expanded="!!diffDetail[it.key]"
                @click="toggleDiffDetail(it.key)"
              >
                <span>{{ it.detail.length }} 项明细</span>
                <Icon name="chevronDown" :size="12" />
              </button>
              <ol
                v-if="diffDetail[it.key]"
                class="diff-detail"
                :data-diff-detail="it.key"
              >
                <li v-for="(nm, i) in it.detail" :key="`${it.key}:${i}`">
                  <span class="diff-detail-no">{{ i + 1 }}</span>
                  <span class="diff-detail-name" :title="nm">{{ nm }}</span>
                </li>
              </ol>
            </template>
          </div>
        </section>
      </div>
      <p class="caption diff-tip">应用后需重新排座才会生效。</p>
    </template>
    <template #footer>
      <button class="btn" @click="diffOpen = false">
        {{ rosterDiff.length ? "取消" : "关闭" }}
      </button>
      <button
        v-if="rosterDiff.length"
        class="btn primary"
        :disabled="!diffPickedCount"
        @click="applyRosterDiff"
      >
        应用所选（{{ diffPickedCount }}）
      </button>
    </template>
  </UiModal>

  <!-- 开始排座前的名册差异确认：快照是历史记录，不替用户改写 -->
  <UiModal
    v-model="arrangeDiffOpen"
    title="名册与本项目快照不一致"
    :description="`名册有 ${rosterDiff.length} 项改动未同步，继续将按项目快照中的旧数据排座。`"
    width="480px"
  >
    <div class="diff-overview">
      <span v-for="g in diffGroups" :key="g.kind" class="diff-chip">
        <Icon :name="g.icon" :size="12" />
        <span>{{ g.label }}</span>
        <span class="diff-group-count">{{ g.items.length }}</span>
      </span>
    </div>
    <template #footer>
      <button class="btn" @click="arrangeWithSnapshot">按当前快照排座</button>
      <button class="btn primary" @click="updateRosterBeforeArrange">
        先去手动更新
      </button>
    </template>
  </UiModal>

  <!-- 添加人员：与名册页批量添加同款录入方式 -->
  <UiModal
    v-model="addOpen"
    title="添加人员"
    description="回车添加；多人用逗号、顿号或换行分隔。"
    width="440px"
  >
    <div class="field">
      <label>姓名</label>
      <textarea
        ref="addInputEl"
        v-model="addText"
        class="textarea"
        rows="3"
        placeholder="张三、李四、王五…"
        @keydown.enter.exact="onAddKey"
      />
    </div>
    <div class="field-row">
      <div class="field">
        <label>职级（可留空）</label>
        <UiSelect v-model="addRankId" :options="addRankOptions" />
      </div>
      <div class="field">
        <label>单位（可留空）</label>
        <UiSelect v-model="addUnitId" :options="addUnitOptions" />
      </div>
    </div>
    <div class="field">
      <label>职务（可留空，仅展示与筛选）</label>
      <input
        v-model="addDuty"
        class="input"
        placeholder="如：主任、处长、副主任"
      />
    </div>
    <template #footer>
      <button class="btn" @click="addOpen = false">取消</button>
      <button
        class="btn primary"
        :disabled="!addText.trim()"
        @click="submitAdd"
      >
        添加
      </button>
    </template>
  </UiModal>

  <!-- 导入名册：复用名册页的批量导入 -->
  <ImportDialog
    v-model="importOpen"
    :unit-options="snapUnitOptions"
    :unit-names="snapUnitNames"
    :rank-names="snapRankNames"
    :default-unit-id="snapRootUnitId"
    @import="handleProjectImport"
  />

  <!-- 座位详情：锚定在座位上方/下方的浮层卡片 -->
  <Teleport to="body">
    <div
      v-if="selectedSeat"
      ref="popoverEl"
      class="seat-popover"
      role="dialog"
      aria-label="座位详情"
      tabindex="-1"
      :data-placement="popoverPos.above ? 'above' : 'below'"
      :style="{
        left: popoverPos.left + 'px',
        top: popoverPos.top + 'px',
        width: CARD_W + 'px',
        '--sp-arrow': popoverPos.arrow + 'px',
        transform: popoverPos.above ? 'translateY(-100%)' : undefined,
      }"
    >
      <div class="sp-head">
        <span class="sp-kicker">{{ seatLabel(selectedSeat) }}</span>
        <button
          class="sp-close"
          type="button"
          title="关闭"
          aria-label="关闭座位详情"
          @click="closeSeatCard"
        >
          <Icon name="close" :size="12" />
        </button>
      </div>

      <div
        v-if="!selectedSeatDisabled"
        class="sp-cap"
        title="只影响当前排座项目，不改动会场布局"
      >
        <span class="sp-cap-k">本桌容量</span>
        <div class="sp-cap-opts">
          <button
            type="button"
            class="sp-cap-btn"
            :class="{ on: capCustom === 1 }"
            @click="applyPreset(1)"
          >
            单人
          </button>
          <button
            type="button"
            class="sp-cap-btn"
            :class="{ on: capCustom === 2 }"
            @click="applyPreset(2)"
          >
            双人
          </button>
          <UiNumberInput
            v-model="capCustom"
            class="sp-cap-num"
            size="sm"
            :width="56"
            :min="1"
            :max="50"
            unit="人"
            label="自定义容量"
            @enter="applyCapacityFromCard"
          />
          <button
            type="button"
            class="sp-cap-btn"
            @click="applyCapacityFromCard"
          >
            应用
          </button>
        </div>
      </div>

      <!-- 座位状态：详情卡与批量属性的唯一入口 -->
      <div v-if="!selectedSeatFixed" class="sp-cap sp-state">
        <span class="sp-cap-k">座位状态</span>
        <div class="sp-cap-opts">
          <button
            type="button"
            class="sp-cap-btn"
            :class="{ on: !selectedSeatDisabled }"
            :aria-pressed="!selectedSeatDisabled"
            @click="setSelectedSeatOccupiable(true)"
          >
            坐人
          </button>
          <button
            type="button"
            class="sp-cap-btn"
            :class="{ on: selectedSeatDisabled }"
            :aria-pressed="selectedSeatDisabled"
            @click="setSelectedSeatOccupiable(false)"
          >
            不坐人
          </button>
        </div>
      </div>

      <div v-if="selectedSeatFixed" class="sp-body">
        <template v-if="selectedFixedMember">
          <div class="sp-person-head">
            <div class="person-main">
              <div class="avatar">
                {{ selectedFixedMember.name.slice(0, 1) }}
              </div>
              <div>
                <div class="person-name">{{ selectedFixedMember.name }}</div>
                <div class="caption">
                  {{
                    unitById.get(selectedFixedMember.unitId)?.name ||
                    "未填写单位"
                  }}
                </div>
              </div>
            </div>
            <button
              type="button"
              class="sp-lock is-on"
              title="解除固定"
              @click="unbindFixedSeat"
            >
              <Icon name="lock" :size="14" />
            </button>
          </div>
          <p v-if="selectedFixedIssue" class="sp-warn">
            {{ selectedFixedIssue }}
          </p>
        </template>
        <template v-else>
          <div class="tag warn">不坐人 · 不可安排人员</div>
          <p class="caption">到「会场布局」双击该座位可恢复。</p>
        </template>
      </div>

      <div
        v-else-if="selectedSeatStopped && selectedFixedMember"
        class="sp-body"
      >
        <div class="sp-person-head">
          <div class="person-main">
            <div class="avatar">
              {{ selectedFixedMember.name.slice(0, 1) }}
            </div>
            <div>
              <div class="person-name">{{ selectedFixedMember.name }}</div>
              <div class="caption">该座位本次不坐人 · 固定暂不生效</div>
            </div>
          </div>
          <button
            type="button"
            class="sp-lock is-on"
            title="解除固定"
            @click="unbindFixedSeat"
          >
            <Icon name="lock" :size="14" />
          </button>
        </div>
      </div>

      <div
        v-else-if="selectedSeatStopped && selectedAssignment"
        class="sp-body"
      >
        <div class="sp-actions insp-actions">
          <button type="button" class="insp-btn is-danger" @click="clearSeat">
            清空座位
          </button>
        </div>
      </div>

      <div v-else-if="!selectedSeatStopped && cardMember" class="sp-body">
        <div class="sp-person-head">
          <div class="person-main">
            <div class="avatar">{{ cardMember.name.slice(0, 1) }}</div>
            <div>
              <div class="person-name">{{ cardMember.name }}</div>
              <div class="caption">
                {{ unitById.get(cardMember.unitId)?.name || "未填写单位" }}
              </div>
            </div>
          </div>
          <button
            type="button"
            class="sp-lock"
            :class="{ 'is-on': !!selectedFixedMember }"
            :aria-pressed="!!selectedFixedMember"
            :title="selectedFixedMember ? '解除固定' : '固定'"
            @click="toggleFixedSeat"
          >
            <Icon :name="selectedFixedMember ? 'lock' : 'unlock'" :size="14" />
          </button>
        </div>
        <div class="sp-meta">
          <div class="sp-meta-row">
            <span class="sp-meta-k">职级</span>
            <span class="sp-meta-v">{{
              rankById.get(cardMember.rankId)?.name || "未定级"
            }}</span>
          </div>
          <div class="sp-meta-row">
            <span class="sp-meta-k">单位</span>
            <span class="sp-meta-v">{{
              unitById.get(cardMember.unitId)?.name || "—"
            }}</span>
          </div>
          <div class="sp-meta-row">
            <span class="sp-meta-k">职务</span>
            <span class="sp-meta-v">{{ cardMember.duty || "—" }}</span>
          </div>
        </div>
        <div v-if="selectedAssignment" class="field sp-field">
          <label>与会状态</label>
          <div
            class="status-toggle sp-status"
            role="group"
            aria-label="与会状态"
          >
            <button
              type="button"
              class="st-btn"
              :class="{ on: selectedAssignment.status === 'present' }"
              :aria-pressed="selectedAssignment.status === 'present'"
              @click="setStatus('present')"
            >
              在位
            </button>
            <button
              type="button"
              class="st-btn leave"
              :class="{ on: selectedAssignment.status === 'leave' }"
              :aria-pressed="selectedAssignment.status === 'leave'"
              @click="setStatus('leave')"
            >
              请假
            </button>
          </div>
        </div>
        <p v-if="selectedFixedIssue" class="sp-warn">
          {{ selectedFixedIssue }}
        </p>
        <div class="sp-actions insp-actions">
          <button
            v-if="selectedAssignment && !selectedFixedMember"
            type="button"
            class="insp-btn is-danger"
            @click="clearSeat"
          >
            清空座位
          </button>
        </div>
      </div>

      <div v-else-if="!selectedSeatStopped" class="sp-body sp-pick">
        <label class="member-search">
          <Icon name="search" :size="12" />
          <input
            v-model="seatQuery"
            type="search"
            placeholder="搜索并选择人员…"
          />
          <button
            v-if="seatQuery"
            type="button"
            class="ms-clear"
            aria-label="清空搜索"
            @click="seatQuery = ''"
          >
            ×
          </button>
        </label>
        <div v-if="seatCandidates.length" class="sp-pick-list">
          <button
            v-for="m in seatCandidates"
            :key="m.id"
            type="button"
            class="sp-pick-item"
            @click="pickSeatMember(m.id)"
          >
            <span>{{ m.name }}</span>
            <em>{{ memberHint(m) }}</em>
          </button>
        </div>
        <p v-else class="sp-pick-empty">
          {{ seatQuery.trim() ? "没有匹配的人员" : "名单中已无未排座人员" }}
        </p>
      </div>
    </div>
  </Teleport>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
