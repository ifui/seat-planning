<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{ open: boolean; x: number; y: number; minWidth?: number }>(),
  { minWidth: 190 }
)

const emit = defineEmits<{ (e: 'close'): void }>()

const panelRef = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })

function place(): void {
  const h = panelRef.value?.offsetHeight ?? 260
  const w = panelRef.value?.offsetWidth ?? props.minWidth
  const left = Math.max(8, Math.min(props.x, window.innerWidth - w - 8))
  const top = Math.max(8, Math.min(props.y, window.innerHeight - h - 8))
  pos.value = { left, top }
}

function close(): void {
  emit('close')
}

function onDocDown(e: PointerEvent): void {
  if (panelRef.value?.contains(e.target as Node)) return
  close()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

function onScroll(e: Event): void {
  const t = e.target as Node | null
  if (t && panelRef.value?.contains(t)) return
  close()
}

function bind(on: boolean): void {
  if (on) {
    document.addEventListener('pointerdown', onDocDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', onScroll, true)
  } else {
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', onScroll, true)
  }
}

watch(
  () => [props.open, props.x, props.y],
  ([open]) => {
    if (open) nextTick(place)
  },
  { immediate: true }
)

watch(() => props.open, bind)
onBeforeUnmount(() => bind(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="menu">
      <div
        v-if="open"
        ref="panelRef"
        class="ui-menu"
        :style="{ left: pos.left + 'px', top: pos.top + 'px', minWidth: minWidth + 'px' }"
        role="menu"
        @contextmenu.prevent
      >
        <slot :close="close" />
      </div>
    </Transition>
  </Teleport>
</template>
