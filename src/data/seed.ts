/** 首次启动 / 空库时灌入的示例数据 */
import type { LayoutPackage, Project, RosterPlan, SheetCell } from '../types'
import { DEFAULT_RULESET } from '../types'
import { createBlankLayout, createSheet, ensureSeatIds, nowISO, setCell, uid } from '../engine/sheet'

export function buildSeed(): { roster: RosterPlan; layout: LayoutPackage; project: Project } {
  const roster = seedRoster()
  const layout = seedLayout()
  const project: Project = {
    id: uid('proj'),
    name: '第一次全体会议',
    rosterPlanId: roster.id,
    layoutPackageId: layout.id,
    rosterSnapshot: JSON.parse(JSON.stringify(roster)),
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

const RANK_COLORS = ['#3D5A6C', '#4A7C7B', '#C2A079', '#B4483F', '#3D5A6C']

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
      status: 'present' as const,
      order: i
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
  base.zones = []

  // 主席台：第 1 排 9 个单人位
  for (let c = 0; c < sheet.cols; c++) {
    const cell: SheetCell = { kind: 'podium', seats: 1, tableId: 'table-stage', tableLabel: '主席台' }
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
        tableId: `table-${r}-${c < 2 ? 'l' : 'r'}-${Math.floor(c / 2)}`,
        tableLabel: `${r + 1} 排`
      }
      ensureSeatIds(cell)
      setCell(sheet, r, c, cell)
    }
  }
  return base
}
