/** 批量生成桌子的参数（生成对话框与页面之间的契约） */
export interface GenOptions {
  rows: number
  /** 列块分布，如 [2,7,2] 表示三组、组间留过道 */
  blocks: number[]
  capacity: 1 | 2
  w: number
  h: number
  gapX: number
  gapY: number
  blockGap: number
  startX: number
  startY: number
  center: boolean
  zoneId: string
}
