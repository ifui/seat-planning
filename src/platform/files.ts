/**
 * 文件导出与打印的平台适配。
 *
 * 浏览器：保持原有的 <a download> + Blob URL 行为，单文件产物直接可用；打印走隐藏 iframe。
 * 桌面端：走保存对话框 + Rust 写文件命令，避免 WebView 对下载行为的差异化处理；
 * 打印改为应用内 window.print()（WebView2 实测会弹出原生打印对话框），不再导出临时页给系统浏览器。
 */
import { isTauri } from './env'

export type FileKind = 'png' | 'xlsx' | 'json' | 'sp'

const MIME: Record<FileKind, string> = {
  png: 'image/png',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  sp: 'application/octet-stream'
}

const FILTERS: Record<FileKind, { name: string; extensions: string[] }> = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  xlsx: { name: 'Excel 工作簿', extensions: ['xlsx'] },
  json: { name: 'JSON 文件', extensions: ['json'] },
  sp: { name: '座位编排备份', extensions: ['sp'] }
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

export type PrintPaper = 'landscape' | 'portrait'

/** A4 尺寸与页边距（mm）：两条链路共用同一套几何，图片按比例装箱，不会溢出到第二页 */
const A4_MM = { long: 297, short: 210 }
const PRINT_MARGIN_MM = 10
const SHEET_ID = 'print-sheet'
const SHEET_STYLE_ID = 'print-sheet-style'

function fitPage(aspect: number, paper: PrintPaper): { w: number; h: number } {
  const pageW = paper === 'landscape' ? A4_MM.long : A4_MM.short
  const pageH = paper === 'landscape' ? A4_MM.short : A4_MM.long
  const availW = pageW - PRINT_MARGIN_MM * 2
  const availH = pageH - PRINT_MARGIN_MM * 2
  const w = Math.min(availW, availH * aspect)
  return { w, h: w / aspect }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** 浏览器打印页：与桌面端同一套页面几何，仅载体不同 */
function printDocumentHtml(name: string, url: string, paper: PrintPaper, box: { w: number; h: number }): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>` +
    `<style>@page{size:A4 ${paper};margin:${PRINT_MARGIN_MM}mm}` +
    `html,body{margin:0;padding:0}` +
    `img{display:block;width:${box.w}mm;height:${box.h}mm;margin:0 auto}</style>` +
    `</head><body><img src="${url}"></body></html>`
  )
}

/**
 * 桌面端应用内打印：把图挂成打印专用页，屏幕不可见，打印时成为唯一内容，
 * @page 负责纸张方向，几何与浏览器链路一致。
 */
function desktopPrint(url: string, paper: PrintPaper, box: { w: number; h: number }): Promise<void> {
  return new Promise((resolve) => {
    document.getElementById(SHEET_ID)?.remove()
    document.getElementById(SHEET_STYLE_ID)?.remove()

    const style = document.createElement('style')
    style.id = SHEET_STYLE_ID
    style.textContent = `@media print {
  @page { size: A4 ${paper}; margin: ${PRINT_MARGIN_MM}mm }
  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; background: #fff !important; }
  body > *:not(#${SHEET_ID}) { display: none !important; }
  #${SHEET_ID} { display: block !important; }
  #${SHEET_ID} img { display: block !important; width: ${box.w}mm !important; height: ${box.h}mm !important; margin: 0 auto !important; }
}`

    const sheet = document.createElement('div')
    sheet.id = SHEET_ID
    sheet.setAttribute('aria-hidden', 'true')
    sheet.style.display = 'none'
    const img = new Image()
    img.alt = ''
    img.src = url
    sheet.appendChild(img)
    document.head.appendChild(style)
    document.body.appendChild(sheet)

    const cleanup = (): void => {
      sheet.remove()
      style.remove()
    }
    img
      .decode()
      .catch(() => undefined)
      .then(() => {
        window.print()
        // window.print() 在对话框关闭后才返回，届时移除打印页
        setTimeout(cleanup, 1200)
        resolve()
      })
  })
}

/**
 * 打印座位图。返回 'desktop' 表示已在应用内弹出原生打印对话框，
 * 'browser' 表示走浏览器 iframe 打印。
 */
export async function printImage(
  name: string,
  url: string,
  paper: PrintPaper,
  aspect: number
): Promise<'browser' | 'desktop'> {
  const box = fitPage(aspect, paper)
  if (!isTauri()) {
    browserPrint(printDocumentHtml(name, url, paper, box))
    return 'browser'
  }
  await desktopPrint(url, paper, box)
  return 'desktop'
}
