<script setup lang="ts">
import type { UiConfig } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { buildCrumbs, type MetaCrumb } from '~/utils/breadcrumbs'
import { KONAMI_TOAST_KEY } from '~/utils/funMode'
import { bottomLabelKey, bottomNavFor, isNavActive, navCount, navGroupsFor } from '~/utils/nav'

const { me } = useMe()
const { counts, refreshIfStale: refreshCounts } = useCounts()
const { t } = useI18n()
const route = useRoute()
const orgLine = usePublicConfig().values().orgLine
const meError = useState<string>('meError', () => '')
const pageCrumbs = usePageCrumbs()

// Below 1024 px the rail is a temporary drawer and the bottom navigation shows the daily pages (proposal §4.3).
const { width } = useDisplay()
const mobile = computed(() => width.value < 1024)
// null lets Vuetify open it on desktop and keep it closed on narrow screens
const drawer = ref<boolean | null>(null)

const RAIL_KEY = 'yoda_rail_collapsed'
const collapsed = ref(false)
onMounted(() => {
  try {
    collapsed.value = localStorage.getItem(RAIL_KEY) === '1'
  } catch {
    // storage blocked: keep the full rail
  }
})
function toggleRail() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(RAIL_KEY, collapsed.value ? '1' : '0')
  } catch {
    // not remembered
  }
}

const groups = computed(() => (me.value ? navGroupsFor(me.value) : null))
const bottom = computed(() => (me.value ? bottomNavFor(me.value) : []))
const requester = computed(() => !!me.value && !me.value.isStaff)

const crumbs = computed(() =>
  buildCrumbs(
    {
      path: route.path,
      groups: groups.value ?? [],
      meta: route.meta.crumbs as MetaCrumb[] | undefined,
      dynamic: pageCrumbs.value?.path === route.path ? pageCrumbs.value.crumbs : [],
    },
    t,
  ),
)
useHead({
  title: () => crumbs.value.at(-1)?.label ?? '',
  titleTemplate: (title?: string) => (title ? `${title} · ${t('app.name')}` : t('app.title')),
})

// Fun mode (cosmetic, admin switch): read once per sign-in; off until known. The easter egg only listens while on.
const { enabled: funMode, set: setFunMode } = useFunMode()
const api = useApi()
watch(() => me.value?.id, (id) => {
  if (!id) return
  api<UiConfig>('/ui-config').then(c => setFunMode(c.funMode), () => setFunMode(false))
}, { immediate: true })
const konamiToast = ref(false)
useKonami(funMode, () => {
  konamiToast.value = true
})

// Badges: on sign-in, on navigation and every minute (no extra live stream); at most every 20 s.
let timer: ReturnType<typeof setInterval> | null = null
watch([me, () => route.path], () => {
  if (me.value) void refreshCounts()
}, { immediate: true })
onMounted(() => {
  timer = setInterval(() => {
    if (me.value && document.visibilityState === 'visible') void refreshCounts()
  }, 60000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <a href="#main" class="skip-link" data-testid="skip-link">{{ t('shell.skipToContent') }}</a>
  <v-navigation-drawer
    v-model="drawer"
    :rail="collapsed && !mobile"
    rail-width="64"
    :mobile="mobile"
    :temporary="mobile"
    data-testid="nav-drawer"
  >
    <AppRail
      :groups="groups"
      :path="route.path"
      :counts="counts"
      :requester="requester"
      :org-line="orgLine"
      :collapsed="collapsed && !mobile"
      :collapsible="!mobile"
      @toggle="toggleRail"
    />
  </v-navigation-drawer>
  <v-app-bar>
    <div class="top-bar">
      <v-btn v-if="mobile" icon="mdi-menu" variant="text" class="ml-n2" :aria-label="t('shell.openMenu')" data-testid="menu-open" @click="drawer = !drawer" />
      <AppBreadcrumbs :items="crumbs" :compact="mobile" />
      <template v-if="me">
        <GlobalSearch :requester="requester" :compact="mobile" />
        <NotificationBell />
        <UserMenu :me="me" :compact="mobile" />
      </template>
    </div>
  </v-app-bar>
  <v-main id="main" tabindex="-1">
    <v-container fluid class="app-content">
      <v-alert v-if="meError" type="error" data-testid="me-error">{{ t(meError) }}</v-alert>
      <div v-else-if="!me" class="app-loading" role="status" data-testid="shell-loading">
        <v-progress-circular indeterminate color="primary" size="32" />
        <span class="text-body-2 text-medium-emphasis">{{ t('shell.signingIn') }}</span>
      </div>
      <slot v-else />
    </v-container>
  </v-main>
  <v-bottom-navigation v-if="me && mobile" grow height="64" class="bottom-nav" :aria-label="t('shell.mainMenu')" data-testid="bottom-nav">
    <v-btn
      v-for="i in bottom"
      :key="i.key"
      :to="i.to"
      :active="isNavActive(i.to, route.path)"
      :aria-current="isNavActive(i.to, route.path) ? 'page' : undefined"
      color="primary"
      :data-testid="`bottom-${i.to.slice(1)}`"
    >
      <v-badge :model-value="!!navCount(i, counts)" :content="navCount(i, counts) ?? ''" color="error">
        <v-icon :icon="i.icon" />
      </v-badge>
      <span>{{ t(bottomLabelKey(i)) }}</span>
    </v-btn>
  </v-bottom-navigation>
  <v-snackbar v-model="konamiToast" :timeout="4000" color="nav" location="top" data-testid="konami-toast">
    <span class="d-inline-flex align-center ga-2"><AppMark :size="20" />{{ t(KONAMI_TOAST_KEY) }}</span>
  </v-snackbar>
</template>

<style scoped>
.skip-link {
  position: fixed; top: 8px; left: 8px; z-index: 3000; padding: 8px 16px; border-radius: 6px;
  background: rgb(var(--v-theme-primary)); color: #fff; font-weight: 500; text-decoration: none;
  transform: translateY(-200%);
}
.skip-link:focus { transform: none; }
#main:focus { outline: none; }
.top-bar { display: flex; align-items: center; gap: 16px; width: 100%; height: 100%; padding: 0 24px; min-width: 0; }
.app-content { padding: 24px; }
.app-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 50vh; }
@media (max-width: 1023px) {
  .top-bar { gap: 4px; padding: 0 8px 0 16px; }
  .app-content { padding: 16px 16px 24px; }
}
.bottom-nav :deep(.v-btn) { font-size: 12px; min-width: 0; }
</style>
