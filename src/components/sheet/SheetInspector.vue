<script setup lang="ts">
import { computed } from 'vue'
import type { CellStyle, Sheet, SheetCell, ZoneDef } from '../../types'
import type { CellRange } from '../../engine/sheet'
import { cellAt, blockRoleLabel, mergeAt, seatsInRow } from '../../engine/sheet'
import UiSelect from '../../ui/components/UiSelect.vue'

const props = defineProps<{
  sheet: Sheet
  selection: CellRange
  active: { row: number; col: number }
  zones: ZoneDef[]
  /** 区域管理里正在高亮的区域 */
  highlightZoneId?: string
}>()

const emit = defineEmits<{
  (e: 'patch', patch: Partial<SheetCell>): void
  (e: 'style', patch: CellStyle): void
  /** 取色器拖动中的实时预览，不写撤销历史 */
  (e: 'preview-style', patch: CellStyle): void
  (e: 'select-zone', zoneId: string): void
  (e: 'focus-zone', zoneId: string): void
  (e: 'add-zone'): void
  (e: 'delete-zone', id: string): void
  (e: 'rename-zone', id: string): void
}>()

const FILLS = ['#FFFFFF', '#F4EFE4', '#E8EEEE', '#DDE6E7', '#E6EDEF', '#FBE9E7', '#EDEFE8', '#F5F7F7']
const TEXT_COLORS = ['#26333A', '#3E4A4B', '#4A7C7B', '#B4483F', '#3D6FA8', '#FFFFFF']

const range = computed(() => ({
  r1: Math.min(props.selection.r1, props.selection.r2),
  c1: Math.min(props.selection.c1, props.selection.c2),
  r2: Math.max(props.selection.r1, props.selection.r2),
  c2: Math.max(props.selection.c1, props.selection.c2)
}))

const cellCount = computed(() => (range.value.r2 - range.value.r1 + 1) * (range.value.c2 - range.value.c1 + 1))

const anchorCell = computed<SheetCell | undefined>(() => {
  const a = props.active
  const m = mergeAt(props.sheet, a.row, a.col)
  return cellAt(props.sheet, m ? m.row : a.row, m ? m.col : a.col)
})

const kindLabel = computed(() => {
  const c = anchorCell.value
  if (!c) return '空白'
  if (c.kind === 'podium') return '主席台座位'
  if (c.kind === 'seat') return '座位'
  return blockRoleLabel(c.role)
})

const isSeat = computed(() => anchorCell.value?.kind === 'seat' || anchorCell.value?.kind === 'podium')

/** 每个区域占用的格子数，用于区域管理里的反向查看 */
const zoneCellCount = computed(() => {
  const out: Record<string, number> = {}
  for (const cell of Object.values(props.sheet.cells)) {
    if (!cell.zoneId) continue
    out[cell.zoneId] = (out[cell.zoneId] ?? 0) + 1
  }
  return out
})

const isBlock = computed(() => anchorCell.value?.kind === 'block')

const seatTotal = computed(() => {
  let n = 0
  for (let r = 0; r < props.sheet.rows; r++) n += seatsInRow(props.sheet, r).filter((s) => !s.disabled).length
  return n
})

const mergedCount = computed(() => props.sheet.merges.length)
const selectedSeats = computed(() => {
  let n = 0
  for (let r = range.value.r1; r <= range.value.r2; r++) {
    for (const s of seatsInRow(props.sheet, r)) {
      if (s.col >= range.value.c1 && s.col <= range.value.c2) n++
    }
  }
  return n
})

function setTableLabel(e: Event): void {
  emit('patch', { tableLabel: (e.target as HTMLInputElement).value })
}

function setText(e: Event): void {
  emit('patch', { text: (e.target as HTMLInputElement).value })
}

function colorOf(e: Event): string {
  return (e.target as HTMLInputElement).value
}

function previewFill(e: Event): void {
  emit('preview-style', { fill: colorOf(e) })
}

function setFill(e: Event): void {
  emit('style', { fill: colorOf(e) })
}

function clearFill(): void {
  emit('style', { fill: undefined })
}

