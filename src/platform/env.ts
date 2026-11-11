/**
 * 运行环境判定。
 * Tauri v1 会向页面注入 `__TAURI__`（withGlobalTauri 开启）与 `__TAURI_IPC__`，
 * 浏览器环境两者都不存在。
 */
export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_IPC__' in window
}
