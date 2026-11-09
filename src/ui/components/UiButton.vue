<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'

const props = withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'copper' | 'ghost' | 'danger'
    size?: 'md' | 'sm' | 'xs'
    icon?: string
    iconSize?: number
    block?: boolean
    type?: 'button' | 'submit'
  }>(),
  { variant: 'default', size: 'md', type: 'button', block: false, iconSize: 0 }
)

const cls = computed(() => [
  'btn',
  props.variant !== 'default' ? props.variant : '',
  props.size !== 'md' ? props.size : '',
  { block: props.block }
])
const icoSize = computed(() => props.iconSize || (props.size === 'xs' ? 11 : props.size === 'sm' ? 13 : 14))
</script>

<template>
  <button :type="type" class="ui-btn" :class="cls">
    <UiIcon v-if="icon" :name="icon" :size="icoSize" />
    <slot />
  </button>
</template>
