<script setup lang="ts">
import { computed } from 'vue'
import type { BaseElement, LayoutPackage, SeatingElement, ShapeKind, ZoneDef } from '../../types'
import { elementText, hasEditableText, isSeatingElement } from '../../types'
import { isElementLocked, lockedGroupSet } from '../../groupLocks'
import { TYPE_LABEL } from '../../labels'
import LayerPanel from './LayerPanel.vue'
import { reflowSeats } from './seatOps'
import {
  ALIGN_ACTIONS, FILLS, FONT_FAMILIES, FONT_WEIGHTS, RULE_TAG_LABEL, SHAPE_OPTIONS,
  STROKES, TEXT_ALIGNS, type AlignKey
} from './options'
import {
  UiField, UiIcon, UiIconButton, UiInput, UiPanel, UiSegmented, UiSelect, UiTabs
} from '../../ui'

const props = defineProps<{
  layout: LayoutPackage
  activeTab: string
  selectedIds: string[]
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:activeTab', v: string): void
  (e: 'commit'): void
  (e: 'select', ids: string[]): void
  (e: 'create-group'): void
  (e: 'rename-group', id: string, name: string): void
  (e: 'toggle-lock', id: string): void
  (e: 'toggle-collapse', id: string): void
  (e: 'ungroup', id: string): void
  (e: 'tidy'): void
  (e: 'layer', action: 'front' | 'up' | 'down' | 'back'): void
  (e: 'align', key: AlignKey): void
  (e: 'distribute', axis: 'h' | 'v'): void
  (e: 'zone-add'): void
  (e: 'zone-edit', z: ZoneDef): void
  (e: 'zone-delete', z: ZoneDef): void
  (e: 'collapse'): void
}>()

const tabModel = computed({
  get: () => props.activeTab,
  set: (v: string) => emit('update:activeTab', v)
})

const tabItems = computed(() => [
  { key: 'canvas', label: '画布' },
  { key: 'props', label: '属性', badge: props.selectedIds.length || undefined },
  { key: 'zones', label: '区域', badge: props.layout.zones.length || undefined }
])

const selectedEls = computed(() =>
  props.layout.elements.filter((e) => props.selectedIds.includes(e.id))
)
const lockedGroupIds = computed(() => lockedGroupSet(props.layout.groups))
function isLocked(el: BaseElement): boolean {
  return isElementLocked(el, lockedGroupIds.value)
}
const single = computed<BaseElement | null>(() => (props.selectedIds.length === 1 ? selectedEls.value[0] ?? null : null))
const singleSeatEl = computed<SeatingElement | null>(() => {
  const e = single.value
  return e && isSeatingElement(e) ? e : null
})
const multiSeating = computed(() => selectedEls.value.filter(isSeatingElement))
const canAlign = computed(() => selectedEls.value.length >= 2)
const canDistribute = computed(() => selectedEls.value.length >= 3)

const zoneOptions = computed(() => [
  { value: '', label: '未分区' },
  ...props.layout.zones.map((z) => ({ value: z.id, label: z.name }))
])
const multiZone = computed(() => {
  const els = multiSeating.value
  if (!els.length) return ''
  const z = els[0].zoneId ?? ''
  return els.every((e) => (e.zoneId ?? '') === z) ? z : ''
})
const multiCapacity = computed<1 | 2 | null>(() => {
  const els = multiSeating.value
  if (!els.length) return null
  const c = els[0].capacity
  return els.every((e) => e.capacity === c) ? c : null
})

const textTargets = computed(() => selectedEls.value.filter((e) => hasEditableText(e)))
const singleText = computed<BaseElement | null>(() =>
  single.value && hasEditableText(single.value) ? single.value : null
)

function fontCommon(key: 'fontFamily' | 'fontSize' | 'fontWeight' | 'textAlign'): string | number | undefined {
  const src = singleText.value ?? textTargets.value[0]
  return src?.style?.[key]
}

