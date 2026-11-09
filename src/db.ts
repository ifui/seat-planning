import Dexie, { type Table } from 'dexie'
import type { LayoutPackage, Project, RosterPlan, SheetCell, Snapshot } from './types'
import { DEFAULT_RULESET } from './types'
import { createBlankLayout, createSheet, ensureSeatIds, nowISO, setCell, uid } from './engine/sheet'

class SeatDB extends Dexie {
  rosters!: Table<RosterPlan, string>
  layouts!: Table<LayoutPackage, string>
  projects!: Table<Project, string>
  snapshots!: Table<Snapshot, string>
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
  }
}

export const db = new SeatDB()

export function buildSeed(): { roster: RosterPlan; layout: LayoutPackage; project: Project } {
  const roster = seedRoster()
  const layout = seedLayout()
  const project: Project = {
    id: uid('proj'),
    name: '第一次全体会议',
    rosterPlanId: roster.id,
    layoutPackageId: layout.id,
    ruleSet: { ...DEFAULT_RULESET },
    assignments: [],
    participantIds: [],
    unassigned: [],
    pendingNames: [],
    status: 'draft',
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
  return { roster, layout, project }
}

// ---------- 存储层：IndexedDB 优先，file:// 下退化为 localStorage ----------

export type StorageMode = 'indexeddb' | 'local' | 'memory'

export interface Tables {
  rosters: RosterPlan[]
  layouts: LayoutPackage[]
  projects: Project[]
  snapshots: Snapshot[]
}

const LOCAL_KEY = 'seat-planning:v2'
let mode: StorageMode = 'indexeddb'
let probed: StorageMode | null = null
let cache: Tables | null = null

const emptyTables = (): Tables => ({ rosters: [], layouts: [], projects: [], snapshots: [] })
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

function localTables(): Tables {
  if (cache) return cache
  let next: Tables
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    next = raw ? { ...emptyTables(), ...JSON.parse(raw) } : emptyTables()
  } catch {
    next = emptyTables()
  }
  cache = next
  return next
}

function localFlush(): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localTables()))
  } catch {
    /* 容量或权限受限：内存仍可用，但本次不落盘 */
    mode = 'memory'
  }
}

/** 探测可用存储：IndexedDB → localStorage → 纯内存。file:// 下 Chrome/Edge 会禁用 IndexedDB。 */
export async function openStorage(): Promise<StorageMode> {
  if (probed) return probed
  try {
    await db.open()
    await db.rosters.count()
    probed = 'indexeddb'
  } catch {
    try {
      const k = '__seat_planning_probe__'
      localStorage.setItem(k, '1')
      localStorage.removeItem(k)
      probed = 'local'
    } catch {
      probed = 'memory'
    }
  }
  mode = probed
  return mode
}

export function storageMode(): StorageMode {
  return mode
}

export async function loadTables(): Promise<Tables> {
  if (mode === 'indexeddb') {
    const [rosters, layouts, projects, snapshots] = await Promise.all([
      db.rosters.toArray(),
      db.layouts.toArray(),
      db.projects.toArray(),
      db.snapshots.toArray()
    ])
    return { rosters, layouts, projects, snapshots }
  }
  const c = localTables()
  return {
    rosters: [...c.rosters],
    layouts: [...c.layouts],
    projects: [...c.projects],
    snapshots: [...c.snapshots]
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.push(item)
}

export async function putRoster(r: RosterPlan): Promise<void> {
  if (mode === 'indexeddb') {
    await db.rosters.put(plain(r))
    return
  }
  upsert(localTables().rosters, plain(r))
  localFlush()
}

export async function putLayout(l: LayoutPackage): Promise<void> {
  if (mode === 'indexeddb') {
    await db.layouts.put(plain(l))
    return
  }
  upsert(localTables().layouts, plain(l))
  localFlush()
}

export async function putProject(p: Project): Promise<void> {
  if (mode === 'indexeddb') {
    await db.projects.put(plain(p))
    return
  }
  upsert(localTables().projects, plain(p))
  localFlush()
}

export async function deleteRoster(id: string): Promise<void> {
  if (mode === 'indexeddb') {
    await db.rosters.delete(id)
    return
  }
  localTables().rosters = localTables().rosters.filter((x) => x.id !== id)
  localFlush()
}

export async function deleteLayout(id: string): Promise<void> {
  if (mode === 'indexeddb') {
    await db.layouts.delete(id)
    return
  }
  localTables().layouts = localTables().layouts.filter((x) => x.id !== id)
  localFlush()
}

export async function deleteProject(id: string): Promise<void> {
  if (mode === 'indexeddb') {
    await db.projects.delete(id)
    await db.snapshots.where('projectId').equals(id).delete()
    return
  }
  const c = localTables()
  c.projects = c.projects.filter((x) => x.id !== id)
  c.snapshots = c.snapshots.filter((x) => x.projectId !== id)
  localFlush()
}

export async function addSnapshot(s: Snapshot): Promise<void> {
  if (mode === 'indexeddb') {
    await db.snapshots.put(plain(s))
    return
  }
  upsert(localTables().snapshots, plain(s))
  localFlush()
}

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  if (mode === 'indexeddb') {
    return db.snapshots.where('projectId').equals(projectId).toArray()
  }
  return localTables().snapshots.filter((s) => s.projectId === projectId)
}

export async function getSnapshotById(id: string): Promise<Snapshot | undefined> {
  if (mode === 'indexeddb') return db.snapshots.get(id)
  return localTables().snapshots.find((s) => s.id === id)
}

const RANK_COLORS = ['#3D5A6C', '#6E8CA0', '#A4774E', '#8C9B7C', '#9A7E8A', '#7C8894']

