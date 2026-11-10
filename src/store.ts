import { reactive } from 'vue'
import type { LayoutPackage, LayoutPreset, Project, RosterPlan, Snapshot } from './types'
import {
  addSnapshot,
  buildSeed,
  clearSnapshots as dbClearSnapshots,
  deleteLayout as dbDeleteLayout,
  deletePreset as dbDeletePreset,
  deleteProject as dbDeleteProject,
  deleteRoster as dbDeleteRoster,
  deleteSnapshots as dbDeleteSnapshots,
  getSnapshotById,
  listSnapshots as dbListSnapshots,
  loadTables,
  openStorage,
  putLayout,
  putPreset,
  putProject,
  putRoster,
  type StorageMode
} from './db'

export const state = reactive({
  ready: false,
  /** 存储模式：indexeddb / local（file:// 下的 localStorage）/ memory（仅当次有效） */
  storage: 'indexeddb' as StorageMode,
  persistent: true,
  rosters: [] as RosterPlan[],
  layouts: [] as LayoutPackage[],
  projects: [] as Project[],
  presets: [] as LayoutPreset[]
})

function sortAll(): void {
  state.rosters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.layouts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.presets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 读取全部数据；seedIfEmpty=false 用于「清空数据」后保持空库，不重新灌示例 */
export async function loadAll(seedIfEmpty = true): Promise<void> {
  state.storage = await openStorage()
  state.persistent = state.storage !== 'memory'
  let t = await loadTables()
  if (!t.rosters.length && seedIfEmpty) {
    const { roster, layout, project } = buildSeed()
    await putRoster(roster)
    await putLayout(layout)
    await putProject(project)
    t = { rosters: [roster], layouts: [layout], projects: [project], snapshots: [], presets: [] }
  }
  state.rosters = t.rosters
  state.layouts = t.layouts
  state.projects = t.projects
  state.presets = t.presets
  sortAll()
  state.ready = true
}

export async function saveRoster(r: RosterPlan): Promise<void> {
  r.updatedAt = new Date().toISOString()
  await putRoster(r)
  await loadAll()
}

export async function saveLayout(l: LayoutPackage): Promise<void> {
  l.updatedAt = new Date().toISOString()
  await putLayout(l)
  await loadAll()
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = new Date().toISOString()
  await putProject(p)
  await loadAll()
}

export async function removeProject(id: string): Promise<void> {
  await dbDeleteProject(id)
  await loadAll()
}

export async function removeLayout(id: string): Promise<void> {
  await dbDeleteLayout(id)
  await loadAll()
}

export async function removeRoster(id: string): Promise<void> {
  await dbDeleteRoster(id)
  await loadAll()
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  await addSnapshot(s)
}

export async function savePreset(p: LayoutPreset): Promise<void> {
  p.updatedAt = new Date().toISOString()
  await putPreset(p)
  await loadAll()
}

export async function removePreset(id: string): Promise<void> {
  await dbDeletePreset(id)
  await loadAll()
}

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  return dbListSnapshots(projectId)
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return getSnapshotById(id)
}

/** 批量删除历史快照 */
export async function removeSnapshots(ids: string[]): Promise<void> {
  await dbDeleteSnapshots(ids)
}

/** 一键清空历史快照（名册/布局/项目不受影响） */
export async function clearAllSnapshots(): Promise<void> {
  await dbClearSnapshots()
}

export function rosterOf(p: Project): RosterPlan | undefined {
  // 优先使用项目自己的冻结快照；旧数据没有快照时才回落到当前名册
  return p.rosterSnapshot ?? state.rosters.find((r) => r.id === p.rosterPlanId)
}

export function layoutOf(p: Project): LayoutPackage | undefined {
  return state.layouts.find((l) => l.id === p.layoutPackageId)
}
