/**
 * 自由元素：讲台、人形、箭头、门、话筒、桌牌、投影屏幕、绿植。
 *
 * 坐标系约定：与工作表一致（左上角为 sheet.originX / originY，单位为单元格像素）。
 * 元素有两种锚定方式：
 * - cell：绑定单元格/区域，按相对比例换算位置，行列增删或尺寸变化时跟随；
 * - free：绝对坐标，单元格变化不影响。
 * 切换锚定方式时用相对比例反向换算，保证视觉位置不跳动。
 */
import type {
  ElementAnchor,
  ElementKind,
  LayoutElement,
  Sheet
} from '../types'
import { cellRect, colWidthAt, rowHeightAt } from './sheet'
import type { CellRange } from './sheet'

export interface ElementMeta {
  kind: ElementKind
  label: string
  /** 默认尺寸（工作表单位） */
  w: number
  h: number
  color: string
  stroke: string
  strokeWidth: number
  bordered: boolean
  text: string
  /** 默认文字字号占高度的比例 */
  textRatio: number
}

export const ELEMENT_LIBRARY: ElementMeta[] = [
  { kind: 'podium', label: '讲台', w: 190, h: 74, color: '#E8EEEE', stroke: '#8FA3A4', strokeWidth: 1.4, bordered: false, text: '讲台', textRatio: 0.3 },
  { kind: 'person', label: '人形', w: 42, h: 66, color: '#7E9A9C', stroke: '#5C7476', strokeWidth: 1.2, bordered: false, text: '发言人', textRatio: 0.16 },
  { kind: 'arrow', label: '箭头', w: 76, h: 40, color: '#5B8A88', stroke: '#3E6A68', strokeWidth: 1.2, bordered: false, text: '', textRatio: 0.2 },
  { kind: 'door', label: '门', w: 60, h: 76, color: '#DDE6E7', stroke: '#7E9294', strokeWidth: 1.5, bordered: true, text: '', textRatio: 0.2 },
  { kind: 'double-door', label: '双开门', w: 96, h: 76, color: '#DDE6E7', stroke: '#7E9294', strokeWidth: 1.5, bordered: true, text: '', textRatio: 0.2 },
  { kind: 'mic', label: '话筒', w: 34, h: 68, color: '#5F7376', stroke: '#43595B', strokeWidth: 1.2, bordered: false, text: '', textRatio: 0.2 },
  { kind: 'plaque', label: '桌牌', w: 80, h: 30, color: '#F4EFE4', stroke: '#B9A98C', strokeWidth: 1.2, bordered: true, text: '席位牌', textRatio: 0.34 },
  { kind: 'screen', label: '投影屏幕', w: 118, h: 80, color: '#E6EDEF', stroke: '#87989B', strokeWidth: 1.4, bordered: true, text: '', textRatio: 0.18 },
  { kind: 'plant', label: '绿植', w: 48, h: 64, color: '#6F8F6A', stroke: '#4E6B4A', strokeWidth: 1.2, bordered: false, text: '', textRatio: 0.2 }
]

export function elementMeta(kind: ElementKind): ElementMeta {
  return ELEMENT_LIBRARY.find((m) => m.kind === kind) ?? ELEMENT_LIBRARY[0]
}

/**
 * 图形路径（viewBox 0 0 100 100）：
 * - fill：跟随元素颜色的填充部分；
 * - lines：只描边的细节（门弧线、话筒支架、屏幕支架等）。
 * 画布渲染（Canvas Path2D）与界面预览（SVG）共用同一份路径，保证两边形状一致。
 */
