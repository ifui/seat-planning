<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LayoutPackage, Member, RankDef, RuleSet, TierRule, UnitNode, ZoneRule } from '../types'
import { uid, seatsOfSheet } from '../engine/sheet'
import UiSelect from '../ui/components/UiSelect.vue'
import UiNumberInput from '../ui/components/UiNumberInput.vue'
import UiModal from '../ui/components/UiModal.vue'

const props = defineProps<{
  rules: RuleSet
  ranks: RankDef[]
  layout: LayoutPackage
  members: Member[]
  units: UnitNode[]
}>()

const sortedRanks = computed(() => [...props.ranks].sort((a, b) => a.order - b.order))

// 下拉项只保留名称，说明文案统一放在侧栏的提示里
const STAGE_SIDE_OPTIONS = [
  { value: 'left', label: '左为上' },
  { value: 'right', label: '右为上' }
]
const EVEN_OPTIONS = [
  { value: 'left', label: '左中位' },
  { value: 'right', label: '右中位' }
]
const HALL_ORDER_OPTIONS = [
  { value: 'center-left', label: '中间左优先' },
  { value: 'center-right', label: '中间右优先' },
  { value: 'left-to-right', label: '从左到右' },
  { value: 'right-to-left', label: '从右到左' }
]
const UNIT_ORDER_OPTIONS = [
  { value: 'continuous', label: '同单位连续' },
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

function removeTier(id: string): void {
  const i = props.rules.tiers.findIndex((t) => t.id === id)
  if (i >= 0) props.rules.tiers.splice(i, 1)
}

// ---------- 职级多选：两套规则共用同一个弹窗，避免胶囊重复堆叠 ----------
type RankPickKind = 'tier' | 'zone-in' | 'zone-ex'
const rankPick = ref<{ kind: RankPickKind; id: string } | null>(null)
const rankDraft = ref<string[]>([])

const rankPickOpen = computed({
  get: () => !!rankPick.value,
  set: (v: boolean) => { if (!v) rankPick.value = null }
})
const rankPickTitle = computed(() => {
  if (rankPick.value?.kind === 'tier') return '分层规则 · 限定职级'
  if (rankPick.value?.kind === 'zone-ex') return '区域规则 · 排除级别'
  return '区域规则 · 包含级别'
})

function openRankPicker(kind: RankPickKind, id: string, current: string[]): void {
  rankPick.value = { kind, id }
  rankDraft.value = [...current]
}

function toggleRankDraft(id: string): void {
  const i = rankDraft.value.indexOf(id)
  if (i >= 0) rankDraft.value.splice(i, 1)
  else rankDraft.value.push(id)
}

function saveRankPicker(): void {
  const p = rankPick.value
  if (!p) return
  if (p.kind === 'tier') {
    const t = props.rules.tiers.find((x) => x.id === p.id)
    if (t) t.rankIds = [...rankDraft.value]
  } else {
    const rule = zoneRules.value.find((x) => x.id === p.id)
    if (rule) {
      snapZone()
      if (p.kind === 'zone-in') rule.rankIds = [...rankDraft.value]
      else rule.excludeRankIds = [...rankDraft.value]
    }
  }
  rankPick.value = null
}

/** 规则里已选职级的短标签，空表示不限 */
function rankLabel(ids: string[]): string {
  if (!ids.length) return '不限职级'
  return ids.map((id) => rankName(id)).join('、')
}

// ---------- 区域人员分配 ----------

const zoneRules = computed<ZoneRule[]>(() => props.rules.zoneRules ?? [])
const zoneOnlyOptions = computed(() => props.layout.zones.map((z) => ({ value: z.id, label: z.name })))
const zoneName = (id: string): string => props.layout.zones.find((z) => z.id === id)?.name ?? '未选区域'

/**
 * 区域容量：与排座引擎同源，按实际座位槽统计。
 * 合并块（如 3 座主席台）要按块内座位数计入，而不是按格子数；
 * 禁用座位与引擎一致，不计入可用容量。
 */
const zoneSeats = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const seat of seatsOfSheet(props.layout.sheet)) {
    if (seat.disabled || !seat.zoneId) continue
    out[seat.zoneId] = (out[seat.zoneId] ?? 0) + 1
  }
  return out
})

