import type { BaseElement, CellRef, GridConfig, LayoutPackage } from '../types'
import { collectSeats, groupRows, type AbsSeat } from './geometry'

export const GRID_MAX_ROWS = 200
export const GRID_MAX_COLS = 200

export interface CellRect {
  x: number
  y: number
  w: number
  h: number
}

/** 一排座位：rowIndex 是真实排号（网格行号 + 1），不是数组下标 */
export interface SeatRow {
  rowIndex: number
  seats: AbsSeat[]
  /** true = 来自网格；false = 游离元素按坐标聚出来的排 */
  grid: boolean
  stage: boolean
}

export interface GridOptions {
  rows: number
  cols: number
  colWidth: number
  rowHeight: number
  originX: number
  originY: number
  padding: number
}

export function createGrid(o: GridOptions): GridConfig {
  const rows = clampInt(o.rows, 1, GRID_MAX_ROWS)
  const cols = clampInt(o.cols, 1, GRID_MAX_COLS)
  return {
    rows,
    cols,
    colWidth: Math.max(24, Math.round(o.colWidth)),
    rowHeight: Math.max(24, Math.round(o.rowHeight)),
    colWidths: Array.from({ length: cols }, () => Math.max(24, Math.round(o.colWidth))),
    rowHeights: Array.from({ length: rows }, () => Math.max(24, Math.round(o.rowHeight))),
    originX: Math.max(0, Math.round(o.originX)),
    originY: Math.max(0, Math.round(o.originY)),
    padding: Math.max(0, Math.round(o.padding)),
    merges: []
  }
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : min
  return Math.min(max, Math.max(min, n))
}

/** 规整网格数据：补齐行高/列宽数组、过滤越界的合并区 */
export function normalizeGrid(g: GridConfig): GridConfig {
  const rows = clampInt(g.rows, 1, GRID_MAX_ROWS)
  const cols = clampInt(g.cols, 1, GRID_MAX_COLS)
  const colWidth = Math.max(24, Math.round(g.colWidth || 120))
  const rowHeight = Math.max(24, Math.round(g.rowHeight || 72))
  const colWidths = Array.from({ length: cols }, (_, i) => Math.max(24, Math.round(g.colWidths?.[i] ?? colWidth)))
  const rowHeights = Array.from({ length: rows }, (_, i) => Math.max(24, Math.round(g.rowHeights?.[i] ?? rowHeight)))
  const merges = (g.merges || [])
    .filter((m) => m && m.row >= 0 && m.col >= 0 && m.row < rows && m.col < cols)
    .map((m) => ({
      row: m.row,
      col: m.col,
      rowSpan: clampInt(m.rowSpan ?? 1, 1, rows - m.row),
      colSpan: clampInt(m.colSpan ?? 1, 1, cols - m.col)
    }))
  return {
    rows,
    cols,
    colWidth,
    rowHeight,
    colWidths,
    rowHeights,
    originX: Math.max(0, Math.round(g.originX || 0)),
    originY: Math.max(0, Math.round(g.originY || 0)),
    padding: Math.max(0, Math.round(g.padding ?? 6)),
    merges
  }
}

export function colWidthAt(g: GridConfig, col: number): number {
  return g.colWidths?.[col] ?? g.colWidth
}

export function rowHeightAt(g: GridConfig, row: number): number {
  return g.rowHeights?.[row] ?? g.rowHeight
}

export function gridSize(g: GridConfig): { w: number; h: number } {
  let w = 0
  let h = 0
  for (let c = 0; c < g.cols; c++) w += colWidthAt(g, c)
  for (let r = 0; r < g.rows; r++) h += rowHeightAt(g, r)
  return { w, h }
}

/** 网格单元矩形；跨格时返回合并后的矩形 */
export function cellRect(g: GridConfig, row: number, col: number, rowSpan = 1, colSpan = 1): CellRect {
  let x = g.originX
  for (let c = 0; c < col; c++) x += colWidthAt(g, c)
  let y = g.originY
  for (let r = 0; r < row; r++) y += rowHeightAt(g, r)
  let w = 0
  for (let c = 0; c < colSpan; c++) w += colWidthAt(g, col + c)
  let h = 0
  for (let r = 0; r < rowSpan; r++) h += rowHeightAt(g, row + r)
  return { x, y, w, h }
}

