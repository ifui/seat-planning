<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { init, type ChartOption } from '../charts'

const props = withDefaults(
  defineProps<{
    /** 由各页面计算出的完整 option；为 null 时显示空状态。 */
    option: ChartOption | null
    /** 图表可视高度（px），宽度跟随容器。 */
    height?: number
    emptyText?: string
  }>(),
  { height: 180, emptyText: '暂无数据' }
)

const el = ref<HTMLDivElement | null>(null)
const chart = shallowRef<ReturnType<typeof init> | null>(null)
const isEmpty = computed(() => !props.option)
let ro: ResizeObserver | null = null

function render(): void {
  if (!el.value || isEmpty.value) return
  if (!chart.value) chart.value = init(el.value, undefined, { renderer: 'canvas' })
  if (props.option) chart.value.setOption(props.option, true)
}

onMounted(() => {
  render()
  ro = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    // 面板折叠/标签页隐藏时宽高为 0，跳过避免 ECharts 反复重算。
    if (rect && rect.width > 0 && rect.height > 0) chart.value?.resize()
  })
  if (el.value) ro.observe(el.value)
})

watch(
  () => props.option,
  () => render(),
  { deep: true }
)

watch(isEmpty, async (empty) => {
  if (empty) return
  await nextTick()
  render()
  chart.value?.resize()
})

onBeforeUnmount(() => {
  ro?.disconnect()
  chart.value?.dispose()
  chart.value = null
})
</script>

<template>
  <div class="chart-box" :style="{ height: `${height}px` }">
    <div v-show="!isEmpty" ref="el" class="chart-canvas" />
    <div v-if="isEmpty" class="chart-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.chart-box { position: relative; width: 100%; min-width: 0; }
.chart-canvas { width: 100%; height: 100%; }
.chart-empty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center; padding: 12px;
  border: 1px dashed var(--border); border-radius: var(--radius-sm);
  background: var(--bg-subtle); color: var(--text-muted);
  font-size: var(--fs-xs); line-height: 1.6; text-align: center;
}
</style>
