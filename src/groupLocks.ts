import type { BaseElement, LayerGroup } from './types'

/** 分组锁定的统一判定：组锁 = 组内所有元素锁定 */
export function lockedGroupSet(groups?: LayerGroup[]): Set<string> {
  return new Set((groups ?? []).filter((g) => g.locked).map((g) => g.id))
}

export function isElementLocked(el: BaseElement, lockedGroups: Set<string>): boolean {
  return !!el.locked || (!!el.groupId && lockedGroups.has(el.groupId))
}
