<script setup lang="ts">
withDefaults(defineProps<{ label?: string; marginLeft?: boolean }>(), { label: '', marginLeft: false })
</script>

<template>
  <div class="tb-group" :style="marginLeft ? { marginLeft: 'auto' } : undefined">
    <span v-if="label" class="tb-label">{{ label }}</span>
    <slot />
  </div>
</template>
