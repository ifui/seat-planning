<script setup lang="ts">
/**
 * 网格对话框：先定行列生成表格式网格，元素放进格子。
 * 排/列号由格子决定，排座直接读行列号；这里只负责参数与入格操作。
 */
import { computed, ref, watch } from 'vue'
import { UiModal } from '../../ui'
import type { BaseElement, GridConfig, GridAlign } from '../../types'

const props = defineProps<{
  modelValue: boolean
  grid?: GridConfig
  selection: BaseElement[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'create', opts: { rows: number; cols: number; colWidth: number; rowHeight: number; originX: number; originY: number; padding: number; autoPlace: boolean }): void
  (e: 'update', opts: { rows: number; cols: number; colWidth: number; rowHeight: number; originX: number; originY: number; padding: number }): void
  (e: 'apply'): void
  (e: 'clear'): void
  (e: 'cell', payload: { id: string; row: number; col: number; rowSpan: number; colSpan: number; align: GridAlign; pad: number }): void
  (e: 'detach', id: string): void
}>()

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const form = ref({
  rows: 10,
  cols: 11,
  colWidth: 160,
  rowHeight: 72,
  originX: 40,
  originY: 120,
  padding: 6,
  autoPlace: true
})

const cellForm = ref({ row: 0, col: 0, rowSpan: 1, colSpan: 1, align: 'fill' as GridAlign, pad: 6 })

watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    const g = props.grid
    if (g) {
      form.value.rows = g.rows
      form.value.cols = g.cols
      form.value.colWidth = g.colWidth
      form.value.rowHeight = g.rowHeight
      form.value.originX = g.originX
      form.value.originY = g.originY
      form.value.padding = g.padding
    }
    const el = props.selection.length === 1 ? props.selection[0] : null
    if (el?.cell) {
      cellForm.value = {
        row: el.cell.row + 1,
        col: el.cell.col + 1,
        rowSpan: el.cell.rowSpan ?? 1,
        colSpan: el.cell.colSpan ?? 1,
        align: el.align ?? 'fill',
        pad: el.pad ?? props.grid?.padding ?? 6
      }
    }
  }
)

const single = computed(() => (props.selection.length === 1 ? props.selection[0] : null))
const strayCount = computed(() => props.selection.filter((e) => !e.cell).length)

function submit(): void {
  const o = {
    rows: Math.max(1, Math.round(form.value.rows) || 1),
    cols: Math.max(1, Math.round(form.value.cols) || 1),
    colWidth: Math.max(24, Math.round(form.value.colWidth) || 160),
    rowHeight: Math.max(24, Math.round(form.value.rowHeight) || 72),
    originX: Math.max(0, Math.round(form.value.originX) || 0),
    originY: Math.max(0, Math.round(form.value.originY) || 0),
    padding: Math.max(0, Math.round(form.value.padding) || 0)
  }
  if (props.grid) emit('update', o)
  else emit('create', { ...o, autoPlace: form.value.autoPlace })
  open.value = false
}

function submitCell(): void {
  if (!single.value) return
  const g = props.grid
  emit('cell', {
    id: single.value.id,
    row: Math.max(0, Math.round(cellForm.value.row) - 1),
    col: Math.max(0, Math.round(cellForm.value.col) - 1),
    rowSpan: Math.max(1, Math.round(cellForm.value.rowSpan) || 1),
    colSpan: Math.max(1, Math.round(cellForm.value.colSpan) || 1),
    align: cellForm.value.align,
    pad: Math.max(0, Math.round(cellForm.value.pad) || 0)
  })
  if (!g) return
  open.value = false
}
</script>

