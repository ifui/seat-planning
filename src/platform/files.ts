/**
 * 文件导出与打印的平台适配。
 *
 * 浏览器：保持原有的 <a download> + Blob URL 行为，单文件产物直接可用。
 * 桌面端：走保存对话框 + Rust 写文件命令，避免 WebView 对下载行为的差异化处理；
 * 打印则生成临时 HTML 交给系统默认浏览器，规避各平台 WebView 打印能力不一致。
 */
import { isTauri } from './env'

export type FileKind = 'png' | 'xlsx' | 'json' | 'html'

const MIME: Record<FileKind, string> = {
  png: 'image/png',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  html: 'text/html'
}

const FILTERS: Record<FileKind, { name: string; extensions: string[] }> = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] },
  json: { name: 'JSON 文件', extensions: ['json'] },
  html: { name: 'HTML 文件', extensions: ['html'] }
}

export interface SaveResult {
  saved: boolean
  path?: string
}

/** 浏览器下载：保持原有单文件产物的离线行为 */
function browserDownload(name: string, blob: Blob): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * 保存文件。用户取消保存对话框时返回 saved=false，调用方可据此提示。
 */
export async function saveFile(name: string, data: Blob | string, kind: FileKind): Promise<SaveResult> {
  const blob = typeof data === 'string' ? new Blob([data], { type: MIME[kind] }) : data
  if (!isTauri()) {
    browserDownload(name, blob)
    return { saved: true }
  }
  const [{ save }, { invoke }] = await Promise.all([
    import('@tauri-apps/api/dialog'),
    import('@tauri-apps/api/tauri')
  ])
  const path = await save({ defaultPath: name, filters: [FILTERS[kind]] })
  if (!path) return { saved: false }
  await invoke('save_file_bytes', { path, base64: await blobToBase64(blob) })
  return { saved: true, path }
}

/** 浏览器内打印：沿用原 iframe 方案 */
function browserPrint(html: string): void {
  const iframe = document.createElement('iframe')
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) return
  doc.open()
  doc.write(html)
  doc.close()
  setTimeout(() => {
    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    setTimeout(() => document.body.removeChild(iframe), 800)
  }, 400)
}

/**
 * 打印一份完整 HTML。桌面端写入临时文件并用系统浏览器打开，
 * 返回 'system' 表示打印由外部浏览器完成，调用方可提示用户。
 */
export async function printHtml(name: string, html: string): Promise<'browser' | 'system'> {
  if (!isTauri()) {
    browserPrint(html)
    return 'browser'
  }
  const { invoke } = await import('@tauri-apps/api/tauri')
  const safe = name.replace(/[\\/:*?"<>|]/g, '-')
  const path = await invoke<string>('write_temp_file', {
    name: `${safe}.html`,
    base64: await blobToBase64(new Blob([html], { type: MIME.html }))
  })
  await invoke('open_path', { path })
  return 'system'
}
