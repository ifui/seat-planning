<script setup lang="ts">
/**
 * 批量生成对话框：只负责参数输入、实时占用预估与校验，
 * 真正的元素创建交给页面（便于统一走历史记录与自动分组）。
 */
import { computed, ref, watch } from 'vue'
import { UiIcon, UiModal, UiSelect } from '../../ui'
import type { GenOptions } from './generate'

const props = defineProps<{
  modelValue: boolean
  canvasW: number
  canvasH: number
  zones: { value: string; label: string }[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'generate', opts: GenOptions): void
}>()

const GEN_MAX = 240
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const form = ref({
  rows: 10,
  blocks: '2,7,2',
  capacity: 2 as 1 | 2,
  w: 160,
  h: 72,
  gapX: 8,
  gapY: 16,
  blockGap: 60,
  startX: 100,
  startY: 220,
  center: true,
  zoneId: ''
})

watch(
  () => props.modelValue,
  (v) => {
    if (v) form.value.zoneId = ''
  }
)

function parseBlocks(text: string): number[] {
  const parts = String(text)
    .split(/[,，、\s]+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  const list = (parts.length ? parts : [7]).slice(0, 12)
  return list.map((n) => Math.max(1, Math.min(20, n)))
}

const metrics = computed(() => {
  const g = form.value
  const rows = Math.max(1, Math.min(60, Math.floor(g.rows) || 1))
  const blocks = parseBlocks(g.blocks)
  const cols = blocks.reduce((a, b) => a + b, 0)
  const tw = Math.max(60, Math.min(600, Math.round(g.w) || 160))
  const th = Math.max(40, Math.min(320, Math.round(g.h) || 72))
  const gapX = Math.max(0, Math.min(200, Math.round(g.gapX) || 0))
  const gapY = Math.max(0, Math.min(200, Math.round(g.gapY) || 0))
  const blockGap = Math.max(0, Math.min(400, Math.round(g.blockGap) || 0))
  const blocksW = blocks.map((c) => c * (tw + gapX) - gapX)
  const width = blocksW.reduce((a, b) => a + b, 0) + (blocks.length - 1) * blockGap
  const height = rows * (th + gapY) - gapY
  const count = rows * cols
  const startX = g.center ? Math.max(24, Math.round((props.canvasW - width) / 2)) : Math.max(0, g.startX)
  const startY = Math.max(0, g.startY)
  const needW = Math.max(props.canvasW, Math.ceil(startX + width + 48))
  const needH = Math.max(props.canvasH, Math.ceil(startY + height + 48))
  return {
    rows, blocks, blocksW, cols, width, height, count, startX, startY, needW, needH,
    tw, th, gapX, gapY, blockGap,
    over: count > GEN_MAX,
    grow: needW > props.canvasW || needH > props.canvasH
  }
})

function submit(): void {
  const m = metrics.value
  if (m.over) return
  emit('generate', {
    rows: m.rows,
    blocks: m.blocks,
    capacity: form.value.capacity,
    w: m.tw,
    h: m.th,
    gapX: m.gapX,
    gapY: m.gapY,
    blockGap: m.blockGap,
    startX: m.startX,
    startY: m.startY,
    center: form.value.center,
    zoneId: form.value.zoneId
  })
  open.value = false
}
</script>

<template>
  <UiModal
    v-model="open"
    title="批量生成桌子"
    description="按列块分布生成，块间自动留过道；生成后自动归入一个图层分组，可整体选中/移动"
    width="580px"
  >
    <div class="field-row">
      <div class="field"><label>排数</label><input v-model.number="form.rows" type="number" min="1" max="60" class="input" /></div>
      <div class="field">
        <label>列块分布</label>
        <input v-model="form.blocks" class="input mono" placeholder="如 2,7,2" />
      </div>
      <div class="field">
        <label>每桌人数</label>
        <div class="seg">
          <button class="seg-btn" :class="{ on: form.capacity === 1 }" @click="form.capacity = 1">单人</button>
          <button class="seg-btn" :class="{ on: form.capacity === 2 }" @click="form.capacity = 2">双人</button>
        </div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>桌宽</label><input v-model.number="form.w" type="number" min="60" class="input" /></div>
      <div class="field"><label>桌高</label><input v-model.number="form.h" type="number" min="40" class="input" /></div>
      <div class="field"><label>块内横向间距</label><input v-model.number="form.gapX" type="number" min="0" class="input" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>排间距</label><input v-model.number="form.gapY" type="number" min="0" class="input" /></div>
      <div class="field"><label>块间过道</label><input v-model.number="form.blockGap" type="number" min="0" class="input" /></div>
      <div class="field"><label>起始 Y</label><input v-model.number="form.startY" type="number" min="0" class="input" /></div>
    </div>
    <div class="field-row">
      <div class="field">
        <label>起始 X</label>
        <input v-model.number="form.startX" type="number" min="0" class="input" :disabled="form.center" />
      </div>
      <div class="field">
        <label>所属区域</label>
        <UiSelect v-model="form.zoneId" :options="zones" placeholder="未分区" />
      </div>
      <label class="inline-check" style="padding-top: 18px">
        <input v-model="form.center" type="checkbox" />
        水平居中
      </label>
    </div>
    <div class="gen-summary" :class="{ warn: metrics.grow }">
      <div>
        <strong>{{ metrics.count }}</strong> 张桌 · <strong>{{ metrics.count * form.capacity }}</strong> 个座位 ·
        {{ metrics.blocks.length }} 块（{{ metrics.blocks.join(' + ') }}）· 约占 {{ Math.round(metrics.width) }} × {{ Math.round(metrics.height) }} px
      </div>
      <div v-if="metrics.grow" class="gen-note">
        <UiIcon name="warning" :size="13" />
        超出当前画布，生成后自动扩展至 {{ metrics.needW }} × {{ metrics.needH }} px 并适配窗口
      </div>
      <div v-else class="gen-note">在当前画布内即可完整容纳</div>
    </div>
    <div v-if="metrics.over" class="gen-summary warn">
      <div class="gen-note"><UiIcon name="warning" :size="13" />单次最多生成 {{ GEN_MAX }} 张桌，请减少排数或列块规模。</div>
    </div>
    <template #footer>
      <button class="btn" @click="open = false">取消</button>
      <button class="btn primary" :disabled="metrics.over" @click="submit">生成桌子</button>
    </template>
  </UiModal>
</template>