function setTextStyle(key: 'fontFamily' | 'fontSize' | 'fontWeight' | 'textAlign', value: string | number | undefined): void {
  let v: string | number | undefined = value
  if (key === 'fontSize') {
    const n = value === undefined || value === null || value === '' ? 12 : Number(value)
    v = Number.isFinite(n) ? Math.min(96, Math.max(8, Math.round(n))) : 12
  }
  for (const el of textTargets.value) el.style = { ...(el.style || {}), [key]: v }
}

function setTextContent(value: string): void {
  const el = singleText.value
  if (!el) return
  el.text = value
  if (el.type === 'zone') {
    const z = props.layout.zones.find((x) => x.id === el.id)
    if (z) z.name = value || '未命名区域'
  }
}

function setStyle(key: 'fill' | 'stroke' | 'radius' | 'opacity', value: string | number): void {
  for (const el of selectedEls.value) el.style = { ...(el.style ?? {}), [key]: value }
}

function setRotation(v: number): void {
  const deg = Number.isFinite(v) ? Math.round(((v % 360) + 360) % 360) : 0
  for (const el of selectedEls.value) {
    if (!isLocked(el)) el.rotation = deg
  }
  emit('commit')
}

function nudgeRotation(delta: number): void {
  const base = selectedEls.value.find((e) => !isLocked(e))?.rotation ?? 0
  setRotation(base + delta)
}

function setShape(kind: string): void {
  if (!single.value) return
  single.value.shape = kind as ShapeKind
  emit('commit')
}

function setLockSelected(locked: boolean): void {
  for (const el of selectedEls.value) {
    el.locked = locked
    // 解锁时同步解开所在分组：否则组锁会继续生效，出现「取消勾选但仍拖不动」的困惑
    if (!locked && el.groupId) {
      const g = props.layout.groups?.find((x) => x.id === el.groupId)
      if (g) g.locked = false
    }
  }
  emit('commit')
}

function setLabel(v: string): void {
  if (singleSeatEl.value) singleSeatEl.value.label = v
}

function setCapacity(v: 1 | 2): void {
  for (const el of multiSeating.value) {
    el.capacity = v
    reflowSeats(el)
  }
  emit('commit')
}

function setZone(v: string): void {
  for (const el of selectedEls.value) {
    if (isSeatingElement(el)) el.zoneId = v || undefined
  }
  emit('commit')
}

function regenerateSeats(): void {
  if (!singleSeatEl.value) return
  reflowSeats(singleSeatEl.value)
  emit('commit')
}

function reflowSingle(): void {
  if (singleSeatEl.value) reflowSeats(singleSeatEl.value)
}

function toggleSeat(elementId: string, seatId: string): void {
  const el = props.layout.elements.find((e) => e.id === elementId)
  if (!el || !isSeatingElement(el)) return
  const seat = el.seats.find((s) => s.id === seatId)
  if (!seat) return
  seat.disabled = !seat.disabled
  emit('commit')
}

function setAllSeats(disabled: boolean): void {
  if (!singleSeatEl.value) return
  for (const s of singleSeatEl.value.seats) s.disabled = disabled
  emit('commit')
}

function seatDisabledIn(el: SeatingElement): number {
  return el.seats.filter((s) => s.disabled).length
}
</script>

