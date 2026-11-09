import type { ElementType, ShapeKind } from '../../types'

/** 布局编辑器里的选项常量：添加菜单、图形、字体、色板、区域标签等。 */

export const SHAPE_LABEL: Record<string, string> = {
  rect: '长方形', square: '正方形', circle: '圆形', diamond: '菱形', triangle: '三角形'
}

export const SHAPE_OPTIONS = [
  { value: 'rect', label: '长方形' },
  { value: 'square', label: '正方形' },
  { value: 'circle', label: '圆形' },
  { value: 'diamond', label: '菱形' },
  { value: 'triangle', label: '三角形' }
]

export const ADD_ITEMS: { key: ElementType; label: string; icon: string; hint: string }[] = [
  { key: 'table', label: '桌子', icon: 'table', hint: '会议桌，可设单人/双人位' },
  { key: 'hostTable', label: '主席台', icon: 'host', hint: '长条主席台，多座位' },
  { key: 'podium', label: '讲台', icon: 'podium', hint: '带文字的讲台' },
  { key: 'lectern', label: '演讲台', icon: 'lectern', hint: '单人演讲台' },
  { key: 'aisle', label: '过道', icon: 'aisle', hint: '纵向过道分隔' },
  { key: 'zone', label: '区域', icon: 'zone', hint: '同时加入区域列表' },
  { key: 'label', label: '标注', icon: 'label', hint: '纯文字标注' }
]

export const SHAPE_MENU: { value: ShapeKind; label: string }[] = [
  { value: 'rect', label: '长方形' },
  { value: 'square', label: '正方形' },
  { value: 'circle', label: '圆形' },
  { value: 'diamond', label: '菱形' },
  { value: 'triangle', label: '三角形' }
]

export const FONT_FAMILIES = [
  { value: '', label: '系统默认' },
  { value: "'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',system-ui,sans-serif", label: '无衬线（界面）' },
  { value: "'Microsoft YaHei','PingFang SC',sans-serif", label: '黑体' },
  { value: "'Songti SC','SimSun',serif", label: '宋体 / 衬线' },
  { value: "'KaiTi','STKaiti',serif", label: '楷体' },
  { value: "'Consolas','SFMono-Regular',monospace", label: '等宽' }
]

export const FONT_WEIGHTS = [
  { value: 300, label: '细' },
  { value: 400, label: '常规' },
  { value: 500, label: '中等' },
  { value: 600, label: '半粗' },
  { value: 700, label: '粗' }
]

export const TEXT_ALIGNS = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' }
]

export const RULE_TAG_LABEL: Record<string, string> = {
  podium: '主席台', front: '前排', vip: '贵宾', staff: '工作席', other: '普通'
}

export const RULE_TAG_OPTIONS = [
  { value: 'podium', label: '主席台 · 按主席台规则' },
  { value: 'front', label: '前排' },
  { value: 'vip', label: '贵宾' },
  { value: 'staff', label: '工作席' },
  { value: 'other', label: '普通' }
]

export const FILLS = ['#FFFFFF', '#F7F6F2', '#F1F3F4', '#ECF1F3', '#E8EDF3', '#F4ECE2', '#E3EAE4', '#DCE4EE']
export const STROKES = ['#DCE1E6', '#C6CFD4', '#B9C7CE', '#E1E5E9', '#DCCBB6', '#A4774E', '#D6D3CA', '#939B9A']
export const ZONE_COLORS = ['#DCE4EE', '#E8EDF3', '#EEF2F4', '#F4ECE2', '#ECF1F3', '#F1F0EA', '#E3EAE4', '#F3EEF0']

export const ALIGN_ACTIONS = [
  { key: 'left', title: '左对齐', icon: 'alignLeft' },
  { key: 'hcenter', title: '水平居中对齐', icon: 'alignHCenter' },
  { key: 'right', title: '右对齐', icon: 'alignRight' },
  { key: 'top', title: '上对齐', icon: 'alignTop' },
  { key: 'vcenter', title: '垂直居中对齐', icon: 'alignVCenter' },
  { key: 'bottom', title: '下对齐', icon: 'alignBottom' }
] as const

export type AlignKey = typeof ALIGN_ACTIONS[number]['key']
