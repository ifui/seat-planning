<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ZoneDef } from '../../types'
import UiButton from '../../ui/components/UiButton.vue'
import UiModal from '../../ui/components/UiModal.vue'
import UiSelect from '../../ui/components/UiSelect.vue'

const props = defineProps<{
  modelValue: boolean
  rangeLabel: string
  zones: ZoneDef[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'fill', payload: { kind: 'seat' | 'podium'; seats: 1 | 2; tablePerRow: boolean; tableLabel: string; zoneId: string }): void
}>()

const kind = ref<'seat' | 'podium'>('seat')
const seats = ref<1 | 2>(2)
const tablePerRow = ref(true)
const tableLabel = ref('')
const zoneId = ref('')

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      kind.value = 'seat'
      seats.value = 2
      tablePerRow.value = true
      tableLabel.value = ''
      zoneId.value = ''
    }
  }
)

const zoneOptions = computed(() => [
  { value: '', label: '不分配区域' },
  ...props.zones.map((z) => ({ value: z.id, label: z.name }))
])

function submit(): void {
  emit('fill', {
    kind: kind.value,
    seats: seats.value,
    tablePerRow: tablePerRow.value,
    tableLabel: tableLabel.value.trim(),
    zoneId: zoneId.value
  })
  emit('update:modelValue', false)
}
</script>

<template>
  <UiModal
    :model-value="modelValue"
    title="批量填充座位"
    :description="`把 ${rangeLabel} 按座位格批量铺开；合并区自动跳过`"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="fd">
      <div class="fd-row">
        <span class="fd-label">填充类型</span>
        <div class="fd-seg">
          <button :class="{ on: kind === 'seat' }" @click="kind = 'seat'">普通座位</button>
          <button :class="{ on: kind === 'podium' }" @click="kind = 'podium'">主席台</button>
        </div>
      </div>
      <div class="fd-row">
        <span class="fd-label">座位规格</span>
        <div class="fd-seg">
          <button :class="{ on: seats === 1 }" @click="seats = 1">单人位</button>
          <button :class="{ on: seats === 2 }" @click="seats = 2">双人位</button>
        </div>
      </div>
      <label class="fd-check">
        <input v-model="tablePerRow" type="checkbox" />
        <span>整行视作同一张条桌（桌带连续绘制）</span>
      </label>
      <label class="fd-field">
        <span>桌名（可选）</span>
        <input v-model="tableLabel" placeholder="如：1 排" />
      </label>
      <label class="fd-field">
        <span>区域</span>
        <UiSelect v-model="zoneId" :options="zoneOptions" size="sm" />
      </label>
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
.fd-seg { display: flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
.fd-seg button {
  border: none; background: var(--bg); padding: 5px 14px; font-size: 12px; font-family: inherit;
  color: var(--text-secondary); cursor: pointer;
}
.fd-seg button + button { border-left: 1px solid var(--border); }
.fd-seg button.on { background: var(--primary-soft); color: var(--primary); font-weight: 500; }
.fd-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.fd-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
.fd-field input {
  height: 30px; padding: 0 8px; font-size: 12px; font-family: inherit;
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg);
  color: var(--text-primary); outline: none;
}
.fd-field input:focus { border-color: var(--primary); }
</style>