<template>
  <div class="panel inspector" :class="{ collapsed: !open }">
    <UiPanel class="insp-card" head-class="insp-head" body-class="insp-body">
      <template #head>
        <UiTabs v-model="tabModel" :items="tabItems" />
        <UiIconButton icon="chevronRight" title="收起面板" @click="emit('collapse')" />
      </template>

      <!-- 画布 -->
      <template v-if="activeTab === 'canvas'">
        <div class="prop-section">
          <div class="prop-title">画布尺寸</div>
          <div class="num-grid">
            <div class="num-field">
              <input v-model.number="layout.canvas.width" type="number" min="400" class="input" @change="emit('commit')" />
              <span class="unit">宽 px</span>
            </div>
            <div class="num-field">
              <input v-model.number="layout.canvas.height" type="number" min="300" class="input" @change="emit('commit')" />
              <span class="unit">高 px</span>
            </div>
          </div>
          <button class="btn sm" style="align-self: flex-start; margin-top: 8px" @click="emit('tidy')"><UiIcon name="expand" />按内容调整画布</button>
        </div>

        <div class="prop-section">
          <div class="prop-title">外观</div>
          <div class="field">
            <label>画布底色</label>
            <div style="display: flex; gap: 8px; align-items: center">
              <input type="color" class="color-input" :value="layout.canvas.background" @input="layout.canvas.background = ($event.target as HTMLInputElement).value" @change="emit('commit')" />
              <span class="caption mono">{{ layout.canvas.background }}</span>
            </div>
          </div>
        </div>

        <LayerPanel
          :elements="layout.elements"
          :groups="layout.groups ?? []"
          :selected-ids="selectedIds"
          @select="emit('select', $event)"
          @create-group="emit('create-group')"
          @rename-group="(id, name) => emit('rename-group', id, name)"
          @toggle-lock="emit('toggle-lock', $event)"
          @toggle-collapse="emit('toggle-collapse', $event)"
          @ungroup="emit('ungroup', $event)"
        />
      </template>

      <!-- 属性 -->
      <template v-else-if="activeTab === 'props'">
        <div v-if="!selectedIds.length" class="empty" style="padding: 30px 14px">
          在画布上点选元素，或框选多个元素后在这里调整属性。
        </div>

        <template v-else-if="single">
          <div class="prop-section">
            <div class="prop-title">
              位置与尺寸
              <span class="tag ink">{{ TYPE_LABEL[single.type] }}</span>
            </div>
            <div class="num-grid">
              <div class="num-field">
                <input v-model.number="single.x" type="number" class="input" @change="emit('commit')" />
                <span class="unit">X</span>
              </div>
              <div class="num-field">
                <input v-model.number="single.y" type="number" class="input" @change="emit('commit')" />
                <span class="unit">Y</span>
              </div>
              <div class="num-field">
                <input v-model.number="single.w" type="number" min="24" class="input" @input="reflowSingle" @change="emit('commit')" />
                <span class="unit">宽</span>
              </div>
              <div class="num-field">
                <input v-model.number="single.h" type="number" min="20" class="input" @input="reflowSingle" @change="emit('commit')" />
                <span class="unit">高</span>
              </div>
            </div>
          </div>

          <div class="prop-section">
            <div class="prop-title">旋转与锁定<span class="caption">支持任意角度</span></div>
            <div class="field-row">
              <div class="field">
                <label>角度</label>
                <div class="num-field">
                  <input
                    type="number"
                    step="1"
                    class="input"
                    :value="single.rotation ?? 0"
                    @change="setRotation(Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="unit">°</span>
                </div>
              </div>
              <div class="field">
                <label>微调</label>
                <div class="mini-btns">
                  <button class="btn ghost xs" @click="nudgeRotation(-15)">−15°</button>
                  <button class="btn ghost xs" @click="nudgeRotation(15)">+15°</button>
                </div>
              </div>
            </div>
            <div class="seg">
              <button
                v-for="r in [0, 45, 90, 180, 270]"
                :key="r"
                class="seg-btn"
                :class="{ on: (single.rotation ?? 0) === r }"
                @click="setRotation(r)"
              >{{ r }}°</button>
            </div>
            <label class="inline-check">
              <input type="checkbox" :checked="isLocked(single)" @change="setLockSelected(($event.target as HTMLInputElement).checked)" />
              锁定位置与角度，避免误拖
            </label>
          </div>

          <div v-if="single.type === 'shape'" class="prop-section">
            <div class="prop-title">图形</div>
            <div class="field">
              <label>形状</label>
              <UiSelect :model-value="single.shape ?? 'rect'" :options="SHAPE_OPTIONS" @update:model-value="setShape($event)" />
            </div>
            <div class="caption">图形只作装饰或区域标识，不参与排座。文字在外观下方统一设置。</div>
          </div>

          <div class="prop-section">
            <div class="prop-title">外观</div>
            <div class="field-row">
              <div class="field">
                <label>填充色</label>
                <div style="display: flex; gap: 8px; align-items: center">
                  <input type="color" class="color-input" :value="single.style?.fill ?? '#FFFFFF'" @input="setStyle('fill', ($event.target as HTMLInputElement).value)" @change="emit('commit')" />
                  <span class="caption mono">{{ single.style?.fill ?? '#FFFFFF' }}</span>
                </div>
              </div>
              <div class="field">
                <label>描边色</label>
                <input type="color" class="color-input" :value="single.style?.stroke ?? '#DCE1E6'" @input="setStyle('stroke', ($event.target as HTMLInputElement).value)" @change="emit('commit')" />
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label>圆角</label>
                <input type="number" class="input" min="0" max="40" :value="single.style?.radius ?? 8" @input="setStyle('radius', Number(($event.target as HTMLInputElement).value))" @change="emit('commit')" />
              </div>
              <div class="field">
                <label>不透明度</label>
                <input type="number" class="input" min="0.1" max="1" step="0.05" :value="single.style?.opacity ?? 1" @input="setStyle('opacity', Number(($event.target as HTMLInputElement).value))" @change="emit('commit')" />
              </div>
            </div>
          </div>

          <template v-if="singleSeatEl">
            <div class="prop-section">
              <div class="prop-title">
                座位与归属
                <span class="caption">{{ singleSeatEl.seats.length }} 座 · {{ seatDisabledIn(singleSeatEl) }} 空位</span>
              </div>
              <div v-if="singleSeatEl.type === 'table'" class="field">
                <label>座位容量</label>
                <div class="seg">
                  <button class="seg-btn" :class="{ on: singleSeatEl.capacity === 1 }" @click="setCapacity(1)">单人位</button>
                  <button class="seg-btn" :class="{ on: singleSeatEl.capacity === 2 }" @click="setCapacity(2)">双人位</button>
                </div>
              </div>
              <div class="field">
                <label>所属区域</label>
                <UiSelect :model-value="singleSeatEl.zoneId ?? ''" :options="zoneOptions" placeholder="未分区" @update:model-value="setZone($event)" />
              </div>
              <div class="field">
                <label>桌号 / 标注</label>
                <input class="input" :value="singleSeatEl.label ?? ''" placeholder="如：1 排" @input="setLabel(($event.target as HTMLInputElement).value)" @change="emit('commit')" />
              </div>
              <div class="field">
                <label>座位（点击切换空位）</label>
                <div class="seat-grid">
                  <button
                    v-for="s in singleSeatEl.seats"
                    :key="s.id"
                    class="seat-chip"
                    :class="{ disabled: s.disabled }"
                    :title="s.disabled ? '空位 / 不可用，排座时跳过' : '点击标记为空位'"
                    @click="toggleSeat(singleSeatEl.id, s.id)"
                  >{{ s.index }}</button>
                </div>
              </div>
              <div style="display: flex; gap: 6px">
                <button class="btn sm" @click="setAllSeats(false)">全部可用</button>
                <button class="btn sm" @click="setAllSeats(true)">全部空位</button>
                <button class="btn sm" @click="regenerateSeats">重排座位</button>
              </div>
            </div>
          </template>

          <div class="prop-section">
            <div class="prop-title">层级</div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap">
              <button class="btn sm" @click="emit('layer', 'front')">置顶</button>
              <button class="btn sm" @click="emit('layer', 'up')">上移一层</button>
              <button class="btn sm" @click="emit('layer', 'down')">下移一层</button>
              <button class="btn sm" @click="emit('layer', 'back')">置底</button>
            </div>
          </div>

          <div v-if="textTargets.length" class="prop-section">
            <div class="prop-title">
              文字<span class="caption">{{ singleText ? '双击画布也可编辑' : '批量应用' }}</span>
            </div>
            <UiField v-if="singleText" label="内容">
              <input
                class="input"
                :value="elementText(singleText)"
                placeholder="输入文字后回车"
                @input="setTextContent(($event.target as HTMLInputElement).value)"
                @change="emit('commit')"
              />
            </UiField>
            <UiField label="字体">
              <UiSelect
                :model-value="fontCommon('fontFamily') ?? ''"
                :options="FONT_FAMILIES"
                @update:model-value="setTextStyle('fontFamily', $event); emit('commit')"
              />
            </UiField>
            <div class="field-row">
              <UiField label="字号">
                <UiInput
                  type="number"
                  :min="8"
                  :max="96"
                  :model-value="fontCommon('fontSize') ?? 12"
                  unit="px"
                  @update:model-value="setTextStyle('fontSize', Number($event))"
                  @change="emit('commit')"
                />
              </UiField>
              <UiField label="字重">
                <UiSelect
                  :model-value="fontCommon('fontWeight') ?? 400"
                  :options="FONT_WEIGHTS"
                  @update:model-value="setTextStyle('fontWeight', Number($event)); emit('commit')"
                />
              </UiField>
            </div>
            <UiField label="对齐">
              <UiSegmented
                block
                :model-value="fontCommon('textAlign') ?? 'center'"
                :options="TEXT_ALIGNS"
                @update:model-value="setTextStyle('textAlign', $event); emit('commit')"
              />
            </UiField>
            <div class="caption">字体均为系统字体，离线包不加载外部字体资源。</div>
          </div>
        </template>

        <template v-else>
          <div class="prop-section">
            <div class="prop-title">
              批量设置
              <span class="tag ink">{{ selectedEls.length }} 个元素</span>
            </div>
            <div class="caption">改动会同时应用到所有选中的元素。</div>
          </div>

          <div class="prop-section">
            <div class="prop-title">对齐与分布</div>
            <div style="display: flex; gap: 2px; flex-wrap: wrap">
              <button
                v-for="a in ALIGN_ACTIONS"
                :key="a.key"
                class="icon-btn"
                :title="a.title"
                @click="emit('align', a.key)"
              >
                <UiIcon :name="a.icon" />
              </button>
              <button class="btn ghost xs" :disabled="!canDistribute" @click="emit('distribute', 'h')">横向等距</button>
              <button class="btn ghost xs" :disabled="!canDistribute" @click="emit('distribute', 'v')">纵向等距</button>
            </div>
          </div>

          <div class="prop-section">
            <div class="prop-title">统一旋转与锁定</div>
            <div class="field-row">
              <div class="field">
                <label>角度</label>
                <div class="num-field">
                  <input
                    type="number"
                    step="1"
                    class="input"
                    placeholder="输入后回车"
                    @change="setRotation(Number(($event.target as HTMLInputElement).value))"
                  />
                  <span class="unit">°</span>
                </div>
              </div>
              <div class="field">
                <label>微调</label>
                <div class="mini-btns">
                  <button class="btn ghost xs" @click="nudgeRotation(-15)">−15°</button>
                  <button class="btn ghost xs" @click="nudgeRotation(15)">+15°</button>
                </div>
              </div>
            </div>
            <div class="seg">
              <button v-for="r in [0, 45, 90, 180, 270]" :key="r" class="seg-btn" @click="setRotation(r)">{{ r }}°</button>
            </div>
            <div style="display: flex; gap: 6px">
              <button class="btn sm" @click="setLockSelected(true)">锁定全部</button>
              <button class="btn sm" @click="setLockSelected(false)">解锁全部</button>
            </div>
          </div>

          <div class="prop-section">
            <div class="prop-title">统一填充</div>
            <div class="swatch-row">
              <button v-for="c in FILLS" :key="c" class="swatch" :style="{ background: c }" :title="c" @click="setStyle('fill', c); emit('commit')" />
            </div>
            <div class="swatch-row">
              <button v-for="c in STROKES" :key="c" class="swatch" :style="{ background: c }" :title="c" @click="setStyle('stroke', c); emit('commit')" />
            </div>
          </div>

          <div v-if="textTargets.length" class="prop-section">
            <div class="prop-title">文字<span class="caption">批量应用</span></div>
            <UiField label="字体">
              <UiSelect
                :model-value="fontCommon('fontFamily') ?? ''"
                :options="FONT_FAMILIES"
                @update:model-value="setTextStyle('fontFamily', $event); emit('commit')"
              />
            </UiField>
            <div class="field-row">
              <UiField label="字号">
                <UiInput
                  type="number"
                  :min="8"
                  :max="96"
                  :model-value="fontCommon('fontSize') ?? 12"
                  unit="px"
                  @update:model-value="setTextStyle('fontSize', Number($event))"
                  @change="emit('commit')"
                />
              </UiField>
              <UiField label="字重">
                <UiSelect
                  :model-value="fontCommon('fontWeight') ?? 400"
                  :options="FONT_WEIGHTS"
                  @update:model-value="setTextStyle('fontWeight', Number($event)); emit('commit')"
                />
              </UiField>
            </div>
            <UiField label="对齐">
              <UiSegmented
                block
                :model-value="fontCommon('textAlign') ?? 'center'"
                :options="TEXT_ALIGNS"
                @update:model-value="setTextStyle('textAlign', $event); emit('commit')"
              />
            </UiField>
          </div>

          <template v-if="multiSeating.length">
            <div class="prop-section">
              <div class="prop-title">座位批量设置</div>
              <div class="field">
                <label>统一容量（会重排座位）</label>
                <div class="seg">
                  <button class="seg-btn" :class="{ on: multiCapacity === 1 }" @click="setCapacity(1)">单人位</button>
                  <button class="seg-btn" :class="{ on: multiCapacity === 2 }" @click="setCapacity(2)">双人位</button>
                </div>
              </div>
              <div class="field">
                <label>统一区域</label>
                <UiSelect :model-value="multiZone" :options="zoneOptions" placeholder="未分区" @update:model-value="setZone($event)" />
              </div>
              <div class="caption">座位空位请在单选中逐个标记，或右键整桌设置。</div>
            </div>
          </template>

          <div class="prop-section">
            <div class="prop-title">层级</div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap">
              <button class="btn sm" @click="emit('layer', 'front')">置顶</button>
              <button class="btn sm" @click="emit('layer', 'up')">上移一层</button>
              <button class="btn sm" @click="emit('layer', 'down')">下移一层</button>
              <button class="btn sm" @click="emit('layer', 'back')">置底</button>
            </div>
          </div>
        </template>
      </template>

      <!-- 区域 -->
      <template v-else>
        <div class="prop-section">
          <div class="prop-title">区域划分<span class="caption">用于分层与规则</span></div>
          <div class="row-list">
            <div v-for="z in layout.zones" :key="z.id" class="zone-row">
              <span class="seq-swatch" :style="{ background: z.color }" />
              <div class="grow" style="min-width: 0">
                <div class="tiny" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ z.name }}</div>
                <div class="caption">{{ RULE_TAG_LABEL[z.ruleTag ?? 'other'] }}</div>
              </div>
              <button class="btn ghost xs" @click="emit('zone-edit', z)">编辑</button>
              <button class="btn ghost xs" style="color: var(--danger)" @click="emit('zone-delete', z)">删除</button>
            </div>
            <div v-if="!layout.zones.length" class="caption">还没有区域。区域可用于主席台识别与职级分层。</div>
          </div>
          <button class="btn sm" style="align-self: flex-start" @click="emit('zone-add')">新增区域</button>
        </div>
        <div class="prop-section">
          <div class="caption">主席台区域内的座位会按主席台规则（居中、左右交替）排列；删除区域前需先移走其下的桌。</div>
        </div>
      </template>
    </UiPanel>
  </div>
</template>
