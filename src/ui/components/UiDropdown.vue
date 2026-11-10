<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useAnchoredPopup } from '../useAnchoredPopup'

const props = withDefaults(
  defineProps<{
    width?: number
    minWidth?: number
    align?: 'left' | 'right'
    panelClass?: string
  }>(),
  { width: 0, minWidth: 0, align: 'left', panelClass: '' }
)

const emit = defineEmits<{ (e: 'open'): void; (e: 'close'): void }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

const { panelStyle, place, bind } = useAnchoredPopup(open, rootRef, panelRef, {
  gap: 4,
  width: props.width,
  minWidth: props.minWidth,
  align: props.align,
  maxHeight: 520
})

function toggle(): void {
  if (open.value) close()
  else {
    place()
    open.value = true
    emit('open')
  }
}

function close(): void {
  if (!open.value) return
  open.value = false
  emit('close')
}

function onDocDown(e: PointerEvent): void {
  if (!open.value) return
  const t = e.target as Node
  if (rootRef.value?.contains(t) || panelRef.value?.contains(t)) return
  close()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

watch(open, (v) => {
  bind(v)
  if (v) {
    document.addEventListener('pointerdown', onDocDown, true)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKey)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  document.removeEventListener('keydown', onKey)
  bind(false)
})

defineExpose({ close, toggle, open })
</script>

<template>
  <div ref="rootRef" class="ui-dropdown" :class="{ open }" @click="toggle">
    <div class="ui-dropdown-trigger">
      <slot name="trigger" :open="open" />
    </div>
    <Teleport to="body">
      <Transition name="uidrop">
        <div
          v-if="open"
          ref="panelRef"
          class="ui-dropdown-panel"
          :class="panelClass"
          :style="panelStyle"
          @click.stop
        >
          <slot :close="close" :open="open" />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
