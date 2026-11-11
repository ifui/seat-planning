import type { Assignment, LayoutPackage, Member, RosterPlan, SheetCell } from '../types'
import { cellRect, cellAt, collectBorderLines, isCovered, mergeAt, seatsInRow, sheetSize } from './sheet'
import { ELEMENT_SHAPES, elementMeta, elementTextAlign, elementTextColor, elementTextOffset, elementTextPadding, elementTextVAlign, resolveGeometry } from './elements'

export interface ChartOptions {
  layout: LayoutPackage
  roster: RosterPlan
  assignments: Assignment[]
  title?: string
  subtitle?: string
  scale?: number
  mode?: 'seated' | 'layout'
  /** 是否在座位左上角画序号，与画布开关一致 */
  showSeatNumbers?: boolean
  /** 座位下方信息：职级（缺省显示） */
  showRank?: boolean
  /** 座位下方信息：职务（缺省隐藏） */
  showDuty?: boolean
  /** 座位下方信息：单位（缺省隐藏） */
  showUnit?: boolean
  /** 序号取座位顺序（与画布 hit 顺序一致）；缺省用排内座号 */
  seatNumbers?: Map<string, number>
  /** 固定座位：seatId → memberId；导出时在座位右上角画锁标识 */
  fixedSeats?: Record<string, string>
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, base: number, min = 8): number {
  let size = base
  ctx.font = `400 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`
  while (size > min && ctx.measureText(text).width > maxW) {
    size -= 0.5
    ctx.font = `400 ${size}px "PingFang SC", "Microsoft YaHei", sans-serif`
  }
  return size
}

/** 固定座位标识：右上角小锁，克制尺寸，不影响姓名/座号/职级 */
function drawSeatLock(ctx: CanvasRenderingContext2D, x: number, y: number, size = 7): void {
  const k = size / 7
  ctx.save()
  ctx.strokeStyle = '#7C8A90'
  ctx.fillStyle = '#7C8A90'
  ctx.lineWidth = Math.max(0.8, 0.9 * k)
  // 锁梁
  ctx.beginPath()
  ctx.arc(x + 3.5 * k, y + 3 * k, 1.9 * k, Math.PI, 0)
  ctx.stroke()
  // 锁体
  roundRect(ctx, x + k, y + 3 * k, 5 * k, 4 * k, k)
  ctx.fill()
  ctx.restore()
}

const BLOCK_FILL: Record<string, string> = {
  aisle: '#F4F6F7',
  lectern: '#E8EEF0',
  backdrop: '#DFE7EA',
  label: '#FCFDFD'
}

