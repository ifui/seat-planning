<script setup lang="ts">
/**
 * 自由元素图层：叠加在工作表之上，随画布一起缩放。
 * 元素以工作表坐标定位，支持选中、拖动、四角缩放、旋转与层级。
 * 只负责交互与渲染，数据修改通过事件抛给 LayoutView，统一进撤销栈。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { LayoutElement, Sheet } from '../../types'
import { ELEMENT_SHAPES, elementMeta, elementTextAlign, elementTextColor, elementTextOffset, elementTextPadding, elementTextVAlign, resolveGeometry } from '../../engine/elements'
import { sheetSize } from '../../engine/sheet'

const props = withDefaults(
  defineProps<{
    elements: LayoutElement[]
    sheet: Sheet
    selectedId?: string | null
    editable?: boolean
    scale?: number
  }>(),
  { selectedId: null, editable: false, scale: 1 }
)

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'change', id: string, patch: Partial<LayoutElement>): void
  (e: 'commit'): void
}>()

const layerEl = ref<HTMLElement | null>(null)
const size = computed(() => sheetSize(props.sheet))
const totalW = computed(() => size.value.w + props.sheet.originX)
const totalH = computed(() => size.value.h + props.sheet.originY)

interface ElView {
  el: LayoutElement
  x: number
  y: number
  w: number
  h: number
  fill: string
  lines: string[]
  strokeWidth: number
  fontSize: number
  textColor: string
  fontFamily: string | undefined
  /** 文字的盒模型对齐与偏移（与导出共用同一套规则） */
  textAlign: 'left' | 'center' | 'right'
  textVAlign: 'top' | 'middle' | 'bottom'
  textOffset: { x: number; y: number }
  textPadding: { x: number; y: number }
}

function viewOf(el: LayoutElement): ElView {
  const g = resolveGeometry(el, props.sheet)
  const meta = elementMeta(el.kind)
  const shape = ELEMENT_SHAPES[el.kind]
  return {
    el,
    x: g.x,
    y: g.y,
    w: g.w,
    h: g.h,
    fill: shape.fill,
    lines: shape.lines ?? [],
    strokeWidth: shape.fill ? (el.strokeWidth * 100) / Math.max(16, Math.min(g.w, g.h)) : el.strokeWidth,
    fontSize: Math.max(6, el.fontSize ?? Math.max(8, Math.min(26, g.h * meta.textRatio))),
    textColor: el.fontColor || elementTextColor(el.kind),
    fontFamily: el.fontFamily,
    textAlign: elementTextAlign(el),
    textVAlign: elementTextVAlign(el),
    textOffset: elementTextOffset(el),
    textPadding: elementTextPadding(el)
  }
}

const views = computed(() => [...props.elements].sort((a, b) => a.zIndex - b.zIndex).map(viewOf))

const handleSize = computed(() => Math.max(6, Math.round(8 / (props.scale || 1))))

type DragMode = 'move' | 'resize' | 'rotate'
interface DragState {
  id: string
  mode: DragMode
  corner: string
  startX: number
  startY: number
  geo: { x: number; y: number; w: number; h: number }
  rotation: number
  pointerAngle: number
}

let drag: DragState | null = null

function scaleNow(): number {
  return props.scale || 1
}

/** 指针位置换算到工作表坐标（图层左上角即工作表 0,0） */
function toSheet(clientX: number, clientY: number): { x: number; y: number } {
  const rect = layerEl.value?.getBoundingClientRect()
  const s = scaleNow()
  if (!rect) return { x: 0, y: 0 }
  return { x: (clientX - rect.left) / s, y: (clientY - rect.top) / s }
}

