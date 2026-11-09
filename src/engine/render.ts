import type { Assignment, LayoutPackage, Member, RosterPlan, Seat } from '../types'
import { isSeatingElement } from '../types'
import { absSeat } from './geometry'

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

function shapePath(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  if (shape === 'circle') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  } else if (shape === 'diamond') {
    ctx.moveTo(x + w / 2, y)
    ctx.lineTo(x + w, y + h / 2)
    ctx.lineTo(x + w / 2, y + h)
    ctx.lineTo(x, y + h / 2)
    ctx.closePath()
  } else if (shape === 'triangle') {
    ctx.moveTo(x + w / 2, y)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
    ctx.closePath()
  } else {
    roundRect(ctx, x, y, w, h, r)
  }
}

export function renderSeatChart(opts: ChartOptions): HTMLCanvasElement {
  const { layout, roster, assignments } = opts
  const scale = opts.scale ?? 2
  const mode = opts.mode ?? 'seated'
  const els = layout.elements
  let minX = 0, minY = 0, maxX = layout.canvas.width, maxY = layout.canvas.height
  if (els.length) {
    minX = Math.min(...els.map((e) => e.x))
    minY = Math.min(...els.map((e) => e.y))
    maxX = Math.max(...els.map((e) => e.x + e.w))
    maxY = Math.max(...els.map((e) => e.y + e.h))
  }
  const pad = 40
  const headerH = 76
  const W = maxX - minX + pad * 2
  const H = maxY - minY + pad * 2 + headerH

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(H * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // 标题
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

  ctx.translate(pad - minX, headerH - minY)

  const memberById = new Map(roster.members.map((m) => [m.id, m]))
  const rankById = new Map(roster.ranks.map((r) => [r.id, r]))
  const assignBySeat = new Map<string, Assignment>()
  for (const a of assignments) assignBySeat.set(a.seatId, a)

  // 先画区域元素，避免遮挡
  for (const el of layout.elements) {
    if (el.type !== 'zone') continue
    const z = layout.zones.find((x) => x.id === el.id)
    ctx.fillStyle = (z?.color ?? '#F3F5F7') + ''
    ctx.globalAlpha = 0.5
    roundRect(ctx, el.x, el.y, el.w, el.h, 10)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = '#D8DEDF'
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#8A979D'
    ctx.font = '400 11px "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText((el as any).name ?? '', el.x + 8, el.y + 6)
  }

  for (const el of layout.elements) {
    if (el.type === 'zone') continue
    const st = el.style || {}
    const rot = el.rotation || 0
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    ctx.save()
    if (rot) {
      ctx.translate(cx, cy)
      ctx.rotate((rot * Math.PI) / 180)
      ctx.translate(-cx, -cy)
    }

    if (el.type === 'aisle') {
      ctx.fillStyle = st.fill ?? '#F1F3F4'
      roundRect(ctx, el.x, el.y, el.w, el.h, 0)
      ctx.fill()
      ctx.restore()
      continue
    }

    if (el.type === 'shape') {
      ctx.globalAlpha = st.opacity ?? 1
      ctx.fillStyle = st.fill ?? '#ECF1F3'
      ctx.strokeStyle = st.stroke ?? '#B9C7CE'
      ctx.lineWidth = 1
      shapePath(ctx, el.shape ?? 'rect', el.x, el.y, el.w, el.h, st.radius ?? 0)
      ctx.fill()
      ctx.stroke()
      ctx.globalAlpha = 1
      const shapeText = (el as any).text as string | undefined
      if (shapeText) {
        ctx.fillStyle = st.textColor ?? '#3D5A6C'
        const fs = fitFont(ctx, shapeText, el.w - 12, 13, 9)
        ctx.font = `400 ${fs}px "PingFang SC", "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(shapeText, el.x + el.w / 2, el.y + el.h / 2)
      }
      ctx.restore()
      continue
    }

    ctx.fillStyle = st.fill ?? '#FFFFFF'
    ctx.strokeStyle = st.stroke ?? '#DCE1E6'
    roundRect(ctx, el.x, el.y, el.w, el.h, st.radius ?? 8)
    ctx.fill()
    ctx.stroke()

    if (isSeatingElement(el)) {
      const seatFill = mode === 'layout' ? '#FAFBFB' : '#FFFFFF'
      for (const seat of el.seats) {
        const r = absSeat(el, seat)
        // absSeat 已含旋转，绘制时还原到元素本地坐标即可
        const local = seat
        const a = assignBySeat.get(seat.id)
        const m = a ? memberById.get(a.memberId) : undefined
        const rank = m ? rankById.get(m.rankId) : undefined
        if (seat.disabled) {
          const sx = el.x + local.x
          const sy = el.y + local.y
          ctx.fillStyle = '#F4F4F3'
          ctx.strokeStyle = '#E1E0DA'
          roundRect(ctx, sx, sy, local.w, local.h, 6)
          ctx.fill()
          ctx.stroke()
          // 斜纹填充，导出图中也能一眼识别「此位不坐人」
          ctx.save()
          ctx.beginPath()
          roundRect(ctx, sx, sy, local.w, local.h, 6)
          ctx.clip()
          ctx.strokeStyle = '#E6E5DF'
          ctx.lineWidth = 1
          for (let hx = sx - local.h; hx < sx + local.w; hx += 8) {
            ctx.beginPath()
            ctx.moveTo(hx, sy + local.h)
            ctx.lineTo(hx + local.h, sy)
            ctx.stroke()
          }
          ctx.restore()
          if (local.w > 34 && local.h > 22) {
            ctx.fillStyle = '#A5A299'
            const fs = fitFont(ctx, '空置', local.w - 4, 10, 7)
            ctx.font = `400 ${fs}px "PingFang SC", "Microsoft YaHei", sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText('空置', sx + local.w / 2, sy + local.h / 2)
          }
          continue
        }
        ctx.fillStyle = seatFill
        ctx.strokeStyle = '#DDE2E3'
        ctx.lineWidth = 1
        roundRect(ctx, el.x + local.x, el.y + local.y, local.w, local.h, 6)
        ctx.fill()
        ctx.stroke()

        if (m && mode === 'seated') {
          const isLeave = a?.status === 'leave'
          const name = m.name
          const nmSize = fitFont(ctx, name, seat.w - 6, 13, 8)
          ctx.fillStyle = isLeave ? '#A8B0B2' : '#26333A'
          ctx.font = `400 ${nmSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const ty = seat.h > 40 && rank ? el.y + local.y + local.h / 2 - 6 : el.y + local.y + local.h / 2
          ctx.fillText(name, el.x + local.x + local.w / 2, ty)
          if (rank && seat.h > 34) {
            ctx.fillStyle = rank.color
            ctx.font = '400 9px "PingFang SC", "Microsoft YaHei", sans-serif'
            ctx.fillText(rank.name, el.x + local.x + local.w / 2, el.y + local.y + local.h / 2 + 10)
          }
        } else if (mode === 'layout') {
          ctx.fillStyle = '#B3BCBE'
          ctx.font = '400 10px "PingFang SC", "Microsoft YaHei", sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(seat.index), el.x + local.x + local.w / 2, el.y + local.y + local.h / 2)
        }
      }
    } else {
      const any = el as any
      const text = any.text || any.label || ''
      if (text) {
        ctx.fillStyle = st.textColor ?? '#5C6B72'
        ctx.font = '400 13px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, el.x + el.w / 2, el.y + el.h / 2)
      }
    }
    ctx.restore()
  }

  return canvas
}
