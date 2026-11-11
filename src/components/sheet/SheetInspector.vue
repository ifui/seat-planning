<script setup lang="ts">
import { computed } from 'vue'
import type { CellStyle, Sheet, SheetCell } from '../../types'
import type { CellRange } from '../../engine/sheet'
import { cellAt, blockRoleLabel, mergeAt, seatsInRow } from '../../engine/sheet'
import UiColorPicker from '../../ui/components/UiColorPicker.vue'

const props = defineProps<{
  sheet: Sheet
  selection: CellRange
  active: { row: number; col: number }
}>()

const emit = defineEmits<{
  (e: 'patch', patch: Partial<SheetCell>): void
  (e: 'style', patch: CellStyle): void
  /** 取色器拖动中的实时预览，不写撤销历史 */
  (e: 'preview-style', patch: CellStyle): void
}>()

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

function previewFill(v: string): void {
  emit('preview-style', { fill: v })
}

function setFill(v: string): void {
  emit('style', { fill: v })
}

function clearFill(): void {
  emit('style', { fill: undefined })
}

function previewTextColor(v: string): void {
  emit('preview-style', { textColor: v })
}

function setTextColor(v: string): void {
  emit('style', { textColor: v })
}

function toggleDisabled(): void {
  emit('patch', { disabled: !anchorCell.value?.disabled })
}

function toggleLocked(): void {
  emit('patch', { locked: !anchorCell.value?.locked })
}

const fillColor = computed(() => anchorCell.value?.style?.fill ?? '')
const textColor = computed(() => anchorCell.value?.style?.textColor ?? '')
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
          <label class="insp-switch" title="不坐人：保留位置但不能坐人">
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
      <div class="insp-title">样式</div>
      <div class="insp-rows">
        <div class="insp-row">
          <span class="insp-label">底色</span>
          <span class="insp-ctl">
            <UiColorPicker
              :model-value="fillColor"
              allow-clear
              clear-label="清除底色"
              custom-label="自定义底色"
              @update:model-value="previewFill"
              @change="setFill"
              @clear="clearFill"
            />
          </span>
        </div>
        <div class="insp-row">
          <span class="insp-label">文字</span>
          <span class="insp-ctl">
            <UiColorPicker
              :model-value="textColor"
              allow-clear
              clear-label="恢复默认文字色"
              custom-label="自定义文字颜色"
              @update:model-value="previewTextColor"
              @change="setTextColor"
              @clear="emit('style', { textColor: undefined })"
            />
          </span>
        </div>
      </div>
    </section>

    <section class="insp-sec si-stats">
      <div class="insp-title">工作表</div>
      <div class="insp-stat"><span>行列</span><b>{{ sheet.rows }} × {{ sheet.cols }}</b></div>
      <div class="insp-stat"><span>座位总数</span><b>{{ seatTotal }}</b></div>
      <div class="insp-stat"><span>合并区</span><b>{{ mergedCount }}</b></div>
      <div class="insp-stat"><span>已填单元格</span><b>{{ Object.keys(sheet.cells).length }}</b></div>
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
.si-stats { gap: 5px; }
</style>