function seedRoster(): RosterPlan {
  const rankNames = ['正处级', '副处级', '正科级', '副科级', '科员']
  const ranks = rankNames.map((name, i) => ({
    id: `rank-${i + 1}`,
    name,
    order: i,
    color: RANK_COLORS[i]
  }))

  const units = [
    { id: 'u-root', name: '局机关', parentId: null, order: 0 },
    { id: 'u-office', name: '办公室', parentId: 'u-root', order: 0 },
    { id: 'u-hr', name: '人事处', parentId: 'u-root', order: 1 },
    { id: 'u-fin', name: '财务处', parentId: 'u-root', order: 2 },
    { id: 'u-tech', name: '技术处', parentId: 'u-root', order: 3 },
    { id: 'u-cent1', name: '直属一单位', parentId: 'u-root', order: 4 },
    { id: 'u-cent2', name: '直属二单位', parentId: 'u-root', order: 5 }
  ]

  const names = [
    '张建国', '李国强', '王振华', '刘志远', '陈文斌',
    '杨立新', '赵春生', '黄海涛', '周敏', '吴晓东',
    '徐文杰', '孙丽娟', '马晓峰', '朱红梅', '胡志刚',
    '郭永强', '林静', '何建军', '高云鹏', '罗晓燕',
    '郑海峰', '梁文华', '谢明', '宋佳', '唐鑫',
    '许文博', '韩雪', '冯志', '邓超', '曹颖'
  ]
  const memberUnitSeq = ['u-office', 'u-office', 'u-office', 'u-office', 'u-office', 'u-hr', 'u-hr', 'u-hr', 'u-hr', 'u-hr']
  const members = names.map((name, i) => {
    const rankIdx = i < 2 ? 0 : i < 6 ? 1 : i < 14 ? 2 : i < 24 ? 3 : 4
    return {
      id: `m-${i + 1}`,
      name,
      unitId: i < 10 ? memberUnitSeq[i] : units[(i % 5) + 2].id,
      rankId: ranks[rankIdx].id,
      aliases: [],
      active: true
    }
  })

  return {
    id: uid('roster'),
    name: '名册方案一',
    ranks,
    units,
    members,
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
}

/** 种子布局：第 1 排主席台（单人位居中），第 3 排起台下双人桌，第 3 列为过道 */
function seedLayout(): LayoutPackage {
  const base = createBlankLayout('第一会议室 · 主席台布局')
  const sheet = createSheet({
    rows: 8,
    cols: 9,
    colWidth: 120,
    rowHeight: 64,
    frozenRows: 0, frozenCols: 0
  })
  base.sheet = sheet
  base.canvas = { width: 1280, height: 880, background: '#FFFFFF' }
  base.zones = [
    { id: 'zone-stage', name: '主席台', color: '#DCE4EE', ruleTag: 'podium' },
    { id: 'zone-front', name: '前排', color: '#EDF1F5', ruleTag: 'front' },
    { id: 'zone-hall', name: '普通席', color: '#F7F8FA', ruleTag: 'other' }
  ]

  // 主席台：第 1 排 9 个单人位
  for (let c = 0; c < sheet.cols; c++) {
    const cell: SheetCell = { kind: 'podium', seats: 1, zoneId: 'zone-stage', tableId: 'table-stage', tableLabel: '主席台' }
    ensureSeatIds(cell)
    setCell(sheet, 0, c, cell)
  }
  // 第 2 排留空作为主席台前的空档
  // 台下：第 3 排起，第 3 列（索引 2）是过道
  for (let r = 2; r < sheet.rows; r++) {
    for (let c = 0; c < sheet.cols; c++) {
      if (c === 2) {
        setCell(sheet, r, c, { kind: 'block', role: 'aisle', text: '过道' })
        continue
      }
      const cell: SheetCell = {
        kind: 'seat',
        seats: 2,
        zoneId: r <= 3 ? 'zone-front' : 'zone-hall',
        tableId: `table-${r}-${c < 2 ? 'l' : 'r'}-${Math.floor(c / 2)}`,
        tableLabel: `${r + 1} 排`
      }
      ensureSeatIds(cell)
      setCell(sheet, r, c, cell)
    }
  }
  return base
}

export async function exportAllData(): Promise<string> {
  const t = await loadTables()
  return JSON.stringify(
    { schemaVersion: '2.0', exportedAt: nowISO(), rosters: t.rosters, layouts: t.layouts, projects: t.projects, snapshots: t.snapshots },
    null,
    2
  )
}

export async function importAllData(json: string): Promise<void> {
  const data = JSON.parse(json)
  const t = await loadTables()
  if (Array.isArray(data.rosters)) for (const x of data.rosters) upsert(t.rosters, x)
  if (Array.isArray(data.layouts)) for (const x of data.layouts) upsert(t.layouts, x)
  if (Array.isArray(data.projects)) for (const x of data.projects) upsert(t.projects, x)
  if (Array.isArray(data.snapshots)) for (const x of data.snapshots) upsert(t.snapshots, x)

  if (mode === 'indexeddb') {
    await db.transaction('rw', db.rosters, db.layouts, db.projects, db.snapshots, async () => {
      if (Array.isArray(data.rosters)) await db.rosters.bulkPut(data.rosters)
      if (Array.isArray(data.layouts)) await db.layouts.bulkPut(data.layouts)
      if (Array.isArray(data.projects)) await db.projects.bulkPut(data.projects)
      if (Array.isArray(data.snapshots)) await db.snapshots.bulkPut(data.snapshots)
    })
    return
  }
  cache = t
  localFlush()
}
