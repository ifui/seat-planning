/**
 * SeatRepository 的 IndexedDB 实现（Dexie）。
 * file:// 下 IndexedDB 不可用时依次降级到 localStorage / 纯内存。
 * 这里保留全部旧库的归一化与备份格式逻辑，视图层不再感知。
 */
import Dexie, { type Table } from 'dexie'
import type { LayoutPackage, LayoutPreset, Project, RosterPlan, Snapshot } from '../types'
import { bytesOf, emptyTables, exportJson, normalizeTables, parseBackup, plain, upsert } from './normalize'
import type { ImportSummary, SeatRepository, StorageMode, StorageUsage, Tables } from './repository'

class SeatDB extends Dexie {
  rosters!: Table<RosterPlan, string>
  layouts!: Table<LayoutPackage, string>
  projects!: Table<Project, string>
  snapshots!: Table<Snapshot, string>
  presets!: Table<LayoutPreset, string>
  settings!: Table<{ key: string; value: unknown }, string>

  constructor() {
    // v2：表格化模型，全新库，不读取旧的自由布局数据
    super('seat-planning-v2')
    this.version(1).stores({
      rosters: 'id, name, updatedAt',
      layouts: 'id, name, updatedAt',
      projects: 'id, name, updatedAt',
      snapshots: 'id, projectId, createdAt',
      settings: 'key'
    })
    // v2.1：新增布局预设表（老库自动升级，其余表保持不动）
    this.version(2).stores({
      presets: 'id, name, updatedAt'
    })
  }
}

const LOCAL_KEY = 'seat-planning:v2'

export class IndexedDbRepository implements SeatRepository {
  private db = new SeatDB()
  private current: StorageMode = 'indexeddb'
  private probed: StorageMode | null = null
  private cache: Tables | null = null

  /**
   * 探测可用存储：IndexedDB → localStorage → 纯内存。
   * file:// 下 Chrome/Edge 可能禁用 IndexedDB。
   */
  async open(): Promise<StorageMode> {
    if (this.probed) {
      this.current = this.probed
      return this.current
    }
    try {
      await this.db.open()
      await this.db.rosters.count()
      this.probed = 'indexeddb'
    } catch {
      try {
        const k = '__seat_planning_probe__'
        localStorage.setItem(k, '1')
        localStorage.removeItem(k)
        this.probed = 'local'
      } catch {
        this.probed = 'memory'
      }
    }
    this.current = this.probed
    return this.current
  }

  mode(): StorageMode {
    return this.current
  }

  private localTables(): Tables {
    if (this.cache) return this.cache
    let next: Tables
    try {
      const raw = localStorage.getItem(LOCAL_KEY)
      next = raw ? { ...emptyTables(), ...JSON.parse(raw) } : emptyTables()
    } catch {
      next = emptyTables()
    }
    this.cache = next
    return next
  }