const activeMembers = computed(() => props.members.filter((m) => m.status === 'present'))
const rankName = (id: string): string => props.ranks.find((r) => r.id === id)?.name ?? '未定级'
const unitName = (id: string): string => props.units.find((u) => u.id === id)?.name ?? '未分配'

/** 分层规则的结果摘要：范围 · 职级 · 预计人数 */
function tierSummary(t: TierRule): string {
  const scope = t.by === 'row' ? `第 ${t.from}–${t.to} 排` : zoneName(t.zoneId ?? '')
  if (!t.rankIds.length) return `${scope} · 未限定职级`
  const hit = activeMembers.value.filter((m) => t.rankIds.includes(m.rankId)).length
  return `${scope} · 预计 ${hit} 人`
}

function ensureZoneRules(): ZoneRule[] {
  if (!props.rules.zoneRules) props.rules.zoneRules = []
  return props.rules.zoneRules
}

function addZoneRule(): void {
  if (!props.layout.zones.length) return
  const list = ensureZoneRules()
  snapZone()
  list.push({
    id: uid('zrule'),
    zoneId: props.layout.zones[0]?.id ?? '',
    rankIds: [],
    excludeRankIds: [],
    memberIds: [],
    enabled: true
  })
}

function removeZoneRule(id: string): void {
  snapZone()
  props.rules.zoneRules = (props.rules.zoneRules ?? []).filter((r) => r.id !== id)
}

// 区域规则改动可逐步撤销
const zoneUndo = ref<string[]>([])
function snapZone(): void {
  zoneUndo.value.push(JSON.stringify(props.rules.zoneRules ?? []))
  if (zoneUndo.value.length > 30) zoneUndo.value.shift()
}
function undoZone(): void {
  const prev = zoneUndo.value.pop()
  if (!prev) return
  props.rules.zoneRules = JSON.parse(prev) as ZoneRule[]
}

/** 级别规则预计影响人数（按当前在位名册推算） */
function preview(rule: ZoneRule): string {
  const set = new Set(rule.rankIds)
  const ex = new Set(rule.excludeRankIds)
  const hit = activeMembers.value.filter((m) => set.has(m.rankId) && !ex.has(m.rankId)).length
  const cap = zoneSeats.value[rule.zoneId] ?? 0
  if (!cap) {
    const who = rule.rankIds.length ? `预计 ${hit} 人 · ` : ''
    return `${who}区域暂无座位（请先在座位图把座位格归入该区域）`
  }
  if (!rule.rankIds.length) return `未限定级别 · 区域 ${cap} 座`
  return `预计 ${hit} 人 → 区域 ${cap} 座${hit > cap ? `（超出 ${hit - cap} 人）` : ''}`
}

/** 预览是否需要示警：人数超出或区域没有座位 */
function previewWarn(rule: ZoneRule): boolean {
  const cap = zoneSeats.value[rule.zoneId] ?? 0
  if (!cap) return true
  const set = new Set(rule.rankIds)
  const ex = new Set(rule.excludeRankIds)
  const hit = activeMembers.value.filter((m) => set.has(m.rankId) && !ex.has(m.rankId)).length
  return hit > cap
}

// 手动勾选人员
const pickerRuleId = ref('')
const pickerIds = ref<string[]>([])
const pickerQuery = ref('')
const pickerOpen = computed({
  get: () => !!pickerRuleId.value,
  set: (v: boolean) => { if (!v) pickerRuleId.value = '' }
})

const pickerList = computed(() => {
  const q = pickerQuery.value.trim().toLowerCase()
  const rankOrder = new Map(props.ranks.map((r) => [r.id, r.order]))
  return activeMembers.value
    .filter((m) => !q || m.name.toLowerCase().includes(q) || unitName(m.unitId).toLowerCase().includes(q))
    .sort((a, b) => (rankOrder.get(a.rankId) ?? 999) - (rankOrder.get(b.rankId) ?? 999) || a.name.localeCompare(b.name, 'zh'))
})

