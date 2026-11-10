<script setup lang="ts">
/**
 * 设置中心：以数据库管理视角查看本机数据，并提供备份 / 恢复 / 清空。
 * 独立页面，与名册、布局、排座同级。
 */
import { computed, onMounted, ref } from 'vue'
import { clearAllData, exportAllData, importAllData, loadTables } from '../db'
import { clearAllSnapshots, loadAll, state } from '../store'
import { UiIcon } from '../ui'

type TableRow = { key: string; label: string; count: number; bytes: number; note: string }

const stats = ref<TableRow[]>([])
const busy = ref(false)
const notice = ref('')
const noticeKind = ref<'ok' | 'warn'>('ok')
const importInput = ref<HTMLInputElement | null>(null)
const confirmOpen = ref(false)
const snapConfirmOpen = ref(false)
const loading = ref(true)

const storageLabel = computed(() =>
  state.storage === 'indexeddb' ? 'IndexedDB' : state.storage === 'local' ? '本地存储' : '仅内存'
)
const totalBytes = computed(() => stats.value.reduce((sum, s) => sum + s.bytes, 0))
const totalRecords = computed(() => stats.value.reduce((sum, s) => sum + s.count, 0))
const maxBytes = computed(() => Math.max(1, ...stats.value.map((s) => s.bytes)))
/** 历史快照：用于单独清理，不影响其它实体数据 */
const snapRow = computed(() => stats.value.find((s) => s.key === 'snapshots'))

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function pct(n: number): number {
  return Math.max(2, Math.round((n / maxBytes.value) * 100))
}

async function refreshStats(): Promise<void> {
  const t = await loadTables()
  const bytes = (v: unknown[]): number => (v.length ? new TextEncoder().encode(JSON.stringify(v)).length : 0)
  stats.value = [
    { key: 'rosters', label: '名册方案', count: t.rosters.length, bytes: bytes(t.rosters), note: '人员、职级、单位' },
    { key: 'layouts', label: '会场布局', count: t.layouts.length, bytes: bytes(t.layouts), note: '表格、座位、区域' },
    { key: 'projects', label: '排座项目', count: t.projects.length, bytes: bytes(t.projects), note: '排座结果与规则' },
    { key: 'snapshots', label: '历史快照', count: t.snapshots.length, bytes: bytes(t.snapshots), note: '排座版本记录' },
    { key: 'presets', label: '布局预设', count: t.presets.length, bytes: bytes(t.presets), note: '快速套用模板' }
  ]
  loading.value = false
}

onMounted(refreshStats)

function say(msg: string, kind: 'ok' | 'warn' = 'ok'): void {
  notice.value = msg
  noticeKind.value = kind
}

