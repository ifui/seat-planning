/**
 * 全局界面偏好。
 * 只收纳代码里已经存在的可选值（导出倍率、打印纸张），不虚构新选项。
 * 与业务数据分开存放：偏好属于本机，不进备份、不参与仓储迁移。
 */
import { reactive, watch } from 'vue'

export type ExportScale = 2 | 3 | 4
export type PaperSide = 'landscape' | 'portrait'

export interface Preferences {
  /** 导出 PNG 的默认倍率 */
  exportScale: ExportScale
  /** 打印默认纸张方向 */
  paper: PaperSide
}

export const DEFAULT_PREFERENCES: Preferences = {
  exportScale: 3,
  paper: 'landscape'
}

const KEY = 'seat-planning:preferences'

function load(): Preferences {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    const data = JSON.parse(raw) as Partial<Preferences>
    return {
      exportScale: data.exportScale === 2 || data.exportScale === 3 || data.exportScale === 4
        ? data.exportScale
        : DEFAULT_PREFERENCES.exportScale,
      paper: data.paper === 'portrait' || data.paper === 'landscape'
        ? data.paper
        : DEFAULT_PREFERENCES.paper
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export const preferences = reactive<Preferences>(load())

watch(
  preferences,
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(preferences))
    } catch {
      /* 偏好写入失败不影响主流程 */
    }
  },
  { deep: true }
)

/** 恢复默认值，立即写回 */
export function resetPreferences(): void {
  Object.assign(preferences, DEFAULT_PREFERENCES)
}
