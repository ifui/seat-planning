<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Sheet } from '../../types'
import UiButton from '../../ui/components/UiButton.vue'
import UiModal from '../../ui/components/UiModal.vue'
import UiNumberInput from '../../ui/components/UiNumberInput.vue'

const props = defineProps<{
  modelValue: boolean
  sheet: Sheet
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'apply', v: { rows: number; cols: number; colWidth: number; rowHeight: number; frozenRows: number; frozenCols: number }): void
}>()

const rows = ref(12)
const cols = ref(10)
const colWidth = ref(120)
const rowHeight = ref(64)
const frozenRows = ref(0)
const frozenCols = ref(0)

watch(
  () => props.modelValue,
  (v) => {
    if (!v) return
    rows.value = props.sheet.rows
    cols.value = props.sheet.cols
    colWidth.value = props.sheet.defaultColWidth
    rowHeight.value = props.sheet.defaultRowHeight
    frozenRows.value = props.sheet.frozenRows
    frozenCols.value = props.sheet.frozenCols
  }
)

function submit(): void {
  emit('apply', {
    rows: Math.max(1, Math.min(300, Math.round(rows.value) || 1)),
    cols: Math.max(1, Math.min(100, Math.round(cols.value) || 1)),
    colWidth: Math.max(48, Math.min(600, Math.round(colWidth.value) || 120)),
    rowHeight: Math.max(32, Math.min(400, Math.round(rowHeight.value) || 64)),
    frozenRows: Math.max(0, Math.min(5, Math.round(frozenRows.value) || 0)),
    frozenCols: Math.max(0, Math.min(5, Math.round(frozenCols.value) || 0))
  })
  emit('update:modelValue', false)
}
</script>

<template>
  <UiModal
    :model-value="modelValue"
    title="表格设置"
    description="缩小行列会裁掉超出范围的内容"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="ss">
      <label class="ss-field">
        <span>行数</span>
        <UiNumberInput v-model="rows" width="100%" :min="1" :max="300" label="行数" />
      </label>
      <label class="ss-field">
        <span>列数</span>
        <UiNumberInput v-model="cols" width="100%" :min="1" :max="100" label="列数" />
      </label>
      <label class="ss-field">
        <span>默认列宽</span>
        <UiNumberInput v-model="colWidth" width="100%" :min="48" :max="600" unit="px" label="默认列宽" />
      </label>
      <label class="ss-field">
        <span>默认行高</span>
        <UiNumberInput v-model="rowHeight" width="100%" :min="32" :max="400" unit="px" label="默认行高" />
      </label>
      <label class="ss-field">
        <span>冻结行</span>
        <UiNumberInput v-model="frozenRows" width="100%" :min="0" :max="5" label="冻结行数" />
      </label>
      <label class="ss-field">
        <span>冻结列</span>
        <UiNumberInput v-model="frozenCols" width="100%" :min="0" :max="5" label="冻结列数" />
      </label>
    </div>
    <template #footer>
      <UiButton variant="ghost" size="sm" @click="emit('update:modelValue', false)">取消</UiButton>
      <UiButton variant="primary" size="sm" @click="submit">应用</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.ss { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ss-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
</style>
