<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type { RankDef, UnitNode } from "../../types";
import { listenNativeFileDrop } from "../../platform/nativeFileDrop";
import { listRosterSheets, readRosterSheet } from "../../engine/rosterImport";
import {
  planUnitInputs,
  resolveUnit,
  unitPathOf,
} from "../../engine/unitMatch";
import {
  applyParts,
  buildAnalysis,
  matchRank,
  parseRows,
  rebuildRow,
  refreshRowIssues,
  type AdaptiveRow,
  type AdaptiveSheet,
  type CellField,
  type CellPart,
  type ColumnRole,
  type ImportField,
  type RowStatus,
  type SplitOption,
} from "../../engine/rosterAdaptive";
import {
  UiButton,
  UiCheckbox,
  UiIcon,
  UiInput,
  UiModal,
  UiSelect,
} from "../../ui";

interface WireToken {
  /** 碎片文本，按值合并：同一个碎片只出现一次 */
  key: string;
  text: string;
}

/** 一条线就是一次归属 */
interface WireLink {
  token: string;
  field: CellField;
}

/** 批量修同类问题的规则 */
type BatchRule =
  | {
      kind: "token";
      action: "set";
      text: string;
      field: CellField;
      from: CellField | "";
    }
  | { kind: "token"; action: "remove"; text: string; field: CellField }
  | { kind: "rank"; action: "map" | "new"; text: string; rankId?: string };

interface EditRow extends AdaptiveRow {
  ignore: boolean;
  /** 人工把原文映射到已有职级 */
  mapRankId: string;
  /** 人工显式新建的职级名 */
  newRank: string;
  /** 映射时需要回写的职级别名（只来自显式确认） */
  aliasRank: string;
  /** 用户手动改过单位，才把原文当作单位别名的候选 */
  unitTouched: boolean;
  aliasUnit: string;
  /** 并排切法里用户已经点选过的单元格，点过就不再算「待确认」 */
  cutChosen: Record<number, boolean>;
  /** 连线式交互：右栏碎片与当前连线 */
  wireTokens: WireToken[];
  wireLinks: WireLink[];
  /** 连线的原文底稿：只改归属，不动文字，保证回拼校验不受影响 */
  wireBase: CellPart[];
  /** 全部连对后自动确认；撤销时回到备份的连线 */
  autoOk: boolean;
  autoBackup: WireLink[];
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    unitOptions: { value: string; label: string }[];
    /** 当前名册（或项目快照）的单位树，用于逐行解析预览 */
    units: UnitNode[];
    /** 当前名册（或项目快照）的职级，用于逐行解析预览 */
    ranks: RankDef[];
    defaultUnitId?: string;
  }>(),
  { defaultUnitId: "" },
);

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (
    e: "import",
    payload: {
      rows: {
        name: string;
        unit: string;
        rankId: string;
        newRank?: string;
        duty: string;
        note: string;
        aliasRank?: string;
        aliasUnit?: string;
      }[];
      targetUnitId: string;
      allowDuplicate: boolean;
    },
  ): void;
}>();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const STEPS = [
  { n: 1, title: "选择文件", hint: "" },
  { n: 2, title: "核对列", hint: "" },
  { n: 3, title: "处理待确认", hint: "" },
  { n: 4, title: "确认导入", hint: "" },
];

const sheet = ref<AdaptiveSheet | null>(null);
const rows = ref<EditRow[]>([]);
const fileName = ref("");
const error = ref("");
const busy = ref(false);
/** 文件正拖到弹窗上：整块内容区都可松手 */
const dropHot = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const targetUnitId = ref("");
/** 默认拒绝重名：同姓名 + 同单位视为重复录入 */
const allowDuplicate = ref(false);

const step = ref(1);
const pickedFile = ref<File | null>(null);
const sheetNames = ref<string[]>([]);
const activeSheet = ref("");
const bodyRef = ref<HTMLElement | null>(null);
/** 进入第 3 步时锁定的待确认行，处理完也留在原位显示「已处理」 */
const reviewLines = ref<number[]>([]);
const editorRows = ref<Record<number, boolean>>({});

/* ---- 连线交互状态 ---- */
/** 轻点碎片后选中的那一个；再点左栏字段即连线（窄屏兜底） */
const picked = ref<{ line: number; token: string } | null>(null);
/** 正在拖拽的碎片与落点字段 */
const drag = ref<{
  line: number;
  token: string;
  field: CellField | "";
  x: number;
  y: number;
  moved: boolean;
} | null>(null);
/** 每条线画在哪：坐标相对卡片内的连线容器，随时按真实布局重算 */
const wireGeo = ref<
  Record<
    number,
    { links: { token: string; field: CellField; d: string }[]; ghost?: string }
  >
>({});
/** 同类问题批量修改的候选规则，按来源行记录 */
const batchRules = ref<Record<number, BatchRule | undefined>>({});
/** 同一栏被两条线并入时，用户点了「先不处理」的那一栏 */
const mergeDismissed = ref<Record<number, string>>({});

const wireEls = new Map<number, HTMLElement>();
const tokenEls = new Map<string, HTMLElement>();
const fieldEls = new Map<string, HTMLElement>();
let resizeObs: ResizeObserver | null = null;
let measureRaf = 0;
/** 桌面端原生拖放的取消注册函数 */
let stopNativeDrop: (() => void) | null = null;

const ROLE_LABELS: Record<ImportField | "ignore", string> = {
  name: "姓名",
  unit: "单位 / 部门",
  rank: "职级",
  duty: "职务",
  note: "备注 / 电话",
  ignore: "不导入",
};

const ROLE_OPTIONS = [
  { value: "name", label: "姓名" },
  { value: "unit", label: "单位 / 部门" },
  { value: "rank", label: "职级" },
  { value: "duty", label: "职务" },
  { value: "note", label: "备注 / 电话" },
  { value: "ignore", label: "不导入" },
];

/** 左栏固定字段位，顺序不随内容变化 */
const WIRE_FIELDS: ImportField[] = ["name", "unit", "rank", "duty", "note"];
const WIRE_LABELS: Record<ImportField, string> = {
  name: "姓名",
  unit: "单位",
  rank: "职级",
  duty: "职务",
  note: "备注",
};

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      reset();
      targetUnitId.value =
        props.defaultUnitId || props.unitOptions[0]?.value || "";
    }
  },
);

function reset(): void {
  sheet.value = null;
  rows.value = [];
  fileName.value = "";
  error.value = "";
  busy.value = false;
  dropHot.value = false;
  if (fileInput.value) fileInput.value.value = "";
  allowDuplicate.value = false;
  step.value = 1;
  pickedFile.value = null;
  sheetNames.value = [];
  activeSheet.value = "";
  reviewLines.value = [];
  editorRows.value = {};
  picked.value = null;
  drag.value = null;
  batchRules.value = {};
  mergeDismissed.value = {};
  wireGeo.value = {};
  wireEls.clear();
  tokenEls.clear();
  fieldEls.clear();
}

