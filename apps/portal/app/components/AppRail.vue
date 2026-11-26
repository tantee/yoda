<script setup lang="ts">
import type { MeCounts } from '@yoda/shared'
import { computed, useI18n } from '#imports'
import { activeNavItem, navCount, type NavGroup } from '~/utils/nav'

/**
 * The side rail's content (proposal §5.1, §5.2): brand, grouped items with count badges and the active accent,
 * and the organisation line. `groups` null renders skeleton items (the shell while signing in).
 */
const props = defineProps<{
  groups: NavGroup[] | null
  path: string
  counts: MeCounts | null
  requester?: boolean
  orgLine?: string
  collapsed?: boolean
  /** Shows the collapse toggle (desktop only). */
  collapsible?: boolean
}>()
defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const active = computed(() => activeNavItem((props.groups ?? []).flatMap(g => g.items), props.path))
</script>

<template>
  <div class="app-rail" :class="{ 'app-rail--collapsed': collapsed }" data-testid="rail">
    <NuxtLink to="/" class="app-rail__brand" :aria-label="t('app.title')">
      <AppMark />
      <span v-if="!collapsed" class="app-rail__brand-text">
        <span class="app-rail__name">{{ t('app.name') }}</span>
        <span class="app-rail__sub">{{ requester ? t('app.subRequester') : t('app.sub') }}</span>
      </span>
    </NuxtLink>
    <nav :aria-label="t('shell.mainMenu')" class="app-rail__nav">
      <template v-if="groups">
        <div v-for="(g, gi) in groups" :key="g.key ?? gi" class="app-rail__group">
          <div v-if="g.key && !collapsed" class="app-rail__label">{{ t(g.key) }}</div>
          <NuxtLink
            v-for="i in g.items"
            :key="i.key"
            :to="i.to"
            class="app-rail__item"
            :class="{ 'app-rail__item--active': active === i }"
            :aria-current="active === i ? 'page' : undefined"
            :title="collapsed ? t(i.key) : undefined"
            :data-testid="`nav-${i.to.slice(1).replaceAll('/', '-')}`"
          >
            <v-icon :icon="i.icon" size="20" aria-hidden="true" />
            <span v-if="!collapsed" class="app-rail__text">{{ t(i.key) }}</span>
            <span v-if="navCount(i, counts)" class="app-rail__count" :data-testid="`nav-count-${i.count}`">{{ navCount(i, counts) }}</span>
          </NuxtLink>
        </div>
      </template>
      <div v-else class="app-rail__group" data-testid="rail-skeleton">
        <div v-for="n in 6" :key="n" class="app-rail__item app-rail__item--skeleton"><span /></div>
      </div>
    </nav>
    <div class="app-rail__foot">
      <span v-if="orgLine && !collapsed" class="app-rail__org" data-testid="org-line">{{ orgLine }}</span>
      <button
        v-if="collapsible"
        type="button"
        class="app-rail__toggle"
        :aria-label="collapsed ? t('shell.expandRail') : t('shell.collapseRail')"
        :title="collapsed ? t('shell.expandRail') : t('shell.collapseRail')"
        data-testid="rail-toggle"
        @click="$emit('toggle')"
      >
        <v-icon :icon="collapsed ? 'mdi-chevron-double-right' : 'mdi-chevron-double-left'" size="18" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.app-rail { display: flex; flex-direction: column; height: 100%; padding: 12px 12px 12px; color: rgb(var(--v-theme-on-nav)); }
.app-rail__brand { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 8px; margin-bottom: 4px; color: #fff; text-decoration: none; border-radius: 6px; }
.app-rail__brand-text { display: flex; flex-direction: column; min-width: 0; }
.app-rail__name { font-weight: 600; font-size: 15px; line-height: 1.2; }
.app-rail__sub { font-size: 12px; line-height: 1.3; color: rgb(var(--v-theme-nav-label)); }
.app-rail__nav { flex: 1; overflow-y: auto; margin: 0 -12px; padding: 0 12px; }
.app-rail__group { margin-top: 12px; }
.app-rail__label { font-size: 12px; font-weight: 500; color: rgb(var(--v-theme-nav-label)); padding: 4px 12px; }
.app-rail__item {
  position: relative; display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 12px; border-radius: 6px;
  color: rgb(var(--v-theme-on-nav)); font-size: 14px; text-decoration: none;
}
.app-rail__item:hover { background: rgb(var(--v-theme-nav-hover)); }
.app-rail__item--active { background: rgb(var(--v-theme-nav-active)); color: #fff; font-weight: 500; }
.app-rail__item--active::before {
  content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0;
  background: rgb(var(--v-theme-nav-accent));
}
.app-rail__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-rail__count {
  margin-left: auto; min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; display: grid; place-items: center;
  background: #1E3E6B; color: #DCE6F5; font-size: 12px; font-variant-numeric: tabular-nums;
}
.app-rail__item--active .app-rail__count { background: #9CC2FF; color: rgb(var(--v-theme-nav)); font-weight: 600; }
.app-rail__item--skeleton span { display: block; height: 12px; width: 70%; border-radius: 6px; background: rgb(var(--v-theme-nav-active)); }
.app-rail__foot {
  display: flex; align-items: center; gap: 8px; padding: 12px 4px 0 12px; margin-top: 8px;
  border-top: 1px solid #1E3E6B; font-size: 12px; color: rgb(var(--v-theme-nav-label));
}
.app-rail__org { flex: 1; min-width: 0; }
.app-rail__toggle {
  margin-left: auto; width: 32px; height: 32px; border-radius: 6px; display: grid; place-items: center;
  color: rgb(var(--v-theme-nav-label)); background: transparent; border: 0; cursor: pointer;
}
.app-rail__toggle:hover { background: rgb(var(--v-theme-nav-hover)); color: #fff; }
/* Collapsed (64 px): icons only, the count becomes a dot-sized pill on the icon. */
.app-rail--collapsed { padding: 12px 8px; }
.app-rail--collapsed .app-rail__brand { justify-content: center; padding: 0; }
.app-rail--collapsed .app-rail__item { justify-content: center; padding: 0; }
.app-rail--collapsed .app-rail__item--active::before { left: -8px; }
.app-rail--collapsed .app-rail__count { position: absolute; top: 2px; right: 0; min-width: 18px; height: 16px; font-size: 11px; padding: 0 4px; }
.app-rail--collapsed .app-rail__foot { padding: 12px 0 0; justify-content: center; }
.app-rail--collapsed .app-rail__toggle { margin: 0; }
</style>
