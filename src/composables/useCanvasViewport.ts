import { computed, nextTick, ref } from 'vue'

export interface CanvasSize {
  width: number
  height: number
}

/**
 * 画布视口的缩放 / 平移逻辑（不含元素与选择状态）。
 * 页面只负责把 viewport 绑到 DOM，其余 scale / 偏移 / 滚轮 / 空格拖拽都由这里维护。
 */
export function useCanvasViewport(getCanvas: () => CanvasSize | null) {
  const viewport = ref<HTMLElement | null>(null)
  const zoomMode = ref<'fit' | number>('fit')
  /** 视口 border-box 尺寸（含滚动条）。用 offsetWidth 而不是 contentRect：
   *  滚动条出现/消失不再改变测量值，缩放不会反过来触发滚动条，从根源上避免抖动。 */
  const fitWidth = ref(900)
  const fitHeight = ref(620)
  const SCROLLBAR_RESERVE = 14
  const STAGE_PAD = 26

  const viewW = computed(() => Math.max(240, fitWidth.value - SCROLLBAR_RESERVE))
  const viewH = computed(() => Math.max(200, fitHeight.value - SCROLLBAR_RESERVE))

  const scale = computed(() => {
    const canvas = getCanvas()
    if (!canvas) return 1
    if (zoomMode.value === 'fit') {
      const sx = (viewW.value - STAGE_PAD * 2) / canvas.width
      const sy = (viewH.value - STAGE_PAD * 2) / canvas.height
      return Math.min(1, Math.max(0.1, Math.min(sx, sy)))
    }
    return zoomMode.value
  })
  const zoomLabel = computed(() => `${Math.round(scale.value * 100)}%`)

  const stageOffset = computed(() => {
    const canvas = getCanvas()
    if (!canvas) return { x: STAGE_PAD, y: STAGE_PAD }
    const cw = canvas.width * scale.value
    const ch = canvas.height * scale.value
    return {
      x: Math.max(STAGE_PAD, Math.round((viewW.value - cw) / 2)),
      y: Math.max(STAGE_PAD, Math.round((viewH.value - ch) / 2))
    }
  })

  const sizerSize = computed(() => {
    const canvas = getCanvas()
    if (!canvas) return { w: viewW.value, h: viewH.value }
    const offset = stageOffset.value
    return {
      w: Math.max(viewW.value, canvas.width * scale.value + offset.x * 2),
      h: Math.max(viewH.value, canvas.height * scale.value + offset.y * 2)
    }
  })

  const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

  function zoomBy(dir: 1 | -1): void {
    const cur = scale.value
    const next = dir > 0
      ? ZOOM_STEPS.find((v) => v > cur + 0.002) ?? 2
      : [...ZOOM_STEPS].reverse().find((v) => v < cur - 0.002) ?? 0.1
    zoomMode.value = next
  }

  function fitToViewport(): void {
    zoomMode.value = 'fit'
    nextTick(() => {
      const vp = viewport.value
      if (!vp) return
      vp.scrollLeft = Math.max(0, (vp.scrollWidth - vp.clientWidth) / 2)
      vp.scrollTop = 0
    })
  }

  /** Ctrl + 滚轮：围绕指针缩放 */
  function onWheel(e: WheelEvent): void {
    if (!e.ctrlKey) return
    e.preventDefault()
    const vp = viewport.value
    if (!vp) return
    const old = scale.value
    const next = e.deltaY < 0 ? Math.min(2, old * 1.1) : Math.max(0.1, old / 1.1)
    zoomMode.value = Math.round(next * 100) / 100
    const settled = zoomMode.value as number
    const rect = vp.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const cx = (vp.scrollLeft + px) / old
    const cy = (vp.scrollTop + py) / old
    nextTick(() => {
      vp.scrollLeft = cx * settled - px
      vp.scrollTop = cy * settled - py
    })
  }

  const spaceDown = ref(false)
  const panning = ref(false)
  let panStart: { x: number; y: number; left: number; top: number } | null = null

  function maybePan(e: MouseEvent): void {
    const vp = viewport.value
    if (!vp) return
    if (!(spaceDown.value || e.button === 1)) return
    e.preventDefault()
    e.stopPropagation()
    panStart = { x: e.clientX, y: e.clientY, left: vp.scrollLeft, top: vp.scrollTop }
    panning.value = true
    window.addEventListener('mousemove', onPanMove)
    window.addEventListener('mouseup', onPanUp)
  }

  function onPanMove(e: MouseEvent): void {
    const vp = viewport.value
    if (!panStart || !vp) return
    vp.scrollLeft = panStart.left - (e.clientX - panStart.x)
    vp.scrollTop = panStart.top - (e.clientY - panStart.y)
  }

  function onPanUp(): void {
    panning.value = false
    panStart = null
    unbindPan()
  }

  function unbindPan(): void {
    window.removeEventListener('mousemove', onPanMove)
    window.removeEventListener('mouseup', onPanUp)
  }

  function syncViewportMetrics(): void {
    const vp = viewport.value
    if (!vp) return
    fitWidth.value = Math.max(240, vp.offsetWidth)
    fitHeight.value = Math.max(200, vp.offsetHeight)
  }

  return {
    viewport,
    zoomMode,
    fitWidth,
    fitHeight,
    viewW,
    viewH,
    scale,
    zoomLabel,
    stageOffset,
    sizerSize,
    zoomBy,
    fitToViewport,
    onWheel,
    spaceDown,
    panning,
    maybePan,
    onPanMove,
    onPanUp,
    unbindPan,
    syncViewportMetrics
  }
}
