<script setup lang="ts">
/**
 * 全站统一数值输入：替换浏览器原生 number 控件。
 * - 不使用 type="number"，因此没有原生上下箭头；
 * - 单位固定在框内右侧，输入区左对齐，宽度固定；
 * - 支持 ↑/↓ 与鼠标滚轮步进（聚焦时），Enter/失焦提交；
 * - 聚焦态与 .insp-input 共用同一套描边。
 */
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue?: number | null
    min?: number
    max?: number
    step?: number
    unit?: string
    /** 保留的小数位，默认整数 */
    decimals?: number
    /** 固定宽度，可传数字（px）或 CSS 宽度 */
    width?: number | string
    size?: 'sm' | 'md'
    disabled?: boolean
    label?: string
  }>(),
  {
    modelValue: null,
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    step: 1,
    unit: '',
    decimals: 0,
    width: 64,
    size: 'md',
    disabled: false,
    label: '数值'
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void
  (e: 'change', v: number): void
  (e: 'enter'): void
  (e: 'focus'): void
}>()

const focused = ref(false)
const draft = ref('')

function format(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return ''
  return String(Number(v.toFixed(props.decimals)))
}

function parse(text: string): number {
  return Number(text.trim().replace(',', '.'))
}

function normalize(n: number): number {
  const clamped = Math.min(props.max, Math.max(props.min, n))
  return Number(clamped.toFixed(props.decimals))
}

watch(
  () => props.modelValue,
  (v) => {
    if (!focused.value) draft.value = format(v)
  },
  { immediate: true }
)

function onInput(e: Event): void {
  draft.value = (e.target as HTMLInputElement).value
  const n = parse(draft.value)
  if (Number.isFinite(n)) emit('update:modelValue', normalize(n))
}

function commit(e?: Event): void {
  const text = e ? (e.target as HTMLInputElement).value : draft.value
  draft.value = text
  const n = parse(text)
  if (!Number.isFinite(n)) {
    draft.value = format(props.modelValue)
    return
  }
  const v = normalize(n)
  draft.value = format(v)
  if (v !== props.modelValue) {
    emit('update:modelValue', v)
    emit('change', v)
  }
}

function stepBy(dir: number): void {
  if (props.disabled) return
  const typed = parse(draft.value)
  const base = Number.isFinite(typed) ? typed : (props.modelValue ?? 0)
  const v = normalize(base + dir * props.step)
  draft.value = format(v)
  emit('update:modelValue', v)
  emit('change', v)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    stepBy(1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    stepBy(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    commit()
    emit('enter')
  }
}

function onWheel(e: WheelEvent): void {
  // 未聚焦时把滚轮让给页面滚动，避免误触改值
  if (!focused.value || props.disabled) return
  e.preventDefault()
  stepBy(e.deltaY < 0 ? 1 : -1)
}

function onFocus(): void {
  focused.value = true
  emit('focus')
}

function onBlur(): void {
  focused.value = false
  commit()
}
</script>

<template>
  <span
    class="ui-num"
    :class="[size, { 'has-unit': !!unit, 'is-disabled': disabled }]"
    :style="{ width: typeof width === 'number' ? width + 'px' : width }"
  >
    <input
      class="ui-num-input"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      role="spinbutton"
      :value="draft"
      :disabled="disabled"
      :aria-label="label"
      :aria-valuenow="modelValue ?? undefined"
      @input="onInput"
      @change="commit"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
      @wheel="onWheel"
    />
    <span v-if="unit" class="ui-num-unit" aria-hidden="true">{{ unit }}</span>
  </span>
</template>

<style scoped>
.ui-num {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex: none;
  height: 28px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-xs);
  background: var(--bg-panel);
  transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease, background var(--motion-fast) ease;
}
.ui-num:hover:not(.is-disabled) { border-color: var(--text-muted); }
.ui-num:focus-within,
.ui-num:focus-within:hover {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(74, 124, 123, .18);
}
.ui-num.is-disabled { opacity: .5; }

.ui-num-input {
  width: 100%;
  height: 100%;
  padding: 0 8px;
  border: 0;
  border-radius: inherit;
  background: none;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  outline: none;
}
.ui-num.has-unit .ui-num-input { padding-right: 25px; }

.ui-num-unit {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-style: normal;
  font-size: 11px;
  line-height: 1;
  color: var(--text-disabled);
  pointer-events: none;
}

.ui-num.sm { height: 24px; }
.ui-num.sm .ui-num-input { padding: 0 6px; font-size: 11px; }
.ui-num.sm.has-unit .ui-num-input { padding-right: 20px; }
.ui-num.sm .ui-num-unit { right: 5px; font-size: 10px; }
</style>
