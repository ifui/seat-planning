<script setup lang="ts">
withDefaults(defineProps<{ bodyClass?: string; headClass?: string }>(), { bodyClass: '', headClass: '' })
</script>

<template>
  <div class="ui-panel">
    <header v-if="$slots.head" class="ui-panel-head" :class="headClass">
      <slot name="head" />
    </header>
    <div class="ui-panel-body" :class="bodyClass">
      <slot />
    </div>
    <footer v-if="$slots.foot" class="ui-panel-foot">
      <slot name="foot" />
    </footer>
  </div>
</template>
