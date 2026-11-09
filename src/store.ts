import { reactive } from 'vue'
import type { LayoutPackage, Project, RosterPlan } from './types'
import { db, ensureSeed } from './db'

export const state = reactive({
  ready: false,
  rosters: [] as RosterPlan[],
  layouts: [] as LayoutPackage[],
  projects: [] as Project[]
})

export async function loadAll(): Promise<void> {
  await ensureSeed()
  const [rosters, layouts, projects] = await Promise.all([
    db.rosters.toArray(),
    db.layouts.toArray(),
    db.projects.toArray()
  ])
  state.rosters = rosters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.layouts = layouts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.projects = projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  state.ready = true
}

export async function saveRoster(r: RosterPlan): Promise<void> {
  r.updatedAt = new Date().toISOString()
  await db.rosters.put(JSON.parse(JSON.stringify(r)))
  await loadAll()
}

export async function saveLayout(l: LayoutPackage): Promise<void> {
  l.updatedAt = new Date().toISOString()
  await db.layouts.put(JSON.parse(JSON.stringify(l)))
  await loadAll()
}

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = new Date().toISOString()
  await db.projects.put(JSON.parse(JSON.stringify(p)))
  await loadAll()
}

export async function removeProject(id: string): Promise<void> {
  await db.projects.delete(id)
  await db.snapshots.where('projectId').equals(id).delete()
  await loadAll()
}

export async function removeLayout(id: string): Promise<void> {
  await db.layouts.delete(id)
  await loadAll()
}

export async function removeRoster(id: string): Promise<void> {
  await db.rosters.delete(id)
  await loadAll()
}

export function rosterOf(p: Project): RosterPlan | undefined {
  return state.rosters.find((r) => r.id === p.rosterPlanId)
}

export function layoutOf(p: Project): LayoutPackage | undefined {
  return state.layouts.find((l) => l.id === p.layoutPackageId)
}
