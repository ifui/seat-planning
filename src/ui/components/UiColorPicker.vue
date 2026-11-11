<script setup lang="ts">
/**
 * 全站统一取色器：预设色块 + 自定义取色 + 可选的清除/恢复默认。
 * 色块统一 20×20 圆角 5px，自定义入口用同一尺寸的渐变块盖住原生 input，
 * 页面上不出现浏览器原生取色控件外观。
 */
import { computed } from 'vue'
import { COLOR_PRESETS } from '../colorPalette'

const props = withDefaults(
  defineProps<{
    modelValue?: string | null
    /** 需要按场景裁剪时传入，默认使用全站统一预设 */
    presets?: string[]
    allowClear?: boolean
    clearLabel?: string
    customLabel?: string
    disabled?: boolean
  }>(),
  {
    modelValue: '',
    presets: () => COLOR_PRESETS,
    allowClear: false,
    clearLabel: '清除颜色',
    customLabel: '自定义取色',
    disabled: false
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  /** 点击预设或原生取色确认后触发，用于写入撤销历史 */
  (e: 'change', v: string): void
  (e: 'clear'): void
}>()

const current = computed(() => (props.modelValue ?? '').trim())
const active = computed(() => {
  const v = current.value.toLowerCase()
  return props.presets.find((c) => c.toLowerCase() === v) ?? ''
})
const isCustom = computed(() => !!current.value && !active.value)

function pick(color: string): void {
  if (props.disabled) return
  emit('update:modelValue', color)
  emit('change', color)
}

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

function onChange(e: Event): void {
  const v = (e.target as HTMLInputElement).value
  emit('update:modelValue', v)
  emit('change', v)
}

function clear(): void {
  if (props.disabled) return
  emit('clear')
}
</script>

<template>
  <div class="ui-color" :class="{ 'is-disabled': disabled }">
    <button
      v-for="c in presets"
      :key="c"
      type="button"
      class="ui-color-swatch"
      :class="{ on: active === c }"
      :style="{ background: c }"
      :title="c"
      :aria-label="c"
      :disabled="disabled"
      @click="pick(c)"
    />
    <label class="ui-color-custom" :class="{ on: isCustom }" :title="customLabel">
      <input
        type="color"
        :value="current || '#ffffff'"
        :disabled="disabled"
        :aria-label="customLabel"
        @input="onInput"
        @change="onChange"
      />
    </label>
    <button
      v-if="allowClear"
      type="button"
      class="ui-color-clear"
      :class="{ on: !current }"
      :title="clearLabel"
      :aria-label="clearLabel"
      :disabled="disabled"
      @click="clear"
    >
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 9.5 9.5 2.5" /></svg>
    </button>
  </div>
</template>

<style scoped>
.ui-color { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; width: 100%; min-width: 0; }
.ui-color.is-disabled { opacity: 0.5; }

.ui-color-swatch {
  width: 20px; height: 20px; padding: 0; flex: none;
  border: 1px solid rgba(0, 0, 0, .12); border-radius: 5px;
  cursor: pointer;
}
.ui-color-swatch.on { outline: 2px solid var(--primary); outline-offset: 1px; }

.ui-color-custom {
  position: relative; width: 20px; height: 20px; flex: none;
  border: 1px solid rgba(0, 0, 0, .12); border-radius: 5px;
  overflow: hidden; cursor: pointer;
  background: conic-gradient(from 210deg, #e76f51, #e9c46a, #2a9d8f, #4a7c7b, #7c6fa0, #e76f51);
}
.ui-color-custom.on { outline: 2px solid var(--primary); outline-offset: 1px; }
.ui-color-custom input {
  position: absolute; inset: 0; width: 100%; height: 100%;
  padding: 0; border: 0; opacity: 0; cursor: pointer;
}

.ui-color-clear {
  width: 20px; height: 20px; padding: 0; flex: none;
  display: grid; place-items: center; cursor: pointer;
  border: 1px solid rgba(0, 0, 0, .12); border-radius: 5px;
  background: var(--bg-panel); color: var(--danger);
}
.ui-color-clear svg { width: 12px; height: 12px; }
.ui-color-clear svg path { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.ui-color-clear.on { outline: 2px solid var(--primary); outline-offset: 1px; }
</style>
