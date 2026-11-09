<script setup lang="ts">
export interface SegOption {
  value: string | number
  label: string
  title?: string
  disabled?: boolean
}

withDefaults(
  defineProps<{
    modelValue: string | number | null
    options: SegOption[]
    block?: boolean
  }>(),
  { block: false }
)
const emit = defineEmits<{ (e: 'update:modelValue', v: string | number): void }>()
</script>

<template>
  <div class="seg" :class="{ block }">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      class="seg-btn"
      :class="{ on: o.value === modelValue }"
      :title="o.title"
      :disabled="o.disabled"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>
