import { reactive } from 'vue'
import type { LayoutPackage, LayoutPreset, Project, RosterPlan, Snapshot } from './types'
import { buildSeed, repository, type StorageMode } from './data'

export const state = reactive({
  ready: false,
  /** 存储模式：sqlite（桌面端）/ indexeddb / local（file:// 下的 localStorage）/ memory（仅当次有效） */
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
  state.storage = await repository.open()
  state.persistent = state.storage !== 'memory'
  let t = await repository.loadAll()
  if (!t.rosters.length && seedIfEmpty) {
    const { roster, layout, project } = buildSeed()
    await repository.saveRoster(roster)
    await repository.saveLayout(layout)
    await repository.saveProject(project)
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
  await repository.saveRoster(r)
  await loadAll()
}

export async function saveLayout(l: LayoutPackage): Promise<void> {
  l.updatedAt = new Date().toISOString()
  await repository.saveLayout(l)
  await loadAll()
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = new Date().toISOString()
  await repository.saveProject(p)
  await loadAll()
}

export async function removeProject(id: string): Promise<void> {
  await repository.removeProject(id)
  await loadAll()
}

export async function removeLayout(id: string): Promise<void> {
  await repository.removeLayout(id)
  await loadAll()
}

export async function removeRoster(id: string): Promise<void> {
  await repository.removeRoster(id)
  await loadAll()
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  await repository.addSnapshot(s)
}

export async function savePreset(p: LayoutPreset): Promise<void> {
  p.updatedAt = new Date().toISOString()
  await repository.savePreset(p)
  await loadAll()
}

export async function removePreset(id: string): Promise<void> {
  await repository.removePreset(id)
  await loadAll()
}

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  return repository.listSnapshots(projectId)
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return repository.getSnapshot(id)
}

/** 批量删除历史快照 */
export async function removeSnapshots(ids: string[]): Promise<void> {
  await repository.removeSnapshots(ids)
}

/** 一键清空历史快照（名册/布局/项目不受影响） */
export async function clearAllSnapshots(): Promise<void> {
  await repository.clearSnapshots()
}

export function rosterOf(p: Project): RosterPlan | undefined {
  // 优先使用项目自己的冻结快照；旧数据没有快照时才回落到当前名册
  return p.rosterSnapshot ?? state.rosters.find((r) => r.id === p.rosterPlanId)
}

export function layoutOf(p: Project): LayoutPackage | undefined {
  return state.layouts.find((l) => l.id === p.layoutPackageId)
}
