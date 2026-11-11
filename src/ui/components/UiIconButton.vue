<script setup lang="ts">
import UiIcon from './UiIcon.vue'

withDefaults(
  defineProps<{
    icon: string
    iconSize?: number
    title?: string
    ariaLabel?: string
    active?: boolean
    disabled?: boolean
    danger?: boolean
  }>(),
  { iconSize: 16, title: '', ariaLabel: '', active: false, disabled: false, danger: false }
)
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="{ active }"
    :title="title"
    :aria-label="ariaLabel || title || undefined"
    :disabled="disabled"
    :style="danger ? { color: 'var(--danger)' } : undefined"
  >
    <UiIcon :name="icon" :size="iconSize" />
  </button>
</template>
