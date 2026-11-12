<script setup lang="ts">
import { ref, watch } from 'vue'
import UiButton from '../../ui/components/UiButton.vue'
import UiCheckbox from '../../ui/components/UiCheckbox.vue'
import UiInput from '../../ui/components/UiInput.vue'
import UiModal from '../../ui/components/UiModal.vue'
import UiSegmented from '../../ui/components/UiSegmented.vue'

const props = defineProps<{
  modelValue: boolean
  rangeLabel: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'fill', payload: { kind: 'seat' | 'podium'; seats: number; tablePerRow: boolean; tableLabel: string }): void
}>()

const kind = ref<'seat' | 'podium'>('seat')
const tablePerRow = ref(true)
const tableLabel = ref('')

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      kind.value = 'seat'
      tablePerRow.value = true
      tableLabel.value = ''
    }
  }
)

function submit(): void {
  emit('fill', {
    kind: kind.value,
    // 布局只铺单人桌位；一桌坐几人由排座项目按会议设置
    seats: 1,
    tablePerRow: tablePerRow.value,
    tableLabel: tableLabel.value.trim()
  })
  emit('update:modelValue', false)
}
</script>

<template>
  <UiModal
    :model-value="modelValue"
    title="批量填充座位"
    :description="`${rangeLabel}；合并区自动跳过`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="fd">
      <div class="fd-row">
        <span class="fd-label">填充类型</span>
        <div class="fd-seg">
          <UiSegmented
            :model-value="kind"
            :options="[
              { value: 'seat', label: '普通座位' },
              { value: 'podium', label: '主席台' }
            ]"
            @update:model-value="(v: string | number) => (kind = v as 'seat' | 'podium')"
          />
        </div>
      </div>
      <UiCheckbox v-model="tablePerRow" label="整行视作同一张条桌（桌带连续绘制）" />
      <div class="fd-field">
        <span>桌名（可选）</span>
        <UiInput v-model="tableLabel" placeholder="如：1 排" />
      </div>
    </div>
    <template #footer>
      <UiButton variant="ghost" size="sm" @click="emit('update:modelValue', false)">取消</UiButton>
      <UiButton variant="primary" size="sm" @click="submit">填充</UiButton>
    </template>
  </UiModal>
</template>

<style scoped>
.fd { display: flex; flex-direction: column; gap: 12px; }
.fd-row { display: flex; align-items: center; gap: 12px; }
.fd-label { width: 72px; font-size: 12px; color: var(--text-muted); flex: none; }
.fd-seg { flex: 1; min-width: 0; }
.fd-field { display: flex; flex-direction: column; gap: 5px; font-size: var(--fs-xs); color: var(--text-secondary); }
.fd-hint { margin: -2px 0 0; font-size: 11px; line-height: 1.5; color: var(--text-disabled); }
</style>
