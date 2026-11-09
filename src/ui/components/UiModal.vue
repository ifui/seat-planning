<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import UiIcon from './UiIcon.vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title: string
    description?: string
    width?: string
  }>(),
  { description: '', width: '460px' }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'close'): void }>()

function close(): void {
  emit('update:modelValue', false)
  emit('close')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

watch(
  () => props.modelValue,
  (v) => {
    document.body.style.overflow = v ? 'hidden' : ''
    if (v) document.addEventListener('keydown', onKey)
    else document.removeEventListener('keydown', onKey)
  }
)

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="umodal">
      <div v-if="modelValue" class="umodal-mask" @click.self="close">
        <div class="umodal" :style="{ width }" role="dialog" aria-modal="true">
          <header class="umodal-head">
            <div>
              <h2 class="umodal-title">{{ title }}</h2>
              <p v-if="description" class="umodal-desc">{{ description }}</p>
            </div>
            <button type="button" class="umodal-x" aria-label="关闭" @click="close">
              <UiIcon name="close" :size="12" />
            </button>
          </header>
          <div class="umodal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="umodal-foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
