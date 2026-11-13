<script setup lang="ts">
/**
 * 设置中心：只保留备份与恢复、历史快照、关于、清空数据四项操作。
 * 页面本身只做导航与说明，所有操作在弹框内完成；
 * 视觉沿用 tokens 与 .insp-* 的规格，不引入新的颜色与字号档位。
 */
import { computed, onMounted, ref } from "vue";
import { repository, type StorageUsage } from "../data";
import { loadAll } from "../store";
import { saveFile } from "../platform/files";
import { UiIcon, UiModal } from "../ui";
import { version as appVersion } from "../../package.json";

const usage = ref<StorageUsage>({ totalBytes: 0, snapshotCount: 0 });
const busy = ref(false);
const pageNotice = ref("");

const backupOpen = ref(false);
const snapshotOpen = ref(false);
const clearOpen = ref(false);
const aboutOpen = ref(false);

const backupNotice = ref("");
const backupNoticeWarn = ref(false);
const snapshotNotice = ref("");
const importInput = ref<HTMLInputElement | null>(null);

async function refreshUsage(): Promise<void> {
  usage.value = await repository.usage();
}

onMounted(refreshUsage);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ---------- 弹框操作 ----------
function openBackup(): void {
  backupNotice.value = "";
  backupNoticeWarn.value = false;
  backupOpen.value = true;
}

function openSnapshots(): void {
  snapshotNotice.value = "";
  snapshotOpen.value = true;
}

async function backupAll(): Promise<void> {
  try {
    const json = await repository.exportAll();
    const res = await saveFile(
      `seat-planning-backup-${new Date().toISOString().slice(0, 10)}.json`,
      json,
      "json",
    );
    backupNoticeWarn.value = false;
    backupNotice.value = res.saved
      ? "已导出全量备份，请妥善保存该文件。"
      : "已取消导出。";
  } catch {
    backupNoticeWarn.value = true;
    backupNotice.value = "导出失败，请重试。";
  }
}

async function importBackup(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  busy.value = true;
  try {
    const summary = await repository.importAll(await file.text());
    await loadAll(false);
    await refreshUsage();
    const total =
      summary.rosters +
      summary.layouts +
      summary.projects +
      summary.presets +
      summary.snapshots;
    backupNoticeWarn.value = false;
    backupNotice.value = `已导入 ${total} 条数据${summary.warnings.length ? `（${summary.warnings.join("；")}）` : ""}。`;
  } catch (err) {
    backupNoticeWarn.value = true;
    backupNotice.value =
      err instanceof Error ? err.message : "导入失败，请检查备份文件。";
  } finally {
    busy.value = false;
  }
}

async function clearSnaps(): Promise<void> {
  const count = usage.value.snapshotCount;
  if (!count) return;
  busy.value = true;
  try {
    await repository.clearSnapshots();
    await refreshUsage();
    snapshotNotice.value = `已清空全部 ${count} 条历史快照。`;
  } finally {
    busy.value = false;
  }
}

