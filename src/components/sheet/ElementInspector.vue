<script setup lang="ts">
/**
 * 元素属性面板：尺寸与旋转、外观、文字（含位置）、层级与操作。
 * 元素固定为浮于单元格，不再提供锚定方式切换；
 * 旧数据里固定单元格的元素仍按 resolveGeometry 读回原位置。
 * 数据改动只抛出 patch，由 LayoutView 统一写回并进撤销栈。
 */
import { computed } from 'vue'
import type { LayoutElement, Sheet } from '../../types'
import {
  ELEMENT_FONTS,
  ELEMENT_SHAPES,
  elementMeta,
  elementTextAlign,
  elementTextColor,
  elementTextVAlign,
  resolveGeometry
} from '../../engine/elements'
import type { ElementTextAlign, ElementTextVAlign, LayerAction } from '../../engine/elements'
import UiIcon from '../../ui/components/UiIcon.vue'
import UiSelect from '../../ui/components/UiSelect.vue'

const props = defineProps<{
  element: LayoutElement
  sheet: Sheet
  isTop: boolean
  isBottom: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: Partial<LayoutElement>, commit?: boolean): void
  (e: 'layer', action: LayerAction): void
  (e: 'duplicate'): void
  (e: 'remove'): void
}>()

const meta = computed(() => elementMeta(props.element.kind))
const shape = computed(() => ELEMENT_SHAPES[props.element.kind])
const geo = computed(() => resolveGeometry(props.element, props.sheet))

const FILLS = ['#E8EEEE', '#7E9A9C', '#5B8A88', '#DDE6E7', '#F4EFE4', '#E6EDEF', '#6F8F6A', '#B4543E']
const TEXT_COLORS = ['#3E4A4B', '#FFFFFF', '#41504F', '#4A7C7B', '#B4483F', '#3D6FA8']

const textColor = computed(() => props.element.fontColor || elementTextColor(props.element.kind))
const fontFamily = computed(() => props.element.fontFamily || ELEMENT_FONTS[0].value)
const fontSize = computed(() => Math.round(props.element.fontSize ?? Math.max(8, Math.min(26, geo.value.h * meta.value.textRatio))))
const align = computed(() => elementTextAlign(props.element))
const vAlign = computed(() => elementTextVAlign(props.element))
const offsetX = computed(() => Math.round(props.element.textOffsetX ?? 0))
const offsetY = computed(() => Math.round(props.element.textOffsetY ?? 0))

const FONT_OPTIONS = ELEMENT_FONTS.map((f) => ({ value: f.value, label: f.label }))
const STROKE_BASE = [1, 1.5, 2, 3]
/** 线宽下拉始终包含当前值，避免默认 1.4 之类的值显示成占位文案 */
const strokeOptions = computed(() => {
  const current = Math.round(props.element.strokeWidth * 10) / 10
  return [...new Set([...STROKE_BASE, current])]
    .sort((a, b) => a - b)
    .map((v) => ({ value: v, label: `${v} px` }))
})
const ALIGN_OPTIONS: { value: ElementTextAlign; label: string }[] = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' }
]
const VALIGN_OPTIONS: { value: ElementTextVAlign; label: string }[] = [
  { value: 'top', label: '上' },
  { value: 'middle', label: '中' },
  { value: 'bottom', label: '下' }
]

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function setGeom(key: 'w' | 'h' | 'rotation', raw: string): void {
  const current = key === 'rotation' ? props.element.rotation : geo.value[key]
  const v = Math.max(key === 'rotation' ? -360 : 12, Math.min(key === 'rotation' ? 360 : 4000, num(raw, current)))
  const patch: Partial<LayoutElement> = { [key]: v }
  emit('update', patch, true)
}

function setFontSize(raw: string): void {
  const v = Math.max(6, Math.min(120, num(raw, fontSize.value)))
  emit('update', { fontSize: v }, true)
}

function setOffset(axis: 'textOffsetX' | 'textOffsetY', raw: string): void {
  const current = axis === 'textOffsetX' ? offsetX.value : offsetY.value
  const v = Math.max(-400, Math.min(400, Math.round(num(raw, current))))
  emit('update', axis === 'textOffsetX' ? { textOffsetX: v } : { textOffsetY: v }, true)
}

function resetOffset(): void {
  emit('update', { textOffsetX: 0, textOffsetY: 0 }, true)
}

function nudgeRotation(delta: number): void {
  const next = ((props.element.rotation + delta) % 360 + 360) % 360
  emit('update', { rotation: Math.round(next * 10) / 10 }, true)
}
</script>

