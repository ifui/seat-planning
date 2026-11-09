<script setup lang="ts">
import UiIcon from './UiIcon.vue'

withDefaults(
  defineProps<{
    icon?: string
    label?: string
    shortcut?: string
    danger?: boolean
    disabled?: boolean
    checked?: boolean
    caret?: boolean
  }>(),
  { icon: '', label: '', shortcut: '', danger: false, disabled: false, checked: false, caret: false }
)
</script>

<template>
  <button type="button" class="ui-menu-item" :class="{ danger }" :disabled="disabled">
    <UiIcon v-if="icon" :name="icon" :size="14" />
    <span class="ui-menu-item-label"><slot>{{ label }}</slot></span>
    <span v-if="checked" class="ui-menu-item-check"><UiIcon name="check" :size="12" /></span>
    <span v-if="shortcut" class="ui-menu-item-k">{{ shortcut }}</span>
    <span v-if="caret" class="ui-menu-caret"><UiIcon name="chevronRight" :size="11" /></span>
  </button>
</template>