async function clearAll(): Promise<void> {
  busy.value = true;
  try {
    await repository.clearAll();
    await loadAll(false);
    await refreshUsage();
    clearOpen.value = false;
    pageNotice.value = "已清空全部本机数据，可导入备份恢复。";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <header class="page-head">
    <div class="page-head-main">
      <div class="page-eyebrow">系统</div>
      <h1 class="page-title">设置中心</h1>
      <p class="page-desc">维护保存在本机上的名册、会场与排座数据。</p>
    </div>
  </header>

  <div class="set-layout">
    <aside class="set-aside">
      <div class="set-id">
        <svg class="set-mark" viewBox="0 0 1024 1024" aria-hidden="true">
          <rect width="1024" height="1024" rx="224" fill="currentColor" />
          <path
            d="M205 205 V819 H819"
            fill="none"
            stroke="var(--on-primary)"
            stroke-width="66"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <circle cx="785" cy="316" r="82" fill="var(--on-primary)" />
        </svg>
        <div class="set-id-text">
          <div class="set-id-name">座位编排</div>
          <div class="set-id-ver">版本 {{ appVersion }}</div>
        </div>
      </div>
      <p class="set-copy">便捷、方便的座位编排工具。</p>
      <ul class="set-notes">
        <li>
          <UiIcon name="import" :size="12" />
          <span>导入覆盖，同数据会被替换。</span>
        </li>
        <li>
          <UiIcon name="info" :size="12" />
          <span>清空不可撤销，建议先导出一份备份。</span>
        </li>
      </ul>
    </aside>

    <section class="set-main">
      <div class="set-label">维护</div>
      <div class="set-panel">
        <button type="button" class="set-row" @click="openBackup">
          <span class="set-art"><UiIcon name="backup" :size="17" /></span>
          <span class="set-body">
            <span class="set-name">备份与恢复</span>
          </span>
          <span class="set-tail">JSON</span>
          <UiIcon class="set-arrow" name="chevronRight" :size="14" />
        </button>

        <button type="button" class="set-row" @click="openSnapshots">
          <span class="set-art"><UiIcon name="clock" :size="17" /></span>
          <span class="set-body">
            <span class="set-name">历史快照</span>
          </span>
          <span class="set-tail">{{
            usage.snapshotCount ? `${usage.snapshotCount} 条` : "暂无"
          }}</span>
          <UiIcon class="set-arrow" name="chevronRight" :size="14" />
        </button>

        <button type="button" class="set-row" @click="aboutOpen = true">
          <span class="set-art"><UiIcon name="info" :size="17" /></span>
          <span class="set-body">
            <span class="set-name">关于</span>
          </span>
          <span class="set-tail">v{{ appVersion }}</span>
          <UiIcon class="set-arrow" name="chevronRight" :size="14" />
        </button>
      </div>

      <div class="set-panel danger-zone">
        <button
          type="button"
          class="set-row is-danger"
          @click="clearOpen = true"
        >
          <span class="set-art"><UiIcon name="trash" :size="17" /></span>
          <span class="set-body">
            <span class="set-name">清空数据</span>
            <span class="set-desc">删除本机全部名册、布局、项目与快照</span>
          </span>
          <span class="set-tail">不可恢复</span>
          <UiIcon class="set-arrow" name="chevronRight" :size="14" />
        </button>
      </div>

      <p v-if="pageNotice" class="page-notice">{{ pageNotice }}</p>
    </section>
  </div>

  <UiModal
    v-model="backupOpen"
    title="备份与恢复"
    description="备份文件为单个 JSON，包含全部本机数据。"
    icon="backup"
  >
    <div class="set-op">
      <button class="btn" :disabled="busy" @click="backupAll">
        <UiIcon name="export" :size="14" />导出全量备份
      </button>
    </div>
    <div class="set-op">
      <button class="btn" :disabled="busy" @click="importInput?.click()">
        <UiIcon name="import" :size="14" />从备份导入
      </button>
      <input
        ref="importInput"
        type="file"
        accept=".json"
        hidden
        @change="importBackup"
      />
    </div>
    <p
      v-if="backupNotice"
      class="set-note"
      :class="{ 'is-warn': backupNoticeWarn }"
    >
      {{ backupNotice }}
    </p>
    <template #footer>
      <button class="btn" @click="backupOpen = false">关闭</button>
    </template>
  </UiModal>

  <UiModal
    v-model="snapshotOpen"
    title="历史快照"
    description="只清空排座版本记录，名册、布局与项目不受影响。"
    icon="clock"
  >
    <div class="set-count">
      <b>{{ usage.snapshotCount }}</b>
      <span>条历史快照（全部项目）</span>
    </div>
    <p v-if="snapshotNotice" class="set-note">{{ snapshotNotice }}</p>
    <template #footer>
      <button class="btn" @click="snapshotOpen = false">关闭</button>
      <button
        class="btn danger"
        :disabled="busy || !usage.snapshotCount"
        @click="clearSnaps"
      >
        {{ busy ? "正在清空…" : "清空全部快照" }}
      </button>
    </template>
  </UiModal>

  <UiModal
    v-model="clearOpen"
    title="清空数据"
    description="删除本机全部数据，操作不可恢复。"
    icon="trash"
  >
    <div class="set-usage">
      <span>本机数据占用</span>
      <b>{{ fmtBytes(usage.totalBytes) }}</b>
    </div>
    <p class="set-note">
      将删除全部名册方案、会场布局、排座项目、历史快照与布局预设。
    </p>
    <template #footer>
      <button class="btn" :disabled="busy" @click="clearOpen = false">
        取消
      </button>
      <button class="btn danger" :disabled="busy" @click="clearAll">
        {{ busy ? "正在清空…" : "确认清空" }}
      </button>
    </template>
  </UiModal>

  <UiModal v-model="aboutOpen" title="关于" icon="info">
    <dl class="set-meta">
      <div>
        <dt>作者</dt>
        <dd>ifui</dd>
      </div>
      <div>
        <dt>邮箱</dt>
        <dd><a href="mailto:ifui@foxmail.com">ifui@foxmail.com</a></dd>
      </div>
      <div>
        <dt>版本</dt>
        <dd>{{ appVersion }}</dd>
      </div>
    </dl>
    <template #footer>
      <button class="btn" @click="aboutOpen = false">关闭</button>
    </template>
  </UiModal>
</template>

<style scoped>
.set-layout {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
  gap: 28px;
  align-items: stretch;
}

.set-label {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: 10px;
}

/* ---------- 左栏：身份与说明 ---------- */
.set-aside {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 20px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}
.set-id {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.set-mark {
  width: 54px;
  height: 54px;
  flex: none;
  color: var(--primary);
}
.set-id-text {
  min-width: 0;
}
.set-id-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}
.set-id-ver {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.set-copy {
  font-size: var(--fs-xs);
  line-height: 1.75;
  color: var(--text-secondary);
}
.set-notes {
  margin: 18px 0 0;
  padding: 14px 0 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border-soft);
}
.set-notes li {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: var(--fs-xs);
  line-height: 1.65;
  color: var(--text-muted);
}
.set-notes li :deep(.ico) {
  flex: none;
  margin-top: 3px;
  opacity: 0.9;
}

/* ---------- 右栏：操作列表 ---------- */
.set-main {
  min-width: 0;
}
.set-panel {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.set-panel.danger-zone {
  margin-top: 20px;
}
.set-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto 14px;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 16px 18px;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) ease;
}
.set-row + .set-row {
  border-top: 1px solid var(--border-soft);
}
.set-row:hover {
  background: var(--bg-subtle);
}
.set-row:hover .set-art {
  background: var(--bg-panel);
  border-color: var(--border-strong);
}
.set-row:hover .set-arrow {
  color: var(--text-secondary);
  transform: translateX(2px);
}
.set-art {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-soft);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  transition:
    background var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}
