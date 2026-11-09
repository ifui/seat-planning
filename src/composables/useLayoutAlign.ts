import type { BaseElement } from '../types'
import type { AlignKey } from '../components/layout/options'

/** 对齐：以选区外接框为基准移动元素 */
export function alignElements(els: BaseElement[], key: AlignKey): void {
  if (els.length < 2) return
  const minX = Math.min(...els.map((e) => e.x))
  const maxR = Math.max(...els.map((e) => e.x + e.w))
  const minY = Math.min(...els.map((e) => e.y))
  const maxB = Math.max(...els.map((e) => e.y + e.h))
  for (const el of els) {
    if (key === 'left') el.x = minX
    if (key === 'hcenter') el.x = Math.round((minX + maxR) / 2 - el.w / 2)
    if (key === 'right') el.x = maxR - el.w
    if (key === 'top') el.y = minY
    if (key === 'vcenter') el.y = Math.round((minY + maxB) / 2 - el.h / 2)
    if (key === 'bottom') el.y = maxB - el.h
  }
}

/** 等间距分布：首尾元素不动，中间元素按剩余空间均分 */
export function distributeElements(els: BaseElement[], axis: 'h' | 'v'): void {
  if (els.length < 3) return
  const sorted = [...els].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (axis === 'h') {
    const span = last.x + last.w - first.x
    const total = sorted.reduce((s, e) => s + e.w, 0)
    const gap = (span - total) / (sorted.length - 1)
    let cursor = first.x
    for (const e of sorted) {
      e.x = Math.round(cursor)
      cursor += e.w + gap
    }
  } else {
    const span = last.y + last.h - first.y
    const total = sorted.reduce((s, e) => s + e.h, 0)
    const gap = (span - total) / (sorted.length - 1)
    let cursor = first.y
    for (const e of sorted) {
      e.y = Math.round(cursor)
      cursor += e.h + gap
    }
  }
}
