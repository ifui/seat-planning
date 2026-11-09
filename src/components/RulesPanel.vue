<script setup lang="ts">
import { computed } from 'vue'
import type { LayoutPackage, RankDef, RuleSet, TierRule } from '../types'
import { uid } from '../engine/sheet'
import UiSelect from '../ui/components/UiSelect.vue'

const props = defineProps<{
  rules: RuleSet
  ranks: RankDef[]
  layout: LayoutPackage
}>()

const sortedRanks = computed(() => [...props.ranks].sort((a, b) => a.order - b.order))

const EVEN_OPTIONS = [
  { value: 'left', label: '居中偏左（就座者视角）' },
  { value: 'right', label: '居中偏右' }
]
const PODIUM_LEAVE_OPTIONS = [
  { value: 'hold', label: '留空位' },
  { value: 'shift', label: '后续前移' }
]
const HALL_ORDER_OPTIONS = [
  { value: 'center-out', label: '中间向两侧' },
  { value: 'left-to-right', label: '从左到右' },
  { value: 'right-to-left', label: '从右到左' }
]
const VIEWPOINT_OPTIONS = [
  { value: 'audience', label: '观众视角（从台下看，左→右）' },
  { value: 'podium', label: '主席台视角（镜像，右→左）' }
]
const UNIT_ORDER_OPTIONS = [
  { value: 'continuous', label: '同单位连续就座' },
  { value: 'interleave', label: '各单位交替' }
]
const BY_OPTIONS = [
  { value: 'row', label: '按排' },
  { value: 'zone', label: '按区域' }
]
const zoneOptions = computed(() => [
  { value: '', label: '选择区域' },
  ...props.layout.zones.map((z) => ({ value: z.id, label: z.name }))
])

function addTier(): void {
  const t: TierRule = {
    id: uid('tier'),
    by: 'row',
    from: props.rules.tiers.length + 1,
    to: props.rules.tiers.length + 1,
    rankIds: []
  }
  props.rules.tiers.push(t)
}

function toggleRank(t: TierRule, id: string): void {
  const i = t.rankIds.indexOf(id)
  if (i >= 0) t.rankIds.splice(i, 1)
  else t.rankIds.push(id)
}

function removeTier(id: string): void {
  const i = props.rules.tiers.findIndex((t) => t.id === id)
  if (i >= 0) props.rules.tiers.splice(i, 1)
}
</script>

<template>
  <section class="card tight">
    <div class="card-head">
      <div>
        <div class="card-title">排座规则</div>
        <div class="card-sub">默认值即国内会场通行口径，可按会议性质调整</div>
      </div>
    </div>

    <div class="panel-block">
      <div class="field-row">
        <div class="field">
          <label>偶数主席台 1 号位置</label>
          <UiSelect v-model="rules.evenCenterSide" :options="EVEN_OPTIONS" size="sm" />
        </div>
        <div class="field">
          <label>主席台请假处理</label>
          <UiSelect v-model="rules.podiumLeave" :options="PODIUM_LEAVE_OPTIONS" size="sm" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>台下横向填充</label>
          <UiSelect v-model="rules.hallOrder" :options="HALL_ORDER_OPTIONS" size="sm" />
        </div>
        <div class="field">
          <label>单位分布</label>
          <UiSelect v-model="rules.unitOrder" :options="UNIT_ORDER_OPTIONS" size="sm" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>左右视角</label>
          <UiSelect v-model="rules.viewpoint" :options="VIEWPOINT_OPTIONS" size="sm" />
        </div>
        <div class="field">
          <label>排号来源</label>
          <div class="caption" style="margin: 0; padding-top: 6px">
            {{ `表格 ${layout.sheet.rows} 排 × ${layout.sheet.cols} 列` }}
          </div>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <div class="card-head">
      <div class="card-sub" style="margin: 0">职级分层（某排/某区域坐哪些职级）</div>
      <button class="btn sm" @click="addTier">+ 规则</button>
    </div>

    <div v-if="!rules.tiers.length" class="caption">未设置分层：所有职级按「职级 → 单位 → 名单序」统一排序。</div>

    <div class="row-list">
      <div v-for="t in rules.tiers" :key="t.id" class="row-item" style="flex-direction: column; align-items: stretch; gap: 6px; padding: 8px">
        <div style="display: flex; gap: 6px; align-items: center">
          <div style="width: 84px">
            <UiSelect v-model="t.by" :options="BY_OPTIONS" size="sm" />
          </div>
          <template v-if="t.by === 'row'">
            <span class="tiny muted">第</span>
            <input v-model.number="t.from" type="number" class="input" style="height: 26px; width: 52px" min="1" />
            <span class="tiny muted">至</span>
            <input v-model.number="t.to" type="number" class="input" style="height: 26px; width: 52px" min="1" />
            <span class="tiny muted">排</span>
          </template>
          <template v-else>
            <div style="flex: 1; min-width: 110px">
              <UiSelect
                :model-value="t.zoneId ?? ''"
                :options="zoneOptions"
                size="sm"
                placeholder="选择区域"
                @update:model-value="t.zoneId = $event || undefined"
              />
            </div>
          </template>
          <span style="flex: 1" />
          <button class="btn ghost sm" @click="removeTier(t.id)">×</button>
        </div>
        <div style="display: flex; gap: 4px; flex-wrap: wrap">
          <button
            v-for="r in sortedRanks"
            :key="r.id"
            class="btn sm"
            :class="{ copper: t.rankIds.includes(r.id) }"
            @click="toggleRank(t, r.id)"
          >
            <span class="dot" :style="{ background: r.color }" />{{ r.name }}
          </button>
        </div>
      </div>
    </div>
    <div class="caption" style="margin-top: 8px">分层规则会限制该排/区域只能坐勾选的职级，未勾选的人不会挤占。</div>
  </section>
</template>