  private localFlush(): void {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.localTables()))
    } catch {
      /* 容量或权限受限：内存仍可用，但本次不落盘 */
      this.current = 'memory'
    }
  }

  async loadAll(): Promise<Tables> {
    if (this.current === 'indexeddb') {
      const [rosters, layouts, projects, snapshots, presets] = await Promise.all([
        this.db.rosters.toArray(),
        this.db.layouts.toArray(),
        this.db.projects.toArray(),
        this.db.snapshots.toArray(),
        this.db.presets.toArray()
      ])
      return normalizeTables({ rosters, layouts, projects, snapshots, presets })
    }
    const c = this.localTables()
    return normalizeTables({
      rosters: [...c.rosters],
      layouts: [...c.layouts],
      projects: [...c.projects],
      snapshots: [...c.snapshots],
      presets: [...c.presets]
    })
  }

  async saveRoster(r: RosterPlan): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.rosters.put(plain(r))
      return
    }
    upsert(this.localTables().rosters, plain(r))
    this.localFlush()
  }

  async saveLayout(l: LayoutPackage): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.layouts.put(plain(l))
      return
    }
    upsert(this.localTables().layouts, plain(l))
    this.localFlush()
  }

  async saveProject(p: Project): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.projects.put(plain(p))
      return
    }
    upsert(this.localTables().projects, plain(p))
    this.localFlush()
  }

  async savePreset(p: LayoutPreset): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.presets.put(plain(p))
      return
    }
    upsert(this.localTables().presets, plain(p))
    this.localFlush()
  }

  async removeRoster(id: string): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.rosters.delete(id)
      return
    }
    this.localTables().rosters = this.localTables().rosters.filter((x) => x.id !== id)
    this.localFlush()
  }

  async removeLayout(id: string): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.layouts.delete(id)
      return
    }
    this.localTables().layouts = this.localTables().layouts.filter((x) => x.id !== id)
    this.localFlush()
  }

  async removeProject(id: string): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.projects.delete(id)
      await this.db.snapshots.where('projectId').equals(id).delete()
      return
    }
    const c = this.localTables()
    c.projects = c.projects.filter((x) => x.id !== id)
    c.snapshots = c.snapshots.filter((x) => x.projectId !== id)
    this.localFlush()
  }

  async removePreset(id: string): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.presets.delete(id)
      return
    }
    this.localTables().presets = this.localTables().presets.filter((x) => x.id !== id)
    this.localFlush()
  }

  async addSnapshot(s: Snapshot): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.snapshots.put(plain(s))
      return
    }
    upsert(this.localTables().snapshots, plain(s))
    this.localFlush()
  }

  async listSnapshots(projectId: string): Promise<Snapshot[]> {
    if (this.current === 'indexeddb') {
      return this.db.snapshots.where('projectId').equals(projectId).toArray()
    }
    return this.localTables().snapshots.filter((s) => s.projectId === projectId)
  }

  async getSnapshot(id: string): Promise<Snapshot | undefined> {
    if (this.current === 'indexeddb') return this.db.snapshots.get(id)
    return this.localTables().snapshots.find((s) => s.id === id)
  }

  /** 批量删除历史快照：只动快照，不影响名册/布局/项目 */
  async removeSnapshots(ids: string[]): Promise<void> {
    if (!ids.length) return
    if (this.current === 'indexeddb') {
      await this.db.snapshots.bulkDelete(ids)
      return
    }
    const c = this.localTables()
    const set = new Set(ids)
    c.snapshots = c.snapshots.filter((s) => !set.has(s.id))
    this.localFlush()
  }

  /** 一键清空全部历史快照（实体数据保持不变） */
  async clearSnapshots(): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.snapshots.clear()
      return
    }
    this.localTables().snapshots = []
    this.localFlush()
  }

  /** 清空全部业务数据（名册/布局/项目/快照/预设），用于设置中心的重置操作 */
  async clearAll(): Promise<void> {
    if (this.current === 'indexeddb') {
      await this.db.transaction('rw', [this.db.rosters, this.db.layouts, this.db.projects, this.db.snapshots, this.db.presets], async () => {
        await Promise.all([
          this.db.rosters.clear(),
          this.db.layouts.clear(),
          this.db.projects.clear(),
          this.db.snapshots.clear(),
          this.db.presets.clear()
        ])
      })
      return
    }
    this.cache = emptyTables()
    try {
      localStorage.removeItem(LOCAL_KEY)
    } catch {
      /* 权限受限：内存已清空 */
    }
  }

  async exportAll(): Promise<string> {
    return exportJson(await this.loadAll())
  }

  /** 整包导入：先校验版本与结构，再合并写入；返回各表写入数量与告警 */
  async importAll(json: string): Promise<ImportSummary> {
    const { tables, summary } = parseBackup(json)
    const { rosters, layouts, projects, snapshots, presets } = tables

    if (this.current === 'indexeddb') {
      await this.db.transaction('rw', this.db.rosters, this.db.layouts, this.db.projects, this.db.snapshots, this.db.presets, async () => {
        if (rosters.length) await this.db.rosters.bulkPut(plain(rosters))
        if (layouts.length) await this.db.layouts.bulkPut(plain(layouts))
        if (projects.length) await this.db.projects.bulkPut(plain(projects))
        if (snapshots.length) await this.db.snapshots.bulkPut(plain(snapshots))
        if (presets.length) await this.db.presets.bulkPut(plain(presets))
      })
    } else {
      const t = await this.loadAll()
      if (rosters.length) for (const x of rosters) upsert(t.rosters, x)
      if (layouts.length) for (const x of layouts) upsert(t.layouts, x)
      if (projects.length) for (const x of projects) upsert(t.projects, x)
      if (snapshots.length) for (const x of snapshots) upsert(t.snapshots, x)
      if (presets.length) for (const x of presets) upsert(t.presets, x)
      this.cache = t
      this.localFlush()
    }

    return summary
  }

  async usage(): Promise<StorageUsage> {
    const t = await this.loadAll()
    return {
      totalBytes:
        bytesOf(t.rosters) + bytesOf(t.layouts) + bytesOf(t.projects) + bytesOf(t.snapshots) + bytesOf(t.presets),
      snapshotCount: t.snapshots.length
    }
  }
}
