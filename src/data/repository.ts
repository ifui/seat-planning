/**
 * 持久化仓储边界。
 *
 * 视图与 store 只通过本接口读写数据，不接触具体后端。
 * 当前实现是 IndexedDB（dexie）；迁移 Tauri v2 时新增一个 SQLite 实现即可，
 * 视图层不需要改动。
 */
import type { LayoutPackage, LayoutPreset, Project, RosterPlan, Snapshot } from '../types'

/** 实际可用的存储后端：indexeddb / file:// 下的 localStorage / 仅内存 */
export type StorageMode = 'indexeddb' | 'local' | 'memory'

/** 一次读取的全量业务数据 */
export interface Tables {
  rosters: RosterPlan[]
  layouts: LayoutPackage[]
  projects: Project[]
  snapshots: Snapshot[]
  presets: LayoutPreset[]
}

/** 备份导入结果：各表写入条数与告警 */
export interface ImportSummary {
  schemaVersion: string
  rosters: number
  layouts: number
  projects: number
  snapshots: number
  presets: number
  warnings: string[]
}

/** 设置中心需要的用量信息 */
export interface StorageUsage {
  /** 全部业务数据序列化后的总字节数 */
  totalBytes: number
  snapshotCount: number
}

/**
 * 仓储接口：覆盖全量读取、单条写入、删除、快照、备份导出/导入、清空。
 * 所有方法都以领域对象为参数，不暴露表名、事务或后端细节。
 */
export interface SeatRepository {
  /** 探测并打开存储，只执行一次；返回实际后端 */
  open(): Promise<StorageMode>
  /** 当前生效的后端（open 之后有效） */
  mode(): StorageMode

  loadAll(): Promise<Tables>

  saveRoster(roster: RosterPlan): Promise<void>
  saveLayout(layout: LayoutPackage): Promise<void>
  saveProject(project: Project): Promise<void>
  savePreset(preset: LayoutPreset): Promise<void>

  removeRoster(id: string): Promise<void>
  removeLayout(id: string): Promise<void>
  /** 删除项目时一并删除该项目的历史快照 */
  removeProject(id: string): Promise<void>
  removePreset(id: string): Promise<void>

  addSnapshot(snapshot: Snapshot): Promise<void>
  listSnapshots(projectId: string): Promise<Snapshot[]>
  getSnapshot(id: string): Promise<Snapshot | undefined>
  removeSnapshots(ids: string[]): Promise<void>
  clearSnapshots(): Promise<void>

  /** 清空全部业务数据（名册/布局/项目/快照/预设） */
  clearAll(): Promise<void>
  /** 导出全量备份 JSON */
  exportAll(): Promise<string>
  /** 导入备份 JSON：同 ID 覆盖、新 ID 追加 */
  importAll(json: string): Promise<ImportSummary>

  usage(): Promise<StorageUsage>
}
