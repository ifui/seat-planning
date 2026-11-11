/**
 * SeatRepository 的 IndexedDB 实现（Dexie）。
 * file:// 下 IndexedDB 不可用时依次降级到 localStorage / 纯内存。
 * 这里保留全部旧库的归一化与备份格式逻辑，视图层不再感知。
 */
import Dexie, { type Table } from 'dexie'
import type { Assignment, LayoutPackage, LayoutPreset, Member, Project, RosterPlan, Snapshot } from '../types'
import { nowISO } from '../engine/sheet'
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
const SUPPORTED_SCHEMA = ['2.0', '2.1', '2.2']

const emptyTables = (): Tables => ({ rosters: [], layouts: [], projects: [], snapshots: [], presets: [] })
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** 兼容旧数据：成员 active:boolean 迁移为 status（在位 / 请假） */
function normalizeRoster(r: RosterPlan): RosterPlan {
  const members = (r.members ?? []).map((raw) => {
    const m = raw as Member & { active?: boolean }
    const status: Member['status'] =
      m.status === 'leave' || m.status === 'present' ? m.status : m.active === false ? 'leave' : 'present'
    const { active, ...rest } = m
    return { ...rest, status } as Member
  })
  // 名册顺序以 member.order 为准：旧数据没有 order 时沿用数组位置，
  // 随后统一重编为 0..n-1，保证刷新、快照与排座读取到的是同一个顺序
  const ordered = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (a.m.order ?? a.i) - (b.m.order ?? b.i) || a.i - b.i)
    .map((x, i) => (x.m.order === i ? x.m : { ...x.m, order: i }))
  return { ...r, members: ordered }
}

function normalizeTables(t: Tables): Tables {
  const rosters = (t.rosters ?? []).map(normalizeRoster)
  // 仅迁移旧版本的「缺席 / 来宾」；在位与请假原样保留
  const fixStatus = (a: Assignment): Assignment => {
    const s = (a as { status?: string }).status
    return s === 'present' || s === 'leave' ? a : { ...a, status: 'present' }
  }
  const normalizeProject = (p: Project): Project => {
    // 旧项目没有快照：以当前名册补一份，之后就与名册解耦
    const live = rosters.find((r) => r.id === p.rosterPlanId)
    const snapshot = p.rosterSnapshot
      ? normalizeRoster(p.rosterSnapshot)
      : live
        ? normalizeRoster(JSON.parse(JSON.stringify(live)))
        : undefined
    return {
      ...p,
      rosterSnapshot: snapshot,
      // 名册变动不再联动项目，已排好的分配保持不变
      assignments: (p.assignments ?? []).map(fixStatus)
    }
  }
  return {
    ...t,
    rosters,
    projects: (t.projects ?? []).map(normalizeProject),
    snapshots: (t.snapshots ?? []).map((s) => ({ ...s, assignments: (s.assignments ?? []).map(fixStatus) }))
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.push(item)
}

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
    const t = await this.loadAll()
    return JSON.stringify(
      {
        schemaVersion: '2.2',
        exportedAt: nowISO(),
        rosters: t.rosters,
        layouts: t.layouts,
        projects: t.projects,
        snapshots: t.snapshots,
        presets: t.presets
      },
      null,
      2
    )
  }

  /** 整包导入：先校验版本与结构，再合并写入；返回各表写入数量与告警 */
  async importAll(json: string): Promise<ImportSummary> {
    let data: any
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error('文件不是有效的 JSON')
    }
    if (!data || typeof data !== 'object') throw new Error('备份文件内容为空')
    const ver = String(data.schemaVersion ?? '')
    if (!ver) throw new Error('备份文件缺少 schemaVersion 版本号')
    if (!SUPPORTED_SCHEMA.includes(ver)) {
      const major = ver.split('.')[0]
      throw new Error(
        major === '2' ? `不支持的备份版本 ${ver}，当前仅支持 ${SUPPORTED_SCHEMA.join(' / ')}` : `备份版本 ${ver} 与当前应用不兼容`
      )
    }

    const warnings: string[] = []
    const pick = <T extends { id?: unknown }>(key: string): T[] => {
      const v = data[key]
      if (v === undefined) return []
      if (!Array.isArray(v)) {
        warnings.push(`字段 ${key} 格式异常，已跳过`)
        return []
      }
      const valid = v.filter((x: any) => x && typeof x === 'object' && typeof x.id === 'string')
      if (valid.length !== v.length) warnings.push(`${key} 中有 ${v.length - valid.length} 条记录缺少 id，已跳过`)
      return valid as T[]
    }

    const { rosters, layouts, projects, snapshots, presets } = normalizeTables({
      rosters: pick<RosterPlan>('rosters'),
      layouts: pick<LayoutPackage>('layouts'),
      projects: pick<Project>('projects'),
      snapshots: pick<Snapshot>('snapshots'),
      presets: pick<LayoutPreset>('presets')
    })
    if (!rosters.length && !layouts.length && !projects.length && !presets.length) {
      throw new Error('备份文件中没有可导入的数据')
    }

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

    return {
      schemaVersion: ver,
      rosters: rosters.length,
      layouts: layouts.length,
      projects: projects.length,
      snapshots: snapshots.length,
      presets: presets.length,
      warnings
    }
  }

  async usage(): Promise<StorageUsage> {
    const t = await this.loadAll()
    const bytes = (v: unknown[]): number => (v.length ? new TextEncoder().encode(JSON.stringify(v)).length : 0)
    return {
      totalBytes:
        bytes(t.rosters) + bytes(t.layouts) + bytes(t.projects) + bytes(t.snapshots) + bytes(t.presets),
      snapshotCount: t.snapshots.length
    }
  }
}