function previewTextColor(e: Event): void {
  emit('preview-style', { textColor: colorOf(e) })
}

function setTextColor(e: Event): void {
  emit('style', { textColor: colorOf(e) })
}

function toggleDisabled(): void {
  emit('patch', { disabled: !anchorCell.value?.disabled })
}

function toggleLocked(): void {
  emit('patch', { locked: !anchorCell.value?.locked })
}

const fillColor = computed(() => (anchorCell.value?.style?.fill ?? '#FFFFFF').toUpperCase())
const textColor = computed(() => (anchorCell.value?.style?.textColor ?? '#26333A').toUpperCase())

const zoneOptions = computed(() => [
  { value: '', label: '未分配区域' },
  ...props.zones.map((z) => ({ value: z.id, label: z.name }))
])

function onZone(v: string): void {
  emit('select-zone', v)
}
</script>

<template>
  <aside class="insp-panel sheet-inspector">
    <section class="insp-sec">
      <div class="insp-title">选区</div>
      <div class="si-range">{{ range.r1 + 1 }} 排 {{ range.c1 + 1 }} 列 — {{ range.r2 + 1 }} 排 {{ range.c2 + 1 }} 列</div>
      <div class="si-meta">{{ cellCount }} 格 · {{ selectedSeats }} 个座位</div>
      <span class="si-kind">{{ kindLabel }}</span>
    </section>

    <section v-if="isSeat" class="insp-sec">
      <div class="insp-title">座位</div>
      <div class="insp-rows">
        <label class="insp-row">
          <span class="insp-label">桌名</span>
          <span class="insp-ctl">
            <input class="insp-input" :value="anchorCell?.tableLabel ?? ''" placeholder="如：1 排 · A 桌" @change="setTableLabel" />
          </span>
        </label>
        <div class="insp-row">
          <span class="insp-label">空位</span>
          <label class="insp-switch" title="固定空位：保留位置但不能坐人">
            <input type="checkbox" :checked="!!anchorCell?.disabled" @change="toggleDisabled" />
            <span class="insp-switch-track" />
          </label>
        </div>
        <div class="insp-row">
          <span class="insp-label">锁定</span>
          <label class="insp-switch" title="锁定后不被批量填充 / 清空覆盖">
            <input type="checkbox" :checked="!!anchorCell?.locked" @change="toggleLocked" />
            <span class="insp-switch-track" />
          </label>
        </div>
      </div>
    </section>

    <section v-if="isBlock" class="insp-sec">
      <div class="insp-title">块内容</div>
      <label class="insp-row">
        <span class="insp-label">文字</span>
        <span class="insp-ctl">
          <input class="insp-input" :value="anchorCell?.text ?? ''" placeholder="如：过道 / 入口" @change="setText" />
        </span>
      </label>
    </section>

    <section class="insp-sec">
      <div class="insp-title">区域</div>
      <UiSelect :model-value="anchorCell?.zoneId ?? ''" :options="zoneOptions" size="sm" @update:model-value="onZone" />
      <div v-if="anchorCell?.zoneId" class="insp-actions">
        <button type="button" class="insp-btn" @click="emit('select-zone', '')">清除选区归属</button>
      </div>
      <div class="si-zones">
        <button
          v-for="z in zones"
          :key="z.id"
          type="button"
          class="si-zone"
          :class="{ 'is-on': highlightZoneId === z.id }"
          :title="`在画布上高亮「${z.name}」包含的格子`"
          @click="emit('focus-zone', z.id)"
        >
          <i :style="{ background: z.color }" />
          <span>{{ z.name }}</span>
          <em>{{ zoneCellCount[z.id] ?? 0 }} 格</em>
          <b
            class="si-zone-edit"
            title="重命名区域"
            @click.stop="emit('rename-zone', z.id)"
          >✎</b>
          <b
            class="si-zone-del"
            title="删除区域"
            @click.stop="emit('delete-zone', z.id)"
          >×</b>
        </button>
      </div>
      <div class="insp-actions">
        <button type="button" class="insp-btn" @click="emit('add-zone')">＋ 新建区域</button>
      </div>
    </section>

    <section class="insp-sec">
      <div class="insp-title">样式</div>
      <div class="insp-rows">
        <div class="insp-row">
          <span class="insp-label">底色</span>
          <span class="insp-ctl insp-swatches">
            <button
              v-for="c in FILLS"
              :key="c"
              type="button"
              class="insp-swatch"
              :class="{ on: fillColor === c.toUpperCase() }"
              :style="{ background: c }"
              :title="c"
              @click="emit('style', { fill: c })"
            />
            <label class="insp-color" title="自定义底色">
              <input type="color" :value="anchorCell?.style?.fill ?? '#ffffff'" @input="previewFill" @change="setFill" />
            </label>
          </span>
        </div>
        <div class="insp-row">
          <span class="insp-label">文字</span>
          <span class="insp-ctl insp-swatches">
            <button
              v-for="c in TEXT_COLORS"
              :key="c"
              type="button"
              class="insp-swatch"
              :class="{ on: textColor === c.toUpperCase() }"
              :style="{ background: c }"
              :title="c"
              @click="emit('style', { textColor: c })"
            />
            <label class="insp-color" title="自定义文字颜色">
              <input type="color" :value="anchorCell?.style?.textColor ?? '#26333a'" @input="previewTextColor" @change="setTextColor" />
            </label>
          </span>
        </div>
      </div>
      <div class="insp-actions">
        <button type="button" class="insp-btn" @click="clearFill">清除底色</button>
      </div>
    </section>

    <section class="insp-sec si-stats">
      <div class="insp-title">工作表</div>
      <div class="insp-stat"><span>行列</span><b>{{ sheet.rows }} × {{ sheet.cols }}</b></div>
      <div class="insp-stat"><span>座位总数</span><b>{{ seatTotal }}</b></div>
      <div class="insp-stat"><span>合并区</span><b>{{ mergedCount }}</b></div>
      <div class="insp-stat"><span>已填单元格</span><b>{{ Object.keys(sheet.cells).length }}</b></div>
    </section>

    <section class="insp-sec">
      <details class="insp-keys">
        <summary>提示</summary>
        <ul>
          <li>座位只定义位置，一桌坐几人请在排座项目里设置。</li>
          <li>点区域可在画布上高亮其格子，再点一次取消。</li>
          <li>区域分配与解除可用 Ctrl+Z 撤销。</li>
        </ul>
      </details>
    </section>
  </aside>
