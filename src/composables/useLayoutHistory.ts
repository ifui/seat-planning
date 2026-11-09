import { computed, ref, type Ref } from 'vue'
import type { BaseElement, GridConfig, LayerGroup, LayoutPackage, ZoneDef } from '../types'

interface SnapshotData {
  elements: BaseElement[]
  zones: ZoneDef[]
  groups?: LayerGroup[]
  canvas: LayoutPackage['canvas']
  grid?: GridConfig
}

/**
 * 布局撤销 / 重做：以序列化快照保存「元素 + 区域 + 分组 + 画布 + 网格」五部分，
 * 保证分组关系与网格参数（行列、合并、元素归属）随撤销重做一起回滚。
 */
export function useLayoutHistory(draft: Ref<LayoutPackage | null>, selectedIds: Ref<string[]>) {
  const history = ref<string[]>([])
  const hIndex = ref(-1)

  const canUndo = computed(() => hIndex.value > 0)
  const canRedo = computed(() => hIndex.value < history.value.length - 1)

  function snapshotStr(): string {
    const l = draft.value
    if (!l) return ''
    return JSON.stringify({
      elements: l.elements,
      zones: l.zones,
      groups: l.groups ?? [],
      canvas: l.canvas,
      grid: l.grid,
    })
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
    l.elements = data.elements
    l.zones = data.zones
    l.groups = data.groups ?? []
    l.canvas = data.canvas
    if (data.grid) l.grid = data.grid
    else delete l.grid
    selectedIds.value = selectedIds.value.filter((id) => l.elements.some((e) => e.id === id))
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
