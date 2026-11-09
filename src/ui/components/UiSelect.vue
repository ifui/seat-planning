<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface SelectOption {
  value: string | number
  label: string
  hint?: string
  color?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue?: string | number | null
    options: SelectOption[]
    placeholder?: string
    size?: 'sm' | 'md'
    disabled?: boolean
  }>(),
  { placeholder: '请选择', size: 'md' }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: any): void }>()

const open = ref(false)
const activeIndex = ref(-1)
const trigger = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})
const panelRef = ref<HTMLElement | null>(null)

const selected = computed(() => props.options.find((o) => o.value === props.modelValue))

function position(): void {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.max(r.width, 172)
  const rowH = 36
  const estimated = Math.min(props.options.length, 9) * rowH + 12
  let top = r.bottom + 6
  if (top + estimated > window.innerHeight - 8) {
    top = Math.max(8, r.top - estimated - 6)
  }
  let left = r.left
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8
  panelStyle.value = { left: left + 'px', top: top + 'px', width: width + 'px' }
}

function toggle(): void {
  if (props.disabled) return
  if (open.value) { open.value = false; return }
  position()
  open.value = true
  const idx = props.options.findIndex((o) => o.value === props.modelValue)
  activeIndex.value = idx >= 0 ? idx : 0
  nextTick(() => {
    panelRef.value?.querySelector<HTMLElement>('.ui-select-opt.active')?.scrollIntoView({ block: 'nearest' })
  })
}

function pick(o: SelectOption): void {
  if (o.disabled) return
  emit('update:modelValue', o.value)
  open.value = false
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { open.value = false; return }
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      toggle()
    }
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const dir = e.key === 'ArrowDown' ? 1 : -1
    let i = activeIndex.value
    for (let n = 0; n < props.options.length; n++) {
      i = (i + dir + props.options.length) % props.options.length
      if (!props.options[i].disabled) break
    }
    activeIndex.value = i
    nextTick(() => {
      panelRef.value?.querySelector<HTMLElement>('.ui-select-opt.active')?.scrollIntoView({ block: 'nearest' })
    })
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const o = props.options[activeIndex.value]
    if (o) pick(o)
  }
}

function onDocDown(e: PointerEvent): void {
  if (!open.value) return
  const t = e.target as Node
  if (trigger.value?.contains(t) || panelRef.value?.contains(t)) return
  open.value = false
}

function onWinChange(): void {
  if (open.value) open.value = false
}

function onScroll(e: Event): void {
  const t = e.target as Node | null
  if (t && (trigger.value?.contains(t) || panelRef.value?.contains(t))) return
  onWinChange()
}

watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onDocDown, true)
    window.addEventListener('resize', onWinChange)
    window.addEventListener('scroll', onScroll, true)
  } else {
    document.removeEventListener('pointerdown', onDocDown, true)
    window.removeEventListener('resize', onWinChange)
    window.removeEventListener('scroll', onScroll, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true)
  window.removeEventListener('resize', onWinChange)
  window.removeEventListener('scroll', onScroll, true)
})
</script>

<template>
  <div class="ui-select" :class="[size, { open, disabled }]">
    <button
      ref="trigger"
      type="button"
      class="ui-select-trigger"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKey"
    >
      <span v-if="selected?.color" class="ui-select-dot" :style="{ background: selected.color }" />
      <span class="ui-select-label" :class="{ placeholder: !selected }">{{ selected?.label ?? placeholder }}</span>
      <svg class="ui-select-chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>

    <Teleport to="body">
      <Transition name="uisel">
        <div v-if="open" ref="panelRef" class="ui-select-panel" :style="panelStyle" role="listbox">
          <div v-if="!options.length" class="ui-select-empty">暂无可选项</div>
          <button
            v-for="(o, i) in options"
            :key="o.value"
            type="button"
            class="ui-select-opt"
            :class="{ active: i === activeIndex, selected: o.value === modelValue, disabled: o.disabled }"
            role="option"
            :aria-selected="o.value === modelValue"
            @mouseenter="activeIndex = i"
            @click="pick(o)"
          >
            <span v-if="o.color" class="ui-select-dot" :style="{ background: o.color }" />
            <span class="ui-select-opt-label">{{ o.label }}</span>
            <span v-if="o.hint" class="ui-select-hint">{{ o.hint }}</span>
            <svg v-if="o.value === modelValue" class="ui-select-check" width="11" height="8" viewBox="0 0 11 8">
              <path d="M1 4l3 3 6-6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