.set-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.set-name {
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}
.set-desc {
  font-size: var(--fs-xs);
  color: var(--text-muted);
  line-height: 1.5;
}
.set-tail {
  font-size: var(--fs-xs);
  color: var(--text-disabled);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.set-arrow {
  color: var(--text-disabled);
  transition:
    color var(--motion-fast) ease,
    transform var(--motion-fast) ease;
}

/* 危险操作独占权重：图标、悬停与箭头都用危险色，其余三项保持中性 */
.set-row.is-danger:hover {
  background: var(--danger-soft);
}
.set-row.is-danger:hover .set-art {
  background: var(--bg-panel);
  border-color: var(--danger-line);
  color: var(--danger);
}
.set-row.is-danger:hover .set-arrow {
  color: var(--danger);
}
.set-row.is-danger .set-art {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: var(--danger-line);
}
.set-row.is-danger .set-tail {
  color: var(--danger);
}

.page-notice {
  margin: 12px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

/* ---------- 弹框内容 ---------- */
.set-op {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}
.set-op + .set-op {
  padding-top: 14px;
  border-top: 1px solid var(--border-soft);
}
.set-op :deep(.btn) {
  width: 100%;
}
.set-note {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-muted);
}
.set-note.is-warn {
  color: var(--warning);
}

.set-count {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.set-count b {
  font-size: var(--fs-xl);
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.set-count span {
  font-size: var(--fs-xs);
  color: var(--text-muted);
}

.set-usage {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
.set-usage b {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.set-meta {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.set-meta > div {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 0;
  font-size: var(--fs-xs);
}
.set-meta > div + div {
  border-top: 1px solid var(--border-soft);
}
.set-meta dt {
  width: 40px;
  flex: none;
  color: var(--text-muted);
}
.set-meta dd {
  margin: 0;
  min-width: 0;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.set-meta a {
  color: var(--primary);
  text-decoration: none;
}
.set-meta a:hover {
  text-decoration: underline;
}

@media (max-width: 900px) {
  .set-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
}
@media (max-width: 520px) {
  .set-tail {
    display: none;
  }
}
@media (max-width: 420px) {
  .set-op {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .set-op :deep(.btn) {
    width: auto;
    justify-self: start;
  }
}
</style>
