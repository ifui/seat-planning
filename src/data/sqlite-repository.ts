/**
 * SeatRepository 的 SQLite 实现（Tauri v1 + rusqlite 内置命令）。
 *
 * v1 没有官方 SQL 插件，Rust 侧用 `db_execute` / `db_select` 复刻原插件的
 * execute/select 语义：SQL 字符串 + JSON 参数数组 + JSON 行结果，
 * 因此这里的写法和 v2 插件版几乎一致，接口边界不变。
 *
 * 表结构刻意保持「一行一条领域对象 + JSON 正文」：
 * 仓储接口本来就是整对象读写，这样两种后端语义完全一致，
 * 迁移或回退都不会产生数据格式差异。索引列只服务于按项目查快照等固定查询。
 * 任何初始化失败都会自动回退到 IndexedDB，不影响浏览器模式。
 */
import { invoke } from '@tauri-apps/api/tauri'
import type { LayoutPackage, LayoutPreset, Project, RosterPlan, Snapshot } from '../types'
import { isTauri } from '../platform/env'
import { IndexedDbRepository } from './indexeddb-repository'
import { bytesOf, exportJson, normalizeTables, parseBackup, plain } from './normalize'
import type { ImportSummary, SeatRepository, StorageMode, StorageUsage, Tables } from './repository'

const SCHEMA: string[] = [
  'CREATE TABLE IF NOT EXISTS rosters (id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)',
  'CREATE TABLE IF NOT EXISTS layouts (id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)',
  'CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)',
  'CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, createdAt TEXT, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT)',
  'CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(projectId)'
]

/** 执行写语句，返回受影响行数 */
function exec(sql: string, params: unknown[] = []): Promise<number> {
  return invoke<number>('db_execute', { sql, params })
}

/** 执行查询，返回按列名组织的行对象 */
function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return invoke<T[]>('db_select', { sql, params })
}

export class SqliteRepository implements SeatRepository {
  /** 回退实现：浏览器环境或 SQLite 初始化失败时使用 */
  private fallback = new IndexedDbRepository()
  private ready = false
  private probed = false

  async open(): Promise<StorageMode> {
    if (this.probed) return this.mode()
    this.probed = true
    if (!isTauri()) {
      return this.fallback.open()
    }
    try {
      for (const sql of SCHEMA) await exec(sql)
      this.ready = true
      return 'sqlite'
    } catch {
      this.ready = false
      return this.fallback.open()
    }
  }

  mode(): StorageMode {
    return this.ready ? 'sqlite' : this.fallback.mode()
  }

  private async selectAll<T>(table: string): Promise<T[]> {
    const rows = await query<{ data: string }>(`SELECT data FROM ${table}`)
    return rows.map((r) => JSON.parse(r.data) as T)
  }