/** 该点落在哪一格（越界时夹到边缘格） */
export function cellFromPoint(g: GridConfig, x: number, y: number): { row: number; col: number } {
  let col = 0
  let acc = g.originX
  for (let c = 0; c < g.cols; c++) {
    const w = colWidthAt(g, c)
    if (x < acc + w) {
      col = c
      break
    }
    acc += w
    col = c
  }
  let row = 0
  let accY = g.originY
  for (let r = 0; r < g.rows; r++) {
    const h = rowHeightAt(g, r)
    if (y < accY + h) {
      row = r
      break
    }
    accY += h
    row = r
  }
  const m = mergeOf(g, row, col)
  return m ? { row: m.row, col: m.col } : { row, col }
}

/** 该格是否属于某个合并区，返回合并区锚点 */
export function mergeOf(g: GridConfig, row: number, col: number): CellRef | undefined {
  return (g.merges || []).find(
    (m) => row >= m.row && row < m.row + (m.rowSpan ?? 1) && col >= m.col && col < m.col + (m.colSpan ?? 1)
  )
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function elementSpan(el: BaseElement): { rowSpan: number; colSpan: number } {
  return { rowSpan: Math.max(1, el.cell?.rowSpan ?? 1), colSpan: Math.max(1, el.cell?.colSpan ?? 1) }
}

/** 已被占用的格子（锚点 -> 元素 id） */
export function cellOccupancy(layout: LayoutPackage, excludeIds?: Set<string>): Map<string, string> {
  const map = new Map<string, string>()
  for (const el of layout.elements) {
    if (!el.cell) continue
    if (excludeIds?.has(el.id)) continue
    map.set(cellKey(el.cell.row, el.cell.col), el.id)
  }
  return map
}

function overlapMerge(g: GridConfig, row: number, col: number, rowSpan: number, colSpan: number): CellRef | undefined {
  return (g.merges || []).find(
    (m) => row < m.row + (m.rowSpan ?? 1) && row + rowSpan > m.row && col < m.col + (m.colSpan ?? 1) && col + colSpan > m.col
  )
}

/** 按单元格与对齐方式摆放元素；keepSize 时保留元素自身尺寸（center/start/end） */
export function placeElementInCell(el: BaseElement, g: GridConfig): void {
  if (!el.cell) return
  const { rowSpan, colSpan } = elementSpan(el)
  const r = cellRect(g, el.cell.row, el.cell.col, rowSpan, colSpan)
  const pad = Math.max(0, el.pad ?? g.padding)
  const inner = { x: r.x + pad, y: r.y + pad, w: Math.max(8, r.w - pad * 2), h: Math.max(8, r.h - pad * 2) }
  const align = el.align || 'fill'
  if (align === 'fill') {
    el.x = inner.x
    el.y = inner.y
    el.w = inner.w
    el.h = inner.h
    return
  }
  const w = Math.min(el.w, inner.w)
  const h = Math.min(el.h, inner.h)
  if (align === 'center') {
    el.x = inner.x + (inner.w - w) / 2
    el.y = inner.y + (inner.h - h) / 2
  } else if (align === 'start') {
    el.x = inner.x
    el.y = inner.y
  } else {
    el.x = inner.x + inner.w - w
    el.y = inner.y + inner.h - h
  }
  el.w = w
  el.h = h
}

/** 重算所有入格元素的几何（改行高/列宽/内边距后调用） */
export function applyGridGeometry(layout: LayoutPackage): void {
  if (!layout.grid) return
  const g = normalizeGrid(layout.grid)
  layout.grid = g
  for (const el of layout.elements) {
    if (!el.cell) continue
    const { rowSpan, colSpan } = elementSpan(el)
    el.cell.row = Math.min(Math.max(0, el.cell.row), Math.max(0, g.rows - 1))
    el.cell.col = Math.min(Math.max(0, el.cell.col), Math.max(0, g.cols - 1))
    el.cell.rowSpan = Math.min(rowSpan, g.rows - el.cell.row)
    el.cell.colSpan = Math.min(colSpan, g.cols - el.cell.col)
    placeElementInCell(el, g)
  }
  syncMerges(layout)
}

/** 从元素跨度重建合并区：跨格元素所在区域就是一个合并单元格 */
export function syncMerges(layout: LayoutPackage): void {
  if (!layout.grid) return
  const merges: CellRef[] = []
  for (const el of layout.elements) {
    if (!el.cell) continue
    const { rowSpan, colSpan } = elementSpan(el)
    if (rowSpan > 1 || colSpan > 1) {
      merges.push({ row: el.cell.row, col: el.cell.col, rowSpan, colSpan })
    }
  }
  layout.grid.merges = merges
}

function findFreeCell(
  g: GridConfig,
  occ: Map<string, string>,
  row: number,
  col: number,
  rowSpan: number,
  colSpan: number
): { row: number; col: number } | null {
  const fits = (r: number, c: number): boolean => {
    if (r < 0 || c < 0 || r + rowSpan > g.rows || c + colSpan > g.cols) return false
    if (overlapMerge(g, r, c, rowSpan, colSpan)) {
      const m = overlapMerge(g, r, c, rowSpan, colSpan)!
      if (!(m.row === r && m.col === c && (m.rowSpan ?? 1) === rowSpan && (m.colSpan ?? 1) === colSpan)) return false
    }
    for (let rr = r; rr < r + rowSpan; rr++) {
      for (let cc = c; cc < c + colSpan; cc++) {
        if (occ.has(cellKey(rr, cc))) return false
      }
    }
    return true
  }
  if (fits(row, col)) return { row, col }
  const maxR = Math.max(g.rows, g.cols)
  for (let radius = 1; radius <= maxR; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue
        const r = row + dr
        const c = col + dc
        if (fits(r, c)) return { row: r, col: c }
      }
    }
  }
  return null
}

