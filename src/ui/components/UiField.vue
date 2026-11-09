<script setup lang="ts">
withDefaults(defineProps<{ label?: string }>(), { label: '' })
</script>

<template>
  <div class="field">
    <label v-if="label">{{ label }}</label>
    <slot />
  </div>
</template>
