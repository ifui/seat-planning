import type { BaseElement, LayoutPackage, SeatingElement, Seat, ShapeKind } from '../types'
import { isSeatingElement } from '../types'

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}

export interface AbsSeat {
  seat: Seat
  element: SeatingElement
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  zoneId?: string
  stage: boolean
  /** 网格行号（0 起），来自元素所属单元格；未入格则为 undefined */
  gridRow?: number
  /** 网格列号（0 起），来自元素所属单元格 */
  gridCol?: number
}

/** 计算座位在画布上的绝对矩形（支持任意角度旋转，取旋转后的外接矩形） */
export function absSeat(el: SeatingElement, seat: Seat): { x: number; y: number; w: number; h: number } {
  const rot = ((el.rotation || 0) % 360 + 360) % 360
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  // 座位中心相对元素中心
  const dx = seat.x + seat.w / 2 - el.w / 2
  const dy = seat.y + seat.h / 2 - el.h / 2
  const rad = (rot * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  const w = Math.abs(seat.w * cos) + Math.abs(seat.h * sin)
  const h = Math.abs(seat.w * sin) + Math.abs(seat.h * cos)
  return { x: cx + rx - w / 2, y: cy + ry - h / 2, w, h }
}

export function collectSeats(layout: LayoutPackage, opts: { includeDisabled?: boolean } = {}): AbsSeat[] {
  const out: AbsSeat[] = []
  for (const el of layout.elements) {
    if (!isSeatingElement(el)) continue
    const zone = el.zoneId
    const zoneDef = zone ? layout.zones.find((z) => z.id === zone) : undefined
    const stage = el.type === 'hostTable' || el.arrangeMode === 'podium' || zoneDef?.ruleTag === 'podium'
    const inGrid = !!layout.grid && !!el.cell
    for (const seat of el.seats) {
      if (seat.disabled && !opts.includeDisabled) continue
      const r = absSeat(el, seat)
      out.push({
        seat,
        element: el,
        ...r,
        cx: r.x + r.w / 2,
        cy: r.y + r.h / 2,
        zoneId: zone,
        stage,
        gridRow: inGrid ? el.cell!.row : undefined,
        gridCol: inGrid ? el.cell!.col : undefined
      })
    }
  }
  return out
}

/** 按 y 聚类成「排」，返回每排座位（按 x 升序） */
export function groupRows(seats: AbsSeat[]): AbsSeat[][] {
  const sorted = [...seats].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
  const rows: AbsSeat[][] = []
  let cur: AbsSeat[] = []
  let lastY = -1e9
  for (const s of sorted) {
    if (cur.length && Math.abs(s.cy - lastY) > Math.max(18, s.h * 0.5)) {
      rows.push(cur)
      cur = []
    }
    cur.push(s)
    lastY = s.cy
  }
  if (cur.length) rows.push(cur)
  for (const r of rows) r.sort((a, b) => a.cx - b.cx)
  return rows
}

/** 依 8pt 栅格生成默认座位槽 */
export function makeSeats(el: Pick<SeatingElement, 'w' | 'h' | 'capacity' | 'type'>): Seat[] {
  const gap = 8
  const pad = 10
  if (el.type === 'lectern') {
    return [{
      id: uid('seat'), index: 1,
      x: pad, y: pad, w: Math.max(24, el.w - pad * 2), h: Math.max(24, el.h - pad * 2)
    }]
  }
  const n = el.capacity
  const innerW = Math.max(20, el.w - pad * 2)
  const innerH = Math.max(20, el.h - pad * 2)
  const seatW = n === 1 ? innerW : (innerW - gap * (n - 1)) / n
  const seats: Seat[] = []
  for (let i = 0; i < n; i++) {
    seats.push({
      id: uid('seat'),
      index: i + 1,
      x: pad + i * (seatW + gap),
      y: pad,
      w: seatW,
      h: innerH
    })
  }
  return seats
}

export function makeTable(x: number, y: number, w = 160, h = 84, capacity: 1 | 2 = 1, type: 'table' | 'hostTable' = 'table'): SeatingElement {
  const el: SeatingElement = {
    id: uid(type === 'hostTable' ? 'host' : 'table'),
    type,
    x, y, w, h,
    rotation: 0,
    capacity,
    seats: [],
    style: { fill: '#FFFFFF', stroke: '#DCE1E6', radius: 10, textColor: '#33424B' }
  }
  el.seats = makeSeats(el)
  if (type === 'hostTable') el.arrangeMode = 'podium'
  return el
}

export function makePlain(type: 'podium' | 'aisle' | 'zone' | 'label', x: number, y: number, w: number, h: number): BaseElement {
  const base: BaseElement = {
    id: uid(type),
    type, x, y, w, h,
    rotation: 0,
    style: { fill: type === 'aisle' ? '#F1F3F4' : '#FFFFFF', stroke: '#E1E5E9', radius: type === 'aisle' ? 0 : 8 }
  }
  return base
}

/** 装饰/标识用几何图形 */
export function makeShape(shape: ShapeKind, x: number, y: number, w: number, h: number): BaseElement {
  return {
    id: uid('shape'),
    type: 'shape',
    shape,
    x, y, w, h,
    rotation: 0,
    text: '',
    style: { fill: '#ECF1F3', stroke: '#B9C7CE', radius: shape === 'square' || shape === 'rect' ? 8 : 0, opacity: 1, textColor: '#3D5A6C' }
  }
}

/** 新建空白布局：讲台 + 一条主席台 */
export function createBlankLayout(name = '新布局'): LayoutPackage {
  const host = makeTable(240, 150, 720, 92, 1, 'hostTable')
  host.seats = []
  const n = 7
  const pad = 12
  const gap = 8
  const seatW = (host.w - pad * 2 - gap * (n - 1)) / n
  for (let i = 0; i < n; i++) {
    host.seats.push({ id: uid('hs'), index: i + 1, x: pad + i * (seatW + gap), y: pad, w: seatW, h: host.h - pad * 2 })
  }
  const podium: BaseElement = {
    ...makePlain('podium', 480, 40, 240, 52),
    style: { fill: '#EEF2F4', stroke: '#DDE3E7', radius: 10 }
  }
  ;(podium as any).text = '讲  台'
  const aisle = makePlain('aisle', 575, 280, 34, 420)
  return {
    schemaVersion: '1.0',
    id: uid('layout'),
    name,
    canvas: { width: 1200, height: 760, background: '#FFFFFF' },
    zones: [
      { id: 'zone-stage', name: '主席台', color: '#DCE4EE', ruleTag: 'podium' },
      { id: 'zone-front', name: '前排', color: '#E8EDF3', ruleTag: 'front' }
    ],
    elements: [podium, host, aisle],
    groups: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  }
}
