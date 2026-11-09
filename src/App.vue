<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { loadAll, state } from './store'
import { UiIcon } from './ui'
import RosterView from './views/RosterView.vue'
import RankView from './views/RankView.vue'
import UnitView from './views/UnitView.vue'
import LayoutView from './views/LayoutView.vue'
import ProjectView from './views/ProjectView.vue'

type Tab = 'roster' | 'rank' | 'unit' | 'layout' | 'project'
const tab = ref<Tab>('roster')
const ready = ref(false)
const activeRosterId = ref('')

onMounted(async () => {
  await loadAll()
  ready.value = true
})

const navItems: { key: Tab; label: string; icon: string }[] = [
  { key: 'roster', label: '名册与组织', icon: 'users' },
  { key: 'layout', label: '会场布局', icon: 'layout' },
  { key: 'project', label: '排座项目', icon: 'seat' }
]

function go(t: Tab): void {
  tab.value = t
}

function openSequence(t: 'rank' | 'unit', rosterId: string): void {
  activeRosterId.value = rosterId
  tab.value = t
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" />
        <div>
          <div class="brand-name">座位编排</div>
          <div class="brand-sub">SEAT PLANNING</div>
        </div>
      </div>

      <nav class="nav-group">
        <div class="nav-label">工作区</div>
        <button
          v-for="item in navItems"
          :key="item.key"
          class="nav-item"
          :class="{ active: tab === item.key || (item.key === 'roster' && (tab === 'rank' || tab === 'unit')) }"
          @click="tab = item.key"
        >
          <UiIcon class="ico" :name="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="side-foot">
        数据保存在本机浏览器 IndexedDB<br />
        可在「排座项目」导出全量备份
      </div>
    </aside>

    <main class="main" :class="{ fill: tab === 'layout' || tab === 'project' }">
      <div v-if="!ready" class="empty">正在加载本地数据…</div>
      <template v-else>
        <RosterView
          v-if="tab === 'roster'"
          @open-ranks="openSequence('rank', $event)"
          @open-units="openSequence('unit', $event)"
        />
        <RankView v-else-if="tab === 'rank'" :initial-roster-id="activeRosterId" @back="go('roster')" />
        <UnitView v-else-if="tab === 'unit'" :initial-roster-id="activeRosterId" @back="go('roster')" />
        <LayoutView v-else-if="tab === 'layout'" />
        <ProjectView v-else />
      </template>
    </main>
  </div>
</template>
