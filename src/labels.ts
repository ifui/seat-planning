import type { BaseElement } from './types'

export const TYPE_LABEL: Record<string, string> = {
  table: '会议桌',
  hostTable: '主席台',
  podium: '讲台',
  lectern: '演讲台',
  aisle: '过道',
  zone: '区域',
  label: '标注',
  shape: '图形'
}

/** 图层列表展示名：优先用户填写的文本/标签，否则退回类型名 */
export function elTitle(e: BaseElement): string {
  const any = e as unknown as { text?: string; label?: string; name?: string }
  return any.text || any.label || any.name || TYPE_LABEL[e.type] || '元素'
}
