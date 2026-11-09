<script setup lang="ts">
const props = withDefaults(defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>(), {
  label: '',
  disabled: false
})
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

function onChange(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <label class="inline-check">
    <input type="checkbox" :checked="modelValue" :disabled="disabled" @change="onChange" />
    <span v-if="label || $slots.default"><slot>{{ label }}</slot></span>
  </label>
</template>
