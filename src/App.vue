<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { loadAll } from './store'
import { UiIcon } from './ui'
import RosterView from './views/RosterView.vue'
import RankView from './views/RankView.vue'
import UnitView from './views/UnitView.vue'
import LayoutView from './views/LayoutView.vue'
import ProjectView from './views/ProjectView.vue'
import SettingsView from './views/SettingsView.vue'

type Tab = 'roster' | 'rank' | 'unit' | 'layout' | 'project' | 'settings'
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

      <nav class="nav-group nav-group-foot">
        <div class="nav-label">系统</div>
        <button class="nav-item" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">
          <UiIcon class="ico" name="settings" :size="16" />
          <span>设置中心</span>
        </button>
      </nav>
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
        <ProjectView v-else-if="tab === 'project'" />
        <SettingsView v-else />
      </template>
    </main>
  </div>
</template>