function beginDrag(e: PointerEvent, v: ElView, mode: DragMode, corner = ''): void {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  emit('select', v.el.id)
  if (!props.editable) return
  const center = { x: v.x + v.w / 2, y: v.y + v.h / 2 }
  const p = toSheet(e.clientX, e.clientY)
  drag = {
    id: v.el.id,
    mode,
    corner,
    startX: e.clientX,
    startY: e.clientY,
    geo: { x: v.x, y: v.y, w: v.w, h: v.h },
    rotation: v.el.rotation,
    pointerAngle: (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

function onMove(e: PointerEvent): void {
  if (!drag) return
  const s = scaleNow()
  const dx = (e.clientX - drag.startX) / s
  const dy = (e.clientY - drag.startY) / s
  if (drag.mode === 'move') {
    emit('change', drag.id, { x: drag.geo.x + dx, y: drag.geo.y + dy })
    return
  }
  if (drag.mode === 'rotate') {
    const rect = layerEl.value?.getBoundingClientRect()
    if (!rect) return
    const p = toSheet(e.clientX, e.clientY)
    const cx = drag.geo.x + drag.geo.w / 2
    const cy = drag.geo.y + drag.geo.h / 2
    const angle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI
    let next = drag.rotation + (angle - drag.pointerAngle)
    if (e.shiftKey) next = Math.round(next / 15) * 15
    next = ((next % 360) + 360) % 360
    emit('change', drag.id, { rotation: Math.round(next * 10) / 10 })
    return
  }
  // 四角缩放
  const west = drag.corner.includes('w')
  const north = drag.corner.includes('n')
  const min = 16
  let { x, y, w, h } = drag.geo
  if (west) {
    w = Math.max(min, drag.geo.w - dx)
    x = drag.geo.x + (drag.geo.w - w)
  } else {
    w = Math.max(min, drag.geo.w + dx)
  }
  if (north) {
    h = Math.max(min, drag.geo.h - dy)
    y = drag.geo.y + (drag.geo.h - h)
  } else {
    h = Math.max(min, drag.geo.h + dy)
  }
  emit('change', drag.id, { x, y, w, h })
}

function onUp(): void {
  if (!drag) return
  drag = null
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
  emit('commit')
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
})
</script>

<template>
  <div
    ref="layerEl"
    class="sg-el-layer"
    :class="{ 'is-editable': editable }"
    :style="{ width: totalW + 'px', height: totalH + 'px' }"
  >
    <div
      v-for="v in views"
      :key="v.el.id"
      class="sg-el"
      :data-el-id="v.el.id"
      :class="{ 'is-selected': v.el.id === selectedId }"
      :style="{
        left: v.x + 'px',
        top: v.y + 'px',
        width: v.w + 'px',
        height: v.h + 'px',
        transform: `rotate(${v.el.rotation}deg)`,
        zIndex: v.el.zIndex
      }"
      @pointerdown="beginDrag($event, v, 'move')"
      @dblclick.stop
      @contextmenu.stop.prevent
    >
      <svg class="sg-el-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path
          :d="v.fill"
          :fill="v.el.color"
          :stroke="v.el.bordered ? v.el.stroke : 'none'"
          :stroke-width="v.el.bordered ? v.strokeWidth : 0"
          stroke-linejoin="round"
        />
        <path
          v-for="(d, i) in v.lines"
          :key="i"
          :d="d"
          fill="none"
          :stroke="v.el.stroke"
          :stroke-width="v.strokeWidth"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span
        v-if="v.el.text"
        class="sg-el-text"
        :class="`is-${v.el.kind}`"
        :style="{
          fontSize: v.fontSize + 'px',
          color: v.textColor,
          fontFamily: v.fontFamily,
          justifyContent: v.textAlign === 'left' ? 'flex-start' : v.textAlign === 'right' ? 'flex-end' : 'center',
          alignItems: v.textVAlign === 'top' ? 'flex-start' : v.textVAlign === 'bottom' ? 'flex-end' : 'center',
          textAlign: v.textAlign,
          padding: `${v.textPadding.y * v.h}px ${v.textPadding.x * v.w}px`,
          transform: `translate(${v.textOffset.x}px, ${v.textOffset.y}px)`
        }"
      >{{ v.el.text }}</span>

      <template v-if="editable && v.el.id === selectedId">
        <span
          v-for="c in ['nw', 'ne', 'sw', 'se']"
          :key="c"
          class="sg-el-handle"
          :class="`is-${c}`"
          :style="{ width: handleSize + 'px', height: handleSize + 'px' }"
          @pointerdown="beginDrag($event, v, 'resize', c)"
        />
        <span
          class="sg-el-rotate"
          :style="{ width: handleSize * 1.4 + 'px', height: handleSize * 1.4 + 'px', top: -handleSize * 2.2 + 'px' }"
          title="拖动旋转（Shift 吸附 15°）"
          @pointerdown="beginDrag($event, v, 'rotate')"
        >
          <svg viewBox="0 0 16 16" width="100%" height="100%">
            <path d="M13 8a5 5 0 1 1-1.4-3.4M13 2.5V5h-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.sg-el-layer {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
  z-index: 4;
}
.sg-el {
  position: absolute;
  pointer-events: auto;
  transform-origin: center center;
  touch-action: none;
  cursor: default;
}
/* 只读视图（排座图）：元素不拦截座位点击 */
.sg-el-layer:not(.is-editable) .sg-el { pointer-events: none; }
.is-editable .sg-el { cursor: move; }
.sg-el.is-selected { outline: 1px dashed var(--primary); outline-offset: 2px; }
.sg-el-svg { display: block; width: 100%; height: 100%; overflow: visible; }
.sg-el-text {
  position: absolute;
  inset: 0;
  display: flex;
  box-sizing: border-box;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  pointer-events: none;
}
/* 人形：文字默认贴底，字重略轻 */
.sg-el-text.is-person { font-weight: 500; }
.sg-el-text.is-plaque { letter-spacing: 0.08em; }
.sg-el-handle {
  position: absolute;
  background: #fff;
  border: 1px solid var(--primary);
  border-radius: 2px;
  box-sizing: border-box;
}
.sg-el-handle.is-nw { left: 0; top: 0; margin: -1px 0 0 -1px; cursor: nwse-resize; }
.sg-el-handle.is-ne { right: 0; top: 0; margin: -1px -1px 0 0; cursor: nesw-resize; }
.sg-el-handle.is-sw { left: 0; bottom: 0; margin: 0 0 -1px -1px; cursor: nesw-resize; }
.sg-el-handle.is-se { right: 0; bottom: 0; margin: 0 -1px -1px 0; cursor: nwse-resize; }
.sg-el-rotate {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: grid;
  place-items: center;
  color: var(--primary);
  background: #fff;
  border: 1px solid var(--primary);
  border-radius: 50%;
  cursor: grab;
}
</style>
