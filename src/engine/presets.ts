import type { LayoutPackage, LayoutPreset, SheetCell, ZoneDef } from '../types'
import { createSheet, ensureSeatIds, keyOf, nowISO, uid } from './sheet'

function buildTemplate(opts: {
  name: string
  note: string
  rows: number
  cols: number
  podiumCols: [number, number]
}): LayoutPackage {
  const { name, rows, cols, podiumCols } = opts
  const sheet = createSheet({ rows, cols, colWidth: 108, rowHeight: 58, originX: 40, originY: 40 })
  sheet.rowHeights[0] = 68
  const zones: ZoneDef[] = [
    { id: 'zone-stage', name: '主席台', color: '#DCE9EA', ruleTag: 'podium' },
    { id: 'zone-front', name: '前排', color: '#E6F0EF', ruleTag: 'vip' },
    { id: 'zone-hall', name: '会场', color: '#EFF5F4', ruleTag: 'other' }
  ]
  const cells: Record<string, SheetCell> = {}

  // 主席台：整排单人位，居中留出两端空列
  for (let c = podiumCols[0]; c <= podiumCols[1]; c++) {
    cells[keyOf(0, c)] = {
      kind: 'podium',
      seats: 1,
      zoneId: 'zone-stage',
      tableId: 'table-stage',
      tableLabel: c === podiumCols[0] ? '主席台' : undefined
    }
  }

  // 主席台与台下之间留一条整行通道
  sheet.merges.push({ row: 1, col: 0, rowSpan: 1, colSpan: cols })
  cells[keyOf(1, 0)] = { kind: 'block', role: 'aisle', text: '通道' }

  // 台下：双人桌，第 1 排靠前，按排编组
  for (let r = 2; r < rows; r++) {
    const tableId = uid('table')
    for (let c = 0; c < cols; c++) {
      const zoneId = r <= 3 ? 'zone-front' : 'zone-hall'
      cells[keyOf(r, c)] = {
        kind: 'seat',
        seats: 2,
        zoneId,
        tableId,
        tableLabel: c === 0 ? `${r - 1} 排` : undefined
      }
    }
  }

  for (const cell of Object.values(cells)) ensureSeatIds(cell)

  const w = cols * 108 + 80
  const h = 68 + 58 + (rows - 2) * 58 + 80
  const now = nowISO()
  return {
    schemaVersion: '2.0',
    id: uid('preset-layout'),
    name,
    canvas: { width: w, height: h, background: '#FFFFFF' },
    sheet: { ...sheet, cells },
    zones,
    createdAt: now,
    updatedAt: now
  }
}

const PRESETS: LayoutPreset[] = [
  {
    id: 'preset-builtin-standard',
    name: '标准会场 · 主席台 9 座',
    note: '9 人主席台，台下 6 排双人桌，中间整行通道',
    builtin: true,
    layout: buildTemplate({ name: '标准会场', note: '', rows: 8, cols: 9, podiumCols: [0, 8] }),
    createdAt: nowISO(),
    updatedAt: nowISO()
  },
  {
    id: 'preset-builtin-classroom',
    name: '课桌式 · 主席台 9 座',
    note: '9 人主席台，台下 8 排双人桌，适合培训与报告',
    builtin: true,
    layout: buildTemplate({ name: '课桌式会场', note: '', rows: 10, cols: 11, podiumCols: [1, 9] }),
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
]

/** 内置模板：始终可用，不写入数据库 */
export function builtinPresets(): LayoutPreset[] {
  return PRESETS.map((p) => JSON.parse(JSON.stringify(p)) as LayoutPreset)
}

/** 当前布局存为预设快照 */
export function presetFromLayout(layout: LayoutPackage, name: string, note?: string): LayoutPreset {
  const now = nowISO()
  return {
    id: uid('preset'),
    name,
    note,
    layout: JSON.parse(JSON.stringify(layout)) as LayoutPackage,
    createdAt: now,
    updatedAt: now
  }
}

/** 从预设复制出新布局：新 id、新座位 id，避免与来源布局串座 */
export function layoutFromPreset(preset: LayoutPreset, name?: string): LayoutPackage {
  const src = JSON.parse(JSON.stringify(preset.layout)) as LayoutPackage
  const now = nowISO()
  const layout: LayoutPackage = {
    ...src,
    schemaVersion: '2.0',
    id: uid('layout'),
    name: name || preset.name,
    createdAt: now,
    updatedAt: now
  }
  for (const cell of Object.values(layout.sheet.cells)) {
    if (cell.kind !== 'seat' && cell.kind !== 'podium') continue
    cell.seatIds = (cell.seatIds ?? []).map(() => uid('seat'))
    ensureSeatIds(cell)
  }
  return layout
}
