<script setup lang="ts">
import { computed } from 'vue'
import type { CellStyle, Sheet, SheetCell, ZoneDef } from '../../types'
import type { CellRange } from '../../engine/sheet'
import { cellAt, blockRoleLabel, mergeAt, seatsInRow } from '../../engine/sheet'
import UiButton from '../../ui/components/UiButton.vue'
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
  return `特殊块 · ${blockRoleLabel(c.role)}`
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

const zoneOptions = computed(() => [
  { value: '', label: '未分配区域' },
  ...props.zones.map((z) => ({ value: z.id, label: z.name }))
])

function onZone(v: string): void {
  emit('select-zone', v)
}
</script>

<template>
  <aside class="sheet-inspector">
    <section class="si-block">
      <div class="si-title">选区</div>
      <div class="si-range">{{ range.r1 + 1 }} 排 {{ range.c1 + 1 }} 列 — {{ range.r2 + 1 }} 排 {{ range.c2 + 1 }} 列</div>
      <div class="si-meta">{{ cellCount }} 格 · {{ selectedSeats }} 个座位</div>
      <div class="si-kind">{{ kindLabel }}</div>
    </section>

    <section v-if="isSeat" class="si-block">
      <div class="si-title">座位</div>
      <label class="si-field">
        <span>桌号 / 桌名</span>
        <input :value="anchorCell?.tableLabel ?? ''" placeholder="如：1 排 · A 桌" @change="setTableLabel" />
      </label>
      <label class="si-field si-field-row">
        <span>固定空位</span>
        <input type="checkbox" :checked="!!anchorCell?.disabled" @change="toggleDisabled" />
      </label>
      <label class="si-field si-field-row">
        <span>锁定（不被批量覆盖）</span>
        <input type="checkbox" :checked="!!anchorCell?.locked" @change="toggleLocked" />
      </label>
      <p class="si-hint">这里只定义座位位置；一桌坐几人请在排座项目中设置。</p>
    </section>

    <section v-if="isBlock" class="si-block">
      <div class="si-title">特殊块</div>
      <label class="si-field">
        <span>显示文字</span>
        <input :value="anchorCell?.text ?? ''" placeholder="如：过道 / 主席台 / 背景板" @change="setText" />
      </label>
    </section>

    <section class="si-block">
      <div class="si-title">区域</div>
      <UiSelect :model-value="anchorCell?.zoneId ?? ''" :options="zoneOptions" size="sm" @update:model-value="onZone" />
      <UiButton
        v-if="anchorCell?.zoneId"
        variant="ghost"
        size="sm"
        @click="emit('select-zone', '')"
      >清除选区归属</UiButton>
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
      <UiButton variant="ghost" size="sm" icon="plus" @click="emit('add-zone')">新建区域</UiButton>
      <p class="si-hint">点区域可在画布上高亮其全部格子；再点一次取消高亮。分配/解除区域可用 Ctrl+Z 撤销。</p>
    </section>

    <section class="si-block">
      <div class="si-title">样式</div>
      <div class="si-colors">
        <label class="si-color">
          <span>底色</span>
          <input
            type="color"
            :value="anchorCell?.style?.fill ?? '#ffffff'"
            @input="previewFill"
            @change="setFill"
          />
        </label>
        <button type="button" class="si-clear" @click="clearFill">清除底色</button>
      </div>
      <div class="si-colors">
        <label class="si-color">
          <span>文字</span>
          <input
            type="color"
            :value="anchorCell?.style?.textColor ?? '#26333a'"
            @input="previewTextColor"
            @change="setTextColor"
          />
        </label>
      </div>
    </section>

    <section class="si-block si-stats">
      <div class="si-title">工作表</div>
      <div class="si-stat"><span>行列</span><b>{{ sheet.rows }} × {{ sheet.cols }}</b></div>
      <div class="si-stat"><span>座位总数</span><b>{{ seatTotal }}</b></div>
      <div class="si-stat"><span>合并区</span><b>{{ mergedCount }}</b></div>
      <div class="si-stat"><span>已填单元格</span><b>{{ Object.keys(sheet.cells).length }}</b></div>
    </section>
  </aside>
</template>

<style scoped>
.sheet-inspector {
  width: 244px; flex: none;
  display: flex; flex-direction: column; gap: 10px;
  padding: 10px; overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.si-block { display: flex; flex-direction: column; gap: 6px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
.si-block:last-child { border-bottom: none; padding-bottom: 0; }
.si-title { font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: 0.02em; }
.si-range { font-size: 13px; color: var(--text-primary); font-weight: 500; }
.si-meta { font-size: 11px; color: var(--text-muted); }
.si-kind { font-size: 11px; color: var(--primary); background: var(--primary-soft); border-radius: 4px; padding: 3px 8px; align-self: flex-start; }
.si-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-muted); }
.si-field input[type='text'], .si-field input:not([type]) {
  height: 28px; padding: 0 8px; font-size: 12px; font-family: inherit;
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg);
  color: var(--text-primary); outline: none;
}
.si-field input:focus { border-color: var(--primary); }
.si-field-row { flex-direction: row; align-items: center; justify-content: space-between; }
.si-zones { display: flex; flex-direction: column; gap: 3px; }
.si-zone {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 4px 6px; border: none; border-radius: 4px; background: none;
  font-family: inherit; font-size: 11px; color: var(--text-secondary);
  text-align: left; cursor: pointer;
}
.si-zone:hover { background: var(--bg-hover); }
.si-zone.is-on { background: var(--primary-soft); color: var(--primary); }
.si-zone i { width: 9px; height: 9px; flex: none; border-radius: 2px; }
.si-zone span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.si-zone em { flex: none; font-style: normal; font-size: 10px; color: var(--text-disabled); font-variant-numeric: tabular-nums; }
.si-zone-edit {
  flex: none; border: none; background: none; color: var(--text-disabled);
  cursor: pointer; font-size: 11px; font-weight: 400; padding: 0 1px;
}
.si-zone-edit:hover { color: var(--primary); }
.si-zone-del { flex: none; border: none; background: none; color: var(--text-disabled); cursor: pointer; font-size: 13px; font-weight: 400; padding: 0 2px; }
.si-zone-del:hover { color: var(--danger); }
.si-hint { margin: 2px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--text-disabled); }

.si-colors { display: flex; gap: 10px; align-items: center; }
.si-color { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); }
.si-color-grow { flex: 1; min-width: 0; }
.si-color-grow :deep(.ui-select) { flex: 1; min-width: 0; }
.si-inline-label { flex: none; font-size: 11px; color: var(--text-muted); }
.si-select-grow { flex: 1; min-width: 0; }
.si-color input { width: 24px; height: 22px; padding: 0; border: 1px solid var(--border); border-radius: 3px; background: none; }
.si-clear {
  height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: 4px;
  background: var(--bg); color: var(--text-muted);
  font-family: inherit; font-size: 10.5px; cursor: pointer;
}
.si-clear:hover { color: var(--primary); border-color: var(--primary-line); }
.si-stats { gap: 4px; }
.si-stat { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); }
.si-stat b { color: var(--text-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }
</style>
