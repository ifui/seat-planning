import Dexie, { type Table } from 'dexie'
import type { LayoutPackage, Project, RosterPlan, Snapshot } from './types'
import { DEFAULT_RULESET } from './types'
import { createBlankLayout, makeTable, nowISO, uid } from './engine/geometry'

class SeatDB extends Dexie {
  rosters!: Table<RosterPlan, string>
  layouts!: Table<LayoutPackage, string>
  projects!: Table<Project, string>
  snapshots!: Table<Snapshot, string>
  settings!: Table<{ key: string; value: unknown }, string>

  constructor() {
    super('seat-planning')
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

let seeded = false
export async function ensureSeed(): Promise<void> {
  if (seeded) return
  seeded = true
  const count = await db.rosters.count()
  if (count === 0) {
    const roster = seedRoster()
    await db.rosters.put(roster)
    const layout = seedLayout()
    await db.layouts.put(layout)
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
    await db.projects.put(project)
  }
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

function seedLayout(): LayoutPackage {
  const base = createBlankLayout('第一会议室 · 主席台布局')
  base.canvas = { width: 1200, height: 880, background: '#FFFFFF', grid: { size: 20, visible: false } }
  const elements = base.elements
  const host = elements.find((e) => e.type === 'hostTable') as any
  if (host) host.zoneId = 'zone-stage'

  const tables = []
  const rows = 5
  for (let r = 0; r < rows; r++) {
    const y = 300 + r * 110
    tables.push(makeTable(120, y, 200, 78, 2))
    tables.push(makeTable(340, y, 200, 78, 2))
    tables.push(makeTable(660, y, 200, 78, 2))
    tables.push(makeTable(880, y, 200, 78, 2))
  }
  for (const t of tables) {
    t.zoneId = r0Zone(t.y)
    t.label = `${Math.max(1, Math.floor((t.y - 300) / 110) + 1)} 排`
  }
  return {
    ...base,
    zones: [
      ...base.zones,
      { id: 'zone-hall', name: '普通席', color: '#F3F5F7', ruleTag: 'other' }
    ],
    elements: [...elements, ...tables],
    canvas: { width: 1200, height: 900, background: '#FFFFFF', grid: { size: 20, visible: false } }
  }
}

function r0Zone(y: number): string {
  return y < 410 ? 'zone-front' : 'zone-hall'
}

export async function exportAllData(): Promise<string> {
  const [rosters, layouts, projects, snapshots] = await Promise.all([
    db.rosters.toArray(),
    db.layouts.toArray(),
    db.projects.toArray(),
    db.snapshots.toArray()
  ])
  return JSON.stringify({ schemaVersion: '1.0', exportedAt: nowISO(), rosters, layouts, projects, snapshots }, null, 2)
}

export async function importAllData(json: string): Promise<void> {
  const data = JSON.parse(json)
  await db.transaction('rw', db.rosters, db.layouts, db.projects, db.snapshots, async () => {
    if (Array.isArray(data.rosters)) await db.rosters.bulkPut(data.rosters)
    if (Array.isArray(data.layouts)) await db.layouts.bulkPut(data.layouts)
    if (Array.isArray(data.projects)) await db.projects.bulkPut(data.projects)
    if (Array.isArray(data.snapshots)) await db.snapshots.bulkPut(data.snapshots)
  })
}