function openPicker(rule: ZoneRule): void {
  pickerRuleId.value = rule.id
  pickerIds.value = [...rule.memberIds]
  pickerQuery.value = ''
}

function togglePicker(id: string): void {
  const i = pickerIds.value.indexOf(id)
  if (i >= 0) pickerIds.value.splice(i, 1)
  else pickerIds.value.push(id)
}

function savePicker(): void {
  const rule = zoneRules.value.find((r) => r.id === pickerRuleId.value)
  if (rule) {
    snapZone()
    rule.memberIds = [...pickerIds.value]
  }
  pickerRuleId.value = ''
}
</script>

<template>
  <section class="card tight rules-panel">
    <!-- 基础排法：每项一行，标签在上、下拉独占整行 -->
    <div class="rules-stack">
      <div class="field">
        <label>主席台座次</label>
        <UiSelect v-model="rules.stageSide" :options="STAGE_SIDE_OPTIONS" size="sm" />
      </div>
      <div class="field">
        <label>主席台 1 号位</label>
        <UiSelect v-model="rules.evenCenterSide" :options="EVEN_OPTIONS" size="sm" />
      </div>
      <div class="field">
        <label>台下填充</label>
        <UiSelect v-model="rules.hallOrder" :options="HALL_ORDER_OPTIONS" size="sm" />
      </div>
      <div class="field">
        <label>单位分布</label>
        <UiSelect v-model="rules.unitOrder" :options="UNIT_ORDER_OPTIONS" size="sm" />
      </div>
    </div>

    <hr class="divider" />

    <!-- ① 职级分层 -->
    <div class="rules-head">
      <div class="insp-title">
        <b>1</b>
        <span>职级分层</span>
      </div>
      <button class="btn sm" @click="addTier">+ 规则</button>
    </div>

    <div v-if="!rules.tiers.length" class="rules-empty">未设置</div>

    <div class="tier-list">
      <div v-for="t in rules.tiers" :key="t.id" class="tr">
        <div class="tr-head">
          <div class="tr-by">
            <UiSelect v-model="t.by" :options="BY_OPTIONS" size="sm" />
          </div>
          <template v-if="t.by === 'row'">
            <span class="tr-txt">第</span>
            <UiNumberInput :model-value="t.from" :min="1" :max="300" :width="46" label="起始排" @update:model-value="t.from = $event" />
            <span class="tr-txt">–</span>
            <UiNumberInput :model-value="t.to" :min="1" :max="300" :width="46" label="结束排" @update:model-value="t.to = $event" />
            <span class="tr-txt">排</span>
          </template>
          <div v-else class="tr-zone">
            <UiSelect
              :model-value="t.zoneId ?? ''"
              :options="zoneOptions"
              size="sm"
              placeholder="选择区域"
              @update:model-value="t.zoneId = $event || undefined"
            />
          </div>
        </div>
        <div class="tr-pick">
          <button
            class="rank-pick"
            :class="{ on: t.rankIds.length }"
            @click="openRankPicker('tier', t.id, t.rankIds)"
          >
            <span class="rank-pick-k">职级</span>
            <span class="rank-pick-v">{{ rankLabel(t.rankIds) }}</span>
            <span class="rank-pick-n">{{ t.rankIds.length }}/{{ sortedRanks.length }}</span>
          </button>
          <span class="tr-result">{{ tierSummary(t) }}</span>
          <button class="tr-del" title="删除这条分层规则" @click="removeTier(t.id)">×</button>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <!-- ② 区域人员分配 -->
    <div class="rules-head">
      <div class="insp-title">
        <b>2</b>
        <span>区域人员分配</span>
      </div>
      <button class="btn sm" :disabled="!layout.zones.length" @click="addZoneRule">+ 规则</button>
    </div>

    <div v-if="!layout.zones.length" class="rules-empty">还没有区域，先在座位图框选后到属性面板新建。</div>
    <div v-else-if="!zoneRules.length" class="rules-empty">未配置</div>

    <div class="zone-list">
      <div v-for="rule in zoneRules" :key="rule.id" class="zr">
        <div class="zr-head">
          <div class="zr-zone">
            <UiSelect v-model="rule.zoneId" :options="zoneOnlyOptions" size="sm" placeholder="选择区域" />
          </div>
          <label class="zr-switch">
            <span class="insp-switch-txt">启用</span>
            <span class="insp-switch">
              <input v-model="rule.enabled" type="checkbox" />
              <span class="insp-switch-track" />
            </span>
          </label>
          <button class="tr-del zr-undo" :disabled="!zoneUndo.length" title="撤销上次区域修改" @click="undoZone">↺</button>
          <button class="tr-del" title="删除这条区域规则" @click="removeZoneRule(rule.id)">×</button>
        </div>

        <div class="zr-line">
          <span class="zr-k">包含</span>
          <button
            class="rank-pick"
            :class="{ on: rule.rankIds.length }"
            @click="openRankPicker('zone-in', rule.id, rule.rankIds)"
          >
            <span class="rank-pick-v">{{ rankLabel(rule.rankIds) }}</span>
            <span class="rank-pick-n">{{ rule.rankIds.length }}/{{ sortedRanks.length }}</span>
          </button>
        </div>

        <details class="zr-adv ui-fold" :open="rule.excludeRankIds.length > 0">
          <summary>排除级别<span v-if="rule.excludeRankIds.length">（{{ rule.excludeRankIds.length }}）</span></summary>
          <button
            class="rank-pick ex"
            :class="{ on: rule.excludeRankIds.length }"
            @click="openRankPicker('zone-ex', rule.id, rule.excludeRankIds)"
          >
            <span class="rank-pick-v">{{ rule.excludeRankIds.length ? rankLabel(rule.excludeRankIds) : '不排除' }}</span>
            <span class="rank-pick-n">{{ rule.excludeRankIds.length }}/{{ sortedRanks.length }}</span>
          </button>
        </details>

        <div class="zr-result">
          <button class="btn sm" @click="openPicker(rule)">指定人员 {{ rule.memberIds.length }}</button>
          <span class="zr-preview" :class="{ 'is-warn': previewWarn(rule) }">{{ preview(rule) }}</span>
        </div>
      </div>
    </div>

    <UiModal v-model="pickerOpen" :title="`指定人员 · ${zoneName(zoneRules.find(r => r.id === pickerRuleId)?.zoneId ?? '')}`" width="520px">
      <input v-model="pickerQuery" class="input" placeholder="搜索姓名或单位" />
      <div class="picker-list">
        <label v-for="m in pickerList" :key="m.id" class="picker-row">
          <input type="checkbox" :checked="pickerIds.includes(m.id)" @change="togglePicker(m.id)" />
          <span class="picker-name">{{ m.name }}</span>
          <span class="picker-hint">{{ rankName(m.rankId) }} · {{ unitName(m.unitId) }}</span>
        </label>
        <div v-if="!pickerList.length" class="caption">没有匹配的人员。</div>
      </div>
      <template #footer>
        <button class="btn" @click="pickerRuleId = ''">取消</button>
        <button class="btn primary" @click="savePicker">确定（{{ pickerIds.length }} 人）</button>
      </template>
    </UiModal>

    <!-- 职级多选：分层规则与区域规则共用，避免两套胶囊重复堆叠 -->
    <UiModal v-model="rankPickOpen" :title="rankPickTitle" width="400px">
      <div class="rank-pick-list">
        <label v-for="r in sortedRanks" :key="r.id" class="picker-row">
          <input type="checkbox" :checked="rankDraft.includes(r.id)" @change="toggleRankDraft(r.id)" />
          <span class="rank-dot" :style="{ background: r.color }" />
          <span class="picker-name">{{ r.name }}</span>
        </label>
      </div>
      <template #footer>
        <button class="btn" @click="rankPick = null">取消</button>
        <button class="btn primary" @click="saveRankPicker">确定（{{ rankDraft.length }}）</button>
      </template>
    </UiModal>
  </section>
