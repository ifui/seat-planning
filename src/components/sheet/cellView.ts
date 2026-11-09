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
  fill?: string
  textColor?: string
  align?: string
}
