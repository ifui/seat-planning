import type { Assignment, LayoutPackage, Member, RosterPlan, SheetCell } from '../types'
import { cellRect, cellAt, isCovered, mergeAt, seatsInRow, sheetSize } from './sheet'

export interface ChartOptions {
  layout: LayoutPackage
  roster: RosterPlan
  assignments: Assignment[]
  title?: string
  subtitle?: string
  scale?: number
  mode?: 'seated' | 'layout'
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

const BLOCK_FILL: Record<string, string> = {
  aisle: '#F0F2F3',
  lectern: '#E7ECEF',
  backdrop: '#E4E9EC',
  label: '#F7F8F9'
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
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 6)
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
        ctx.fillStyle = '#F4F4F3'
        ctx.strokeStyle = '#E1E0DA'
        roundRect(ctx, seat.x, seat.y, seat.w, seat.h, 6)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#A5A299'
        ctx.font = '400 10px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (seat.w > 34 && seat.h > 22) ctx.fillText('空置', seat.x + seat.w / 2, seat.y + seat.h / 2)
        continue
      }
      ctx.fillStyle = mode === 'layout' ? '#FAFBFB' : '#FFFFFF'
      ctx.strokeStyle = seat.stage ? '#C9D3DB' : '#DDE2E3'
      ctx.lineWidth = 1
      roundRect(ctx, seat.x, seat.y, seat.w, seat.h, 6)
      ctx.fill()
      ctx.stroke()

      if (mbr && mode === 'seated') {
        const isLeave = a?.status === 'leave'
        const nmSize = fitFont(ctx, mbr.name, seat.w - 6, 13, 8)
        ctx.fillStyle = isLeave ? '#A8B0B2' : '#26333A'
        ctx.font = `400 ${nmSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const ty = seat.h > 40 && rank ? seat.y + seat.h / 2 - 6 : seat.y + seat.h / 2
        ctx.fillText(mbr.name, seat.x + seat.w / 2, ty)
        if (rank && seat.h > 34) {
          ctx.fillStyle = rank.color
          ctx.font = '400 9px "PingFang SC", "Microsoft YaHei", sans-serif'
          ctx.fillText(rank.name, seat.x + seat.w / 2, seat.y + seat.h / 2 + 10)
        }
      } else if (mode === 'layout') {
        ctx.fillStyle = '#B3BCBE'
        ctx.font = '400 10px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${seat.seatNo}`, seat.x + seat.w / 2, seat.y + seat.h / 2)
      }
    }
  }

  return canvas
}

/** 单元格导出用：按类型取默认文字 */
export function cellText(cell: SheetCell): string {
  return cell.text ?? cell.tableLabel ?? ''
}