</template>

<style scoped>
/* 紧凑规则面板：操作在上、结果紧跟、说明固定在最底部 */
.rules-panel { padding: 12px 14px 10px; }
/* 基础排法：一项一行，标签在上、下拉占满整行宽度 */
.rules-stack { display: flex; flex-direction: column; gap: 8px; }
.rules-stack .field { display: flex; flex-direction: column; gap: 4px; }
.rules-stack .field label { font-size: var(--fs-xs); color: var(--text-secondary); }
.rules-stack .ui-select-label { font-size: var(--fs-xs); }
.rules-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 6px;
}
.rules-empty { font-size: var(--fs-xs); color: var(--text-disabled); line-height: 1.5; margin: 2px 0 6px; }

.rules-panel .divider { margin: 12px 0; }
.tier-list, .zone-list { display: flex; flex-direction: column; gap: 6px; }
.tr {
  display: flex; flex-direction: column; gap: 6px;
  padding: 7px 9px; border-radius: var(--radius-xs);
  background: var(--bg-subtle); border: 1px solid var(--border-soft);
}
.tr-head { display: flex; align-items: center; gap: 5px; min-height: 28px; }
.tr-by { width: 78px; flex: none; }
.tr-txt { flex: none; font-size: var(--fs-xs); color: var(--text-secondary); }
.tr-zone { flex: 1; min-width: 0; }
.tr-del {
  margin-left: auto; flex: none; width: 20px; height: 20px; padding: 0;
  border: none; border-radius: 4px; background: none; cursor: pointer;
  color: var(--text-disabled); font-size: 14px; line-height: 1;
}
.tr-del:hover { background: var(--bg-hover); color: var(--danger); }
.tr-pick { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 28px; }
.tr-result {
  flex: 0 1 auto; min-width: 0; font-size: 11px; line-height: 1.4; color: var(--text-disabled);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 职级多选按钮：一行展示已选范围，点开弹窗勾选，替代整墙胶囊 */
.rank-pick {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px;
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-strong); border-radius: var(--radius-xs);
  background: var(--bg-panel); font-size: var(--fs-xs);
  color: var(--text-secondary); cursor: pointer;
}
.rank-pick:hover { border-color: var(--primary-line); color: var(--text-primary); }
.rank-pick.on { background: var(--primary-soft); border-color: var(--primary-line); }
.rank-pick.ex.on { background: var(--danger-soft); border-color: var(--danger-line); }
.rank-pick-k { flex: none; font-size: var(--fs-xs); color: var(--text-disabled); }
.rank-pick-v { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left; }
.rank-pick-n { flex: none; font-size: 11px; color: var(--text-disabled); font-variant-numeric: tabular-nums; }
.rank-pick-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; }
.rank-dot { flex: none; width: 9px; height: 9px; border-radius: 2px; }

