<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { RankDef, UnitNode } from "../../types";
import { listenNativeFileDrop } from "../../platform/nativeFileDrop";
import { listRosterSheets, readRosterSheet, type RawSheet } from "../../engine/rosterImport";
import { planUnitInputs } from "../../engine/unitMatch";
import {
  buildAnalysis,
  matchRank,
  type AdaptiveSheet,
  type ColumnRole,
  type ImportField,
} from "../../engine/rosterAdaptive";
import { UiButton, UiCheckbox, UiIcon, UiModal, UiSelect } from "../../ui";

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    unitOptions: { value: string; label: string }[];
    /** 当前名册（或项目快照）的单位树，用于列识别与单位解析预览 */
    units: UnitNode[];
    /** 当前名册（或项目快照）的职级 */
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
  { n: 1, title: "选择文件" },
  { n: 2, title: "核对列" },
  { n: 3, title: "确认导入" },
];

const sheet = ref<AdaptiveSheet | null>(null);
const rawSheet = ref<RawSheet | null>(null);
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
/** 首行是否为表头：默认按自动识别结果，可手动切换 */
const firstRowHeader = ref(true);
/** 未识别职级的人工决定：line → 'none' | 'new' | 'rank:<id>' */
const rankChoices = ref<Record<number, string>>({});
/** 桌面端原生拖放的取消注册函数 */
let stopNativeDrop: (() => void) | null = null;

const ROLE_OPTIONS = [
  { value: "name", label: "姓名" },
  { value: "unit", label: "单位 / 部门" },
  { value: "rank", label: "职级" },
  { value: "duty", label: "职务" },
  { value: "note", label: "备注 / 电话" },
  { value: "ignore", label: "不导入" },
];

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
  rawSheet.value = null;
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
  firstRowHeader.value = true;
  rankChoices.value = {};
}

async function loadFile(file: File | null | undefined): Promise<void> {
  if (!file || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const names = await listRosterSheets(file);
    pickedFile.value = file;
    sheetNames.value = names;
    fileName.value = file.name;
    activeSheet.value = names[0] ?? "";
    await readSheet(activeSheet.value);
  } catch (e: any) {
    pickedFile.value = null;
    sheet.value = null;
    error.value = e?.message || String(e) || "读取文件失败";
  } finally {
    busy.value = false;
  }
}

async function readSheet(name: string): Promise<void> {
  if (!pickedFile.value) return;
  busy.value = true;
  error.value = "";
  try {
    const raw = await readRosterSheet(pickedFile.value, name || undefined);
    rawSheet.value = raw;
    applyAnalysis(undefined);
  } catch (e: any) {
    sheet.value = null;
    rawSheet.value = null;
    error.value = e?.message || String(e) || "读取文件失败";
  } finally {
    busy.value = false;
  }
}

/** 按当前「首行是表头」选择重新解析 */
function applyAnalysis(forceHeader: boolean | undefined): void {
  if (!rawSheet.value) return;
  sheet.value = buildAnalysis(rawSheet.value, props.units, props.ranks, {
    forceHeader,
  });
  if (forceHeader === undefined) firstRowHeader.value = sheet.value.hasHeader;
  rankChoices.value = {};
}

function onHeaderToggle(v: boolean): void {
  firstRowHeader.value = v;
  applyAnalysis(v);
}

async function onSheetChange(v: string): Promise<void> {
  activeSheet.value = v;
  await readSheet(v);
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  void loadFile(input.files?.[0]);
}

function hasFiles(e: DragEvent): boolean {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}
function onDragEnter(e: DragEvent): void {
  if (hasFiles(e)) dropHot.value = true;
}
function onDragLeave(): void {
  dropHot.value = false;
}
function onDrop(e: DragEvent): void {
  dropHot.value = false;
  void loadFile(e.dataTransfer?.files?.[0]);
}

/* ---- 派生数据 ---- */

const sheetOptions = computed(() =>
  sheetNames.value.map((n) => ({ value: n, label: n || "文本内容" })),
);

const visibleWarnings = computed(() => {
  const out: string[] = [];
  for (const w of rawSheet.value?.warnings ?? [])
    if (!out.includes(w)) out.push(w);
  return out;
});

const headerHintText = computed(() => {
  const s = sheet.value;
  if (!s) return "";
  return s.hasHeader ? `表头：第 ${s.headerIndex + 1} 行` : "未识别到表头";
});

const hasNameColumn = computed(() =>
  (sheet.value?.columns ?? []).some((c) => c.role === "name"),
);

interface TemplateRow {
  line: number;
  name: string;
  unit: string;
  rankText: string;
  /** 自动匹配到的职级 id；空表示需要人工决定 */
  rankId: string;
  duty: string;
  note: string;
}