async function loadFile(file: File | null | undefined): Promise<void> {
  if (!file || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const names = await listRosterSheets(file);
    pickedFile.value = file;
    sheetNames.value = names;
    activeSheet.value = names[0] ?? "";
    await applySheet();
  } catch (e: any) {
    sheet.value = null;
    rows.value = [];
    error.value = e?.message || "文件解析失败";
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}

/** 按选中的工作表重新读取并解析 */
async function applySheet(): Promise<void> {
  const f = pickedFile.value;
  if (!f) return;
  const raw = await readRosterSheet(f, activeSheet.value || undefined);
  fileName.value = f.name;
  activeSheet.value = raw.sheetName || activeSheet.value;
  sheet.value = buildAnalysis(raw, props.units, props.ranks);
  reparse();
  reviewLines.value = [];
  editorRows.value = {};
  if (!rows.value.length)
    error.value = "这份工作表里没读到人员行，换一个工作表或检查文件内容";
}

async function onSheetChange(v: string | number | null): Promise<void> {
  const name = String(v ?? "");
  if (!name || name === activeSheet.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    activeSheet.value = name;
    await applySheet();
  } catch (e: any) {
    error.value = e?.message || "读取工作表失败";
  } finally {
    busy.value = false;
  }
}

function onPick(e: Event): void {
  const f = (e.target as HTMLInputElement).files?.[0];
  void loadFile(f);
}

function onDrop(e: DragEvent): void {
  dropHot.value = false;
  // 已经读到文件后就不再接受新的拖放，避免误把当前进度冲掉
  if (sheet.value) return;
  const file = e.dataTransfer?.files?.[0];
  if (file) void loadFile(file);
}

/** 整个弹窗内容区都能接住拖拽，不用精确对准虚线框 */
function onDragEnter(): void {
  if (!sheet.value) dropHot.value = true;
}

function onDragLeave(e: DragEvent): void {
  const to = e.relatedTarget as Node | null;
  if (to && bodyRef.value?.contains(to)) return;
  dropHot.value = false;
}

/** 按当前列角色重新解析整个数据区（行内修改会重置） */
function reparse(): void {
  if (!sheet.value) return;
  rows.value = parseRows(sheet.value, props.units, props.ranks).map((r) => ({
    ...r,
    ignore: false,
    mapRankId: "",
    newRank: "",
    aliasRank: "",
    unitTouched: false,
    aliasUnit: "",
    cutChosen: {},
    wireTokens: [],
    wireLinks: [],
    wireBase: [],
    autoOk: false,
    autoBackup: [],
  }));
}

function setColumnRole(index: number, v: string | number | null): void {
  const s = sheet.value;
  if (!s) return;
  const role = String(v ?? "ignore") as ImportField | "ignore";
  const col = s.columns.find((c) => c.index === index);
  if (!col) return;
  // 姓名 / 单位 / 职级 / 职务 只能有一列；备注允许多列
  if (role !== "ignore" && role !== "note") {
    for (const c of s.columns) {
      if (c.index !== index && c.role === role) {
        c.role = "ignore";
        c.confidence = "low";
        c.score = 0;
        c.evidence = "手动改选";
      }
    }
  }
  col.role = role;
  col.confidence = "high";
  col.score = 1;
  col.evidence = "手动指定";
  s.nameColumn = s.columns.find((c) => c.role === "name")?.index ?? -1;
  reparse();
  reviewLines.value = [];
}

const hasNameColumn = computed(
  () => !!sheet.value?.columns.some((c) => c.role === "name"),
);

const headerHintText = computed(() => {
  const s = sheet.value;
  if (!s) return "";
  return s.hasHeader
    ? `第 ${s.headerIndex + 1} 行是表头`
    : "没有表头，按内容自动判断";
});

const visibleWarnings = computed(() =>
  (sheet.value?.warnings ?? []).filter((w) => !w.startsWith("已读取工作表")),
);

const previewHead = computed(
  () =>
    sheet.value?.columns.map((c) => c.label || `第 ${c.index + 1} 列`) ?? [],
);

const sheetOptions = computed(() =>
  sheetNames.value.filter(Boolean).map((n) => ({ value: n, label: n })),
);

function sampleOf(index: number): string {
  const vals = (sheet.value?.dataRows ?? [])
    .map((r) => (r[index] ?? "").trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((v) => (v.length > 16 ? `${v.slice(0, 16)}…` : v));
  return vals.length ? `例如：${vals.join("、")}` : "这一列没有内容";
}

/* ---------------------------------------------------------------- 步骤导航 */

const canGoStep2 = computed(() => !!sheet.value && rows.value.length > 0);
const canGoStep3 = computed(() => canGoStep2.value && hasNameColumn.value);

function canEnter(n: number): boolean {
  if (n <= 1) return true;
  if (n === 2) return canGoStep2.value;
  return canGoStep3.value;
}

function captureReview(): void {
  reviewLines.value = rows.value
    .filter((r) => !r.ignore && tierOf(r) === "review")
    .map((r) => r.line);
  // 每次进第 3 步都按当前 parts 重建碎片和连线，用户之前的改法会保留在 parts 里
  rows.value.forEach(initWire);
  batchRules.value = {};
  mergeDismissed.value = {};
  picked.value = null;
  drag.value = null;
  scheduleMeasure();
}

function goStep(n: number): void {
  if (n === step.value) return;
  if (n > step.value && !canEnter(n)) return;
  step.value = n;
  if (n === 3) captureReview();
  nextTick(() => {
    if (bodyRef.value) bodyRef.value.scrollTop = 0;
    if (n === 3) scheduleMeasure();
  });
}

/** 顶部「待确认」：直接跳到需要处理的行 */
function goReview(): void {
  goStep(3);
  nextTick(() => {
    const el = bodyRef.value?.querySelector<HTMLElement>(".imp-card");
    if (el) el.scrollIntoView({ block: "nearest" });
  });
}

const canNext = computed(() => {
  if (step.value === 1) return canGoStep2.value;
  if (step.value === 2) return canGoStep3.value;
  return true;
});

function next(): void {
  if (step.value < 4) goStep(step.value + 1);
}

function prev(): void {
  if (step.value > 1) step.value -= 1;
}

/* ---------------------------------------------------------------- 行状态 */

/** 仍有并排切法没有点选，才算「多解待确认」 */
function hasUnresolvedAmbiguity(r: EditRow): boolean {
  return r.cells.some((c, i) => ambiguousCell(c.options) && !r.cutChosen[i]);
}

/** 三档状态：人工映射 / 显式新建职级后不再算待确认 */
function tierOf(r: EditRow): RowStatus {
  if (r.ignore) return "ignored";
  if (r.autoOk && wireComplete(r)) return "ok";
  if (!r.name.trim()) return "review";
  if (r.reconstructFail || r.multiUnit || r.hierarchyUp) return "review";
  if (multiLinkToken(r)) return "review";
  if (hasUnresolvedAmbiguity(r)) return "review";
  if (r.unresolved.length) return "review";
  const rankResolved = !!r.rankId || !!r.mapRankId || !!r.newRank;
  if (
    !rankResolved &&
    (r.rankKind === "unknown" ||
      r.rankKind === "suggest" ||
      r.rankKind === "conflict")
  )
    return "review";
  const parts = r.parts.filter((p) => p.value);
  if (r.rankKind === "rule" || r.rankKind === "contains") return "guess";
  if (parts.some((p) => p.confidence === "mid")) return "guess";
  if (
    parts.some(
      (p) => p.confidence === "low" && !(p.field === "rank" && rankResolved),
    )
  )
    return "review";
  // 多解但首选领先够大：推断结果标「推测」
  if (r.cells.some((c) => c.options.length > 1)) return "guess";
  return "ok";
}

const TIER_TEXT: Record<RowStatus, string> = {
  ok: "已识别",
  guess: "推测",
  review: "待确认",
  ignored: "已跳过",
};

const okCount = computed(
  () => rows.value.filter((r) => !r.ignore && tierOf(r) === "ok").length,
);
const guessCount = computed(
  () => rows.value.filter((r) => !r.ignore && tierOf(r) === "guess").length,
);
const reviewCount = computed(
  () => rows.value.filter((r) => !r.ignore && tierOf(r) === "review").length,
);
const ignoredCount = computed(() => rows.value.filter((r) => r.ignore).length);
const importable = computed(() =>
  rows.value.filter((r) => !r.ignore && tierOf(r) !== "review"),
);

const reviewCards = computed(() =>
  rows.value.filter((r) => reviewLines.value.includes(r.line)),
);
const ignoredCards = computed(() => rows.value.filter((r) => r.ignore));

/** 每张卡的批量提醒（同一模式还剩多少行），只在数据变化时重算 */
const batchInfos = computed<
  Record<number, { n: number; lines: number[]; text: string } | null>
>(() => {
  const out: Record<
    number,
    { n: number; lines: number[]; text: string } | null
  > = {};
  for (const r of reviewCards.value) out[r.line] = batchInfo(r);
  return out;
});

const targetPath = computed(() => unitPathOf(props.units, targetUnitId.value));
const unitPlan = computed(() =>
  planUnitInputs(
    props.units,
    importable.value.map((r) => r.unit),
    targetUnitId.value || props.defaultUnitId || "",
  ),
);
const newRankNames = computed(() => [
  ...new Set(
    importable.value
      .filter((r) => !r.rankId && !r.mapRankId && r.newRank.trim())
      .map((r) => r.newRank.trim()),
  ),
]);
const newUnitNames = computed(() =>
  unitPlan.value.newUnits.map((u) => {
    if (!u.parentPath) return u.name;
    const leaf = u.parentPath.split(" / ").pop() ?? "";
    return leaf && u.name.includes(leaf)
      ? u.name
      : `${u.parentPath} / ${u.name}`;
  }),
);

const rankFixOptions = (r: EditRow) => [
  { value: "", label: "选择要对应到哪个职级" },
  ...props.ranks.map((x) => ({ value: x.id, label: x.name })),
  {
    value: "__new__",
    label: `确认新建职级「${r.rankText.trim() || "未命名"}」`,
    disabled: !r.rankText.trim(),
  },
];

const rankNameOf = (id: string): string =>
  props.ranks.find((r) => r.id === id)?.name ?? "";

function needsRankDecision(r: EditRow): boolean {
  if (!r.rankText.trim()) return false;
  if (r.rankId || r.mapRankId || r.newRank) return false;
  return (
    r.rankKind === "unknown" ||
    r.rankKind === "suggest" ||
    r.rankKind === "conflict"
  );
}

/**
 * 同一个碎片被连到两个以上字段（例如「办公室」既当单位又当职务）。
 * 直接看 parts 判断，进第 3 步之前也成立。
 */
function multiLinkToken(r: EditRow): string {
  const seen = new Map<string, Set<CellField>>();
  for (const p of r.parts) {
    const v = (p.value || "").trim();
    if (!v) continue;
    if (!seen.has(v)) seen.set(v, new Set());
    seen.get(v)!.add(p.field);
  }
  for (const [v, fields] of seen) {
    fields.delete("unresolved");
    if (fields.size > 1) return v;
  }
  return "";
}

function linkCount(r: EditRow, token: string): number {
  return r.wireLinks.filter((l) => l.token === token).length;
}

function fieldLinked(r: EditRow, field: CellField): boolean {
  return r.wireLinks.some((l) => l.field === field);
}

function fieldValue(r: EditRow, field: ImportField): string {
  if (field === "name") return r.name.trim();
  if (field === "unit") return r.unit.trim();
  if (field === "rank") return r.rankText.trim();
  if (field === "duty") return r.duty.trim();
  return r.note.trim();
}

/** 卡片上只留一句极短的问题提示，其余交给连线本身 */
function shortHint(r: EditRow): string {
  if (r.reconstructFail) return "和原文对不上";
  const multi = multiLinkToken(r);
  if (multi) return `${multi} 多连了一条`;
  const loose = r.wireTokens.find(
    (t) => !r.wireLinks.some((l) => l.token === t.key),
  );
  if (loose) return `${loose.text} 还没连`;
  if (!r.name.trim()) return "姓名 空着";
  if (r.multiUnit) return "单位 连了两个";
  if (r.hierarchyUp) return "单位 顺序反了";
  if (needsRankDecision(r)) return `职级「${r.rankText}」待定`;
  if (hasUnresolvedAmbiguity(r)) return "切法待确认";
  return "确认一下";
}

function rawText(r: EditRow): string {
  return r.cells
    .map((c) => c.raw)
    .filter(Boolean)
    .join(" ｜ ");
}

function ambiguousCellsOf(
  r: EditRow,
): { cell: SplitOption[]; index: number }[] {
  return r.cells
    .map((c, index) => ({ cell: c.options, index }))
    .filter((x) => ambiguousCell(x.cell));
}

/* ---------------------------------------------------------------- 连线模型 */

/** 按当前 parts 重建碎片与连线；不改文字，回拼校验保持原样 */
function initWire(r: EditRow): void {
  r.wireBase = r.parts.map((p) => ({ ...p }));
  const tokens: WireToken[] = [];
  const links: WireLink[] = [];
  for (const p of r.wireBase) {
    const v = (p.value || "").trim();
    if (!v) continue;
    if (!tokens.some((t) => t.key === v)) tokens.push({ key: v, text: v });
    if (p.field === "unresolved") continue;
    if (!links.some((l) => l.token === v && l.field === p.field))
      links.push({ token: v, field: p.field });
  }
  r.wireTokens = tokens;
  r.wireLinks = links;
  r.autoOk = false;
  r.autoBackup = [];
  dismissBatch(r);
}

/** 把一条线的归属写成一个片段；只改归属时清掉旧的单位 / 职级命中 */
function wirePart(base: CellPart, field: CellField): CellPart {
  if (base.field === field) return { ...base };
  const value = (base.value || "").trim();
  const part: CellPart = {
    field,
    text: base.text,
    value: base.value || value,
    evidence: "手动连线",
    origin: "user",
    confidence: field === "unresolved" ? "low" : "high",
  };
  if (field === "unit" && value) {
    const res = resolveUnit(props.units, value, targetUnitId.value);
    if (res.kind === "existing") part.unitId = res.unitId;
  }
  return part;
}

/** 每条线一个片段；没有线的碎片写成未归类，绝不静默丢掉 */
function syncWire(r: EditRow): void {
  const byToken = new Map<string, CellField[]>();
  for (const l of r.wireLinks) {
    const arr = byToken.get(l.token) ?? [];
    if (!arr.includes(l.field)) arr.push(l.field);
    byToken.set(l.token, arr);
  }
  const out: CellPart[] = [];
  const done = new Set<string>();
  for (const p of r.wireBase) {
    const v = (p.value || "").trim();
    if (!v) {
      out.push({ ...p });
      continue;
    }
    if (done.has(v)) continue;
    done.add(v);
    const fields = (byToken.get(v) ?? []).filter((f) => f !== "unresolved");
    if (!fields.length) {
      out.push({
        ...p,
        field: "unresolved",
        confidence: "low",
        origin: "user",
        unitId: undefined,
        rankId: undefined,
        rankKind: undefined,
      });
      continue;
    }
    for (const f of fields) out.push(wirePart(p, f));
  }
  r.parts = out;
  applyParts(r, props.units, props.ranks);
}

function connect(r: EditRow, token: string, field: CellField): void {
  if (field === "unresolved") return;
  const before = r.wireLinks.filter((l) => l.token === token);
  if (before.some((l) => l.field === field)) return;
  const from = before.length === 1 ? before[0].field : "";
  r.wireLinks = [...r.wireLinks, { token, field }];
  if (field === "unit") r.unitTouched = true;
  syncWire(r);
  // 新并进来的这一栏重新允许弹出合并选择
  if (mergeDismissed.value[r.line] === field)
    mergeDismissed.value = { ...mergeDismissed.value, [r.line]: "" };
  maybeAuto(r);
  batchRules.value = {
    ...batchRules.value,
    [r.line]: { kind: "token", action: "set", text: token, field, from },
  };
  scheduleMeasure();
}

/** 点掉一条线：多连的去掉多余那条，唯一一条也允许断开 */
function removeLink(r: EditRow, token: string, field: CellField): void {
  if (!r.wireLinks.some((l) => l.token === token && l.field === field)) return;
  r.wireLinks = r.wireLinks.filter(
    (l) => !(l.token === token && l.field === field),
  );
  if (field === "unit") r.unitTouched = true;
  syncWire(r);
  maybeAuto(r);
  batchRules.value = {
    ...batchRules.value,
    [r.line]: { kind: "token", action: "remove", text: token, field },
  };
  scheduleMeasure();
}

/** 两条线并进同一栏时，优先让用户选合并还是删除 */
function doubleFieldOf(r: EditRow): CellField | "" {
  for (const f of WIRE_FIELDS) {
    if (mergeDismissed.value[r.line] === f) continue;
    if (r.wireLinks.filter((l) => l.field === f).length > 1) return f;
  }
  return "";
}

/** 并进同一栏的碎片按原文顺序排 */
function mergeTokensOf(r: EditRow): string[] {
  const f = doubleFieldOf(r);
  if (!f) return [];
  const order = new Map<string, number>();
  r.wireBase.forEach((p, i) => {
    const v = (p.value || "").trim();
    if (v && !order.has(v)) order.set(v, i);
  });
  return r.wireLinks
    .filter((l) => l.field === f)
    .map((l) => l.token)
    .sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
}

function mergedTextOf(r: EditRow): string {
  return mergeTokensOf(r).join("");
}

function mergeFieldLabel(r: EditRow): string {
  const f = doubleFieldOf(r);
  return f ? WIRE_LABELS[f as ImportField] : "";
}

function dismissMerge(r: EditRow): void {
  const f = doubleFieldOf(r);
  if (f) mergeDismissed.value = { ...mergeDismissed.value, [r.line]: f };
}

/** 合并成一段：底稿里两段并为一段，按原文顺序拼 */
function mergeFieldLinks(r: EditRow): void {
  const f = doubleFieldOf(r);
  if (!f) return;
  const tokens = mergeTokensOf(r);
  const text = tokens.join("");
  if (!text) return;
  const merged: CellPart = {
    field: f,
    text,
    value: text,
    evidence: "合并碎片",
    origin: "user",
    confidence: "high",
  };
  if (f === "unit") {
    const res = resolveUnit(props.units, text, targetUnitId.value);
    if (res.kind === "existing") merged.unitId = res.unitId;
  }
  let placed = false;
  const base: CellPart[] = [];
  for (const p of r.wireBase) {
    const v = (p.value || "").trim();
    if (v && tokens.includes(v)) {
      if (!placed) {
        base.push(merged);
        placed = true;
      }
      continue;
    }
    base.push(p);
  }
  if (!placed) base.push(merged);
  r.wireBase = base;
  // 合并后的碎片放在原来第一段的位置，右栏顺序不乱
  const nextTokens: WireToken[] = [];
  let tokenPlaced = false;
  for (const t of r.wireTokens) {
    if (tokens.includes(t.key)) {
      if (!tokenPlaced) {
        nextTokens.push({ key: text, text });
        tokenPlaced = true;
      }
      continue;
    }
    nextTokens.push(t);
  }
  if (!tokenPlaced) nextTokens.push({ key: text, text });
  r.wireTokens = nextTokens;
  r.wireLinks = [
    ...r.wireLinks.filter((l) => l.field !== f),
    { token: text, field: f },
  ];
  if (f === "unit") r.unitTouched = true;
  mergeDismissed.value = { ...mergeDismissed.value, [r.line]: "" };
  syncWire(r);
  maybeAuto(r);
  scheduleMeasure();
}

/** 删除其中一条：保留用户选的那条 */
function keepOnlyLink(r: EditRow, token: string): void {
  const f = doubleFieldOf(r);
  if (!f) return;
  r.wireLinks = r.wireLinks.filter((l) => l.field !== f || l.token === token);
  mergeDismissed.value = { ...mergeDismissed.value, [r.line]: f };
  syncWire(r);
  maybeAuto(r);
  scheduleMeasure();
}

/**
 * 自动确认口径：有值的栏每栏最多一条线，姓名与单位各有且仅有一条，
 * 右侧没有未归属碎片，且没有待定的职级。
 */
function wireComplete(r: EditRow): boolean {
  if (r.reconstructFail || !r.wireTokens.length) return false;
  if (r.wireTokens.some((t) => linkCount(r, t.key) !== 1)) return false;
  if (
    WIRE_FIELDS.some((f) => r.wireLinks.filter((l) => l.field === f).length > 1)
  )
    return false;
  if (r.wireLinks.filter((l) => l.field === "name").length !== 1) return false;
  if (r.wireLinks.filter((l) => l.field === "unit").length !== 1) return false;
  return !needsRankDecision(r);
}

/** 连对即自动确认，并留一次撤销机会 */
function maybeAuto(r: EditRow): void {
  if (!wireComplete(r)) {
    if (r.autoOk) r.autoOk = false;
    return;
  }
  if (r.autoOk) return;
  r.autoBackup = r.wireLinks.map((l) => ({ ...l }));
  r.autoOk = true;
}

function undoAuto(r: EditRow): void {
  if (!r.autoOk) return;
  r.wireLinks = r.autoBackup.map((l) => ({ ...l }));
  r.autoOk = false;
  syncWire(r);
  scheduleMeasure();
}

function dismissBatch(r: EditRow): void {
  if (!batchRules.value[r.line]) return;
  batchRules.value = { ...batchRules.value, [r.line]: undefined };
}

/** 还有哪些待确认行是同样的模式 */
function batchTargets(rule: BatchRule, sourceLine: number): EditRow[] {
  return rows.value.filter((r) => {
    if (r.line === sourceLine || r.ignore) return false;
    if (tierOf(r) !== "review") return false;
    if (rule.kind === "rank") {
      return needsRankDecision(r) && r.rankText.trim() === rule.text;
    }
    if (!r.wireTokens.some((t) => t.key === rule.text)) return false;
    const links = r.wireLinks.filter((l) => l.token === rule.text);
    if (rule.action === "remove")
      return links.some((l) => l.field === rule.field);
    if (rule.from) return links.length === 1 && links[0].field === rule.from;
    return links.length === 0;
  });
}

function batchText(rule: BatchRule): string {
  if (rule.kind === "rank") return `职级「${rule.text}」也是同样情况`;
  const label =
    rule.field === "unresolved" ? "未归类" : WIRE_LABELS[rule.field];
  if (rule.action === "remove") return `也会把「${rule.text}」从${label}断开`;
  if (rule.field === "unit") {
    const res = resolveUnit(props.units, rule.text, targetUnitId.value);
    if (res.kind === "new") return `也会新建同一个单位「${res.name}」`;
  }
  return `也会把「${rule.text}」连到${label}`;
}

function batchInfo(
  r: EditRow,
): { n: number; lines: number[]; text: string } | null {
  const rule = batchRules.value[r.line];
  if (!rule) return null;
  const list = batchTargets(rule, r.line);
  if (!list.length) return null;
  return {
    n: list.length,
    lines: list.map((x) => x.line),
    text: batchText(rule),
  };
}

/** 全部按此修改：把同类行的同一处一起改掉 */
function applyBatch(r: EditRow): void {
  const rule = batchRules.value[r.line];
  if (!rule) return;
  for (const t of batchTargets(rule, r.line)) {
    if (rule.kind === "rank") {
      if (rule.action === "new") {
        t.newRank = rule.text;
        t.mapRankId = "";
        t.aliasRank = "";
        t.rankId = "";
        t.rankKind = "new";
      } else {
        t.mapRankId = rule.rankId ?? "";
        t.newRank = "";
        t.aliasRank = t.rankText.trim() || t.originalRank;
        t.rankKind = "alias";
      }
      refreshRowIssues(t);
      continue;
    }
    if (rule.action === "remove") {
      t.wireLinks = t.wireLinks.filter(
        (l) => !(l.token === rule.text && l.field === rule.field),
      );
    } else {
      t.wireLinks = [
        ...t.wireLinks.filter((l) => l.token !== rule.text),
        { token: rule.text, field: rule.field },
      ];
      if (rule.field === "unit") t.unitTouched = true;
    }
    syncWire(t);
    maybeAuto(t);
  }
  dismissBatch(r);
  scheduleMeasure();
}

/* ---------------------------------------------------------------- 连线定位与手势 */

function setWireEl(line: number, el: any): void {
  const prev = wireEls.get(line);
  const next = (el as HTMLElement | null) ?? null;
  if (prev === next) return;
  if (prev) resizeObs?.unobserve(prev);
  wireEls.delete(line);
  if (next) {
    wireEls.set(line, next);
    if (!resizeObs) resizeObs = new ResizeObserver(() => scheduleMeasure());
    resizeObs.observe(next);
    scheduleMeasure();
  } else {
    for (const k of [...tokenEls.keys()])
      if (k.startsWith(`${line}|`)) tokenEls.delete(k);
    for (const k of [...fieldEls.keys()])
      if (k.startsWith(`${line}|`)) fieldEls.delete(k);
  }
}

function setTokenEl(line: number, key: string, el: any): void {
  const k = `${line}|${key}`;
  if (el) tokenEls.set(k, el as HTMLElement);
  else tokenEls.delete(k);
}

function setFieldEl(line: number, field: CellField, el: any): void {
  const k = `${line}|${field}`;
  if (el) fieldEls.set(k, el as HTMLElement);
  else fieldEls.delete(k);
}

/** 布局变化后按真实位置重算，宽窄屏与长碎片都不会错位 */
function scheduleMeasure(): void {
  if (measureRaf) return;
  measureRaf = requestAnimationFrame(() => {
    measureRaf = 0;
    for (const line of [...wireEls.keys()]) measureLine(line);
  });
}

function measureLine(line: number): void {
  const box = wireEls.get(line);
  const r = rows.value.find((x) => x.line === line);
  if (!box || !r) return;
  const br = box.getBoundingClientRect();
  if (!br.width) return;

  const totals = new Map<string, number>();
  for (const l of r.wireLinks) {
    if (l.field === "unresolved") continue;
    totals.set(l.field, (totals.get(l.field) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const links: { token: string; field: CellField; d: string }[] = [];
  for (const l of r.wireLinks) {
    if (l.field === "unresolved") continue;
    const te = tokenEls.get(`${line}|${l.token}`);
    const fe = fieldEls.get(`${line}|${l.field}`);
    if (!te || !fe) continue;
    const tr = te.getBoundingClientRect();
    const fr = fe.getBoundingClientRect();
    if (!tr.width || !fr.width) continue;
    const i = seen.get(l.field) ?? 0;
    seen.set(l.field, i + 1);
    const total = totals.get(l.field) ?? 1;
    const fromX = fr.right - br.left;
    const toX = tr.left - br.left;
    const fromY = fr.top - br.top + fr.height / 2 + (i - (total - 1) / 2) * 7;
    const toY = tr.top - br.top + tr.height / 2;
    const dx = Math.max(10, Math.abs(toX - fromX) * 0.45);
    links.push({
      token: l.token,
      field: l.field,
      d: `M ${fromX.toFixed(1)} ${fromY.toFixed(1)} C ${(fromX + dx).toFixed(1)} ${fromY.toFixed(1)}, ${(toX - dx).toFixed(1)} ${toY.toFixed(1)}, ${toX.toFixed(1)} ${toY.toFixed(1)}`,
    });
  }

  let ghost: string | undefined;
  const d = drag.value;
  if (d && d.line === line && d.moved) {
    const te = tokenEls.get(`${line}|${d.token}`);
    if (te) {
      const tr = te.getBoundingClientRect();
      const x1 = tr.left - br.left + tr.width / 2;
      const y1 = tr.top - br.top + tr.height / 2;
      const x2 = d.x - br.left;
      const y2 = d.y - br.top;
      const dx = Math.max(16, Math.abs(x2 - x1) * 0.5);
      ghost = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 - dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 + dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
  }

  wireGeo.value = { ...wireGeo.value, [line]: { links, ghost } };
}

function hitField(line: number, x: number, y: number): CellField | "" {
  const el = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-wire-field]");
  if (!el || el.dataset.wireLine !== String(line)) return "";
  return (el.dataset.wireField ?? "") as CellField | "";
}

let press: { line: number; token: string; x: number; y: number } | null = null;
let pressMove: ((e: PointerEvent) => void) | null = null;
let pressUp: ((e: PointerEvent) => void) | null = null;

/** 按住在碎片上开始拖线；move / up 挂到 window，拖出卡片也不会丢 */
function onTokenDown(r: EditRow, t: WireToken, e: PointerEvent): void {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const prevMove = pressMove;
  const prevUp = pressUp;
  if (prevMove) window.removeEventListener("pointermove", prevMove);
  if (prevUp) {
    window.removeEventListener("pointerup", prevUp);
    window.removeEventListener("pointercancel", prevUp);
  }
  press = { line: r.line, token: t.key, x: e.clientX, y: e.clientY };
  pressMove = (ev: PointerEvent) => onDragMove(r, t.key, ev);
  pressUp = () => endPress(r, t.key);
  window.addEventListener("pointermove", pressMove);
  window.addEventListener("pointerup", pressUp);
  window.addEventListener("pointercancel", pressUp);
  e.preventDefault();
}

function onDragMove(r: EditRow, token: string, e: PointerEvent): void {
  if (!press || press.line !== r.line) return;
  if (!drag.value?.moved) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    drag.value = {
      line: r.line,
      token,
      field: hitField(r.line, e.clientX, e.clientY),
      x: e.clientX,
      y: e.clientY,
      moved: true,
    };
  } else if (drag.value) {
    const field = hitField(r.line, e.clientX, e.clientY);
    if (
      drag.value.x === e.clientX &&
      drag.value.y === e.clientY &&
      drag.value.field === field
    )
      return;
    drag.value = { ...drag.value, field, x: e.clientX, y: e.clientY };
  }
  scheduleMeasure();
}

function endPress(r: EditRow, token: string): void {
  if (!press || press.line !== r.line) return;
  if (pressMove) window.removeEventListener("pointermove", pressMove);
  if (pressUp) {
    window.removeEventListener("pointerup", pressUp);
    window.removeEventListener("pointercancel", pressUp);
  }
  press = null;
  pressMove = null;
  pressUp = null;
  const d = drag.value;
  drag.value = null;
  if (d?.moved && d.line === r.line) {
    if (d.field) connect(r, token, d.field);
    scheduleMeasure();
    return;
  }
  const same = picked.value?.line === r.line && picked.value?.token === token;
  picked.value = same ? null : { line: r.line, token };
}

/** 轻点碎片选中后，再点左栏字段即连线（窄屏 / 触摸兜底） */
function onFieldClick(r: EditRow, field: CellField): void {
  if (!picked.value || picked.value.line !== r.line) return;
  const token = picked.value.token;
  picked.value = null;
  connect(r, token, field);
}

onMounted(() => {
  window.addEventListener("resize", scheduleMeasure);
  // 桌面端：系统拖放被 Tauri 原生层接管，WebView 收不到 HTML5 drop，
  // 这里监听原生文件拖放事件，读成 File 后走与浏览器相同的解析入口。
  void listenNativeFileDrop({
    onHover: (active) => {
      dropHot.value =
        active && open.value && step.value === 1 && !sheet.value && !busy.value;
    },
    onDrop: (files) => {
      dropHot.value = false;
      if (!open.value || step.value !== 1 || sheet.value || busy.value) return;
      const file = files[0]?.file;
      if (file) void loadFile(file);
    },
    onError: (message) => {
      dropHot.value = false;
      error.value = message;
    },
  }).then((stop) => {
    stopNativeDrop = stop;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", scheduleMeasure);
  stopNativeDrop?.();
  stopNativeDrop = null;
  if (pressMove) window.removeEventListener("pointermove", pressMove);
  if (pressUp) {
    window.removeEventListener("pointerup", pressUp);
    window.removeEventListener("pointercancel", pressUp);
  }
  resizeObs?.disconnect();
  if (measureRaf) cancelAnimationFrame(measureRaf);
});

function skipRow(r: EditRow): void {
  r.ignore = true;
}

function unskipRow(r: EditRow): void {
  r.ignore = false;
}

function toggleEditor(r: EditRow): void {
  const next = !editorRows.value[r.line];
  editorRows.value = { ...editorRows.value, [r.line]: next };
  // 收起编辑后按最新文字重建连线
  if (!next) {
    initWire(r);
    scheduleMeasure();
  }
}

/** 手动改字段时替换对应片段，保证「拆分结果」与输入一致 */
function replaceFieldPart(r: EditRow, field: CellField, text: string): void {
  const parts = r.parts.filter((p) => p.field !== field);
  const value = text.trim();
  if (value) {
    parts.push({
      field,
      text,
      value,
      evidence: "手动修改",
      origin: "user",
      confidence: "high",
    });
  }
  r.parts = parts;
  applyParts(r, props.units, props.ranks);
}

function onField(
  r: EditRow,
  field: ImportField,
  v: string | number | null,
): void {
  const text = String(v ?? "");
  if (field === "name") r.name = text;
  else if (field === "unit") {
    r.unit = text;
    r.multiUnit = false;
    r.hierarchyUp = false;
    r.unitTouched = true;
  } else if (field === "duty") r.duty = text;
  else if (field === "note") r.note = text;
  else if (field === "rank") {
    r.rankText = text;
    r.mapRankId = "";
    r.newRank = "";
    r.aliasRank = "";
  }
  replaceFieldPart(r, field, text);
  // 文字改了，碎片也跟着变；连线在收起编辑时再量
  initWire(r);
}

function onRankFix(r: EditRow, v: string | number | null): void {
  const value = String(v ?? "");
  if (!value) {
    r.mapRankId = "";
    r.aliasRank = "";
    refreshRowIssues(r);
    dismissBatch(r);
    return;
  }
  const text = r.rankText.trim();
  if (value === "__new__") {
    if (!text) return;
    r.newRank = text;
    r.mapRankId = "";
    r.aliasRank = "";
    r.rankId = "";
    r.rankKind = "new";
    refreshRowIssues(r);
    batchRules.value = {
      ...batchRules.value,
      [r.line]: { kind: "rank", action: "new", text },
    };
    return;
  }
  const hit = props.ranks.find((x) => x.id === value);
  if (!hit) return;
  r.mapRankId = hit.id;
  r.newRank = "";
  r.aliasRank = r.rankText.trim() || r.originalRank;
  r.rankKind = "alias";
  refreshRowIssues(r);
  batchRules.value = {
    ...batchRules.value,
    [r.line]: { kind: "rank", action: "map", text, rankId: hit.id },
  };
}

function undoRankFix(r: EditRow): void {
  r.mapRankId = "";
  r.newRank = "";
  r.aliasRank = "";
  const m = matchRank(props.ranks, r.rankText);
  r.rankId = m.rankId;
  r.rankKind = m.kind;
  refreshRowIssues(r);
}

function ambiguousCell(opt: SplitOption[]): boolean {
  return opt.length > 1 && opt[0].score - opt[1].score < 0.15;
}

function optionLabel(opt: SplitOption): string {
  const parts = opt.parts.map((p) => p.value || p.text).filter(Boolean);
  return parts.join(" | ") || "（空）";
}

/** 把多解格子的候选拍平，方便在卡片里并排展示 */
function cutOptionsOf(
  r: EditRow,
): { cell: number; option: number; label: string; active: boolean }[] {
  const out: {
    cell: number;
    option: number;
    label: string;
    active: boolean;
  }[] = [];
  for (const ac of ambiguousCellsOf(r)) {
    ac.cell.forEach((opt, oi) => {
      out.push({
        cell: ac.index,
        option: oi,
        label: `${oi + 1}. ${optionLabel(opt)}`,
        active: r.cells[ac.index].choice === oi,
      });
    });
  }
  return out;
}

function chooseOption(
  r: EditRow,
  cellIndex: number,
  optionIndex: number,
): void {
  const cell = r.cells[cellIndex];
  if (!cell) return;
  r.cutChosen[cellIndex] = true;
  if (cell.choice === optionIndex) return;
  cell.choice = optionIndex;
  r.mapRankId = "";
  r.aliasRank = "";
  rebuildRow(r, props.units, props.ranks);
  initWire(r);
  nextTick(scheduleMeasure);
}

/** 确认当前显示的这一种切法 */
function confirmCut(r: EditRow): void {
  r.cells.forEach((c, i) => {
    if (ambiguousCell(c.options)) r.cutChosen[i] = true;
  });
}

function submit(): void {
  if (reviewCount.value || !importable.value.length || unitPlan.value.conflicts)
    return;
  emit("import", {
    rows: importable.value.map((r) => {
      const mapped = r.mapRankId || r.rankId;
      const known = mapped && props.ranks.some((x) => x.id === mapped);
      const originalUnit = r.originalUnit.trim();
      const resolvedUnit =
        r.unitTouched && originalUnit && originalUnit !== r.unit.trim()
          ? resolveUnit(props.units, r.unit.trim(), targetUnitId.value)
          : null;
      return {
        name: r.name.trim(),
        unit: r.unit.trim(),
        rankId: known ? mapped : "",
        newRank: !known && r.newRank.trim() ? r.newRank.trim() : undefined,
        duty: r.duty.trim(),
        note: r.note.trim(),
        aliasRank: r.mapRankId ? r.aliasRank || r.rankText.trim() : undefined,
        aliasUnit: resolvedUnit?.kind === "existing" ? originalUnit : undefined,
      };
    }),
    targetUnitId: targetUnitId.value,
    allowDuplicate: allowDuplicate.value,
  });
  open.value = false;
}

function columnLabel(c: ColumnRole): string {
  return c.label || `第 ${c.index + 1} 列`;
}

const submitBlocked = computed(
  () =>
    !importable.value.length ||
    !!reviewCount.value ||
    !!unitPlan.value.conflicts,
);
</script>

<template>
  <UiModal v-model="open" title="批量导入人员" icon="import" width="1120px">
    <div class="imp-wizard">
      <ol class="imp-steps">
        <li v-for="s in STEPS" :key="s.n" class="imp-step-item">
          <button
            type="button"
            class="imp-step"
            :class="{ active: step === s.n, done: step > s.n }"
            :disabled="!canEnter(s.n)"
            @click="goStep(s.n)"
          >
            <span class="imp-step-n">{{ step > s.n ? "✓" : s.n }}</span>
            <span class="imp-step-text">
              <b>{{ s.title }}</b>
              <i>{{ s.hint }}</i>
            </span>
          </button>
        </li>
      </ol>

      <div v-if="sheet && step > 1" class="imp-bands">
        <span class="imp-band ok"
          >已识别 <b>{{ okCount }}</b></span
        >
        <span class="imp-band guess"
          >推测 <b>{{ guessCount }}</b></span
        >
        <button
          type="button"
          class="imp-band review clickable"
          @click="goReview"
        >
          待确认 <b>{{ reviewCount }}</b>
          <span v-if="reviewCount" class="imp-band-go">去处理</span>
        </button>
        <span class="imp-band ignored"
          >已跳过 <b>{{ ignoredCount }}</b></span
        >
        <span class="imp-band-tip">共 {{ rows.length }} 行</span>
      </div>

      <div
        ref="bodyRef"
        class="imp-body"
        @dragenter.prevent="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <!-- 第 1 步：文件与工作表 -->
        <section v-if="step === 1" class="imp-pane">
          <header class="imp-head">
            <h3>确认文件和要导入的工作表</h3>
          </header>

          <input
            ref="fileInput"
            type="file"
            class="imp-file"
            accept=".xlsx,.xls,.xlsm,.docx,.csv,.txt,.tsv"
            @change="onPick"
          />

          <button
            v-if="!sheet"
            type="button"
            class="imp-drop"
            :class="{ busy, hot: dropHot }"
            @click="fileInput?.click()"
          >
            <span class="imp-drop-art insp-head-art"
              ><UiIcon name="import" :size="24"
            /></span>
            <span class="imp-drop-title">{{
              busy ? "正在读取…" : dropHot ? "松开即可读取" : "选择文件，或把文件拖到这里"
            }}</span>
            <span class="imp-drop-hint"
              >支持 .xlsx / .xls / .docx / .csv / .txt</span
            >
          </button>

          <template v-else>
            <div class="imp-file-card">
              <div class="imp-file-main">
                <span class="imp-file-art"
                  ><UiIcon name="import" :size="18"
                /></span>
                <div class="imp-file-text">
                  <div class="imp-file-name">{{ fileName }}</div>
                  <div class="imp-file-meta">
                    {{ sheet.dataRows.length }} 行人员数据 ·
                    {{ sheet.columns.length }} 列 ·
                    {{ headerHintText }}
                  </div>
                </div>
              </div>
              <UiButton
                size="sm"
                icon="rotate"
                :disabled="busy"
                @click="fileInput?.click()"
              >
                {{ busy ? "读取中…" : "重新选择文件" }}
              </UiButton>
            </div>

            <div v-if="sheetOptions.length > 1" class="imp-sheet-pick">
              <span class="insp-label">要导入的工作表</span>
              <UiSelect
                :model-value="activeSheet"
                :options="sheetOptions"
                size="sm"
                @update:model-value="onSheetChange"
              />
              <span class="imp-hint">
                这份文件有
                {{ sheetOptions.length }} 个工作表，只导入选中的这一个。
              </span>
            </div>

            <div class="imp-preview">
              <div class="imp-preview-head">
                <span class="insp-title">读到的前几行</span>
              </div>
              <div class="imp-preview-wrap">
                <table class="imp-preview-table">
                  <thead>
                    <tr>
                      <th v-for="(h, i) in previewHead" :key="i">{{ h }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(row, ri) in sheet.dataRows.slice(0, 3)"
                      :key="ri"
                    >
                      <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>

          <div v-if="error" class="imp-alert error">{{ error }}</div>
          <div v-for="w in visibleWarnings" :key="w" class="imp-alert note">
            {{ w }}
          </div>

          <ul v-if="!sheet" class="imp-rules">
            <li>旧版 .doc 请先另存为 .docx；CSV 支持 UTF-8 与 GBK。</li>
            <li>一个文件有多个工作表时，下一步可以选要导入的那一个。</li>
          </ul>
        </section>

        <!-- 第 2 步：列角色 -->
        <section v-else-if="step === 2" class="imp-pane">
          <header class="imp-head">
            <h3>给每一列选好用途</h3>
            <p>姓名必须选；用不到的列选「不导入」</p>
          </header>

          <div class="imp-map-grid">
            <div
              v-for="c in sheet?.columns ?? []"
              :key="c.index"
              class="imp-map-item"
            >
              <div class="imp-map-title">{{ columnLabel(c) }}</div>
              <div class="imp-map-sample">{{ sampleOf(c.index) }}</div>
              <UiSelect
                :model-value="c.role"
                :options="ROLE_OPTIONS"
                size="sm"
                @update:model-value="setColumnRole(c.index, $event)"
              />
            </div>
          </div>

          <div class="imp-map-target">
            <span class="insp-label">没写单位的人归到</span>
            <UiSelect
              v-model="targetUnitId"
              :options="unitOptions"
              size="sm"
              placeholder="选择单位"
            />
            <span class="imp-hint"
              >{{ targetPath || "未指定" }} · 只影响单位为空的人</span
            >
          </div>

          <div v-if="!hasNameColumn" class="imp-alert error">
            还没有选「姓名」列，请在任意一列选择「姓名」后再继续。
          </div>
          <div v-if="error" class="imp-alert error">{{ error }}</div>
        </section>

        <!-- 第 3 步：待确认 -->
        <section v-else-if="step === 3" class="imp-pane">
          <header class="imp-head">
            <h3>把碎片连到该去的字段</h3>
            <p>
              拖一条线，或先点碎片再点字段；连错了点一下线就断开。每栏各一条线、右侧没有剩余碎片时自动确认。
              <template v-if="reviewCount"
                >还剩 <b class="imp-strong">{{ reviewCount }}</b> 行。</template
              >
            </p>
          </header>

          <div v-if="!reviewCards.length" class="imp-empty-card">
            没有需要确认的行，可以直接进入下一步。
          </div>

          <article
            v-for="r in reviewCards"
            :key="r.line"
            class="imp-card"
            :class="{
              done: !r.ignore && tierOf(r) !== 'review',
              skipped: r.ignore,
            }"
          >
            <header class="imp-card-head">
              <span class="imp-card-line">第 {{ r.line }} 行</span>
              <span class="imp-state" :class="tierOf(r)">{{
                TIER_TEXT[tierOf(r)]
              }}</span>
              <span v-if="r.autoOk" class="imp-auto">已自动确认</span>
              <span
                v-else-if="!r.ignore && tierOf(r) !== 'review'"
                class="imp-card-done"
                >已处理</span
              >
              <span v-else-if="r.ignore" class="imp-card-done"
                >已跳过，不导入</span
              >
              <span v-else class="imp-card-hint">{{ shortHint(r) }}</span>
            </header>

            <div class="imp-card-raw">原文：{{ rawText(r) }}</div>

            <!-- 连线式：左栏固定字段位，右栏碎片，中间一条线就是一次归属 -->
            <div
              v-if="!editorRows[r.line]"
              class="imp-wire"
              :class="{ dragging: !!(drag && drag.line === r.line) }"
              :ref="(el) => setWireEl(r.line, el)"
            >
              <div class="imp-wire-fields">
                <div
                  v-for="f in WIRE_FIELDS"
                  :key="f"
                  class="imp-wire-field"
                  :class="{
                    on: fieldLinked(r, f),
                    drop: drag?.line === r.line && drag?.field === f,
                    pick: picked?.line === r.line && !r.ignore,
                  }"
                  :data-wire-field="f"
                  :data-wire-line="r.line"
                  :ref="(el) => setFieldEl(r.line, f, el)"
                  @click="onFieldClick(r, f)"
                >
                  <span class="imp-wire-name">{{ WIRE_LABELS[f] }}</span>
                  <span
                    class="imp-wire-value"
                    :class="{ blank: !fieldValue(r, f) }"
                  >
                    {{ fieldValue(r, f) || "—" }}
                  </span>
                </div>
              </div>

              <div class="imp-wire-tokens">
                <button
                  v-for="t in r.wireTokens"
                  :key="t.key"
                  type="button"
                  class="imp-token"
                  :class="{
                    multi: linkCount(r, t.key) > 1,
                    loose: linkCount(r, t.key) === 0,
                    picked: picked?.line === r.line && picked?.token === t.key,
                  }"
                  :data-token="t.key"
                  :ref="(el) => setTokenEl(r.line, t.key, el)"
                  @pointerdown="onTokenDown(r, t, $event)"
                >
                  {{ t.text }}
                  <i v-if="linkCount(r, t.key) > 1" class="imp-token-n">{{
                    linkCount(r, t.key)
                  }}</i>
                </button>
                <span v-if="!r.wireTokens.length" class="imp-wire-none">
                  没有可连的碎片，用「手动填写」
                </span>
              </div>

              <svg class="imp-wires" aria-hidden="true">
                <path
                  v-for="ln in wireGeo[r.line]?.links ?? []"
                  :key="`${ln.token}|${ln.field}`"
                  :d="ln.d"
                  class="imp-wire-line"
                  :class="ln.field"
                />
                <path
                  v-for="ln in wireGeo[r.line]?.links ?? []"
                  :key="`hit-${ln.token}|${ln.field}`"
                  :d="ln.d"
                  class="imp-wire-hit"
                  :data-field="ln.field"
                  :data-token="ln.token"
                  @click.stop="removeLink(r, ln.token, ln.field)"
                />
                <path
                  v-if="wireGeo[r.line]?.ghost"
                  :d="wireGeo[r.line]?.ghost"
                  class="imp-wire-ghost"
                />
              </svg>
            </div>

            <div v-else class="imp-editor">
              <label class="imp-field">
                <span>姓名</span>
                <UiInput
                  :model-value="r.name"
                  placeholder="必填"
                  @update:model-value="onField(r, 'name', $event)"
                />
              </label>
              <label class="imp-field">
                <span>单位</span>
                <UiInput
                  :model-value="r.unit"
                  placeholder="可留空"
                  @update:model-value="onField(r, 'unit', $event)"
                />
              </label>
              <label class="imp-field">
                <span>职级</span>
                <UiInput
                  :model-value="r.rankText"
                  placeholder="可留空"
                  @update:model-value="onField(r, 'rank', $event)"
                />
              </label>
              <label class="imp-field">
                <span>职务</span>
                <UiInput
                  :model-value="r.duty"
                  placeholder="可留空"
                  @update:model-value="onField(r, 'duty', $event)"
                />
              </label>
              <label class="imp-field">
                <span>备注</span>
                <UiInput
                  :model-value="r.note"
                  placeholder="可留空"
                  @update:model-value="onField(r, 'note', $event)"
                />
              </label>
            </div>

            <!-- 两条线并进同一栏：合并成一段，或只留其中一条 -->
            <div v-if="doubleFieldOf(r)" class="imp-merge">
              <div class="imp-merge-title">
                {{ mergeTokensOf(r).length }} 条线都连到了「{{
                  mergeFieldLabel(r)
                }}」，这一段怎么处理？
              </div>
              <div class="imp-merge-actions">
                <UiButton size="xs" @click="mergeFieldLinks(r)">
                  合并成「{{ mergedTextOf(r) }}」
                </UiButton>
                <button
                  v-for="t in mergeTokensOf(r)"
                  :key="`keep-${t}`"
                  type="button"
                  class="imp-link"
                  @click="keepOnlyLink(r, t)"
                >
                  只留「{{ t }}」
                </button>
                <button type="button" class="imp-link" @click="dismissMerge(r)">
                  先不处理
                </button>
              </div>
            </div>

            <div v-if="ambiguousCellsOf(r).length" class="imp-card-block thin">
              <div class="imp-card-label">换一种切法</div>
              <div class="imp-options">
                <button
                  v-for="opt in cutOptionsOf(r)"
                  :key="`${opt.cell}-${opt.option}`"
                  type="button"
                  class="imp-option"
                  :class="{ active: opt.active }"
                  @click="chooseOption(r, opt.cell, opt.option)"
                >
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div
              v-if="needsRankDecision(r) || r.mapRankId || r.newRank"
              class="imp-card-block thin"
            >
              <div class="imp-card-label">这行的职级要你定</div>
              <div v-if="needsRankDecision(r)" class="imp-rank-fix">
                <UiSelect
                  :model-value="''"
                  :options="rankFixOptions(r)"
                  size="sm"
                  @update:model-value="onRankFix(r, $event)"
                />
              </div>
              <div v-else-if="r.mapRankId" class="imp-rank-note ok">
                对应到「{{ rankNameOf(r.mapRankId) }}」
                <button type="button" class="imp-link" @click="undoRankFix(r)">
                  撤销
                </button>
              </div>
              <div v-else class="imp-rank-note new">
                将新建职级「{{ r.newRank }}」
                <button type="button" class="imp-link" @click="undoRankFix(r)">
                  撤销
                </button>
              </div>
            </div>

            <div class="imp-card-actions">
              <button
                v-if="r.autoOk"
                type="button"
                class="imp-link"
                @click="undoAuto(r)"
              >
                撤销自动确认
              </button>
              <UiButton
                v-if="hasUnresolvedAmbiguity(r) && !r.ignore"
                size="xs"
                @click="confirmCut(r)"
              >
                确认当前切法
              </UiButton>
              <UiButton
                size="xs"
                :variant="editorRows[r.line] ? 'primary' : 'default'"
                @click="toggleEditor(r)"
              >
                {{ editorRows[r.line] ? "收起填写" : "手动填写" }}
              </UiButton>
              <UiButton
                v-if="!r.ignore"
                size="xs"
                variant="ghost"
                @click="skipRow(r)"
              >
                跳过这行
              </UiButton>
              <UiButton v-else size="xs" variant="ghost" @click="unskipRow(r)">
                恢复这行
              </UiButton>
            </div>

            <div v-if="batchInfos[r.line]" class="imp-batch">
              <span class="imp-batch-text">
                还有 <b>{{ batchInfos[r.line]!.n }}</b> 行同样情况：{{
                  batchInfos[r.line]!.text
                }}
              </span>
              <UiButton size="xs" @click="applyBatch(r)">全部按此修改</UiButton>
              <button type="button" class="imp-link" @click="dismissBatch(r)">
                不用
              </button>
              <span class="imp-batch-lines"
                >第 {{ batchInfos[r.line]!.lines.join("、") }} 行</span
              >
            </div>
          </article>

          <div v-if="ignoredCards.length" class="imp-skipped">
            <span>已跳过 {{ ignoredCards.length }} 行：</span>
            <button
              v-for="r in ignoredCards"
              :key="`skip-${r.line}`"
              type="button"
              class="imp-skip-chip"
              @click="unskipRow(r)"
            >
              第 {{ r.line }} 行 · 恢复
            </button>
          </div>
        </section>

        <!-- 第 4 步：确认导入 -->
        <section v-else class="imp-pane">
          <header class="imp-head">
            <h3>确认后导入</h3>
            <p>看一眼汇总，确认无误再写入名册。</p>
          </header>

          <div class="imp-sum-grid">
            <div class="imp-sum-card">
              <b>{{ importable.length }}</b>
              <span>人将导入</span>
            </div>
            <div class="imp-sum-card">
              <b>{{ newUnitNames.length }}</b>
              <span>个单位将新建</span>
            </div>
            <div class="imp-sum-card">
              <b>{{ newRankNames.length }}</b>
              <span>个职级将新建</span>
            </div>
            <div class="imp-sum-card" :class="{ danger: reviewCount > 0 }">
              <b>{{ reviewCount }}</b>
              <span>行还没确认</span>
            </div>
          </div>

          <div v-if="newUnitNames.length" class="imp-sum-line">
            <span class="imp-card-label">将新建单位</span>
            <span>{{ newUnitNames.join("、") }}</span>
          </div>
          <div v-if="newRankNames.length" class="imp-sum-line">
            <span class="imp-card-label">将新建职级</span>
            <span>{{ newRankNames.join("、") }}</span>
          </div>

          <div v-if="reviewCount" class="imp-alert error">
            还有 {{ reviewCount }} 行没确认，不能导入。
            <button type="button" class="imp-link" @click="goReview">
              去处理
            </button>
          </div>
          <div v-if="unitPlan.conflicts" class="imp-alert error">
            有 {{ unitPlan.conflicts }} 个单位重名，需要先在组织架构里处理。
          </div>

          <div class="imp-dup">
            <UiCheckbox
              v-model="allowDuplicate"
              label="允许重名：同姓名且同单位的记录也写入（默认跳过重名）"
            />
            <p class="imp-dup-hint">
              默认会跳过同名同单位的人，跳过名单会在导入结果里列出来，不会悄悄消失。
            </p>
          </div>

          <p class="imp-final-tip">
            导入后可继续在名册里调整单位、职级和座位。
          </p>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="imp-foot">
        <span class="imp-foot-step">第 {{ step }} / 4 步</span>
        <span class="imp-grow" />
        <UiButton variant="ghost" @click="open = false">取消</UiButton>
        <UiButton v-if="step > 1" @click="prev">上一步</UiButton>
        <UiButton
          v-if="step < 4"
          variant="primary"
          :disabled="!canNext"
          @click="next"
        >
          {{ step === 1 ? "核对列" : "下一步" }}
        </UiButton>
        <UiButton
          v-else
          variant="primary"
          :disabled="submitBlocked"
          @click="submit"
        >
          导入 {{ importable.length }} 人
        </UiButton>
      </div>
    </template>
  </UiModal>
</template>

<style scoped>
.imp-wizard {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.imp-steps {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.imp-step-item {
  flex: 1;
  min-width: 0;
}
.imp-step {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}
.imp-step:hover:not(:disabled) {
  border-color: var(--primary-line);
  color: var(--text-secondary);
}
.imp-step:disabled {
  cursor: default;
  opacity: 0.55;
}
.imp-step.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}
.imp-step.done {
  color: var(--text-secondary);
}
.imp-step-n {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  border: 1px solid currentColor;
}
.imp-step.active .imp-step-n {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.imp-step-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.35;
}
.imp-step-text b {
  font-size: var(--fs-xs);
  font-weight: 600;
}
.imp-step-text i {
  font-style: normal;
  font-size: 10px;
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.imp-bands {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.imp-band {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  font-size: var(--fs-xs);
  background: var(--bg-subtle);
  color: var(--text-muted);
}
.imp-band b {
  font-weight: 600;
}
.imp-band.ok {
  background: var(--success-soft);
  color: var(--success);
  border-color: transparent;
}
.imp-band.guess {
  background: var(--warning-soft);
  color: var(--warning);
  border-color: transparent;
}
.imp-band.review {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: transparent;
}
.imp-band.ignored {
  color: var(--text-disabled);
}
.imp-band.clickable {
  font: inherit;
  font-size: var(--fs-xs);
  cursor: pointer;
}
.imp-band.clickable:disabled {
  cursor: default;
}
.imp-band-go {
  margin-left: 2px;
  text-decoration: underline;
}
.imp-band-tip {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-disabled);
}

.imp-body {
  max-height: clamp(240px, calc(100vh - 330px), 620px);
  overflow: auto;
  padding-right: 2px;
}
.imp-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.imp-head h3 {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.imp-head p {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  line-height: 1.7;
  color: var(--text-muted);
}
.imp-strong {
  color: var(--danger);
}

.imp-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 150px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) ease,
    background var(--motion-fast) ease;
}
.imp-drop:hover {
  border-color: var(--primary-line);
  background: var(--primary-soft);
  color: var(--primary);
}
/* 文件拖到弹窗上：整块内容区亮起来，松手即读取 */
.imp-drop.hot {
  border-style: solid;
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.imp-drop.busy {
  pointer-events: none;
  color: var(--text-muted);
}
.imp-drop-art {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.imp-drop-title {
  font-size: var(--fs-sm);
}
.imp-drop-hint {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.imp-file {
  display: none;
}

.imp-rules {
  margin: 0;
  padding-left: 16px;
  font-size: var(--fs-xs);
  line-height: 1.9;
  color: var(--text-muted);
}

.imp-file-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.imp-file-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.imp-file-art {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-soft);
  color: var(--primary);
}
.imp-file-text {
  min-width: 0;
}
.imp-file-name {
  font-size: var(--fs-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imp-file-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
}
.imp-sheet-pick {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.imp-sheet-pick :deep(.ui-select) {
  width: 220px;
}
.imp-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.imp-preview-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.imp-preview-wrap {
  margin-top: 6px;
  overflow: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.imp-preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-xs);
}
.imp-preview-table th {
  padding: 6px 8px;
  text-align: left;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.imp-preview-table td {
  padding: 5px 8px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-soft);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.imp-alert {
  padding: 7px 10px;
  border-radius: var(--radius-xs);
  font-size: var(--fs-xs);
  line-height: 1.6;
}
.imp-alert.error {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger-line);
}
.imp-alert.note {
  background: var(--bg-subtle);
  color: var(--text-muted);
  border: 1px solid var(--border-soft);
}

.imp-map-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px 14px;
}
.imp-map-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.imp-map-title {
  font-size: var(--fs-xs);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imp-map-sample {
  font-size: 10px;
  color: var(--text-muted);
  height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imp-map-target {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.imp-map-target :deep(.ui-select) {
  width: 240px;
}

.imp-empty-card {
  padding: 22px 16px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.imp-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger-soft) 30%, var(--bg-panel));
}
.imp-card.done {
  border-color: var(--success-line, var(--border-soft));
  background: var(--bg-panel);
}
.imp-card.skipped {
  border-color: var(--border-soft);
  background: var(--bg-subtle);
  opacity: 0.85;
}
.imp-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.imp-card-line {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.imp-card-done {
  font-size: 10px;
  color: var(--success);
}
.imp-card-hint {
  font-size: 11px;
  color: var(--danger);
}
.imp-card.done .imp-card-hint,
.imp-card.skipped .imp-card-hint {
  color: var(--text-muted);
}
.imp-card-raw {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.6;
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  background: var(--bg-subtle);
  word-break: break-all;
}
.imp-card-label {
  flex: none;
  font-size: 10px;
  line-height: 20px;
  color: var(--text-muted);
}
.imp-card-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.imp-card-block.thin {
  padding-top: 2px;
  border-top: 1px dashed var(--border-soft);
}
.imp-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

/* ---- 连线式卡片：左栏固定字段，右栏碎片，中间画线 ---- */
.imp-wire {
  position: relative;
  display: grid;
  /* 两栏按比例分：左栏字段，右栏碎片靠右，中间留出画线的距离 */
  grid-template-columns: minmax(0, 0.38fr) minmax(0, 0.62fr);
  column-gap: clamp(28px, 8%, 120px);
  align-items: start;
  padding: 2px 0;
  user-select: none;
}
/* 连线层压在最下面：线的命中区不能抢走碎片与字段的点击 */
.imp-wire-fields {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.imp-wire-field {
  display: flex;
  flex-direction: column;
  gap: 1px;
  justify-content: center;
  min-height: 32px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px dashed var(--border);
  background: var(--bg-subtle);
  cursor: pointer;
  transition:
    border-color 0.12s,
    background 0.12s,
    box-shadow 0.12s;
}
.imp-wire-field.on {
  border-style: solid;
  border-color: var(--border-strong);
  background: var(--bg-panel);
}
.imp-wire-field.pick:hover {
  border-color: var(--primary-line);
}
.imp-wire-field.drop {
  border-color: var(--primary);
  background: var(--primary-soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 26%, transparent);
}
.imp-wire-name {
  font-size: 10px;
  line-height: 1.3;
  color: var(--text-muted);
}
.imp-wire-value {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.imp-wire-value.blank {
  color: var(--text-disabled, var(--text-muted));
  opacity: 0.6;
}
/* 碎片竖排在右栏：两边各自纵向排列，线左右对拉，不会斜穿整片 */
.imp-wire-tokens {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-wrap: nowrap;
  gap: 4px;
  padding-top: 1px;
  min-width: 0;
  /* 碎片靠右后整列很宽，空白处不能挡住下面的连线命中区 */
  pointer-events: none;
}
.imp-token {
  pointer-events: auto;
  position: relative;
  max-width: 100%;
  font: inherit;
  font-size: 11px;
  line-height: 1.6;
  text-align: left;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-panel);
  color: var(--text-secondary);
  cursor: grab;
  touch-action: none;
  word-break: break-all;
}
.imp-token:active {
  cursor: grabbing;
}
.imp-token.loose {
  border-style: dashed;
  border-color: var(--danger-line);
  background: var(--danger-soft);
  color: var(--danger);
}
.imp-token.multi {
  border-color: var(--warning);
  background: var(--warning-soft);
  color: var(--warning);
}
.imp-token.picked {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 24%, transparent);
}
.imp-token-n {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--warning);
  color: #fff;
  font-style: normal;
  font-size: 9px;
  line-height: 14px;
  text-align: center;
}
.imp-wire-none {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.8;
}

/* 自动确认 / 两条线并进同一栏 */
.imp-auto {
  font-size: 11px;
  color: var(--success);
}
.imp-merge {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--warning);
  background: var(--warning-soft);
}
.imp-merge-title {
  font-size: 11px;
  color: var(--text-secondary);
}
.imp-merge-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.imp-wires {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
.imp-wire-line {
  fill: none;
  stroke: var(--border-strong);
  stroke-width: 1.4;
}
.imp-wire-line.name {
  stroke: var(--text-secondary);
}
.imp-wire-line.unit {
  stroke: var(--primary);
}
.imp-wire-line.rank {
  stroke: var(--success);
}
.imp-wire-line.duty {
  stroke: var(--warning);
}
.imp-wire-line.note {
  stroke: var(--text-muted);
}
.imp-wire-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  pointer-events: stroke;
  cursor: pointer;
}
.imp-wire-hit:hover {
  stroke: color-mix(in srgb, var(--danger) 18%, transparent);
}
.imp-wire.dragging .imp-wire-hit {
  pointer-events: none;
}
.imp-wire-ghost {
  fill: none;
  stroke: var(--primary);
  stroke-width: 1.4;
  stroke-dasharray: 4 3;
}

/* ---- 同类问题批量提醒 ---- */
.imp-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--primary-line);
  background: var(--primary-soft);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.imp-batch-text b {
  color: var(--primary);
  font-weight: 600;
}
.imp-batch-lines {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
}

.imp-options {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.imp-option {
  font: inherit;
  font-size: 10px;
  line-height: 1.6;
  text-align: left;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px dashed var(--warning-line);
  background: var(--warning-soft);
  color: var(--warning);
}
.imp-option.active {
  border-style: solid;
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.imp-rank-fix {
  max-width: 280px;
}
.imp-rank-note {
  font-size: 11px;
  line-height: 1.6;
  display: flex;
  gap: 6px;
  align-items: center;
}
.imp-rank-note.ok {
  color: var(--success);
}
.imp-rank-note.new {
  color: var(--primary);
}
.imp-link {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--text-muted);
  cursor: pointer;
  text-decoration: underline;
}

.imp-editor {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px 12px;
}
.imp-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.imp-field > span {
  font-size: 10px;
  color: var(--text-muted);
}

.imp-skipped {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-muted);
}
.imp-skip-chip {
  font: inherit;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  background: var(--bg-subtle);
  color: var(--text-muted);
  cursor: pointer;
}
.imp-skip-chip:hover {
  border-color: var(--primary-line);
  color: var(--primary);
}

.imp-sum-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.imp-sum-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  background: var(--bg-subtle);
}
.imp-sum-card b {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.2;
}
.imp-sum-card span {
  font-size: 11px;
  color: var(--text-muted);
}
.imp-sum-card.danger {
  border-color: var(--danger-line);
  background: var(--danger-soft);
}
.imp-sum-card.danger b {
  color: var(--danger);
}
.imp-sum-line {
  display: flex;
  gap: 10px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1.7;
}
.imp-sum-line .imp-card-label {
  line-height: 1.7;
}

.imp-dup {
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.imp-dup-hint {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-muted);
}
.imp-final-tip {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.imp-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.imp-foot-step {
  font-size: 11px;
  color: var(--text-muted);
}
.imp-grow {
  flex: 1;
}

@media (max-width: 880px) {
  .imp-steps {
    flex-wrap: wrap;
  }
  .imp-step-item {
    flex: 1 1 46%;
  }
  .imp-step-text i {
    display: none;
  }
  .imp-body {
    max-height: 52vh;
  }
  .imp-sum-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .imp-map-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .imp-editor {
    grid-template-columns: 1fr;
  }
  .imp-file-card {
    flex-direction: column;
    align-items: stretch;
  }
  .imp-wire {
    grid-template-columns: minmax(0, 0.46fr) minmax(0, 0.54fr);
    column-gap: 14px;
  }
  /* 窄屏碎片不再靠右，贴着字段列走，线短一些 */
  .imp-wire-tokens {
    align-items: flex-start;
  }
  .imp-wire-field {
    min-height: 28px;
    padding: 2px 6px;
  }
  .imp-token {
    font-size: 10px;
    padding: 2px 7px;
  }
  .imp-batch-lines {
    margin-left: 0;
    width: 100%;
  }
}
</style>
