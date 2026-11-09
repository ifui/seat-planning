import { reactive } from 'vue'
import type { LayoutPackage, Project, RosterPlan, Snapshot } from './types'
import {
  addSnapshot,
  buildSeed,
  deleteLayout as dbDeleteLayout,
  deleteProject as dbDeleteProject,
  deleteRoster as dbDeleteRoster,
  getSnapshotById,
  listSnapshots as dbListSnapshots,
  loadTables,
  openStorage,
  putLayout,
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
  projects: [] as Project[]
})

function sortAll(): void {
  state.rosters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.layouts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function loadAll(): Promise<void> {
  state.storage = await openStorage()
  state.persistent = state.storage !== 'memory'
  let t = await loadTables()
  if (!t.rosters.length) {
    const { roster, layout, project } = buildSeed()
    await putRoster(roster)
    await putLayout(layout)
    await putProject(project)
    t = { rosters: [roster], layouts: [layout], projects: [project], snapshots: [] }
  }
  state.rosters = t.rosters
  state.layouts = t.layouts
  state.projects = t.projects
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

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  return dbListSnapshots(projectId)
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return getSnapshotById(id)
}

export function rosterOf(p: Project): RosterPlan | undefined {
  return state.rosters.find((r) => r.id === p.rosterPlanId)
}

export function layoutOf(p: Project): LayoutPackage | undefined {
  return state.layouts.find((l) => l.id === p.layoutPackageId)
}