const parsedRows = computed<TemplateRow[]>(() => {
  const s = sheet.value;
  if (!s) return [];
  const active = s.columns.filter((c) => c.role !== "ignore");
  const out: TemplateRow[] = [];
  s.dataRows.forEach((cells, i) => {
    const pick = (role: ImportField): string => {
      const col = active.find((c) => c.role === role);
      return col ? (cells[col.index] ?? "").trim() : "";
    };
    const name = pick("name");
    const unit = pick("unit");
    const rankText = pick("rank");
    const duty = pick("duty");
    const note = pick("note");
    if (!name && !unit && !rankText && !duty && !note) return;
    const m = matchRank(props.ranks, rankText);
    out.push({
      line: s.headerIndex >= 0 ? s.headerIndex + 2 + i : i + 1,
      name,
      unit,
      rankText: m.rankId ? m.target : rankText,
      rankId: m.rankId,
      duty,
      note,
    });
  });
  return out;
});

const importableRows = computed(() =>
  parsedRows.value.filter((r) => r.name),
);
const noNameCount = computed(
  () => parsedRows.value.length - importableRows.value.length,
);

const newRankNames = computed(() => {
  const out: string[] = [];
  for (const r of importableRows.value) {
    if (r.rankId) continue;
    if ((rankChoices.value[r.line] ?? "none") !== "new") continue;
    const t = r.rankText.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
});

const unitPlan = computed(() =>
  planUnitInputs(
    props.units,
    importableRows.value.map((r) => r.unit),
    targetUnitId.value || props.defaultUnitId,
  ),
);

const targetPath = computed(() => {
  const id = targetUnitId.value || props.defaultUnitId;
  if (!id) return "";
  const map = new Map(props.units.map((u) => [u.id, u]));
  return map.get(id)?.name ?? "";
});

/** 单行单位的解析结果展示：命中已有单位直接显示名称（全局唯一），仅新建时给父级位置 */
function unitTextOf(i: number): string {
  const item = unitPlan.value.items[i];
  if (!item) return "";
  if (item.kind === "empty") return `—（归入 ${targetPath.value || "未指定"}）`;
  if (item.kind === "existing") return item.name;
  if (item.kind === "new") return `将新建：${item.name}`;
  return "重名冲突";
}

/** 未识别职级的人工选项 */
function rankOptionsOf(r: TemplateRow) {
  return [
    { value: "none", label: "不设置" },
    ...props.ranks.map((x) => ({ value: `rank:${x.id}`, label: x.name })),
    { value: "new", label: `新建「${r.rankText}」` },
  ];
}

/** 行最终职级：'rank:<id>' / 'new' / ''（不设置） */
function rankChoiceOf(r: TemplateRow): string {
  if (r.rankId) return `rank:${r.rankId}`;
  const v = rankChoices.value[r.line] ?? "none";
  return v === "none" ? "" : v;
}

function sampleOf(index: number): string {
  const s = sheet.value;
  if (!s) return "";
  for (const row of s.dataRows) {
    const v = (row[index] ?? "").trim();
    if (v) return v;
  }
  return "";
}

function columnLabel(c: ColumnRole): string {
  return c.label || `第 ${c.index + 1} 列`;
}

function setColumnRole(index: number, role: string): void {
  const s = sheet.value;
  if (!s) return;
  const col = s.columns[index];
  if (!col) return;
  col.role = role as ColumnRole["role"];
  col.confidence = "high";
  col.evidence = "手动指定";
}

function canEnter(n: number): boolean {
  if (n === 1) return true;
  if (!sheet.value) return false;
  if (n === 3) return hasNameColumn.value;
  return true;
}

const canNext = computed(() => {
  if (step.value === 1) return !!sheet.value;
  if (step.value === 2) return hasNameColumn.value;
  return false;
});

const submitBlocked = computed(
  () =>
    !importableRows.value.length ||
    !!unitPlan.value.conflicts ||
    busy.value,
);

function goStep(n: number): void {
  if (!canEnter(n)) return;
  step.value = n;
}
function next(): void {
  if (step.value < 3 && canNext.value) step.value++;
}
function prev(): void {
  if (step.value > 1) step.value--;
}

function submit(): void {
  if (submitBlocked.value) return;
  emit("import", {
    rows: importableRows.value.map((r) => {
      const choice = rankChoiceOf(r);
      const mapped = choice.startsWith("rank:")
        ? choice.slice(5)
        : "";
      return {
        name: r.name,
        unit: r.unit,
        rankId: mapped,
        newRank: choice === "new" ? r.rankText : undefined,
        duty: r.duty,
        note: r.note,
        aliasRank:
          mapped && r.rankText && !r.rankId ? r.rankText : undefined,
      };
    }),
    targetUnitId: targetUnitId.value,
    allowDuplicate: allowDuplicate.value,
  });
}

onMounted(async () => {
  stopNativeDrop = await listenNativeFileDrop({
    onHover: (active) => {
      dropHot.value = active;
    },
    onDrop: (files) => {
      void loadFile(files[0]?.file ?? null);
    },
    onError: (message) => {
      error.value = message;
    },
  });
});

onBeforeUnmount(() => {
  stopNativeDrop?.();
});
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
            </span>
          </button>
        </li>
      </ol>

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
                    {{ sheet.dataRows.length }} 行数据 ·
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
            </div>

            <div class="imp-preview">
              <div class="imp-preview-head">
                <span class="insp-title">读到的前几行</span>
              </div>
              <div class="imp-preview-wrap">
                <table class="imp-preview-table">
                  <thead>
                    <tr>
                      <th v-for="(h, i) in sheet.headerLabels" :key="i">
                        {{ h }}
                      </th>
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
            <li>按模板整理：姓名列必填，单位 / 职级 / 职务 / 备注可选。</li>
            <li>旧版 .doc 请先另存为 .docx；CSV 支持 UTF-8 与 GBK。</li>
          </ul>
        </section>

        <!-- 第 2 步：核对列 -->
        <section v-else-if="step === 2" class="imp-pane">
          <header class="imp-head">
            <h3>核对每一列的用途</h3>
            <p>姓名必须选；用不到的列选「不导入」。</p>
          </header>

          <label class="imp-header-toggle">
            <UiCheckbox
              :model-value="firstRowHeader"
              label="首行是表头"
              @update:model-value="onHeaderToggle"
            />
          </label>

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
            <span class="imp-hint">
              {{ targetPath || "未指定" }} · 只影响单位为空的人
            </span>
          </div>

          <div v-if="!hasNameColumn" class="imp-alert error">
            还没有选「姓名」列，请在任意一列选择「姓名」后再继续。
          </div>
          <div v-if="error" class="imp-alert error">{{ error }}</div>
        </section>

        <!-- 第 3 步：确认导入 -->
        <section v-else class="imp-pane">
          <header class="imp-head">
            <h3>确认后导入</h3>
          </header>

          <div class="imp-sum-grid">
            <div class="imp-sum-card">
              <b>{{ importableRows.length }}</b>
              <span>人将导入</span>
            </div>
            <div class="imp-sum-card">
              <b>{{ unitPlan.newUnits.length }}</b>
              <span>个单位将新建</span>
            </div>
            <div class="imp-sum-card">
              <b>{{ newRankNames.length }}</b>
              <span>个职级将新建</span>
            </div>
            <div
              class="imp-sum-card"
              :class="{ danger: noNameCount > 0 }"
            >
              <b>{{ noNameCount }}</b>
              <span>行缺姓名将跳过</span>
            </div>
          </div>

          <div v-if="unitPlan.newUnits.length" class="imp-sum-line">
            <span class="imp-sum-label">将新建单位</span>
            <span>{{
              unitPlan.newUnits
                .map(
                  (u) =>
                    `${u.name}${u.parentPath ? `（挂到 ${u.parentPath}）` : ""}`,
                )
                .join("、")
            }}</span>
          </div>
          <div v-if="newRankNames.length" class="imp-sum-line">
            <span class="imp-sum-label">将新建职级</span>
            <span>{{ newRankNames.join("、") }}</span>
          </div>

          <div v-if="unitPlan.conflicts" class="imp-alert error">
            有 {{ unitPlan.conflicts }} 个单位重名，需要先处理重名单位再导入。
          </div>

          <div class="imp-preview">
            <div class="imp-preview-head">
              <span class="insp-title">导入预览</span>
              <span class="imp-hint">共 {{ importableRows.length }} 行</span>
            </div>
            <div class="imp-preview-wrap">
              <table class="imp-preview-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>单位</th>
                    <th>职级</th>
                    <th>职务</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(r, i) in importableRows"
                    :key="r.line"
                    :class="{ 'is-dim': !r.name }"
                  >
                    <td>{{ r.name || "—（将跳过）" }}</td>
                    <td>{{ unitTextOf(i) }}</td>
                    <td class="imp-rank-cell">
                      <span v-if="r.rankId">{{
                        props.ranks.find((x) => x.id === r.rankId)?.name ??
                        r.rankText
                      }}</span>
                      <UiSelect
                        v-else-if="r.rankText"
                        :model-value="rankChoices[r.line] ?? 'none'"
                        :options="rankOptionsOf(r)"
                        size="sm"
                        @update:model-value="
                          rankChoices[r.line] = String($event)
                        "
                      />
                      <span v-else class="imp-hint">未设置</span>
                    </td>
                    <td>{{ r.duty }}</td>
                    <td>{{ r.note }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="imp-dup">
            <UiCheckbox
              v-model="allowDuplicate"
              label="允许重名（同姓名且同单位也写入，默认跳过）"
            />
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="imp-foot">
        <span class="imp-foot-step">第 {{ step }} / 3 步</span>
        <span class="imp-grow" />
        <UiButton variant="ghost" @click="open = false">取消</UiButton>
        <UiButton v-if="step > 1" @click="prev">上一步</UiButton>
        <UiButton
          v-if="step < 3"
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
          导入 {{ importableRows.length }} 人
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
  min-width: 0;
  line-height: 1.35;
}
.imp-step-text b {
  font-size: var(--fs-xs);
  font-weight: 600;
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

.imp-header-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-secondary);
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
  max-height: 340px;
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
.imp-preview-table tr.is-dim td {
  color: var(--text-muted);
}
.imp-rank-cell :deep(.ui-select) {
  width: 170px;
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
.imp-sum-label {
  flex: none;
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.7;
}

.imp-dup {
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
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
  .imp-body {
    max-height: 52vh;
  }
  .imp-sum-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .imp-map-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
  .imp-file-card {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