  private async put(
    table: string,
    id: string,
    body: string,
    extra?: Record<string, string | undefined>
  ): Promise<void> {
    const cols = ['id', 'data', ...(extra ? Object.keys(extra) : [])]
    const values = [id, body, ...(extra ? Object.values(extra) : [])]
    const marks = cols.map(() => '?').join(', ')
    await exec(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${marks})`, values)
  }

  async loadAll(): Promise<Tables> {
    if (!this.ready) return this.fallback.loadAll()
    const [rosters, layouts, projects, snapshots, presets] = await Promise.all([
      this.selectAll<RosterPlan>('rosters'),
      this.selectAll<LayoutPackage>('layouts'),
      this.selectAll<Project>('projects'),
      this.selectAll<Snapshot>('snapshots'),
      this.selectAll<LayoutPreset>('presets')
    ])
    return normalizeTables({ rosters, layouts, projects, snapshots, presets })
  }

  async saveRoster(r: RosterPlan): Promise<void> {
    if (!this.ready) return this.fallback.saveRoster(r)
    await this.put('rosters', r.id, JSON.stringify(plain(r)), { updatedAt: r.updatedAt })
  }

  async saveLayout(l: LayoutPackage): Promise<void> {
    if (!this.ready) return this.fallback.saveLayout(l)
    await this.put('layouts', l.id, JSON.stringify(plain(l)), { updatedAt: l.updatedAt })
  }

  async saveProject(p: Project): Promise<void> {
    if (!this.ready) return this.fallback.saveProject(p)
    await this.put('projects', p.id, JSON.stringify(plain(p)), { updatedAt: p.updatedAt })
  }

  async savePreset(p: LayoutPreset): Promise<void> {
    if (!this.ready) return this.fallback.savePreset(p)
    await this.put('presets', p.id, JSON.stringify(plain(p)), { updatedAt: p.updatedAt })
  }

  async removeRoster(id: string): Promise<void> {
    if (!this.ready) return this.fallback.removeRoster(id)
    await exec('DELETE FROM rosters WHERE id = ?', [id])
  }

  async removeLayout(id: string): Promise<void> {
    if (!this.ready) return this.fallback.removeLayout(id)
    await exec('DELETE FROM layouts WHERE id = ?', [id])
  }

  async removeProject(id: string): Promise<void> {
    if (!this.ready) return this.fallback.removeProject(id)
    await exec('DELETE FROM projects WHERE id = ?', [id])
    await exec('DELETE FROM snapshots WHERE projectId = ?', [id])
  }

  async removePreset(id: string): Promise<void> {
    if (!this.ready) return this.fallback.removePreset(id)
    await exec('DELETE FROM presets WHERE id = ?', [id])
  }

  async addSnapshot(s: Snapshot): Promise<void> {
    if (!this.ready) return this.fallback.addSnapshot(s)
    await this.put('snapshots', s.id, JSON.stringify(plain(s)), {
      projectId: s.projectId,
      createdAt: s.createdAt
    })
  }

  async listSnapshots(projectId: string): Promise<Snapshot[]> {
    if (!this.ready) return this.fallback.listSnapshots(projectId)
    const rows = await query<{ data: string }>('SELECT data FROM snapshots WHERE projectId = ?', [projectId])
    return rows.map((r) => JSON.parse(r.data) as Snapshot)
  }

  async getSnapshot(id: string): Promise<Snapshot | undefined> {
    if (!this.ready) return this.fallback.getSnapshot(id)
    const rows = await query<{ data: string }>('SELECT data FROM snapshots WHERE id = ?', [id])
    return rows.length ? (JSON.parse(rows[0].data) as Snapshot) : undefined
  }

  async removeSnapshots(ids: string[]): Promise<void> {
    if (!this.ready) return this.fallback.removeSnapshots(ids)
    // SQLite 单条语句参数上限 999，按 500 一批删除
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const marks = chunk.map(() => '?').join(', ')
      await exec(`DELETE FROM snapshots WHERE id IN (${marks})`, chunk)
    }
  }

  async clearSnapshots(): Promise<void> {
    if (!this.ready) return this.fallback.clearSnapshots()
    await exec('DELETE FROM snapshots')
  }

  async clearAll(): Promise<void> {
    if (!this.ready) return this.fallback.clearAll()
    for (const table of ['rosters', 'layouts', 'projects', 'snapshots', 'presets']) {
      await exec(`DELETE FROM ${table}`)
    }
  }

  async exportAll(): Promise<string> {
    if (!this.ready) return this.fallback.exportAll()
    return exportJson(await this.loadAll())
  }

  async importAll(json: string): Promise<ImportSummary> {
    if (!this.ready) return this.fallback.importAll(json)
    const { tables, summary } = parseBackup(json)
    for (const r of tables.rosters) await this.saveRoster(r)
    for (const l of tables.layouts) await this.saveLayout(l)
    for (const p of tables.projects) await this.saveProject(p)
    for (const s of tables.snapshots) await this.addSnapshot(s)
    for (const p of tables.presets) await this.savePreset(p)
    return summary
  }

  async usage(): Promise<StorageUsage> {
    if (!this.ready) return this.fallback.usage()
    const t = await this.loadAll()
    return {
      totalBytes:
        bytesOf(t.rosters) + bytesOf(t.layouts) + bytesOf(t.projects) + bytesOf(t.snapshots) + bytesOf(t.presets),
      snapshotCount: t.snapshots.length
    }
  }
}