.zr {
  display: flex; flex-direction: column; gap: 6px;
  padding: 7px 9px; border-radius: var(--radius-xs);
  background: var(--bg-subtle); border: 1px solid var(--border-soft);
}
.zr-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.zr-zone { flex: 1; min-width: 0; }
.zr-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.zr-line { display: flex; align-items: flex-start; gap: 6px; }
.zr-k { flex: none; width: 30px; padding-top: 5px; font-size: var(--fs-xs); color: var(--text-secondary); }
.zr-adv summary {
  width: 100%; margin-left: -6px; padding: 4px 6px;
  font-size: var(--fs-xs); color: var(--text-muted);
}
.zr-adv .rank-pick { margin-top: 4px; width: 100%; }
.zr-result { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.zr-preview { font-size: 11px; color: var(--text-muted); }
.zr-preview.is-warn { color: var(--warning); }
.zr-undo { margin-left: 0; font-size: 13px; }
.zr-undo:disabled { opacity: .35; cursor: default; }


.picker-list { max-height: 320px; overflow: auto; margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
.picker-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 4px; font-size: 12px; cursor: pointer; }
.picker-row:hover { background: var(--bg-hover); }
.picker-name { flex: none; min-width: 56px; color: var(--text-primary); }
.picker-hint { flex: 1; min-width: 0; font-size: 11px; color: var(--text-disabled); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
