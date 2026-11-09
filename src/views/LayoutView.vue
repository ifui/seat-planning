<script setup lang="ts">
/**
 * 会场布局：Excel 式工作表工作台。
 * 数据模型：行列 → 单元格（座位 / 主席台 / 特殊块），排号与座号由格子决定。
 */
import { computed, onMounted, ref } from 'vue'
import type { CellStyle, LayoutPackage, SheetCell, ZoneDef } from '../types'
import type { CellRange } from '../engine/sheet'
import {
  addMerge,
  blockRoleLabel,
  cellAt,
  cloneCell,
  colLabel,
  createBlankLayout,
  eachCell,
  fillSeats,
  insertCols,
  insertRows,
  isCovered,
  mergeAt,
  normalizeSheet,
  removeMerge,
  setCell
} from '../engine/sheet'
import { deleteRows, deleteCols } from '../engine/sheet'
import { loadAll, removeLayout, saveLayout, state } from '../store'
import { useLayoutHistory } from '../composables/useLayoutHistory'
import SheetToolbar from '../components/sheet/SheetToolbar.vue'
import SheetGrid from '../components/sheet/SheetGrid.vue'
import SheetInspector from '../components/sheet/SheetInspector.vue'
import FillDialog from '../components/sheet/FillDialog.vue'
import SheetSetupDialog from '../components/sheet/SheetSetupDialog.vue'
import UiContextMenu from '../ui/components/UiContextMenu.vue'
import UiMenuItem from '../ui/components/UiMenuItem.vue'
import UiButton from '../ui/components/UiButton.vue'

const current = ref<LayoutPackage | null>(null)
const selection = ref<CellRange>({ r1: 0, c1: 0, r2: 0, c2: 0 })
const active = ref({ row: 0, col: 0 })
const dirty = ref(false)
const toastMsg = ref('')
let toastTimer = 0

const { canUndo, canRedo, resetHistory, historyPush, undo, redo } = useLayoutHistory(current)

const sheet = computed(() => current.value!.sheet)

const layouts = computed(() =>
  [...state.layouts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
)

function toast(msg: string): void {
  toastMsg.value = msg
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastMsg.value = ''), 2600)
}

function commit(): void {
  historyPush()
  dirty.value = true
}

async function selectLayout(id: string): Promise<void> {
  const found = state.layouts.find((l) => l.id === id)
  if (!found) return
  const next = JSON.parse(JSON.stringify(found)) as LayoutPackage
  next.sheet = normalizeSheet(next.sheet)
  current.value = next
  selection.value = { r1: 0, c1: 0, r2: 0, c2: 0 }
  active.value = { row: 0, col: 0 }
  dirty.value = false
  resetHistory()
}

onMounted(async () => {
  if (!state.ready) await loadAll()
  if (state.layouts.length) await selectLayout(state.layouts[0].id)
  else await createLayout()
})

async function createLayout(): Promise<void> {
  const layout = createBlankLayout(`会场布局 ${state.layouts.length + 1}`)
  await saveLayout(layout)
  await selectLayout(layout.id)
  toast('已新建空白表格')
}

async function removeCurrent(): Promise<void> {
  if (!current.value) return
  if (!window.confirm(`删除布局「${current.value.name}」？此操作不可撤销。`)) return
  await removeLayout(current.value.id)
  if (state.layouts.length) await selectLayout(state.layouts[0].id)
  else await createLayout()
}

async function reloadCurrent(): Promise<void> {
  if (!current.value) return
  if (dirty.value && !window.confirm('放弃未保存的修改，重新载入？')) return
  await selectLayout(current.value.id)
  toast('已重新载入')
}

async function save(): Promise<void> {
  if (!current.value) return
  await saveLayout(current.value)
  dirty.value = false
  toast('已保存到本地')
}

