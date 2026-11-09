<script setup lang="ts">
withDefaults(defineProps<{ sub?: boolean }>(), { sub: false })
</script>

<template>
  <div class="toolbar ui-toolbar" :class="{ 'is-sub': sub }">
    <slot />
  </div>
</template>