<template>
  <UiModal
    v-model="open"
    title="布局网格"
    description="先定行列生成表格式网格，元素放进格子；排座直接读格子行列号，不再靠坐标反推"
    width="600px"
  >
    <div class="field-row">
      <div class="field"><label>行数（排）</label><input v-model.number="form.rows" type="number" min="1" max="200" class="input" /></div>
      <div class="field"><label>列数</label><input v-model.number="form.cols" type="number" min="1" max="200" class="input" /></div>
      <div class="field"><label>内边距</label><input v-model.number="form.padding" type="number" min="0" class="input" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>列宽</label><input v-model.number="form.colWidth" type="number" min="24" class="input" /></div>
      <div class="field"><label>行高</label><input v-model.number="form.rowHeight" type="number" min="24" class="input" /></div>
      <div class="field"><label>起始 X / Y</label>
        <div style="display: flex; gap: 6px">
          <input v-model.number="form.originX" type="number" min="0" class="input" />
          <input v-model.number="form.originY" type="number" min="0" class="input" />
        </div>
      </div>
    </div>
    <div class="gen-summary">
      <div>
        网格 <strong>{{ Math.max(1, Math.round(form.rows)) }} × {{ Math.max(1, Math.round(form.cols)) }}</strong>
        · 格子约 {{ Math.round(form.colWidth) }} × {{ Math.round(form.rowHeight) }} px
        · 共 {{ Math.max(1, Math.round(form.rows)) * Math.max(1, Math.round(form.cols)) }} 格
      </div>
      <div class="gen-note">
        拖动/缩放元素松手后自动吸附到最近空格；跨格用「跨行/跨列」表达，等同合并单元格。
      </div>
    </div>
    <label v-if="!grid" class="inline-check" style="margin-top: 8px">
      <input v-model="form.autoPlace" type="checkbox" />
      生成后把现有元素按中心点套进网格
    </label>

    <template v-if="grid">
      <div class="field-row" style="margin-top: 14px">
        <button class="btn" style="flex: 1" @click="emit('apply')">套用现有元素</button>
        <button class="btn" style="flex: 1" @click="emit('clear')">解除网格</button>
      </div>

      <div v-if="single" class="gen-summary" style="margin-top: 14px">
        <div style="margin-bottom: 8px">
          <strong>选中元素入格</strong>
          <span class="grid-badge" :class="{ stray: !single.cell }" style="margin-left: 8px">
            {{ single.cell ? `第 ${single.cell.row + 1} 排 · 第 ${single.cell.col + 1} 列` : '游离元素' }}
          </span>
        </div>
        <div class="field-row">
          <div class="field"><label>排（行）</label><input v-model.number="cellForm.row" type="number" min="1" class="input" /></div>
          <div class="field"><label>列</label><input v-model.number="cellForm.col" type="number" min="1" class="input" /></div>
          <div class="field"><label>跨行</label><input v-model.number="cellForm.rowSpan" type="number" min="1" class="input" /></div>
          <div class="field"><label>跨列</label><input v-model.number="cellForm.colSpan" type="number" min="1" class="input" /></div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>格内对齐</label>
            <select v-model="cellForm.align" class="input">
              <option value="fill">铺满格子</option>
              <option value="center">居中</option>
              <option value="start">靠左 / 靠上</option>
              <option value="end">靠右 / 靠下</option>
            </select>
          </div>
          <div class="field"><label>元素留白</label><input v-model.number="cellForm.pad" type="number" min="0" class="input" /></div>
          <div class="field" style="display: flex; align-items: flex-end; gap: 6px">
            <button class="btn primary" style="flex: 1" @click="submitCell">应用</button>
            <button v-if="single.cell" class="btn" @click="emit('detach', single.id)">移出</button>
          </div>
        </div>
        <div v-if="strayCount" class="gen-note">{{ strayCount }} 个选中元素尚未入格，拖进网格或点「套用现有元素」。</div>
      </div>
    </template>

    <template #footer>
      <button class="btn" @click="open = false">取消</button>
      <button class="btn primary" @click="submit">{{ grid ? '更新网格' : '生成网格' }}</button>
    </template>
  </UiModal>
</template>
