<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string | number | null
    type?: 'text' | 'number'
    min?: number
    max?: number
    step?: number
    placeholder?: string
    unit?: string
    disabled?: boolean
  }>(),
  { type: 'text', placeholder: '', unit: '', disabled: false }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string | number | null): void }>()

const shown = computed(() => (props.modelValue === null || props.modelValue === undefined ? '' : String(props.modelValue)))

function onInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value
  if (props.type === 'number') emit('update:modelValue', raw === '' ? null : Number(raw))
  else emit('update:modelValue', raw)
}
</script>

<template>
  <div :class="{ 'num-field': !!unit }" class="ui-input">
    <input
      class="input"
      :type="type"
      :value="shown"
      :min="min"
      :max="max"
      :step="step"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
    <span v-if="unit" class="unit">{{ unit }}</span>
  </div>
</template>