</template>

<style scoped>
.si-range { font-size: var(--fs-sm); color: var(--text-primary); font-weight: 500; }
.si-meta { font-size: var(--fs-xs); color: var(--text-muted); }
.si-kind {
  align-self: flex-start; padding: 2px 8px;
  border-radius: var(--radius-xs);
  background: var(--primary-soft); color: var(--primary);
  font-size: var(--fs-xs);
}
.si-zones { display: flex; flex-direction: column; gap: 2px; }
.si-zone {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 28px;
  padding: 0 6px; border: none; border-radius: var(--radius-xs); background: none;
  font-size: var(--fs-xs); color: var(--text-secondary);
  text-align: left; cursor: pointer;
}
.si-zone:hover { background: var(--bg-hover); }
.si-zone.is-on { background: var(--primary-soft); color: var(--primary); }
.si-zone i { width: 9px; height: 9px; flex: none; border-radius: 2px; }
.si-zone span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.si-zone em {
  flex: none; font-style: normal; font-size: 10px;
  color: var(--text-disabled); font-variant-numeric: tabular-nums;
}
.si-zone-edit {
  flex: none; border: none; background: none; color: var(--text-disabled);
  cursor: pointer; font-size: 11px; font-weight: 400; padding: 0 1px;
}
.si-zone-edit:hover { color: var(--primary); }
.si-zone-del {
  flex: none; border: none; background: none; color: var(--text-disabled);
  cursor: pointer; font-size: 13px; font-weight: 400; padding: 0 2px;
}
.si-zone-del:hover { color: var(--danger); }
.si-stats { gap: 5px; }
</style>