export const ELEMENT_SHAPES: Record<ElementKind, { fill: string; lines?: string[] }> = {
  podium: {
    fill: 'M14 24 H86 L96 94 H4 Z',
    lines: ['M24 46 H76']
  },
  // 头与肩贴合：头圆下缘 36，肩线从 38 起，避免头身分离
  person: {
    fill: 'M50 8a14 14 0 1 1 0 28 14 14 0 0 1 0-28Z M50 38c13 0 22 9 25 22l5 34H20l5-34c3-13 12-22 25-22Z'
  },
  arrow: {
    fill: 'M6 36 H54 V14 L94 50 54 86 V64 H6 Z'
  },
  // 门：门框 + 门扇 + 把手，去掉开门弧线
  door: {
    fill: 'M16 94 V12 H62 V94 Z',
    lines: ['M53.5 50a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z']
  },
  'double-door': {
    fill: 'M8 94 V12 H48 V94 Z M52 94 V12 H92 V94 Z',
    lines: ['M42 50a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z', 'M63.2 50a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0Z']
  },
  mic: {
    fill: 'M38 8h24a12 12 0 0 1 12 12v22a12 12 0 0 1-12 12H38a12 12 0 0 1-12-12V20A12 12 0 0 1 38 8Z',
    lines: ['M25 44c0 14 11 25 25 25s25-11 25-25', 'M50 69v17', 'M36 92h28']
  },
  plaque: {
    fill: 'M10 80 L26 32 H74 L90 80 Z',
    lines: ['M26 32 L50 80 L74 32']
  },
  screen: {
    fill: 'M10 10 H90 V62 H10 Z',
    lines: ['M18 18h64v36H18Z', 'M50 62v16', 'M32 88h36']
  },
  plant: {
    fill: 'M36 66 H64 L59 94 H41 Z M50 68C50 50 36 48 26 36 44 32 53 46 50 62 50 46 60 30 76 30 76 50 64 62 50 68Z',
    lines: ['M50 70V50']
  }
}

