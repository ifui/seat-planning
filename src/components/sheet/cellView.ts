export interface CellView {
  key: string
  row: number
  col: number
  x: number
  y: number
  w: number
  h: number
  text: string
  label: string
  seats: number
  tone: string
  disabled: boolean
  fill?: string
  stroke?: string
  strokeStyle?: 'solid' | 'dashed' | 'dotted' | 'none'
  strokeWidth?: number
  borders?: ('top' | 'right' | 'bottom' | 'left')[]
  zoneId?: string
  textColor?: string
  align?: string
}
