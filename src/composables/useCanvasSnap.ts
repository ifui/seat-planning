import type { BaseElement } from '../types'

/** 8px 网格吸附 */
export function snapGrid(v: number): number {
  return Math.round(v / 8) * 8
}

export interface SnapResult {
  x: number
  y: number
  v: number | null
  h: number | null
}

export interface SnapTargets {
  elements: BaseElement[]
  canvasW: number
  canvasH: number
}

export interface SnapLines {
  xs: number[]
  ys: number[]
}

/**
 * 预计算对齐参考线。拖动过程中其它元素是静止的，因此参考线只需在按下时算一次，
 * 每帧不再遍历全部元素（263 元素时每帧可省掉 ~1600 次比较与两次数组分配）。
 */
export function buildSnapLines(targets: SnapTargets, excludeIds: string[] | Set<string>): SnapLines {
  const skip = excludeIds instanceof Set ? excludeIds : new Set(excludeIds)
  const xs: number[] = [0, targets.canvasW / 2, targets.canvasW]
  const ys: number[] = [0, targets.canvasH / 2, targets.canvasH]
  for (const t of targets.elements) {
    if (skip.has(t.id)) continue
    xs.push(t.x, t.x + t.w / 2, t.x + t.w)
    ys.push(t.y, t.y + t.h / 2, t.y + t.h)
  }
  return { xs, ys }
}

/** 对齐吸附：把移动框的左/中/右、上/中/下与参考线比对，取最近的一条 */
export function snapToLines(rect: { x: number; y: number; w: number; h: number }, lines: SnapLines, threshold: number): SnapResult {
  let bestX: { delta: number; line: number } | null = null
  for (const m of [rect.x, rect.x + rect.w / 2, rect.x + rect.w]) {
    for (const t of lines.xs) {
      const delta = t - m
      if (Math.abs(delta) > threshold) continue
      if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) bestX = { delta, line: t }
    }
  }
  let bestY: { delta: number; line: number } | null = null
  for (const m of [rect.y, rect.y + rect.h / 2, rect.y + rect.h]) {
    for (const t of lines.ys) {
      const delta = t - m
      if (Math.abs(delta) > threshold) continue
      if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) bestY = { delta, line: t }
    }
  }
  return {
    x: rect.x + (bestX?.delta ?? 0),
    y: rect.y + (bestY?.delta ?? 0),
    v: bestX?.line ?? null,
    h: bestY?.line ?? null
  }
}

/**
 * 一次性吸附（不在拖动热路径时使用）：构建参考线后立即比对。
 * 阈值按缩放比例换算，保证视觉上 6px 的吸附手感一致。
 */
export function computeSnap(
  rect: { x: number; y: number; w: number; h: number },
  excludeIds: string[] | Set<string>,
  targets: SnapTargets,
  scale = 1
): SnapResult {
  return snapToLines(rect, buildSnapLines(targets, excludeIds), 6 / (scale || 1))
}
