/**
 * 下拉弹层定位：触发器坐标系 → 视口坐标系（position: fixed + Teleport）。
 *
 * 约定：
 * - 弹层贴住触发器下方 4px，左边缘与触发器对齐（align=right 时右对齐）；
 * - 宽度默认不小于触发器，也可指定固定宽度；
 * - 下方空间不足且上方更宽裕时向上翻转；两边都放不下时选空间较大的一侧；
 * - 高度按视口兜底：最多取可用空间的 90%，超出才内部滚动，且不超出视口；
 * - 页面滚动 / 窗口缩放 / 触发器尺寸变化时实时重算，而不是关闭弹层。
 */
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

export interface AnchoredPopupOptions {
  /** 与触发器的间距，默认 4px */
  gap?: number
  /** 最小宽度，默认跟随触发器 */
  minWidth?: number
  /** 固定宽度（设置后不再跟随触发器） */
  width?: number
  /** 对齐方式：left = 左对齐触发器，right = 右对齐触发器 */
  align?: 'left' | 'right'
  /** 弹层最大高度，默认 320；传 0 表示不设业务上限，仅受视口兜底约束 */
  maxHeight?: number
  /** 视口四周安全边距，默认 12 */
  margin?: number
}

export interface AnchoredPopup {
  panelStyle: Ref<Record<string, string>>
  place: () => void
  bind: (on: boolean) => void
}

export function useAnchoredPopup(
  open: Ref<boolean>,
  triggerRef: Ref<HTMLElement | null>,
  panelRef: Ref<HTMLElement | null>,
  options: AnchoredPopupOptions = {}
): AnchoredPopup {
  const { gap = 4, minWidth = 0, width = 0, align = 'left', maxHeight = 320, margin = 12 } = options
  const panelStyle = ref<Record<string, string>>({})
  let raf = 0
  let observer: ResizeObserver | null = null

  function measure(): void {
    raf = 0
    const trigger = triggerRef.value
    if (!trigger) return
    const panel = panelRef.value
    const r = trigger.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    const panelWidth = width || Math.max(r.width, minWidth, panel?.offsetWidth ?? 0)
    // 弹层尚未渲染时先估算高度；已渲染时用 scrollHeight 取自然高度（不受上次 maxHeight 影响）
    const desired = panel ? Math.max(panel.offsetHeight, panel.scrollHeight) : 220

    let left = align === 'right' ? r.right - panelWidth : r.left
    left = Math.max(margin, Math.min(left, vw - panelWidth - margin))

    const below = vh - r.bottom - gap - margin
    const above = r.top - gap - margin
    // 下方放得下就向下；否则看上方；两边都放不下时选空间较大的一侧
    const placeBelow = desired <= below ? true : desired <= above ? false : below >= above
    const available = Math.max(0, placeBelow ? below : above)

    // 视口兜底：最多取可用空间的 90%，仅极端条目数才触发内部滚动
    const softCap = maxHeight > 0 ? maxHeight : Number.POSITIVE_INFINITY
    const cap = Math.min(softCap, Math.floor(available * 0.9))
    const renderedH = Math.min(desired, Math.max(0, cap))

    const top = placeBelow ? r.bottom + gap : r.top - gap - renderedH

    const style: Record<string, string> = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(Math.max(margin, Math.min(top, vh - renderedH - margin)))}px`,
      width: `${Math.round(panelWidth)}px`
    }
    if (desired > cap) {
      style.maxHeight = `${cap}px`
      style.overflowY = 'auto'
    }
    panelStyle.value = style
  }

  function schedule(): void {
    if (raf) return
    raf = window.requestAnimationFrame(measure)
  }

  /** 打开时调用：先用触发器的估算位置落位，下一帧再用真实高度校正 */
  function place(): void {
    measure()
    schedule()
    void nextTick(() => {
      schedule()
      if (panelRef.value && typeof ResizeObserver !== 'undefined') {
        observer?.disconnect()
        observer = new ResizeObserver(schedule)
        observer.observe(panelRef.value)
      }
    })
  }

  function onScroll(e: Event): void {
    const t = e.target as Node | null
    // 弹层内部滚动不影响定位
    if (t && panelRef.value?.contains(t)) return
    schedule()
  }

  function bind(on: boolean): void {
    if (on) {
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', schedule)
      window.visualViewport?.addEventListener('resize', schedule)
      window.visualViewport?.addEventListener('scroll', schedule)
    } else {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      observer?.disconnect()
      observer = null
      if (raf) window.cancelAnimationFrame(raf)
      raf = 0
    }
  }

  watch(open, (v) => {
    bind(v)
  })

  onBeforeUnmount(() => bind(false))

  return { panelStyle, place, bind }
}