export function renderSeatChart(opts: ChartOptions): HTMLCanvasElement {
  const { layout, roster, assignments } = opts
  const scale = opts.scale ?? 2
  const mode = opts.mode ?? 'seated'
  const s = layout.sheet
  const size = sheetSize(s)
  const pad = 44
  const headerH = 76
  const W = size.w + pad * 2 + 40
  const H = size.h + pad * 2 + headerH

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(H * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // 不坐人用的斜纹填充：与画布、打印保持同一套细斜线
  const hatch = (() => {
    const c = document.createElement('canvas')
    c.width = 7
    c.height = 7
    const p = c.getContext('2d')!
    p.fillStyle = '#FAFBFC'
    p.fillRect(0, 0, 7, 7)
    p.strokeStyle = 'rgba(205, 210, 217, 0.9)'
    p.lineWidth = 0.8
    p.beginPath()
    p.moveTo(-1, 8)
    p.lineTo(8, -1)
    p.stroke()
    return ctx.createPattern(c, 'repeat')!
  })()

  ctx.fillStyle = '#26333A'
  const title = opts.title || '座位表'
  const ts = fitFont(ctx, title, W - pad * 2 - 120, 22, 14)
  ctx.font = `500 ${ts}px "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(title, pad, 30)
  if (opts.subtitle) {
    ctx.fillStyle = '#8A979D'
    ctx.font = '400 11px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.fillText(opts.subtitle, pad, 54)
  }
  ctx.strokeStyle = '#E4E7E6'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad, headerH - 12)
  ctx.lineTo(W - pad, headerH - 12)
  ctx.stroke()

  ctx.translate(pad, headerH)
  const memberById = new Map<string, Member>(roster.members.map((m) => [m.id, m]))
  const rankById = new Map(roster.ranks.map((r) => [r.id, r]))
  const unitById = new Map(roster.units.map((u) => [u.id, u]))
  const showRank = opts.showRank !== false
  const showDuty = opts.showDuty === true
  const showUnit = opts.showUnit === true
  const assignBySeat = new Map<string, Assignment>()
  for (const a of assignments) assignBySeat.set(a.seatId, a)

  // 排号在左侧
  for (let row = 0; row < s.rows; row++) {
    const rect = cellRect(s, row, 0)
    ctx.fillStyle = '#98A5AA'
    ctx.font = '400 10px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${row + 1}`, rect.x - 10, rect.y + rect.h / 2)
  }

  // 先画特殊块（合并区/过道/讲台/背景板）
  for (let row = 0; row < s.rows; row++) {
    for (let col = 0; col < s.cols; col++) {
      if (isCovered(s, row, col)) continue
      const cell = cellAt(s, row, col)
      if (!cell || cell.kind !== 'block') continue
      const m = mergeAt(s, row, col)
      const rect = cellRect(s, row, col, m?.rowSpan ?? 1, m?.colSpan ?? 1)
      ctx.fillStyle = cell.style?.fill ?? BLOCK_FILL[cell.role ?? 'label'] ?? '#F7F8F9'
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 0)
      ctx.fill()
      if (cell.text) {
        ctx.fillStyle = cell.style?.textColor ?? '#7C8A90'
        ctx.font = '400 12px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(cell.text, rect.x + rect.w / 2, rect.y + rect.h / 2)
      }
    }
  }

  // 再画座位
  for (let row = 0; row < s.rows; row++) {
    const seats = seatsInRow(s, row)
    for (const seat of seats) {
      const a = assignBySeat.get(seat.seatId)
      const mbr = a ? memberById.get(a.memberId) : undefined
      const rank = mbr ? rankById.get(mbr.rankId) : undefined
      if (seat.disabled) {
        ctx.fillStyle = hatch
        roundRect(ctx, seat.x, seat.y, seat.w, seat.h, 0)
        ctx.fill()
        continue
      }
      const isLeave = mode === 'seated' && a?.status === 'leave'
      let fill = seat.stage ? '#E6EFF0' : '#F5F9F9'
      if (mode === 'seated') {
        if (mbr) fill = isLeave ? '#FBF5E9' : '#F4F9F8'
        else fill = '#FCFDFD'
      }
      ctx.fillStyle = fill
      // 直角；不画默认描边，导出只保留用户显式设置的边框
      roundRect(ctx, seat.x, seat.y, seat.w, seat.h, 0)
      ctx.fill()

      if (mbr && mode === 'seated') {
        // 用很淡的职级底色区分，不再画左侧彩色竖线
        ctx.save()
        ctx.globalAlpha = 0.1
        ctx.fillStyle = isLeave ? '#C9A227' : rank?.color || '#5B7C7B'
        ctx.fillRect(seat.x, seat.y, seat.w, seat.h)
        ctx.restore()
        const meta: string[] = []
        if (showRank && rank) meta.push(rank.name)
        if (showDuty && mbr.duty) meta.push(mbr.duty)
        if (showUnit) {
          const unit = mbr.unitId ? unitById.get(mbr.unitId) : undefined
          if (unit) meta.push(unit.name)
        }
        const metaSize = 8
        const lineH = 8.6
        const metaH = meta.length * lineH
        const nmSize = fitFont(ctx, mbr.name, seat.w - 12, seat.h > 30 ? 11 : 10, 8)
        ctx.fillStyle = isLeave ? '#8C7A4A' : '#26333A'
        ctx.font = `400 ${nmSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        // 姓名居中；信息行按开关逐行显示，裁剪在座位格内避免溢出
        const cx = seat.x + seat.w / 2
        const nameY = seat.y + seat.h / 2 - metaH / 2
        ctx.save()
        ctx.beginPath()
        ctx.rect(seat.x + 1, seat.y + 1, Math.max(1, seat.w - 2), Math.max(1, seat.h - 2))
        ctx.clip()
        ctx.fillText(mbr.name, cx, nameY)
        for (let i = 0; i < meta.length; i++) {
          ctx.fillStyle = i === 0 && showRank && rank ? rank.color : '#7C8A90'
          ctx.font = `400 ${metaSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
          ctx.fillText(meta[i], cx, nameY + nmSize / 2 + lineH * (i + 0.55))
        }
        ctx.restore()
      } else if (mode === 'layout') {
        ctx.fillStyle = '#B3BCBE'
        ctx.font = '400 10px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${seat.seatNo}`, seat.x + seat.w / 2, seat.y + seat.h / 2)
      }
      // 左上角座位序号：与画布一致，受开关控制
      if (mode === 'seated' && opts.showSeatNumbers) {
        const no = opts.seatNumbers?.get(seat.seatId) ?? seat.seatNo
        ctx.fillStyle = '#A8B1B5'
        ctx.font = '400 8px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'top'
        ctx.fillText(`${no}`, seat.x + 3, seat.y + 1)
      }
      // 固定座位锁标识：与画布一致，图片与打印均保留
      if (mode === 'seated' && opts.fixedSeats?.[seat.seatId] && seat.w >= 16) {
        drawSeatLock(ctx, seat.x + seat.w - 9.5, seat.y + 2)
      }
    }
  }

  // 边框：整表统一收集并去重（与画布同一份数据），按导出倍率对齐设备像素
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  const ox = Math.round(pad * scale)
  const oy = Math.round(headerH * scale)
  for (const line of collectBorderLines(s)) {
    const wpx = Math.max(1, Math.round(line.width * scale))
    const offset = wpx % 2 === 1 ? 0.5 : 0
    const snap = (v: number): number => Math.round(v * scale - offset) + offset
    ctx.strokeStyle = line.color
    ctx.lineWidth = wpx
    ctx.setLineDash(
      line.dash === 'dashed'
        ? [6 * scale, 4 * scale]
        : line.dash === 'dotted'
          ? [2 * scale, 3 * scale]
          : []
    )
    ctx.beginPath()
    ctx.moveTo(ox + snap(line.x1), oy + snap(line.y1))
    ctx.lineTo(ox + snap(line.x2), oy + snap(line.y2))
    ctx.stroke()
  }
  ctx.restore()

  // 自由元素：与画布同一份几何、同一套图形路径，位置比例一致
  ctx.save()
  const elementList = [...(layout.elements ?? [])].sort((a, b) => a.zIndex - b.zIndex)
  for (const el of elementList) {
    const g = resolveGeometry(el, layout.sheet)
    if (g.w <= 0 || g.h <= 0) continue
    const shape = ELEMENT_SHAPES[el.kind]
    const rad = (el.rotation * Math.PI) / 180
    const cx = g.x + g.w / 2
    const cy = g.y + g.h / 2
    const strokeW = (100 * el.strokeWidth) / Math.max(16, Math.min(g.w, g.h))
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rad)
    ctx.translate(-g.w / 2, -g.h / 2)
    ctx.scale(g.w / 100, g.h / 100)
    const path = new Path2D(shape.fill)
    ctx.fillStyle = el.color
    ctx.fill(path)
    if (el.bordered) {
      ctx.strokeStyle = el.stroke
      ctx.lineWidth = strokeW
      ctx.lineJoin = 'round'
      ctx.stroke(path)
    }
    if (shape.lines?.length) {
      ctx.strokeStyle = el.stroke
      ctx.lineWidth = strokeW
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const d of shape.lines) ctx.stroke(new Path2D(d))
    }
    ctx.restore()

    if (el.text) {
      const meta = elementMeta(el.kind)
      const fs = Math.max(6, el.fontSize ?? Math.max(8, Math.min(26, g.h * meta.textRatio)))
      const align = elementTextAlign(el)
      const vAlign = elementTextVAlign(el)
      const offset = elementTextOffset(el)
      const padding = elementTextPadding(el)
      const padX = padding.x * g.w
      const padY = padding.y * g.h
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(rad)
      ctx.fillStyle = el.fontColor || elementTextColor(el.kind)
      ctx.font = `${el.kind === 'person' ? 500 : 600} ${fs}px ${el.fontFamily || '"PingFang SC", "Microsoft YaHei", sans-serif'}`
      ctx.textAlign = align
      ctx.textBaseline = vAlign === 'middle' ? 'middle' : vAlign === 'top' ? 'top' : 'bottom'
      const tx =
        (align === 'left' ? -g.w / 2 + padX : align === 'right' ? g.w / 2 - padX : 0) + offset.x
      const ty =
        (vAlign === 'top' ? -g.h / 2 + padY : vAlign === 'bottom' ? g.h / 2 - padY : 0) + offset.y
      ctx.fillText(el.text, tx, ty, Math.max(10, g.w - padX * 2))
      ctx.restore()
    }
  }
  ctx.restore()

  return canvas
}

/** 单元格导出用：按类型取默认文字 */
export function cellText(cell: SheetCell): string {
  return cell.text ?? cell.tableLabel ?? ''
}
