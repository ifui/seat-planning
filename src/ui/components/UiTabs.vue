<script setup lang="ts">
export interface TabItem {
  key: string
  label: string
  badge?: number | string
}

defineProps<{ modelValue: string; items: TabItem[] }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <div class="tabs ui-tabs" role="tablist">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      role="tab"
      class="tab"
      :class="{ active: item.key === modelValue }"
      :aria-selected="item.key === modelValue"
      @click="emit('update:modelValue', item.key)"
    >
      {{ item.label }}<span v-if="item.badge" class="tab-badge">{{ item.badge }}</span>
    </button>
  </div>
</template>