/** 把元素放进指定格子（自动避开已占用的格子） */
export function putElementInCell(
  layout: LayoutPackage,
  el: BaseElement,
  row: number,
  col: number,
  span?: { rowSpan?: number; colSpan?: number },
  excludeIds?: Set<string>
): boolean {
  const g = layout.grid
  if (!g) return false
  const rowSpan = Math.max(1, Math.min(span?.rowSpan ?? elementSpan(el).rowSpan, g.rows))
  const colSpan = Math.max(1, Math.min(span?.colSpan ?? elementSpan(el).colSpan, g.cols))
  const occ = cellOccupancy(layout, excludeIds ?? new Set([el.id]))
  const target =
    findFreeCell(g, occ, clampInt(row, 0, g.rows - 1), clampInt(col, 0, g.cols - 1), rowSpan, colSpan) || null
  if (!target) return false
  el.cell = { row: target.row, col: target.col, rowSpan, colSpan }
  placeElementInCell(el, g)
  syncMerges(layout)
  return true
}

export type GridChangeKind = 'move' | 'resize' | 'create'

export interface SnapableRect {
  id: string
  x: number
  y: number
  w: number
  h: number
  cell?: CellRef
  align?: BaseElement['align']
  pad?: number
}

/**
 * 拖动/缩放结束后把一批元素吸附进格子。
 * 先释放这批元素原有的格子，再逐个找最近的空位，因此整体拖动会保持相对布局。
 */
