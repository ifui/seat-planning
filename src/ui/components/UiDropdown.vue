<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

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
const panelStyle = ref<Record<string, string>>({})

function place(): void {
  const el = rootRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const pw = props.width || panelRef.value?.offsetWidth || 200
  let left = props.align === 'right' ? r.right - pw : r.left
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8))
  let top = r.bottom + 6
  const ph = panelRef.value?.offsetHeight ?? 280
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6)
  const style: Record<string, string> = { left: left + 'px', top: top + 'px' }
  if (props.width) style.width = props.width + 'px'
  if (props.minWidth) style.minWidth = props.minWidth + 'px'
  panelStyle.value = style
}

function toggle(): void {
  if (open.value) close()
  else {
    open.value = true
    emit('open')
    nextTick(place)
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

function onScroll(e: Event): void {
  const t = e.target as Node | null
  if (t && (panelRef.value?.contains(t) || rootRef.value?.contains(t))) return
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

watch(open, bind)
onBeforeUnmount(() => bind(false))

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
