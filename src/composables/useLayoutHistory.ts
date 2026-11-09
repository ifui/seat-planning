import { computed, ref, type Ref } from 'vue'
import type { LayoutPackage, Sheet, ZoneDef } from '../types'

interface SnapshotData {
  sheet: Sheet
  zones: ZoneDef[]
  canvas: LayoutPackage['canvas']
}

/**
 * 布局撤销 / 重做：快照包含「工作表 + 区域 + 画布」。
 * 工作表里已经含有行列数、行高列宽、合并区、单元格内容与座位归属，
 * 因此撤销重做能完整回滚表格模型的任何改动。
 */
export function useLayoutHistory(draft: Ref<LayoutPackage | null>) {
  const history = ref<string[]>([])
  const hIndex = ref(-1)

  const canUndo = computed(() => hIndex.value > 0)
  const canRedo = computed(() => hIndex.value < history.value.length - 1)

  function snapshotStr(): string {
    const l = draft.value
    if (!l) return ''
    return JSON.stringify({ sheet: l.sheet, zones: l.zones, canvas: l.canvas })
  }

  function resetHistory(): void {
    history.value = draft.value ? [snapshotStr()] : []
    hIndex.value = draft.value ? 0 : -1
  }

  function historyPush(): void {
    if (!draft.value) return
    const snap = snapshotStr()
    if (hIndex.value >= 0 && history.value[hIndex.value] === snap) return
    history.value = history.value.slice(0, hIndex.value + 1)
    history.value.push(snap)
    if (history.value.length > 80) history.value.shift()
    hIndex.value = history.value.length - 1
  }

  function applySnapshot(s: string): void {
    const l = draft.value
    if (!l) return
    const data = JSON.parse(s) as SnapshotData
    l.sheet = data.sheet
    l.zones = data.zones
    l.canvas = data.canvas
  }

  function undo(): void {
    if (hIndex.value <= 0) return
    hIndex.value--
    applySnapshot(history.value[hIndex.value])
  }

  function redo(): void {
    if (hIndex.value >= history.value.length - 1) return
    hIndex.value++
    applySnapshot(history.value[hIndex.value])
  }

  return { history, hIndex, canUndo, canRedo, resetHistory, historyPush, undo, redo }
}
