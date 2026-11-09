/**
 * ECharts 按需注册。
 * 只引入实际用到的 Bar / Pie 与坐标系、提示框、图例、标题，避免整包进入离线产物。
 */
import { init, use } from 'echarts/core'
import type { ComposeOption } from 'echarts/core'
import { BarChart, PieChart } from 'echarts/charts'
import type { BarSeriesOption, PieSeriesOption } from 'echarts/charts'
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import type { GridComponentOption, LegendComponentOption, TitleComponentOption, TooltipComponentOption } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

use([BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent, CanvasRenderer])

export type ChartOption = ComposeOption<
  BarSeriesOption | PieSeriesOption | GridComponentOption | TooltipComponentOption | LegendComponentOption | TitleComponentOption
>

/** 图表统一取色：与 ui/tokens.css 的 ai-fuly 变量保持一致。 */
export const chartColors = {
  primary: '#4a7c7b',
  success: '#3f8a63',
  warning: '#a8793b',
  info: '#4f7ba6',
  muted: '#8b93a0',
  textPrimary: '#1f2328',
  textSecondary: '#4d5866',
  border: '#e5e7eb',
  borderSoft: '#f0f1f3',
  bgHover: '#f3f4f6',
  bgPanel: '#ffffff'
} as const

export const chartFont = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'

/** 浮层样式与 ui.css 的菜单/面板保持一致：8px 圆角、轻阴影、12px 正文。 */
export const chartTooltip = {
  backgroundColor: chartColors.bgPanel,
  borderColor: chartColors.border,
  borderWidth: 1,
  padding: [8, 10] as [number, number],
  textStyle: { color: chartColors.textPrimary, fontSize: 12, fontFamily: chartFont },
  extraCssText: 'box-shadow: 0 4px 12px rgba(42, 41, 38, .08); border-radius: 8px;'
}

export const chartAxisText = {
  color: chartColors.textSecondary,
  fontSize: 12,
  fontFamily: chartFont
}

export { init }