<template>
  <aside class="insp-panel sheet-inspector el-inspector">
    <header class="insp-head">
      <svg class="insp-head-art" viewBox="0 0 100 100" aria-hidden="true">
        <path :d="shape.fill" :fill="element.color" :stroke="element.bordered ? element.stroke : 'none'" stroke-width="3" stroke-linejoin="round" />
        <path v-for="(d, i) in shape.lines ?? []" :key="i" :d="d" fill="none" :stroke="element.stroke" stroke-width="2.4" stroke-linecap="round" />
      </svg>
      <div class="insp-head-text">
        <b>{{ meta.label }}</b>
        <span>浮于单元格</span>
      </div>
    </header>

    <section class="insp-sec">
      <h4 class="insp-title">尺寸与旋转</h4>
      <div class="insp-rows">
        <label class="insp-row">
          <span class="insp-label">宽</span>
          <span class="insp-ctl">
            <input class="insp-input" type="number" :value="Math.round(geo.w)" min="12" @change="setGeom('w', ($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">px</em>
          </span>
        </label>
        <label class="insp-row">
          <span class="insp-label">高</span>
          <span class="insp-ctl">
            <input class="insp-input" type="number" :value="Math.round(geo.h)" min="12" @change="setGeom('h', ($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">px</em>
          </span>
        </label>
        <div class="insp-row">
          <span class="insp-label">旋转</span>
          <span class="insp-ctl">
            <input class="el-rot" type="range" :value="element.rotation" min="0" max="345" step="15" @input="emit('update', { rotation: Number(($event.target as HTMLInputElement).value) }, false)" @change="emit('update', {}, true)" />
            <input class="insp-input insp-num" type="number" :value="Math.round(element.rotation)" min="-360" max="360" @change="setGeom('rotation', ($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">°</em>
          </span>
        </div>
      </div>
      <div class="insp-quick">
        <button type="button" @click="nudgeRotation(-15)">−15°</button>
        <button type="button" @click="nudgeRotation(15)">+15°</button>
        <button type="button" @click="emit('update', { rotation: 0 }, true)">回正</button>
      </div>
    </section>

    <section class="insp-sec">
      <h4 class="insp-title">外观</h4>
      <div class="insp-rows">
        <div class="insp-row">
          <span class="insp-label">填充</span>
          <span class="insp-ctl insp-swatches">
            <button
              v-for="c in FILLS"
              :key="c"
              type="button"
              class="insp-swatch"
              :class="{ on: element.color.toLowerCase() === c.toLowerCase() }"
              :style="{ background: c }"
              :title="c"
              @click="emit('update', { color: c }, true)"
            />
            <label class="insp-color" title="自定义填充色">
              <input type="color" :value="element.color" @input="emit('update', { color: ($event.target as HTMLInputElement).value }, false)" @change="emit('update', {}, true)" />
            </label>
          </span>
        </div>
        <div class="insp-row">
          <span class="insp-label">边框</span>
          <span class="insp-ctl">
            <label class="insp-switch" title="显示边框">
              <input type="checkbox" :checked="element.bordered" @change="emit('update', { bordered: ($event.target as HTMLInputElement).checked }, true)" />
              <span class="insp-switch-track" />
            </label>
            <template v-if="element.bordered">
              <UiSelect
                class="el-stroke"
                size="sm"
                :model-value="element.strokeWidth"
                :options="strokeOptions"
                @update:model-value="emit('update', { strokeWidth: Number($event) }, true)"
              />
              <label class="insp-color" title="边框颜色">
                <input type="color" :value="element.stroke" @input="emit('update', { stroke: ($event.target as HTMLInputElement).value }, false)" @change="emit('update', {}, true)" />
              </label>
            </template>
            <span v-else class="insp-note">无边框</span>
          </span>
        </div>
      </div>
    </section>

    <section class="insp-sec">
      <h4 class="insp-title">文字</h4>
      <div class="insp-rows">
        <label class="insp-row">
          <span class="insp-label">内容</span>
          <span class="insp-ctl">
            <input class="insp-input" type="text" :value="element.text" maxlength="24" placeholder="可留空" @change="emit('update', { text: ($event.target as HTMLInputElement).value }, true)" />
          </span>
        </label>
        <label class="insp-row">
          <span class="insp-label">字号</span>
          <span class="insp-ctl">
            <input class="insp-input insp-num" type="number" :value="fontSize" min="6" max="120" @change="setFontSize(($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">px</em>
          </span>
        </label>
        <div class="insp-row">
          <span class="insp-label">字体</span>
          <span class="insp-ctl">
            <UiSelect
              size="sm"
              :model-value="fontFamily"
              :options="FONT_OPTIONS"
              @update:model-value="emit('update', { fontFamily: String($event) }, true)"
            />
          </span>
        </div>
        <div class="insp-row">
          <span class="insp-label">颜色</span>
          <span class="insp-ctl insp-swatches">
            <button
              v-for="c in TEXT_COLORS"
              :key="c"
              type="button"
              class="insp-swatch"
              :class="{ on: textColor.toLowerCase() === c.toLowerCase() }"
              :style="{ background: c }"
              :title="c"
              @click="emit('update', { fontColor: c }, true)"
            />
            <label class="insp-color" title="自定义文字颜色">
              <input type="color" :value="textColor" @input="emit('update', { fontColor: ($event.target as HTMLInputElement).value }, false)" @change="emit('update', {}, true)" />
            </label>
          </span>
        </div>
        <div class="insp-row">
          <span class="insp-label">水平</span>
          <div class="insp-ctl">
            <div class="insp-seg">
              <button
                v-for="o in ALIGN_OPTIONS"
                :key="o.value"
                type="button"
                :class="{ on: align === o.value }"
                :title="`文字水平${o.label}对齐`"
                @click="emit('update', { textAlign: o.value }, true)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
        <div class="insp-row">
          <span class="insp-label">垂直</span>
          <div class="insp-ctl">
            <div class="insp-seg">
              <button
                v-for="o in VALIGN_OPTIONS"
                :key="o.value"
                type="button"
                :class="{ on: vAlign === o.value }"
                :title="`文字垂直${o.label}对齐`"
                @click="emit('update', { textVAlign: o.value }, true)"
              >{{ o.label }}</button>
            </div>
          </div>
        </div>
        <label class="insp-row">
          <span class="insp-label">X 偏移</span>
          <span class="insp-ctl">
            <input class="insp-input insp-num" type="number" :value="offsetX" min="-400" max="400" @change="setOffset('textOffsetX', ($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">px</em>
          </span>
        </label>
        <label class="insp-row">
          <span class="insp-label">Y 偏移</span>
          <span class="insp-ctl">
            <input class="insp-input insp-num" type="number" :value="offsetY" min="-400" max="400" @change="setOffset('textOffsetY', ($event.target as HTMLInputElement).value)" />
            <em class="insp-unit">px</em>
          </span>
        </label>
      </div>
      <div class="insp-quick">
        <button type="button" @click="emit('update', { text: '发言人' }, true)">发言人</button>
        <button type="button" @click="emit('update', { text: '工作人员' }, true)">工作人员</button>
        <button type="button" @click="resetOffset">偏移归零</button>
      </div>
    </section>

    <section class="insp-sec">
      <h4 class="insp-title">层级</h4>
      <div class="el-layer">
        <button type="button" :disabled="isTop" title="置顶" aria-label="置顶" @click="emit('layer', 'front')"><UiIcon name="front" /></button>
        <button type="button" :disabled="isTop" title="上移一层" aria-label="上移一层" @click="emit('layer', 'up')"><UiIcon name="up" /></button>
        <button type="button" :disabled="isBottom" title="下移一层" aria-label="下移一层" @click="emit('layer', 'down')"><UiIcon name="down" /></button>
        <button type="button" :disabled="isBottom" title="置底" aria-label="置底" @click="emit('layer', 'back')"><UiIcon name="back" /></button>
      </div>
    </section>

    <section class="insp-sec">
      <details class="insp-keys">
        <summary>快捷键</summary>
        <ul>
          <li>Delete：删除元素</li>
          <li>Ctrl + D：复制元素</li>
          <li>拖动手柄缩放，顶部圆点旋转（Shift 吸附 15°）</li>
        </ul>
      </details>
      <footer class="el-foot">
        <button type="button" class="insp-btn" @click="emit('duplicate')"><UiIcon name="duplicate" />复制</button>
        <button type="button" class="insp-btn is-danger" @click="emit('remove')"><UiIcon name="trash" />删除</button>
      </footer>
    </section>
  </aside>
</template>

<style scoped>
.el-inspector { gap: 0; }
/* 下拉在控件列里占满可用宽度，与输入框保持同一行宽 */
.insp-ctl :deep(.ui-select) { flex: 1; min-width: 0; }
.el-stroke { flex: 1; min-width: 0; }
.el-rot { flex: 1; min-width: 0; accent-color: var(--primary); }
.el-layer { display: flex; gap: 5px; }
.el-layer button {
  width: 32px; height: 28px; display: grid; place-items: center;
  border: 1px solid var(--border-strong); border-radius: var(--radius-xs);
  background: var(--bg-panel); color: var(--text-secondary); cursor: pointer;
}
.el-layer button:hover:not(:disabled) { color: var(--primary); border-color: var(--primary-line); }
.el-layer button:disabled { opacity: 0.35; cursor: not-allowed; }
.el-foot { display: flex; align-items: center; gap: 8px; }
</style>