/** 元素文字可选的常见中文字体族（离线可用，按系统已有字体回退） */
export const ELEMENT_FONTS: { label: string; value: string }[] = [
  { label: '系统默认', value: '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif' },
  { label: '黑体', value: '"Microsoft YaHei", "SimHei", "Heiti SC", sans-serif' },
  { label: '宋体', value: '"Songti SC", "SimSun", "Noto Serif SC", serif' },
  { label: '楷体', value: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  { label: '仿宋', value: '"FangSong", "STFangsong", serif' }
]

export function elementLabel(kind: ElementKind): string {
  return elementMeta(kind).label
}

/** 元素内文字颜色：深色图形上用白字，浅色底上用深字 */
export function elementTextColor(kind: ElementKind): string {
  switch (kind) {
    case 'person':
      return '#FFFFFF'
    case 'plaque':
      return '#41504F'
    case 'door':
    case 'double-door':
      return '#FFFFFF'
    case 'screen':
      return '#4A5B5D'
    default:
      return '#3E4A4B'
  }
}

/** 元素当前的实际几何（工作表坐标） */
export interface ElementGeometry {
  x: number
  y: number
  w: number
  h: number
}

export type ElementTextAlign = 'left' | 'center' | 'right'
export type ElementTextVAlign = 'top' | 'middle' | 'bottom'

/** 文字水平对齐（缺省居中） */
export function elementTextAlign(el: LayoutElement): ElementTextAlign {
  return el.textAlign ?? 'center'
}

/** 文字垂直对齐：人形缺省贴底，其余居中 */
export function elementTextVAlign(el: LayoutElement): ElementTextVAlign {
  return el.textVAlign ?? (el.kind === 'person' ? 'bottom' : 'middle')
}

/** 文字相对元素中心的偏移（工作表单位） */
export function elementTextOffset(el: LayoutElement): { x: number; y: number } {
  return { x: el.textOffsetX ?? 0, y: el.textOffsetY ?? 0 }
}

/** 文字向内留白占比：避免贴边，人形底部另留一点给脚下文字 */
export function elementTextPadding(el: LayoutElement): { x: number; y: number } {
  return el.kind === 'person' ? { x: 0.04, y: 0.04 } : { x: 0.06, y: 0.06 }
}

export function resolveGeometry(el: LayoutElement, sheet: Sheet): ElementGeometry {
  if (el.anchor.mode === 'free') return { x: el.x, y: el.y, w: el.w, h: el.h }
  const row = Math.max(0, Math.min(sheet.rows - 1, el.anchor.row))
  const col = Math.max(0, Math.min(sheet.cols - 1, el.anchor.col))
  const rowSpan = Math.max(1, Math.min(sheet.rows - row, el.anchor.rowSpan || 1))
  const colSpan = Math.max(1, Math.min(sheet.cols - col, el.anchor.colSpan || 1))
  const rect = cellRect(sheet, row, col, rowSpan, colSpan)
  return {
    x: rect.x + el.anchor.ox * rect.w,
    y: rect.y + el.anchor.oy * rect.h,
    w: Math.max(8, el.anchor.sw * rect.w),
    h: Math.max(8, el.anchor.sh * rect.h)
  }
}

/** 由矩形反推覆盖的行列范围 */
export function rangeOfRect(sheet: Sheet, g: { x: number; y: number; w: number; h: number }): CellRange {
  let r1 = 0
  let r2 = sheet.rows - 1
  let c1 = 0
  let c2 = sheet.cols - 1

  let acc = sheet.originX
  for (let c = 0; c < sheet.cols; c++) {
    const w = colWidthAt(sheet, c)
    if (acc + w > g.x + 0.5) { c1 = c; break }
    acc += w
  }
  acc = sheet.originX
  for (let c = 0; c < sheet.cols; c++) acc += colWidthAt(sheet, c)
  for (let c = sheet.cols - 1; c >= 0; c--) {
    const w = colWidthAt(sheet, c)
    if (acc - w < g.x + g.w - 0.5) { c2 = c; break }
    acc -= w
  }

  acc = sheet.originY
  for (let r = 0; r < sheet.rows; r++) {
    const h = rowHeightAt(sheet, r)
    if (acc + h > g.y + 0.5) { r1 = r; break }
    acc += h
  }
  acc = sheet.originY
  for (let r = 0; r < sheet.rows; r++) acc += rowHeightAt(sheet, r)
  for (let r = sheet.rows - 1; r >= 0; r--) {
    const h = rowHeightAt(sheet, r)
    if (acc - h < g.y + g.h - 0.5) { r2 = r; break }
    acc -= h
  }

  return { r1, c1, r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}

function anchorFor(sheet: Sheet, g: ElementGeometry): ElementAnchor {
  const range = rangeOfRect(sheet, g)
  const rect = cellRect(sheet, range.r1, range.c1, range.r2 - range.r1 + 1, range.c2 - range.c1 + 1)
  return {
    mode: 'cell',
    row: range.r1,
    col: range.c1,
    rowSpan: range.r2 - range.r1 + 1,
    colSpan: range.c2 - range.c1 + 1,
    ox: rect.w ? (g.x - rect.x) / rect.w : 0,
    oy: rect.h ? (g.y - rect.y) / rect.h : 0,
    sw: rect.w ? g.w / rect.w : 1,
    sh: rect.h ? g.h / rect.h : 1
  }
}

/** 浮于单元格 → 固定单元格：保持当前视觉位置 */
export function anchorToCell(el: LayoutElement, sheet: Sheet): void {
  const g = resolveGeometry(el, sheet)
  el.anchor = anchorFor(sheet, g)
}

/** 固定单元格 → 浮于单元格：把换算后的几何固化，保持当前视觉位置 */
export function anchorToFree(el: LayoutElement, sheet: Sheet): void {
  const g = resolveGeometry(el, sheet)
  el.x = g.x
  el.y = g.y
  el.w = g.w
  el.h = g.h
  el.anchor = { mode: 'free', row: 0, col: 0, rowSpan: 1, colSpan: 1, ox: 0, oy: 0, sw: 1, sh: 1 }
}

/** 拖动结束后把元素重新锚定到落点所在的单元格区域（仅 cell 模式） */
export function reanchorAfterDrag(el: LayoutElement, sheet: Sheet): void {
  if (el.anchor.mode !== 'cell') return
  const g = resolveGeometry(el, sheet)
  el.anchor = anchorFor(sheet, g)
}

export function maxZ(elements: LayoutElement[]): number {
  return elements.reduce((m, e) => Math.max(m, e.zIndex), 0)
}

export interface CreateElementOptions {
  /** 插入位置：优先使用当前选区 */
  range?: CellRange
  /** 是否固定到单元格，默认 false（浮于单元格） */
  cell?: boolean
}

export function createElement(
  kind: ElementKind,
  sheet: Sheet,
  elements: LayoutElement[],
  opts: CreateElementOptions = {}
): LayoutElement {
  const meta = elementMeta(kind)
  let x: number
  let y: number
  let w = meta.w
  let h = meta.h

  if (opts.range) {
    const r = opts.range
    const rect = cellRect(sheet, r.r1, r.c1, r.r2 - r.r1 + 1, r.c2 - r.c1 + 1)
    x = rect.x + (rect.w - meta.w) / 2
    y = rect.y + (rect.h - meta.h) / 2
    // 选区很小的时候别让默认尺寸把元素挤爆，按比例收一档
    if (rect.w > 0 && rect.h > 0 && (rect.w < meta.w * 0.6 || rect.h < meta.h * 0.6)) {
      const k = Math.min(1, Math.max(0.45, Math.max(rect.w / meta.w, rect.h / meta.h)))
      w = Math.max(14, meta.w * k)
      h = Math.max(14, meta.h * k)
      x = rect.x + (rect.w - w) / 2
      y = rect.y + (rect.h - h) / 2
    }
  } else {
    x = sheet.originX + 40
    y = sheet.originY + 40
  }

  const el: LayoutElement = {
    id: `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    x,
    y,
    w,
    h,
    rotation: 0,
    color: meta.color,
    stroke: meta.stroke,
    strokeWidth: meta.strokeWidth,
    bordered: meta.bordered,
    text: meta.text,
    zIndex: maxZ(elements) + 1,
    anchor: { mode: 'free', row: 0, col: 0, rowSpan: 1, colSpan: 1, ox: 0, oy: 0, sw: 1, sh: 1 }
  }
  if (opts.cell) el.anchor = anchorFor(sheet, { x, y, w, h })
  return el
}

/** 兼容旧布局（没有 elements 字段）并修正越界锚定 */
export function normalizeElements(list: LayoutElement[] | undefined, sheet: Sheet): LayoutElement[] {
  const src = Array.isArray(list) ? list : []
  const out: LayoutElement[] = []
  for (const raw of src) {
    if (!raw || !raw.kind) continue
    if (!ELEMENT_LIBRARY.some((m) => m.kind === raw.kind)) continue
    const meta = elementMeta(raw.kind)
    const anchor: ElementAnchor = {
      mode: raw.anchor?.mode === 'cell' ? 'cell' : 'free',
      row: Number.isFinite(raw.anchor?.row) ? Math.max(0, Math.min(sheet.rows - 1, raw.anchor!.row)) : 0,
      col: Number.isFinite(raw.anchor?.col) ? Math.max(0, Math.min(sheet.cols - 1, raw.anchor!.col)) : 0,
      rowSpan: Math.max(1, raw.anchor?.rowSpan ?? 1),
      colSpan: Math.max(1, raw.anchor?.colSpan ?? 1),
      ox: Number.isFinite(raw.anchor?.ox) ? raw.anchor!.ox : 0,
      oy: Number.isFinite(raw.anchor?.oy) ? raw.anchor!.oy : 0,
      sw: Number.isFinite(raw.anchor?.sw) ? raw.anchor!.sw : 1,
      sh: Number.isFinite(raw.anchor?.sh) ? raw.anchor!.sh : 1
    }
    anchor.rowSpan = Math.max(1, Math.min(sheet.rows - anchor.row, anchor.rowSpan))
    anchor.colSpan = Math.max(1, Math.min(sheet.cols - anchor.col, anchor.colSpan))
    out.push({
      id: raw.id || `el-${Math.random().toString(36).slice(2, 9)}`,
      kind: raw.kind,
      x: Number.isFinite(raw.x) ? raw.x : sheet.originX,
      y: Number.isFinite(raw.y) ? raw.y : sheet.originY,
      w: Math.max(8, Number.isFinite(raw.w) ? raw.w : meta.w),
      h: Math.max(8, Number.isFinite(raw.h) ? raw.h : meta.h),
      rotation: Number.isFinite(raw.rotation) ? raw.rotation : 0,
      color: raw.color || meta.color,
      stroke: raw.stroke || meta.stroke,
      strokeWidth: Number.isFinite(raw.strokeWidth) ? raw.strokeWidth : meta.strokeWidth,
      bordered: raw.bordered ?? meta.bordered,
      text: raw.text ?? meta.text,
      fontSize: Number.isFinite(raw.fontSize) ? raw.fontSize : undefined,
      fontColor: raw.fontColor || undefined,
      fontFamily: raw.fontFamily || undefined,
      textAlign: raw.textAlign === 'left' || raw.textAlign === 'right' ? raw.textAlign : undefined,
      textVAlign:
        raw.textVAlign === 'top' || raw.textVAlign === 'middle' || raw.textVAlign === 'bottom'
          ? raw.textVAlign
          : undefined,
      textOffsetX: Number.isFinite(raw.textOffsetX) ? raw.textOffsetX : undefined,
      textOffsetY: Number.isFinite(raw.textOffsetY) ? raw.textOffsetY : undefined,
      zIndex: Number.isFinite(raw.zIndex) ? raw.zIndex : 1,
      anchor
    })
  }
  out.sort((a, b) => a.zIndex - b.zIndex)
  out.forEach((el, i) => { el.zIndex = i + 1 })
  return out
}

/** 行列增删后同步 cell 模式的锚定坐标，避免元素与所在格子脱节 */
export function shiftElementAnchors(
  elements: LayoutElement[],
  sheet: Sheet,
  op: { axis: 'row' | 'col'; at: number; count: number; remove: boolean }
): void {
  const limit = op.axis === 'row' ? sheet.rows : sheet.cols
  for (const el of elements) {
    if (el.anchor.mode !== 'cell') continue
    const key = op.axis === 'row' ? 'row' : 'col'
    const spanKey = op.axis === 'row' ? 'rowSpan' : 'colSpan'
    let start = el.anchor[key]
    let span = el.anchor[spanKey]
    if (op.remove) {
      const end = op.at + op.count
      if (start >= end) start -= op.count
      else if (start >= op.at) {
        // 锚定起点被删掉：贴到删除位置，跨度相应收缩
        span = Math.max(1, span - (Math.min(end, start + span) - start))
        start = op.at
      } else if (start + span > op.at) {
        span = Math.max(1, span - Math.min(op.count, start + span - op.at))
      }
    } else if (start >= op.at) {
      start += op.count
    }
    el.anchor[key] = Math.max(0, Math.min(limit - 1, start))
    el.anchor[spanKey] = Math.max(1, Math.min(limit - el.anchor[key], span))
  }
}

export type LayerAction = 'up' | 'down' | 'front' | 'back'

/** 调整层级：按当前 zIndex 排序后重新编号，保证相邻交换稳定 */
export function applyLayerAction(elements: LayoutElement[], id: string, action: LayerAction): void {
  const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
  const index = sorted.findIndex((e) => e.id === id)
  if (index < 0) return
  let target = index
  if (action === 'up') target = Math.min(sorted.length - 1, index + 1)
  if (action === 'down') target = Math.max(0, index - 1)
  if (action === 'front') target = sorted.length - 1
  if (action === 'back') target = 0
  if (target === index) return
  const [item] = sorted.splice(index, 1)
  sorted.splice(target, 0, item)
  sorted.forEach((el, i) => { el.zIndex = i + 1 })
}
