/**
 * 桌面端原生文件拖放。
 *
 * Tauri v1 的窗口默认开启 `fileDropEnabled`，系统拖放由 Rust 侧接管，
 * WebView 里不会产生 HTML5 的 dragover / drop，也没有 dataTransfer。
 * 因此桌面端必须监听 `tauri://file-drop` 拿到文件路径，再读成 File，
 * 交给与浏览器完全相同的解析入口（listRosterSheets / readRosterSheet）。
 */
import { isTauri } from './env'

export interface NativeDropFile {
  name: string
  file: File
}

export interface NativeDropHandlers {
  /** 文件拖到窗口上 / 拖出窗口：用于和网页版一致的虚线框高亮 */
  onHover?(active: boolean): void
  onDrop?(files: NativeDropFile[]): void
  onError?(message: string): void
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || '未命名文件'
}

function fileFromBase64(name: string, base64: string): File {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name)
}

/**
 * 注册原生拖放监听，返回取消注册的函数。
 * 浏览器环境直接返回空函数，调用方不需要判断平台。
 */
export async function listenNativeFileDrop(
  handlers: NativeDropHandlers
): Promise<() => void> {
  if (!isTauri()) return () => {}

  const [{ listen }, { invoke }] = await Promise.all([
    import('@tauri-apps/api/event'),
    import('@tauri-apps/api/tauri')
  ])

  const stops: Array<() => void> = []
  stops.push(await listen('tauri://file-drop-hover', () => handlers.onHover?.(true)))
  stops.push(await listen('tauri://file-drop-cancelled', () => handlers.onHover?.(false)))
  stops.push(
    await listen<string[] | { paths?: string[] }>('tauri://file-drop', async (event) => {
      handlers.onHover?.(false)
      // Tauri v1 的 FileDropEvent::Dropped 直接把路径数组作为 payload；
      // 兼容可能被包装成 { paths } 的版本。
      const payload = event.payload as string[] | { paths?: string[] } | null
      const paths = Array.isArray(payload) ? payload : payload?.paths ?? []
      if (!paths.length) return
      try {
        const files: NativeDropFile[] = []
        for (const path of paths) {
          const base64 = await invoke<string>('read_file_base64', { path })
          files.push({ name: baseName(path), file: fileFromBase64(baseName(path), base64) })
        }
        handlers.onDrop?.(files)
      } catch (e: any) {
        handlers.onError?.(e?.message || String(e) || '读取拖入的文件失败')
      }
    })
  )

  return () => {
    for (const stop of stops) stop()
  }
}
