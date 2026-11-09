import type { Seat, SeatingElement } from '../../types'
import { makeSeats, uid } from '../../engine/geometry'

/** 主席台等需要「桌面内均匀分布 n 个座位」的场景 */
export function buildDistributedSeats(el: SeatingElement, n: number): Seat[] {
  const pad = 12
  const gap = 8
  const w = Math.max(20, (el.w - pad * 2 - gap * (n - 1)) / n)
  const seats: Seat[] = []
  for (let i = 0; i < n; i++) {
    seats.push({
      id: uid('seat'), index: i + 1,
      x: pad + i * (w + gap), y: pad, w, h: Math.max(20, el.h - pad * 2)
    })
  }
  return seats
}

/** 按当前元素尺寸重排座位几何，保留原座位 id / 序号 / 空位标记，避免排座结果失效 */
export function reflowSeats(el: SeatingElement): void {
  const n = el.type === 'hostTable' && el.seats.length > 2 ? el.seats.length : el.capacity
  const fresh = el.type === 'hostTable' && n > 2 ? buildDistributedSeats(el, n) : makeSeats(el)
  const prev = el.seats
  el.seats = fresh.map((s, i) => ({
    ...s,
    id: prev[i]?.id ?? s.id,
    index: prev[i]?.index ?? s.index,
    disabled: prev[i]?.disabled ?? false
  }))
}
