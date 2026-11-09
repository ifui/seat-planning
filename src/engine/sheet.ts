import type { BlockRole, LayoutPackage, MergeRange, Sheet, SheetCell } from '../types'

export const SHEET_MAX_ROWS = 300
export const SHEET_MAX_COLS = 100

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

export interface CellRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface SeatRef {
  seatId: string
  /** 所在逻辑格（合并区为锚点） */
  row: number
  col: number
  /** 格内第几个座位（1 起） */
  index: number
  /** 该排内的座号（1 起，跳过过道与空格） */
  seatNo: number
  x: number
  y: number
  w: number
  h: number
  stage: boolean
  zoneId?: string
  disabled: boolean
  tableId?: string
  tableLabel?: string
}

export interface SheetOptions {
  rows: number
  cols: number
  colWidth: number
  rowHeight: number
  frozenRows?: number
  frozenCols?: number
  originX?: number
  originY?: number
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : min
  return Math.min(max, Math.max(min, n))
}

export function createSheet(o: SheetOptions): Sheet {
  const rows = clampInt(o.rows, 1, SHEET_MAX_ROWS)
  const cols = clampInt(o.cols, 1, SHEET_MAX_COLS)
  const colWidth = clampInt(o.colWidth, 24, 2000)
  const rowHeight = clampInt(o.rowHeight, 24, 2000)
  return {
    rows,
    cols,
    defaultColWidth: colWidth,
    defaultRowHeight: rowHeight,
    colWidths: Array.from({ length: cols }, () => colWidth),
    rowHeights: Array.from({ length: rows }, () => rowHeight),
    frozenRows: clampInt(o.frozenRows ?? 0, 0, 5),
    frozenCols: clampInt(o.frozenCols ?? 0, 0, 5),
    originX: Math.max(0, Math.round(o.originX ?? 0)),
    originY: Math.max(0, Math.round(o.originY ?? 0)),
    merges: [],
    cells: {}
  }
}