function download(name: string, body: string, type: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([body], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function backupAll(): Promise<void> {
  try {
    const json = await exportAllData()
    download(`seat-planning-backup-${new Date().toISOString().slice(0, 10)}.json`, json, 'application/json')
    say('已导出全量备份，请妥善保存该文件。')
  } catch {
    say('当前浏览器不支持本机数据库，备份不可用。', 'warn')
  }
}

async function importBackup(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  try {
    const summary = await importAllData(await file.text())
    await loadAll(false)
    await refreshStats()
    const total = summary.rosters + summary.layouts + summary.projects + summary.presets
    say(`已导入 ${total} 条数据${summary.warnings.length ? `（${summary.warnings.join('；')}）` : ''}。`)
  } catch (err) {
    say(err instanceof Error ? err.message : '导入失败，请检查备份文件。', 'warn')
  } finally {
    busy.value = false
  }
}

/** 只清历史快照：名册、布局、项目、预设原样保留 */
async function clearSnaps(): Promise<void> {
  const row = snapRow.value
  if (!row || !row.count) return
  busy.value = true
  try {
    await clearAllSnapshots()
    await loadAll(false)
    await refreshStats()
    snapConfirmOpen.value = false
    say(`已清空 ${row.count} 条历史快照，释放约 ${fmtBytes(row.bytes)}；名册、布局与项目数据未受影响。`, 'warn')
  } finally {
    busy.value = false
  }
}

async function clearAll(): Promise<void> {
  busy.value = true
  try {
    await clearAllData()
    await loadAll(false)
    await refreshStats()
    confirmOpen.value = false
    say('已清空全部本机数据，可导入备份恢复。', 'warn')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <header class="page-head">
    <div class="page-head-main">
      <div class="page-eyebrow">系统</div>
      <h1 class="page-title">设置中心</h1>
      <p class="page-desc">本机数据的存储概况、备份恢复与清理。所有数据只保存在当前浏览器，不上传服务器。</p>
    </div>
  </header>

  <div class="settings-page">
    <section class="card settings-db">
      <div class="db-head">
        <div>
          <h2 class="settings-h2">数据库概况</h2>
          <p class="settings-sub">按数据表统计记录数与占用空间，合计 {{ totalRecords }} 条记录。</p>
        </div>
        <div class="db-total">
          <span>总占用</span>
          <strong>{{ fmtBytes(totalBytes) }}</strong>
        </div>
      </div>

      <div class="db-store">
        <span class="db-store-k">存储位置</span>
        <b>{{ storageLabel }}</b>
        <span class="db-store-sep" aria-hidden="true" />
        <span class="db-store-k">持久化</span>
        <b>{{ state.persistent ? '关闭浏览器后保留' : '仅本次会话有效' }}</b>
      </div>

      <div v-if="loading" class="caption" style="margin-top: 12px">正在读取本机数据…</div>
      <div v-else class="db-table">
        <div class="db-thead">
          <span>数据表</span>
          <span>说明</span>
          <span>记录数</span>
          <span>占用</span>
          <span class="db-bar-col">占比</span>
        </div>
        <div v-for="s in stats" :key="s.key" class="db-trow">
          <span class="db-name">{{ s.label }}</span>
          <span class="db-note">{{ s.note }}</span>
          <span class="db-num">{{ s.count }} 条</span>
          <span class="db-num">{{ fmtBytes(s.bytes) }}</span>
          <span class="db-bar-col"><i class="db-bar" :style="{ width: pct(s.bytes) + '%' }" /></span>
        </div>
      </div>
    </section>

    <div class="settings-side">
      <section class="card settings-block">
        <h2 class="settings-h2">备份与恢复</h2>
        <p class="settings-sub">导出包含全部名册、布局、项目与快照的 JSON 文件；导入会覆盖同 ID 的数据。</p>
        <div class="settings-actions">
          <button class="btn" :disabled="busy" @click="backupAll">
            <UiIcon name="backup" :size="14" />导出全量备份
          </button>
          <button class="btn" :disabled="busy" @click="importInput?.click()">
            <UiIcon name="restore" :size="14" />导入备份
          </button>
          <input ref="importInput" type="file" accept=".json" hidden @change="importBackup" />
        </div>
      </section>

      <section class="card settings-block">
        <h2 class="settings-h2">历史快照</h2>
        <p class="settings-sub">
          每次重新排座前会自动保留一份快照，用于恢复到旧版本。当前共
          <b>{{ snapRow?.count ?? 0 }}</b> 条，占用 <b>{{ fmtBytes(snapRow?.bytes ?? 0) }}</b>。
          清理只删除快照，不动名册、布局与项目。
        </p>
        <button
          class="btn"
          :disabled="busy || !(snapRow?.count)"
          @click="snapConfirmOpen = true"
        >一键清空历史快照</button>
      </section>

      <section class="card settings-block is-danger">
        <h2 class="settings-h2">清空数据</h2>
        <p class="settings-sub">
          将删除本机的名册方案、会场布局、排座项目、历史快照与布局预设，并清空排座规则等界面偏好。
          <b>操作不可恢复</b>，建议先导出全量备份。
        </p>
        <button class="btn danger" :disabled="busy" @click="confirmOpen = true">清空全部数据</button>
      </section>

      <p v-if="notice" class="settings-notice" :class="{ 'is-warn': noticeKind === 'warn' }">{{ notice }}</p>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="snapConfirmOpen" class="settings-confirm-mask" @click.self="snapConfirmOpen = false">
      <div class="settings-confirm" role="dialog" aria-modal="true" aria-labelledby="snap-title">
        <h3 id="snap-title">确认清空全部历史快照？</h3>
        <ul>
          <li>将删除 <b>{{ snapRow?.count ?? 0 }}</b> 条历史快照，可释放约 <b>{{ fmtBytes(snapRow?.bytes ?? 0) }}</b> 空间。</li>
          <li>只清空排座版本记录，名册方案、会场布局、排座项目与布局预设均不受影响。</li>
          <li>清空后无法再恢复到这些旧版本，<b>操作不可撤销</b>。</li>
        </ul>
        <div class="settings-confirm-actions">
          <button class="btn" :disabled="busy" @click="snapConfirmOpen = false">取消</button>
          <button class="btn danger" :disabled="busy" @click="clearSnaps">{{ busy ? '正在清空…' : '确认清空' }}</button>
        </div>
      </div>
    </div>

    <div v-if="confirmOpen" class="settings-confirm-mask" @click.self="confirmOpen = false">
      <div class="settings-confirm" role="dialog" aria-modal="true" aria-labelledby="clear-title">
        <h3 id="clear-title">确认清空全部本机数据？</h3>
        <ul>
          <li>将删除：名册方案 {{ stats.find((s) => s.key === 'rosters')?.count ?? 0 }} 个、会场布局 {{ stats.find((s) => s.key === 'layouts')?.count ?? 0 }} 个、排座项目 {{ stats.find((s) => s.key === 'projects')?.count ?? 0 }} 个、历史快照 {{ stats.find((s) => s.key === 'snapshots')?.count ?? 0 }} 个、布局预设 {{ stats.find((s) => s.key === 'presets')?.count ?? 0 }} 个。</li>
          <li>排座规则、显示开关等本机偏好也会一并重置。</li>
          <li>清空后<b>无法撤销</b>，只能通过此前导出的备份文件恢复。</li>
        </ul>
        <p class="settings-confirm-tip">建议先点「导出全量备份」，确认文件已保存后再清空。</p>
        <div class="settings-confirm-actions">
          <button class="btn" :disabled="busy" @click="confirmOpen = false">取消</button>
          <button class="btn" :disabled="busy" @click="backupAll">先导出备份</button>
          <button class="btn danger" :disabled="busy" @click="clearAll">{{ busy ? '正在清空…' : '确认清空' }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.settings-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 14px;
  align-items: start;
  padding-bottom: 24px;
}
.settings-h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.settings-sub { margin: 4px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--text-muted); }
.settings-db { padding: 16px 18px; }
.db-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.db-total { text-align: right; flex: none; }
.db-total span { display: block; font-size: 10.5px; color: var(--text-disabled); }
.db-total strong { font-size: 22px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.db-store {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
  margin-top: 10px; padding: 7px 10px; border-radius: 6px;
  background: var(--bg-subtle); font-size: 11.5px; color: var(--text-secondary);
}
.db-store-k { color: var(--text-disabled); }
.db-store-sep { width: 1px; height: 12px; background: var(--border); margin: 0 6px; }
.db-table { margin-top: 12px; border: 1px solid var(--border-soft); border-radius: 6px; overflow: hidden; }
.db-thead, .db-trow {
  display: grid; grid-template-columns: 92px minmax(0, 1fr) 64px 70px 90px;
  align-items: center; gap: 10px; padding: 7px 12px;
}
.db-thead { font-size: 10.5px; color: var(--text-disabled); background: var(--bg-subtle); border-bottom: 1px solid var(--border-soft); }
.db-trow { font-size: 12px; color: var(--text-secondary); border-bottom: 1px solid var(--border-soft); }
.db-trow:last-child { border-bottom: none; }
.db-name { color: var(--text-primary); font-weight: 500; }
.db-note { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; color: var(--text-disabled); }
.db-num { text-align: right; font-variant-numeric: tabular-nums; }
.db-bar-col { display: flex; justify-content: flex-end; }
.db-bar { display: block; height: 5px; border-radius: 3px; background: var(--primary); opacity: .55; }
.settings-side { display: flex; flex-direction: column; gap: 14px; }
.settings-block { padding: 16px 18px; }
.settings-block.is-danger { border-color: color-mix(in srgb, var(--danger) 24%, var(--border-soft)); }
.settings-block .settings-actions { margin-top: 12px; }
.settings-block.is-danger .btn.danger { margin-top: 12px; width: 100%; justify-content: center; }
.settings-notice { margin: 0; font-size: 11.5px; color: var(--text-muted); }
.settings-notice.is-warn { color: var(--warning); }
.settings-confirm-mask {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(15, 23, 42, .32);
  display: flex; align-items: center; justify-content: center;
}
.settings-confirm {
  width: min(440px, calc(100vw - 32px)); padding: 20px 22px;
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 24px 60px rgba(15, 23, 42, .18);
}
.settings-confirm h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }
.settings-confirm ul { margin: 10px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--text-secondary); }
.settings-confirm-tip { margin: 10px 0 0; font-size: 11.5px; color: var(--warning); }
.settings-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
@media (max-width: 1100px) {
  .settings-page { grid-template-columns: minmax(0, 1fr); }
}
</style>