function exportJson(): void {
  if (!current.value) return
  const blob = new Blob([JSON.stringify(current.value, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${current.value.name}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

const fileInput = ref<HTMLInputElement | null>(null)

function onImportClick(): void {
  fileInput.value?.click()
}

async function onImportFile(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text()) as LayoutPackage
    if (parsed.schemaVersion !== '2.0' || !parsed.sheet) {
      toast('只支持 2.0 表格布局文件')
      return
    }
    parsed.id = `layout-${Date.now().toString(36)}`
    parsed.name = `${parsed.name || '导入的布局'}`
    await saveLayout(parsed)
    await selectLayout(parsed.id)
    toast('导入成功')
  } catch {
    toast('文件解析失败')
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

// ---------- 选区信息 ----------

const range = computed<CellRange>(() => ({
  r1: Math.min(selection.value.r1, selection.value.r2),
  c1: Math.min(selection.value.c1, selection.value.c2),
  r2: Math.max(selection.value.r1, selection.value.r2),
  c2: Math.max(selection.value.c1, selection.value.c2)
}))

const selectionLabel = computed(() => {
  const r = range.value
  const a = `${colLabel(r.c1)}${r.r1 + 1}`
  const b = `${colLabel(r.c2)}${r.r2 + 1}`
  return a === b ? a : `${a}:${b}`
})

const cellCount = computed(() => (range.value.r2 - range.value.r1 + 1) * (range.value.c2 - range.value.c1 + 1))

const activeCell = computed(() => {
  if (!current.value) return undefined
  const m = mergeAt(current.value.sheet, active.value.row, active.value.col)
  return cellAt(current.value.sheet, m ? m.row : active.value.row, m ? m.col : active.value.col)
})

const seatsValue = computed<1 | 2>(() => (activeCell.value?.seats === 2 ? 2 : 1))

// ---------- 单元格操作 ----------

function setType(kind: 'seat' | 'podium' | 'block', role?: 'aisle' | 'lectern' | 'backdrop' | 'label'): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    const base: SheetCell = cell ? { ...cell } : { kind }
    if (kind === 'block') {
      base.kind = 'block'
      base.role = role ?? 'label'
      delete base.seats
      delete base.seatIds
      if (!base.text) base.text = blockRoleLabel(base.role)
    } else {
      base.kind = kind
      base.seats = base.seats === 2 ? 2 : 1
      delete base.role
      delete base.text
      ensureIds(base)
    }
    setCell(s, row, col, base)
  })
  commit()
}

function ensureIds(cell: SheetCell): void {
  const n = cell.seats === 2 ? 2 : 1
  const ids = cell.seatIds ? [...cell.seatIds] : []
  while (ids.length < n) ids.push(`seat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
  ids.length = n
  cell.seatIds = ids
}

function setSeats(n: 1 | 2): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (!cell || (cell.kind !== 'seat' && cell.kind !== 'podium')) return
    const next: SheetCell = { ...cell, seats: n }
    ensureIds(next)
    setCell(s, row, col, next)
  })
  commit()
}

function patchCell(patch: Partial<SheetCell>): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (!cell) return
    setCell(s, row, col, { ...cell, ...patch })
  })
  commit()
}

function patchStyle(patch: CellStyle): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (!cell) return
    setCell(s, row, col, { ...cell, style: { ...(cell.style ?? {}), ...patch } })
  })
  commit()
}

function assignZone(zoneId: string): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (!cell) return
    const next: SheetCell = { ...cell }
    if (zoneId) next.zoneId = zoneId
    else delete next.zoneId
    setCell(s, row, col, next)
  })
  commit()
}

function mergeSelection(): void {
  if (!current.value) return
  const err = addMerge(current.value.sheet, range.value)
  if (err) {
    toast(err)
    return
  }
  commit()
  toast('已合并单元格')
}

function unmergeSelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  let changed = false
  for (let row = r.r1; row <= r.r2; row++) {
    for (let col = r.c1; col <= r.c2; col++) {
      const m = mergeAt(s, row, col)
      if (m) {
        removeMerge(s, m.row, m.col)
        changed = true
        row = Math.max(row, m.row + m.rowSpan - 1)
      }
    }
  }
  if (!changed) {
    toast('选区内没有合并单元格')
    return
  }
  commit()
}

function insertRow(): void {
  if (!current.value) return
  insertRows(current.value.sheet, range.value.r1, range.value.r2 - range.value.r1 + 1)
  commit()
}

function removeRows(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.r2 - range.value.r1 + 1
  if (s.rows - n < 1) {
    toast('至少要保留一行')
    return
  }
  deleteRows(s, range.value.r1, n)
  selection.value = { r1: Math.min(range.value.r1, s.rows - 1), c1: range.value.c1, r2: Math.min(range.value.r1, s.rows - 1), c2: range.value.c2 }
  commit()
}

function insertCol(): void {
  if (!current.value) return
  insertCols(current.value.sheet, range.value.c1, range.value.c2 - range.value.c1 + 1)
  commit()
}

function removeCols(): void {
  if (!current.value) return
  const s = current.value.sheet
  const n = range.value.c2 - range.value.c1 + 1
  if (s.cols - n < 1) {
    toast('至少要保留一列')
    return
  }
  deleteCols(s, range.value.c1, n)
  selection.value = { r1: range.value.r1, c1: Math.min(range.value.c1, s.cols - 1), r2: range.value.r2, c2: Math.min(range.value.c1, s.cols - 1) }
  commit()
}

function clearSelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  eachCell(s, range.value, (row, col, cell) => {
    if (cell?.locked) return
    setCell(s, row, col, undefined)
  })
  commit()
}

// ---------- 复制粘贴 / 填充 ----------

interface Clip {
  cells: { dr: number; dc: number; cell: SheetCell }[]
  merges: { dr: number; dc: number; rowSpan: number; colSpan: number }[]
  w: number
  h: number
}

let clip: Clip | null = null

function copySelection(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  const data: Clip = { cells: [], merges: [], w: r.c2 - r.c1 + 1, h: r.r2 - r.r1 + 1 }
  eachCell(s, r, (row, col, cell) => {
    if (cell) data.cells.push({ dr: row - r.r1, dc: col - r.c1, cell: JSON.parse(JSON.stringify(cell)) })
  })
  for (const m of s.merges) {
    if (m.row >= r.r1 && m.col >= r.c1 && m.row + m.rowSpan - 1 <= r.r2 && m.col + m.colSpan - 1 <= r.c2) {
      data.merges.push({ dr: m.row - r.r1, dc: m.col - r.c1, rowSpan: m.rowSpan, colSpan: m.colSpan })
    }
  }
  clip = data
  toast(`已复制 ${data.cells.length} 个单元格`)
}

function pasteClipboard(): void {
  if (!current.value) return
  if (!clip) {
    toast('剪贴板为空')
    return
  }
  const s = current.value.sheet
  const baseRow = active.value.row
  const baseCol = active.value.col
  for (const item of clip.cells) {
    const row = baseRow + item.dr
    const col = baseCol + item.dc
    if (row >= s.rows || col >= s.cols) continue
    const next = cloneCell(item.cell, true)
    setCell(s, row, col, next)
  }
  for (const m of clip.merges) {
    const row = baseRow + m.dr
    const col = baseCol + m.dc
    if (row + m.rowSpan > s.rows || col + m.colSpan > s.cols) continue
    if (mergeAt(s, row, col)) continue
    s.merges.push({ row, col, rowSpan: m.rowSpan, colSpan: m.colSpan })
  }
  selection.value = {
    r1: baseRow,
    c1: baseCol,
    r2: Math.min(s.rows - 1, baseRow + clip.h - 1),
    c2: Math.min(s.cols - 1, baseCol + clip.w - 1)
  }
  commit()
}

function fillDown(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  if (r.r2 <= r.r1) {
    toast('请先选中多行再向下填充')
    return
  }
  for (let col = r.c1; col <= r.c2; col++) {
    if (isCovered(s, r.r1, col)) continue
    const src = cellAt(s, r.r1, col)
    if (!src) continue
    for (let row = r.r1 + 1; row <= r.r2; row++) {
      if (isCovered(s, row, col)) continue
      setCell(s, row, col, cloneCell(src, true))
    }
  }
  commit()
}

function fillRight(): void {
  if (!current.value) return
  const s = current.value.sheet
  const r = range.value
  if (r.c2 <= r.c1) {
    toast('请先选中多列再向右填充')
    return
  }
  for (let row = r.r1; row <= r.r2; row++) {
    if (isCovered(s, row, r.c1)) continue
    const src = cellAt(s, row, r.c1)
    if (!src) continue
    for (let col = r.c1 + 1; col <= r.c2; col++) {
      if (isCovered(s, row, col)) continue
      setCell(s, row, col, cloneCell(src, true))
    }
  }
  commit()
}

// ---------- 编辑 / 批量填充 / 表格设置 ----------

const fillOpen = ref(false)
const setupOpen = ref(false)

function onEdit(p: { row: number; col: number; text: string }): void {
  if (!current.value) return
  const s = current.value.sheet
  const m = mergeAt(s, p.row, p.col)
  const row = m ? m.row : p.row
  const col = m ? m.col : p.col
  const cell = cellAt(s, row, col)
  const text = p.text.trim()
  if (!cell) {
    if (!text) return
    setCell(s, row, col, { kind: 'block', role: 'label', text })
  } else if (cell.kind === 'seat' || cell.kind === 'podium') {
    const next: SheetCell = { ...cell }
    if (text) next.tableLabel = text
    else delete next.tableLabel
    setCell(s, row, col, next)
  } else {
    setCell(s, row, col, { ...cell, text })
  }
  commit()
}

function onFill(payload: { kind: 'seat' | 'podium'; seats: 1 | 2; tablePerRow: boolean; tableLabel: string; zoneId: string }): void {
  if (!current.value) return
  const n = fillSeats(current.value.sheet, range.value, payload)
  commit()
  toast(`已填充 ${n} 个座位格`)
}

function applySetup(v: { rows: number; cols: number; colWidth: number; rowHeight: number; frozenRows: number; frozenCols: number }): void {
  if (!current.value) return
  const s = current.value.sheet
  const next = normalizeSheet({
    ...s,
    rows: v.rows,
    cols: v.cols,
    defaultColWidth: v.colWidth,
    defaultRowHeight: v.rowHeight,
    colWidths: s.colWidths,
    rowHeights: s.rowHeights,
    frozenRows: v.frozenRows,
    frozenCols: v.frozenCols
  })
  // 新增行列时用默认宽高补齐
  for (let c = s.cols; c < v.cols; c++) next.colWidths[c] = v.colWidth
  for (let r = s.rows; r < v.rows; r++) next.rowHeights[r] = v.rowHeight
  current.value.sheet = next
  selection.value = { r1: 0, c1: 0, r2: 0, c2: 0 }
  active.value = { row: 0, col: 0 }
  commit()
  toast('表格尺寸已更新')
}

// ---------- 区域 ----------

const ZONE_COLORS = ['#DCE4EE', '#EDF1F5', '#E8EFE9', '#F3EDE6', '#F0EAEF', '#E9EEF2']

function addZone(): void {
  if (!current.value) return
  const n = current.value.zones.length + 1
  const zone: ZoneDef = {
    id: `zone-${Date.now().toString(36)}`,
    name: `区域 ${n}`,
    color: ZONE_COLORS[(n - 1) % ZONE_COLORS.length]
  }
  current.value.zones.push(zone)
  dirty.value = true
}

function deleteZone(id: string): void {
  if (!current.value) return
  const s = current.value.sheet
  current.value.zones = current.value.zones.filter((z) => z.id !== id)
  for (const [k, cell] of Object.entries(s.cells)) {
    if (cell.zoneId !== id) continue
    const next = { ...cell }
    delete next.zoneId
    s.cells[k] = next
  }
  dirty.value = true
}

// ---------- 右键菜单 ----------

const ctx = ref({ open: false, x: 0, y: 0 })

function onContext(p: { x: number; y: number }): void {
  ctx.value = { open: true, x: p.x, y: p.y }
}

function ctxRun(fn: () => void): void {
  ctx.value.open = false
  fn()
}

function onCommand(cmd: string): void {
  switch (cmd) {
    case 'copy':
      copySelection()
      return
    case 'paste':
      pasteClipboard()
      return
    case 'clear':
      clearSelection()
      return
    case 'undo':
      undo()
      dirty.value = true
      return
    case 'redo':
      redo()
      dirty.value = true
      return
    case 'fill-down':
      fillDown()
      return
    case 'fill-right':
      fillRight()
      return
  }
}
</script>

<template>
  <div class="layout-view">
    <aside class="lv-rail">
      <div class="lv-rail-head">
        <span>布局</span>
        <UiButton variant="ghost" size="sm" icon="plus" title="新建布局" @click="createLayout" />
      </div>
      <div class="lv-list">
        <button
          v-for="l in layouts"
          :key="l.id"
          class="lv-item"
          :class="{ active: current?.id === l.id }"
          @click="selectLayout(l.id)"
        >
          <span class="lv-item-name">{{ l.name }}</span>
          <span class="lv-item-meta">{{ l.sheet.rows }}×{{ l.sheet.cols }}</span>
        </button>
      </div>
      <div class="lv-rail-foot">
        <UiButton v-if="current" variant="ghost" size="sm" icon="trash" @click="removeCurrent">删除当前布局</UiButton>
        <div class="lv-tip">排号由格子行列决定：<br />行 = 排，行内座位顺序 = 座号。</div>
      </div>
    </aside>

    <div v-if="current" class="lv-main">
      <SheetToolbar
        :name="current.name"
        :can-undo="canUndo"
        :can-redo="canRedo"
        :selection-label="selectionLabel"
        :cell-count="cellCount"
        :seats="seatsValue"
        @back="reloadCurrent"
        @setup="setupOpen = true"
        @save="save"
        @export="exportJson"
        @import="onImportClick"
        @undo="onCommand('undo')"
        @redo="onCommand('redo')"
        @insert-row="insertRow"
        @delete-row="removeRows"
        @insert-col="insertCol"
        @delete-col="removeCols"
        @merge="mergeSelection"
        @unmerge="unmergeSelection"
        @type="setType"
        @seats="setSeats"
        @fill="fillOpen = true"
        @clear="clearSelection"
      />

      <div class="lv-work">
        <SheetGrid
          :sheet="sheet"
          :selection="selection"
          :active="active"
          @update:selection="selection = $event"
          @update:active="active = $event"
          @commit="commit"
          @context="onContext"
          @edit="onEdit"
          @command="onCommand"
        />
        <SheetInspector
          :sheet="sheet"
          :selection="selection"
          :active="active"
          :zones="current.zones"
          @patch="patchCell"
          @style="patchStyle"
          @select-zone="assignZone"
          @add-zone="addZone"
          @delete-zone="deleteZone"
        />
      </div>
    </div>

    <div v-else class="lv-empty">正在加载布局…</div>

    <FillDialog v-model="fillOpen" :range-label="selectionLabel" :zones="current?.zones ?? []" @fill="onFill" />
    <SheetSetupDialog v-if="current" v-model="setupOpen" :sheet="sheet" @apply="applySetup" />

    <UiContextMenu :open="ctx.open" :x="ctx.x" :y="ctx.y" @close="ctx.open = false">
      <UiMenuItem icon="copy" label="复制" shortcut="Ctrl+C" @click="ctxRun(copySelection)" />
      <UiMenuItem icon="paste" label="粘贴" shortcut="Ctrl+V" @click="ctxRun(pasteClipboard)" />
      <UiMenuItem icon="trash" label="清空内容" shortcut="Del" danger @click="ctxRun(clearSelection)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="square" label="合并单元格" @click="ctxRun(mergeSelection)" />
      <UiMenuItem icon="expand" label="拆分单元格" @click="ctxRun(unmergeSelection)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="plus" label="在上方插入行" @click="ctxRun(insertRow)" />
      <UiMenuItem icon="minus" label="删除选中行" @click="ctxRun(removeRows)" />
      <UiMenuItem icon="plus" label="在左侧插入列" @click="ctxRun(insertCol)" />
      <UiMenuItem icon="minus" label="删除选中列" @click="ctxRun(removeCols)" />
      <div class="ctx-sep" />
      <UiMenuItem icon="seat" label="设为座位" @click="ctxRun(() => setType('seat'))" />
      <UiMenuItem icon="podium" label="设为主席台" @click="ctxRun(() => setType('podium'))" />
      <UiMenuItem icon="aisle" label="设为过道（不坐人）" @click="ctxRun(() => setType('block', 'aisle'))" />
      <UiMenuItem icon="lectern" label="设为讲台（不坐人）" @click="ctxRun(() => setType('block', 'lectern'))" />
      <UiMenuItem icon="rect" label="设为背景板（不坐人）" @click="ctxRun(() => setType('block', 'backdrop'))" />
      <UiMenuItem icon="label" label="设为标签（不坐人）" @click="ctxRun(() => setType('block', 'label'))" />
    </UiContextMenu>

    <input ref="fileInput" type="file" accept="application/json,.json" class="lv-file" @change="onImportFile" />

    <Transition name="toast">
      <div v-if="toastMsg" class="lv-toast">{{ toastMsg }}</div>
    </Transition>

    <div v-if="dirty" class="lv-dirty">未保存</div>
  </div>
</template>

<style scoped>
.layout-view { display: flex; height: 100%; min-height: 0; gap: 10px; padding: 10px; }
.lv-rail {
  width: 196px; flex: none; display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg);
  overflow: hidden;
}
.lv-rail-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px; font-size: 11px; font-weight: 600; color: var(--text-muted);
  border-bottom: 1px solid var(--border-soft);
}
.lv-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.lv-item {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  padding: 7px 9px; border: 1px solid transparent; border-radius: 5px;
  background: none; cursor: pointer; font-family: inherit;
}
.lv-item:hover { background: var(--bg-hover); }
.lv-item.active { background: var(--primary-soft); border-color: var(--primary-line); }
.lv-item-name { font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-item-meta { font-size: 10px; color: var(--text-disabled); }
.lv-rail-foot { padding: 8px; border-top: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 6px; }
.lv-tip { font-size: 10px; line-height: 1.6; color: var(--text-disabled); }

.lv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.lv-work { flex: 1; min-height: 0; display: flex; gap: 8px; }
.lv-empty { flex: 1; display: grid; place-items: center; color: var(--text-muted); font-size: 12px; }

.lv-file { display: none; }
.ctx-sep { height: 1px; background: var(--border-soft); margin: 4px 8px; }
.lv-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  background: var(--text-primary); color: #fff; font-size: 12px;
  padding: 8px 16px; border-radius: 6px; z-index: 80; box-shadow: var(--shadow-md);
}
.lv-dirty {
  position: fixed; right: 18px; bottom: 18px; z-index: 60;
  font-size: 11px; color: var(--warning); background: var(--warning-soft);
  padding: 4px 10px; border-radius: 12px;
}
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 6px); }
</style>