export function createBlankLayout(name = '新布局'): LayoutPackage {
  const sheet = createSheet({ rows: 12, cols: 10, colWidth: 120, rowHeight: 64 })
  return {
    schemaVersion: '2.0',
    id: uid('layout'),
    name,
    canvas: { width: 1400, height: 900, background: '#FFFFFF' },
    sheet,
    zones: [{ id: 'zone-stage', name: '主席台', color: '#DCE4EE', ruleTag: 'podium' }],
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
}

export function keyOf(row: number, col: number): string {
  return `${row}:${col}`
}

export function cellAt(s: Sheet, row: number, col: number): SheetCell | undefined {
  return s.cells[keyOf(row, col)]
}

export function setCell(s: Sheet, row: number, col: number, cell: SheetCell | undefined): void {
  const k = keyOf(row, col)
  if (cell) s.cells[k] = cell
  else delete s.cells[k]
}

export function colWidthAt(s: Sheet, col: number): number {
  return s.colWidths[col] ?? s.defaultColWidth
}

export function rowHeightAt(s: Sheet, row: number): number {
  return s.rowHeights[row] ?? s.defaultRowHeight
}

export function colX(s: Sheet, col: number): number {
  let x = s.originX
  for (let c = 0; c < col; c++) x += colWidthAt(s, c)
  return x
}

export function rowY(s: Sheet, row: number): number {
  let y = s.originY
  for (let r = 0; r < row; r++) y += rowHeightAt(s, r)
  return y
}

export function sheetSize(s: Sheet): { w: number; h: number } {
  let w = 0
  let h = 0
  for (let c = 0; c < s.cols; c++) w += colWidthAt(s, c)
  for (let r = 0; r < s.rows; r++) h += rowHeightAt(s, r)
  return { w, h }
}

export function cellRect(
  s: Sheet,
  row: number,
  col: number,
  rowSpan = 1,
  colSpan = 1
): { x: number; y: number; w: number; h: number } {
  const x = colX(s, col)
  const y = rowY(s, row)
  let w = 0
  let h = 0
  for (let c = 0; c < colSpan; c++) w += colWidthAt(s, col + c)
  for (let r = 0; r < rowSpan; r++) h += rowHeightAt(s, row + r)
  return { x, y, w, h }
}

export function mergeAt(s: Sheet, row: number, col: number): MergeRange | undefined {
  return s.merges.find(
    (m) => row >= m.row && row < m.row + m.rowSpan && col >= m.col && col < m.col + m.colSpan
  )
}

/** 该格是否是合并区的内部格（非锚点） */
export function isCovered(s: Sheet, row: number, col: number): boolean {
  const m = mergeAt(s, row, col)
  return !!m && !(m.row === row && m.col === col)
}

export function anchorOf(s: Sheet, row: number, col: number): { row: number; col: number } {
  const m = mergeAt(s, row, col)
  return m ? { row: m.row, col: m.col } : { row, col }
}

export function colLabel(col: number): string {
  let n = col + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** 补齐/裁剪座位 id，保证长度与 single/double 一致 */
export function ensureSeatIds(cell: SheetCell): void {
  if (cell.kind !== 'seat' && cell.kind !== 'podium') return
  const n = cell.seats === 2 ? 2 : 1
  const ids = cell.seatIds ? [...cell.seatIds] : []
  while (ids.length < n) ids.push(uid('seat'))
  ids.length = n
  cell.seatIds = ids
  if (!cell.seats) cell.seats = 1
}

export function normalizeSheet(input: Sheet): Sheet {
  const rows = clampInt(input.rows, 1, SHEET_MAX_ROWS)
  const cols = clampInt(input.cols, 1, SHEET_MAX_COLS)
  const cw = clampInt(input.defaultColWidth || 120, 24, 2000)
  const rh = clampInt(input.defaultRowHeight || 64, 24, 2000)
  const colWidths = Array.from({ length: cols }, (_, i) => clampInt(input.colWidths?.[i] ?? cw, 24, 2000))
  const rowHeights = Array.from({ length: rows }, (_, i) => clampInt(input.rowHeights?.[i] ?? rh, 24, 2000))
  const merges: MergeRange[] = []
  for (const m of input.merges || []) {
    if (!m || m.row < 0 || m.col < 0 || m.row >= rows || m.col >= cols) continue
    const range = {
      row: m.row,
      col: m.col,
      rowSpan: clampInt(m.rowSpan ?? 1, 1, rows - m.row),
      colSpan: clampInt(m.colSpan ?? 1, 1, cols - m.col)
    }
    if (range.rowSpan === 1 && range.colSpan === 1) continue
    const overlap = merges.some(
      (x) =>
        range.row < x.row + x.rowSpan &&
        range.row + range.rowSpan > x.row &&
        range.col < x.col + x.colSpan &&
        range.col + range.colSpan > x.col
    )
    if (!overlap) merges.push(range)
  }
  const cells: Record<string, SheetCell> = {}
  for (const [k, cell] of Object.entries(input.cells || {})) {
    const [r, c] = k.split(':').map(Number)
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r >= rows || c >= cols) continue
    if (merges.some((m) => r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan && !(m.row === r && m.col === c))) continue
    const next: SheetCell = { ...cell }
    if (next.kind === 'seat' || next.kind === 'podium') {
      next.seats = next.seats === 2 ? 2 : 1
      ensureSeatIds(next)
    } else {
      next.kind = 'block'
      delete next.seats
      delete next.seatIds
      if (!next.role) next.role = 'label'
    }
    cells[k] = next
  }
  return {
    rows,
    cols,
    defaultColWidth: cw,
    defaultRowHeight: rh,
    colWidths,
    rowHeights,
    frozenRows: clampInt(input.frozenRows ?? 0, 0, 5),
    frozenCols: clampInt(input.frozenCols ?? 0, 0, 5),
    originX: Math.max(0, Math.round(input.originX || 0)),
    originY: Math.max(0, Math.round(input.originY || 0)),
    merges,
    cells
  }
}

/** 合并选区内所有格：锚点格类型决定合并块是否坐人 */
export function addMerge(s: Sheet, range: CellRange): string | null {
  const r = normalizeRange(range)
  const rowSpan = r.r2 - r.r1 + 1
  const colSpan = r.c2 - r.c1 + 1
  if (rowSpan === 1 && colSpan === 1) return '请选择至少两个单元格'
  for (const m of s.merges) {
    if (r.r1 < m.row + m.rowSpan && r.r1 + rowSpan > m.row && r.c1 < m.col + m.colSpan && r.c1 + colSpan > m.col) {
      return '选区内已存在合并单元格，请先拆分'
    }
  }
  // 合并后只保留锚点内容，其余格清除，避免出现看不见的重复座位
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      if (row === r.r1 && col === r.c1) continue
      delete s.cells[keyOf(row, col)]
    }
  }
  const anchor = cellAt(s, r.r1, r.c1)
  if (!anchor) {
    s.cells[keyOf(r.r1, r.c1)] = { kind: 'block', role: 'label', text: '' }
  }
  s.merges.push({ row: r.r1, col: r.c1, rowSpan, colSpan })
  return null
}