export function snapChangesToGrid<T extends SnapableRect>(
  layout: LayoutPackage,
  changes: T[],
  kind: GridChangeKind
): T[] {
  const g = layout.grid
  if (!g) return changes
  const moving = new Set(changes.map((c) => c.id))
  const occ = cellOccupancy(layout, moving)
  const byId = new Map(layout.elements.map((e) => [e.id, e]))
  const out: T[] = []
  for (const ch of changes) {
    const el = byId.get(ch.id)
    // 缩放只改「已入格」元素的跨格数；游离元素缩放仍按自由尺寸
    if (kind === 'resize' && !el?.cell) {
      out.push(ch)
      continue
    }
    let rowSpan = Math.max(1, el?.cell?.rowSpan ?? 1)
    let colSpan = Math.max(1, el?.cell?.colSpan ?? 1)
    let anchor: { row: number; col: number } | null = null
    if (kind === 'resize' && el?.cell) {
      const pad = Math.max(0, ch.pad ?? el.pad ?? g.padding)
      colSpan = Math.max(1, Math.min(g.cols - el.cell.col, Math.round((ch.w + pad * 2) / colWidthAt(g, el.cell.col))))
      rowSpan = Math.max(1, Math.min(g.rows - el.cell.row, Math.round((ch.h + pad * 2) / rowHeightAt(g, el.cell.row))))
      anchor = findFreeCell(g, occ, el.cell.row, el.cell.col, rowSpan, colSpan) || { row: el.cell.row, col: el.cell.col }
    } else {
      const center = cellFromPoint(g, ch.x + ch.w / 2, ch.y + ch.h / 2)
      anchor = findFreeCell(g, occ, center.row, center.col, rowSpan, colSpan) || center
    }
    if (!anchor) {
      out.push(ch)
      continue
    }
    for (let rr = anchor.row; rr < anchor.row + rowSpan; rr++) {
      for (let cc = anchor.col; cc < anchor.col + colSpan; cc++) occ.set(cellKey(rr, cc), ch.id)
    }
    const next = { ...ch, cell: { row: anchor.row, col: anchor.col, rowSpan, colSpan } }
    const tmp: BaseElement = {
      id: ch.id,
      type: 'table',
      x: next.x,
      y: next.y,
      w: next.w,
      h: next.h,
      cell: next.cell,
      align: ch.align ?? el?.align ?? 'fill',
      pad: ch.pad ?? el?.pad
    }
    placeElementInCell(tmp, g)
    next.x = tmp.x
    next.y = tmp.y
    next.w = tmp.w
    next.h = tmp.h
    out.push(next)
  }
  return out
}

/** 把当前所有游离元素套进网格（按元素中心找最近的空格） */
export function autoPlaceFreeElements(layout: LayoutPackage): number {
  const g = layout.grid
  if (!g) return 0
  let count = 0
  for (const el of layout.elements) {
    if (el.cell) continue
    const center = cellFromPoint(g, el.x + el.w / 2, el.y + el.h / 2)
    const colSpan = Math.max(1, Math.min(g.cols, Math.round((el.w + g.padding * 2) / colWidthAt(g, center.col))))
    const rowSpan = Math.max(1, Math.min(g.rows, Math.round((el.h + g.padding * 2) / rowHeightAt(g, center.row))))
    if (putElementInCell(layout, el, center.row, center.col, { rowSpan, colSpan })) count++
  }
  syncMerges(layout)
  return count
}

/** 解除网格：保留元素当前位置，清掉网格与格子归属 */
export function clearGrid(layout: LayoutPackage): void {
  for (const el of layout.elements) delete el.cell
  delete layout.grid
}

/** 元素脱离网格，保留当前几何 */
export function detachElement(el: BaseElement): void {
  delete el.cell
}

/** 元素是否游离（布局有网格但元素没入格） */
export function isStray(layout: LayoutPackage, el: BaseElement): boolean {
  return !!layout.grid && !el.cell
}

/**
 * 排座/座位图共用的分行：网格座位读格子行号，游离座位按坐标聚成排接在后面。
 * 这样「第几排」由格子决定，不再依赖坐标推算。
 */
export function seatRowsFor(layout: LayoutPackage, seats: AbsSeat[]): SeatRow[] {
  if (!layout.grid) {
    return groupRows(seats).map((row, i) => ({
      rowIndex: i + 1,
      seats: row,
      grid: false,
      stage: !!row[0]?.stage
    }))
  }
  const byRow = new Map<number, AbsSeat[]>()
  const free: AbsSeat[] = []
  for (const s of seats) {
    if (s.gridRow === undefined) {
      free.push(s)
      continue
    }
    const list = byRow.get(s.gridRow)
    if (list) list.push(s)
    else byRow.set(s.gridRow, [s])
  }
  const rows: SeatRow[] = [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([row, list]) => {
      list.sort((a, b) => (a.gridCol ?? 0) - (b.gridCol ?? 0) || a.seat.index - b.seat.index)
      return { rowIndex: row + 1, seats: list, grid: true, stage: !!list[0]?.stage }
    })
  if (free.length) {
    const base = layout.grid.rows
    groupRows(free).forEach((list, i) => {
      rows.push({ rowIndex: base + i + 1, seats: list, grid: false, stage: !!list[0]?.stage })
    })
  }
  return rows
}

/** 所有座位（含禁用），用于座位图 */
export function allSeatRows(layout: LayoutPackage): SeatRow[] {
  return seatRowsFor(layout, collectSeats(layout, { includeDisabled: true }))
}
