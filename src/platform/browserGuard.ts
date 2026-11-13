/**
 * 生产模式下收口宿主 WebView / 浏览器的默认行为。
 *
 * 桌面端（WebView2）与浏览器共用同一份产物，生产构建里仍会暴露刷新、开发者工具、
 * 页面缩放、右键菜单、拖放文件导航、鼠标侧键前进后退等宿主能力，这里统一拦截。
 *
 * 原则是只 preventDefault、不 stopPropagation：
 * - 画布与表格的自绘右键菜单照常弹出；
 * - Ctrl + 滚轮、Ctrl + 0 等画布缩放手势仍由画布组件处理；
 * - 导入弹窗的文件拖放区仍能收到 drop；
 * - Ctrl + P 不拦截，打印仍走应用内的 window.print()。
 *
 * 开发模式不安装，保留刷新、开发者工具与缩放手势，便于调试。
 */
const RELOAD_KEYS = new Set(['f5', 'r'])
const DEVTOOLS_KEYS = new Set(['f12', 'i', 'j', 'c'])
const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0', 'add', 'subtract'])
const SOURCE_KEYS = new Set(['u', 's', 'o'])

let installed = false

function hasCommandKey(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey
}

function onKeydown(e: KeyboardEvent): void {
  const key = e.key.toLowerCase()

  // 刷新 / 强制刷新：F5、Ctrl+R、Ctrl+Shift+R
  if (RELOAD_KEYS.has(key) && (key === 'f5' || hasCommandKey(e))) {
    e.preventDefault()
    return
  }

  // 开发者工具：F12、Ctrl+Shift+I/J/C
  if (DEVTOOLS_KEYS.has(key) && (key === 'f12' || (hasCommandKey(e) && e.shiftKey))) {
    e.preventDefault()
    return
  }

  // 页面缩放：Ctrl + 加号/减号/0（含小键盘）
  if (hasCommandKey(e) && ZOOM_KEYS.has(key)) {
    e.preventDefault()
    return
  }

  // 查看源码 / 保存页面 / 打开文件：Ctrl+U、Ctrl+S、Ctrl+O
  if (hasCommandKey(e) && !e.shiftKey && SOURCE_KEYS.has(key)) {
    e.preventDefault()
    return
  }

  // 历史前进后退：Alt+←/→、Alt+Home
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home')) {
    e.preventDefault()
    return
  }

  // 键盘呼出右键菜单：菜单键、Shift+F10
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault()
  }
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
}

/** 触控板捏合与 Ctrl + 滚轮在 Chromium 里都表现为 ctrlKey + wheel */
function onWheel(e: WheelEvent): void {
  if (e.ctrlKey || e.metaKey) e.preventDefault()
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}

function onDrop(e: DragEvent): void {
  e.preventDefault()
}

/** 鼠标侧键 3/4 默认是前进后退，桌面端不应导航 */
function onAuxClick(e: MouseEvent): void {
  if (e.button === 3 || e.button === 4) e.preventDefault()
}

export function installBrowserGuards(): void {
  if (installed || typeof window === 'undefined') return
  if (!import.meta.env.PROD) return
  installed = true

  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('contextmenu', onContextMenu, true)
  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
  window.addEventListener('dragover', onDragOver, true)
  window.addEventListener('drop', onDrop, true)
  window.addEventListener('auxclick', onAuxClick, true)
}