export function removeMerge(s: Sheet, row: number, col: number): void {
  const m = mergeAt(s, row, col)
  if (!m) return
  s.merges = s.merges.filter((x) => x !== m)
}

export function normalizeRange(r: CellRange): CellRange {
  return {
    r1: Math.min(r.r1, r.r2),
    c1: Math.min(r.c1, r.c2),
    r2: Math.max(r.r1, r.r2),
    c2: Math.max(r.c1, r.c2)
  }
}

/** 遍历选区内的逻辑格（合并区只回调锚点） */
export function eachCell(s: Sheet, range: CellRange, fn: (row: number, col: number, cell: SheetCell | undefined) => void): void {
  const r = normalizeRange(range)
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      if (isCovered(s, row, col)) continue
      const m = mergeAt(s, row, col)
      if (m && (m.row !== row || m.col !== col)) continue
      fn(row, col, cellAt(s, row, col))
    }
  }
}

export function insertRows(s: Sheet, at: number, count = 1): void {
  const n = clampInt(count, 1, 50)
  const pos = clampInt(at, 0, s.rows)
  s.rows += n
  s.rowHeights.splice(pos, 0, ...Array.from({ length: n }, () => s.defaultRowHeight))
  const cells: Record<string, SheetCell> = {}
  for (const [k, cell] of Object.entries(s.cells)) {
    const [r, c] = k.split(':').map(Number)
    cells[keyOf(r >= pos ? r + n : r, c)] = cell
  }
  s.cells = cells
  for (const m of s.merges) {
    if (m.row >= pos) m.row += n
    else if (pos < m.row + m.rowSpan) m.rowSpan += n
  }
  s.merges = s.merges.filter((m) => m.row + m.rowSpan <= s.rows)
}

export function deleteRows(s: Sheet, at: number, count = 1): void {
  const pos = clampInt(at, 0, s.rows - 1)
  const n = Math.min(clampInt(count, 1, 100), s.rows - pos)
  s.rows -= n
  s.rowHeights.splice(pos, n)
  const cells: Record<string, SheetCell> = {}
  for (const [k, cell] of Object.entries(s.cells)) {
    const [r, c] = k.split(':').map(Number)
    if (r >= pos && r < pos + n) continue
    cells[keyOf(r > pos ? r - n : r, c)] = cell
  }
  s.cells = cells
  s.merges = s.merges
    .map((m) => {
      if (m.row >= pos + n) return { ...m, row: m.row - n }
      if (m.row + m.rowSpan <= pos) return m
      const cut = Math.min(m.row + m.rowSpan, pos + n) - Math.max(m.row, pos)
      const row = m.row < pos ? m.row : pos
      return { ...m, row, rowSpan: m.rowSpan - cut }
    })
    .filter((m) => m.rowSpan > 0 && m.row < s.rows)
}

export function insertCols(s: Sheet, at: number, count = 1): void {
  const n = clampInt(count, 1, 50)
  const pos = clampInt(at, 0, s.cols)
  s.cols += n
  s.colWidths.splice(pos, 0, ...Array.from({ length: n }, () => s.defaultColWidth))
  const cells: Record<string, SheetCell> = {}
  for (const [k, cell] of Object.entries(s.cells)) {
    const [r, c] = k.split(':').map(Number)
    cells[keyOf(r, c >= pos ? c + n : c)] = cell
  }
  s.cells = cells
  for (const m of s.merges) if (m.col >= pos) m.col += n
  s.merges = s.merges.filter((m) => m.col + m.colSpan <= s.cols)
}

export function deleteCols(s: Sheet, at: number, count = 1): void {
  const pos = clampInt(at, 0, s.cols - 1)
  const n = Math.min(clampInt(count, 1, 50), s.cols - pos)
  s.cols -= n
  s.colWidths.splice(pos, n)
  const cells: Record<string, SheetCell> = {}
  for (const [k, cell] of Object.entries(s.cells)) {
    const [r, c] = k.split(':').map(Number)
    if (c >= pos && c < pos + n) continue
    cells[keyOf(r, c > pos ? c - n : c)] = cell
  }
  s.cells = cells
  s.merges = s.merges
    .map((m) => {
      if (m.col >= pos + n) return { ...m, col: m.col - n }
      if (m.col + m.colSpan <= pos) return m
      const cut = Math.min(m.col + m.colSpan, pos + n) - Math.max(m.col, pos)
      const col = m.col < pos ? m.col : pos
      return { ...m, col, colSpan: m.colSpan - cut }
    })
    .filter((m) => m.colSpan > 0 && m.col < s.cols)
}

/** 行内座位（按列、格内序号排序），座号连续编号；过道/空格/禁用不占号。纯函数，不修改 sheet。 */
export function seatsInRow(s: Sheet, row: number): SeatRef[] {
  const out: SeatRef[] = []
  let no = 0
  for (let col = 0; col < s.cols; col++) {
    if (isCovered(s, row, col)) continue
    const cell = cellAt(s, row, col)
    if (!cell || (cell.kind !== 'seat' && cell.kind !== 'podium')) continue
    const span = mergeAt(s, row, col)
    const rect = cellRect(s, row, col, span?.rowSpan ?? 1, span?.colSpan ?? 1)
    const n = cell.seats === 2 ? 2 : 1
    const gap = Math.min(8, Math.max(4, rect.w * 0.04))
    const w = (rect.w - gap * (n + 1)) / n
    const ids = cell.seatIds ?? []
    for (let i = 0; i < n; i++) {
      if (!cell.disabled) no++
      out.push({
        seatId: ids[i] ?? `seat-${row}-${col}-${i + 1}`,
        row,
        col,
        index: i + 1,
        seatNo: cell.disabled ? 0 : no,
        x: rect.x + gap + i * (w + gap),
        y: rect.y + gap,
        w,
        h: rect.h - gap * 2,
        stage: cell.kind === 'podium',
        zoneId: cell.zoneId,
        disabled: !!cell.disabled,
        tableId: cell.tableId,
        tableLabel: cell.tableLabel
      })
    }
  }
  return out
}

export function seatsOfSheet(s: Sheet): SeatRef[] {
  const out: SeatRef[] = []
  for (let row = 0; row < s.rows; row++) out.push(...seatsInRow(s, row))
  return out
}

/** 只在选中范围内填充座位（批量建桌） */
export function fillSeats(
  s: Sheet,
  range: CellRange,
  opts: { kind: 'seat' | 'podium'; seats: 1 | 2; tablePerRow: boolean; tableLabel?: string; zoneId?: string }
): number {
  let count = 0
  const r = normalizeRange(range)
  for (let row = r.r1; row <= r.r2; row++) {
    let tableId = ''
    for (let col = r.c1; col <= r.c2; col++) {
      if (isCovered(s, row, col)) continue
      if (opts.tablePerRow && !tableId) tableId = uid('table')
      const cell: SheetCell = {
        kind: opts.kind,
        seats: opts.seats,
        tableId: opts.tablePerRow ? tableId : uid('table'),
        zoneId: opts.zoneId
      }
      if (opts.tableLabel) cell.tableLabel = opts.tableLabel
      ensureSeatIds(cell)
      setCell(s, row, col, cell)
      count++
    }
  }
  return count
}

/** 复制单元格；粘贴/填充时重新生成座位 id，避免出现重复座位 */
export function cloneCell(cell: SheetCell, regenerateSeatIds = false): SheetCell {
  const next: SheetCell = JSON.parse(JSON.stringify(cell))
  if (regenerateSeatIds && (next.kind === 'seat' || next.kind === 'podium')) {
    next.seatIds = (next.seatIds ?? []).map(() => uid('seat'))
    ensureSeatIds(next)
  }
  return next
}

export function blockRoleLabel(role?: BlockRole): string {
  switch (role) {
    case 'aisle':
      return '过道'
    case 'lectern':
      return '讲台'
    case 'backdrop':
      return '背景板'
    default:
      return '标签'
  }
}
