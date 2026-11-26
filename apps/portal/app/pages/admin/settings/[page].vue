<script setup lang="ts">
import type { AdminSettingsResponse, ChannelName, ChannelSettingsPatch, ChannelStatus, SettingCategory, SettingsCategoryView, SettingsPutResponse } from '@yoda/shared'
import AiDepartment from '~/components/settings/AiDepartment.vue'
import AuditLog from '~/components/settings/AuditLog.vue'
import AuditPanel from '~/components/settings/AuditPanel.vue'
import CategorySection from '~/components/settings/CategorySection.vue'
import CopyField from '~/components/settings/CopyField.vue'
import GitlabStatus from '~/components/settings/GitlabStatus.vue'
import RestartBanner from '~/components/settings/RestartBanner.vue'
import TelegramWebhook from '~/components/settings/TelegramWebhook.vue'
import {
  CATEGORY_ICONS,
  REAUTH_STASH_KEY,
  SETTINGS_HOME,
  SETTINGS_PAGES,
  lockedCount,
  masterKeyAlert,
  parseReauthStash,
  settingsPage,
  settingsPath,
  visibleSettings,
  webhookUrl,
} from '~/utils/settings'

/**
 * System settings (installer proposal §5.2, mockup `installer-admin-settings.html`): the category list (a chip
 * row on phones), the category's cards, and the last changes beside them (below on narrow screens). GitLab and
 * the notification channels, once their own admin pages, are categories here (D5).
 */
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const router = useRouter()
// One instance for every category: switching category is a route update, handled below (fresh data, the
// unsaved-changes guard, the crumbs), not a remount.
definePageMeta({ key: () => 'admin-settings' })
const page = computed(() => settingsPage(String(route.params.page ?? '')))
if (!page.value) await navigateTo(SETTINGS_HOME, { replace: true })

// The category crumb follows the path (useBreadcrumb keys crumbs by the path at setup, which changes here).
const pageCrumbs = usePageCrumbs()
let crumbPath = ''
watchEffect(() => {
  if (!page.value || !route.path.startsWith('/admin/settings/')) return
  crumbPath = route.path
  pageCrumbs.value = { path: crumbPath, crumbs: [{ label: t(`settings.page.${page.value.id}`) }] }
})
onBeforeUnmount(() => {
  if (pageCrumbs.value?.path === crumbPath) pageCrumbs.value = null
})

// Kept between categories so the list's lock counts show at once; the forms wait for a fresh load.
const data = useState<AdminSettingsResponse | null>('adminSettings', () => null)
const fresh = ref(false)
const failure = ref<unknown>(null)
const auditRefresh = ref(0)

async function load() {
  try {
    data.value = await api<AdminSettingsResponse>('/admin/settings')
    failure.value = null
    fresh.value = true
  } catch (e) {
    failure.value = e
  }
}

const catView = (c: SettingCategory): SettingsCategoryView | null => data.value?.categories.find(x => x.category === c) ?? null
const navCount = (categories: SettingCategory[]) =>
  categories.reduce((n, c) => n + lockedCount(visibleSettings(c, catView(c)?.settings ?? [])), 0)

/** After a generated secret: only that category is fetched again; the other forms keep their drafts. */
async function reloadCategory(c: SettingCategory) {
  try {
    const r = await api<AdminSettingsResponse>('/admin/settings', { query: { category: c } })
    const fresh = r.categories.find(x => x.category === c)
    if (data.value && fresh) data.value = { ...data.value, restartRequired: r.restartRequired, categories: data.value.categories.map(x => (x.category === c ? fresh : x)) }
  } catch {
    // the panel shows the old state until the next load
  }
  auditRefresh.value++
}

function onSaved(res: SettingsPutResponse | null) {
  if (res && data.value) {
    data.value = {
      ...data.value,
      restartRequired: res.restartRequired,
      categories: data.value.categories.map(c => (c.category === res.category.category ? res.category : c)),
    }
  } else {
    void load()
  }
  auditRefresh.value++
}

const masterKey = computed(() => data.value?.masterKey ?? null)
const keyAlert = computed(() => masterKeyAlert(masterKey.value))
const origin = typeof window === 'undefined' ? '' : window.location.origin
const publicUrl = computed(() => catView('general')?.settings.find(s => s.key === 'org.publicUrl')?.value)
const hook = (path: string) => webhookUrl(publicUrl.value, origin, path)
const modelWarnings = computed(() => (data.value?.warnings ?? []).filter(w => w.code === 'unpriced_model'))

// Notification channels: the enable switches (`notification_channel_settings`, §5.5) sit on each card's head.
const channels = ref<ChannelStatus[] | null>(null)
const channelBusy = ref(false)
const channelError = ref('')
const channel = (name: string) => channels.value?.find(c => c.name === name) ?? null
async function loadChannels() {
  channels.value = await api<ChannelStatus[]>('/admin/notification-channels').catch(() => null)
}
async function setEnabled(name: ChannelName, on: boolean | null) {
  channelError.value = ''
  channelBusy.value = true
  try {
    const body: ChannelSettingsPatch = { [name]: on === true }
    channels.value = await api<ChannelStatus[]>('/admin/notification-channels', { method: 'PATCH', body })
  } catch (e) {
    channelError.value = t(errorKey(e))
    await loadChannels()
  } finally {
    channelBusy.value = false
  }
}
function onChannelSaved(res: SettingsPutResponse | null) {
  onSaved(res)
  void loadChannels()
}

// Unsaved changes: leaving the page (or closing the tab) asks first.
const dirty = reactive(new Set<string>())
const setDirty = (c: string, d: boolean) => (d ? dirty.add(c) : dirty.delete(c))
const leaveOpen = ref(false)
let pendingLeave: string | null = null
let leaving = false
function guard(to: { fullPath: string }, from: { fullPath: string }) {
  if (!dirty.size || leaving || to.fullPath === from.fullPath) return true
  pendingLeave = to.fullPath
  leaveOpen.value = true
  return false
}
onBeforeRouteLeave(guard)
// Another category (or the change log) is the same page instance: the same question.
onBeforeRouteUpdate((to, from) => (to.path === from.path ? true : guard(to, from)))
async function leave() {
  leaving = true
  leaveOpen.value = false
  dirty.clear()
  try {
    if (pendingLeave) await router.push(pendingLeave)
  } finally {
    leaving = false
  }
}
function beforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.size) return
  // Going to Keycloak to sign in again keeps the form in sessionStorage: no prompt for that.
  try {
    if (parseReauthStash(sessionStorage.getItem(REAUTH_STASH_KEY), route.path)) return
  } catch {
    // ask as usual
  }
  e.preventDefault()
  e.returnValue = ''
}
/** Each category starts from fresh data: the forms wait for it, and no dirty flag outlives its form. */
function enter() {
  fresh.value = false
  failure.value = null
  dirty.clear()
  void load()
  if (page.value?.id === 'channels') void loadChannels()
}
watch(() => page.value?.id, (id, old) => {
  if (id && old && id !== old) enter()
})
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  enter()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<template>
  <div v-if="page" data-testid="admin-settings" :data-page="page.id">
    <PageHeader :title="t('settings.title')">
      <template #meta><span>{{ t('settings.hint') }}</span></template>
      <template #actions>
        <v-btn variant="outlined" prepend-icon="mdi-history" :to="settingsPath('audit')" data-testid="settings-audit-link">{{ t('settings.audit.all') }}</v-btn>
      </template>
    </PageHeader>

    <RestartBanner :keys="data?.restartRequired ?? []" />
    <v-alert v-if="keyAlert" :type="keyAlert.type" variant="tonal" density="compact" class="mb-4" :role="keyAlert.type === 'error' ? 'alert' : 'status'" :data-level="keyAlert.type" data-testid="master-key-alert">
      {{ t(keyAlert.key) }}
    </v-alert>

    <div class="settings-layout" :class="{ 'settings-layout--full': page.id === 'audit' }">
      <nav class="settings-nav" :aria-label="t('settings.navLabel')" data-testid="settings-nav">
        <NuxtLink
          v-for="p in SETTINGS_PAGES"
          :key="p.id"
          :to="settingsPath(p.id)"
          class="settings-nav__item"
          :class="{ 'settings-nav__item--active': p.id === page.id }"
          :aria-current="p.id === page.id ? 'page' : undefined"
          :data-testid="`settings-nav-${p.id}`"
        >
          <v-icon :icon="p.icon" size="20" aria-hidden="true" />
          <span class="settings-nav__label">{{ t(`settings.page.${p.id}`) }}</span>
          <span v-if="navCount(p.categories)" class="settings-nav__locks" :title="t('settings.nav.locked', { n: navCount(p.categories) })">
            {{ navCount(p.categories) }}<v-icon icon="mdi-lock-outline" size="12" aria-hidden="true" />
          </span>
        </NuxtLink>
      </nav>

      <div class="settings-main">
        <AuditLog v-if="page.id === 'audit'" />
        <template v-else-if="!fresh">
          <ErrorState v-if="failure" :error="failure" data-testid="settings-error" @retry="load" />
          <SkeletonList v-else :rows="4" quiet />
        </template>
        <template v-else>
          <!-- GitLab: today's status page content, then the connection settings and the webhook. -->
          <GitlabStatus v-if="page.id === 'gitlab'" :refresh="auditRefresh" />

          <template v-for="c in page.categories" :key="c">
            <CategorySection
              v-if="catView(c)"
              :category="c"
              :view="catView(c)!"
              :title="t(`settings.category.${c}`)"
              :icon="CATEGORY_ICONS[c]"
              :generate="c === 'gitlab' ? ['gitlab.webhookSecret'] : c === 'telegram' ? ['telegram.webhookSecret'] : []"
              :send-test="c === 'email'"
              :key-status="masterKey?.status ?? null"
              class="mb-4"
              @saved="page.id === 'channels' ? onChannelSaved($event) : onSaved($event)"
              @tested="auditRefresh++"
              @generated="reloadCategory(c)"
              @reload="load"
              @dirty="setDirty(c, $event)"
            >
              <template v-if="page.id === 'channels' && channel(c)" #head>
                <StatusChip
                  kind="yesNo"
                  :value="channel(c)!.enabled ? 'yes' : 'no'"
                  :label="t(channel(c)!.enabled ? 'settings.channels.on' : channel(c)!.configured ? 'settings.channels.off' : 'notifications.admin.configuredNo')"
                  size="x-small"
                  :data-testid="`channel-${c}-state`"
                />
                <v-switch
                  :model-value="channel(c)!.enabled"
                  :disabled="channelBusy || (!channel(c)!.configured && !channel(c)!.enabled)"
                  :aria-label="t('settings.channels.enable', { name: t(`settings.category.${c}`) })"
                  color="primary"
                  density="compact"
                  hide-details
                  inset
                  class="flex-grow-0"
                  :data-testid="`channel-${c}-enabled`"
                  @update:model-value="(v: boolean | null) => setEnabled(c as ChannelName, v)"
                />
              </template>

              <template #before>
                <template v-if="c === 'security' && masterKey">
                <dl class="card-body key-grid" data-testid="master-key">
                  <dt>{{ t('settings.security.keyStatus') }}</dt>
                  <dd><StatusChip kind="masterKey" :value="masterKey.status" /></dd>
                  <dt>{{ t('settings.security.keyId') }}</dt>
                  <dd><code class="setting-code">{{ masterKey.keyId ?? '–' }}</code></dd>
                  <dt>{{ t('settings.security.recovery') }}</dt>
                  <dd>{{ masterKey.recovery ? t('gitlab.admin.yes') : t('gitlab.admin.no') }}</dd>
                </dl>
                <p class="card-body pt-0 setting-meta">{{ t('settings.security.keyHelp') }}</p>
                </template>
                <div v-else-if="c === 'ai' && modelWarnings.length" class="card-body pb-0">
                  <v-alert v-for="w in modelWarnings" :key="w.key" type="warning" variant="tonal" density="compact" class="mb-2" data-testid="model-warning">
                    {{ t('settings.warning.unpriced_model', { name: t(`settings.field.${w.key}.label`) }) }}
                  </v-alert>
                </div>
                <p v-else-if="c === 'storage'" class="card-body pb-0 mb-0 setting-meta">{{ t('settings.storage.readOnly') }}</p>
              </template>

              <template v-if="c === 'gitlab'" #after>
                <div class="settings-extra">
                  <CopyField :label="t('gitlab.admin.webhookUrl')" :value="hook('/api/gitlab/webhook')" testid="gitlab-webhook-url" />
                  <div class="setting-label mt-4">{{ t('gitlab.admin.stepsTitle') }}</div>
                  <ol class="webhook-steps text-body-2">
                    <li v-for="n in 4" :key="n">{{ t(`settings.gitlab.steps.${n}`) }}</li>
                  </ol>
                </div>
              </template>
              <template v-else-if="c === 'line'" #after>
                <div class="settings-extra">
                  <CopyField :label="t('settings.channels.lineWebhookUrl')" :value="hook('/api/webhooks/line')" testid="line-webhook-url" />
                </div>
              </template>
              <template v-else-if="c === 'telegram'" #after>
                <TelegramWebhook :url="hook('/api/webhooks/telegram')" @done="auditRefresh++" />
              </template>
              <template v-else-if="c === 'signin'" #after>
                <p class="setting-meta mt-4">{{ t('settings.signin.recoveryNote') }}</p>
                <p class="setting-meta">{{ t('settings.signin.loginFunNote') }}</p>
              </template>
              <template v-else-if="c === 'runners'" #after>
                <p class="setting-meta mt-4"><NuxtLink to="/runners" class="text-primary">{{ t('settings.runners.link') }}</NuxtLink></p>
              </template>
            </CategorySection>
          </template>
          <v-alert v-if="channelError" type="error" variant="tonal" density="compact" class="mb-4" data-testid="channels-error">{{ channelError }}</v-alert>

          <AiDepartment v-if="page.id === 'ai'" />
        </template>
      </div>

      <aside v-if="page.id !== 'audit'" class="settings-aside">
        <AuditPanel :categories="page.categories" :refresh="auditRefresh" />
      </aside>
    </div>

    <ConfirmDialog
      v-model="leaveOpen"
      :title="t('settings.leave.title')"
      :text="t('settings.leave.text')"
      :confirm-label="t('settings.leave.confirm')"
      :cancel-label="t('settings.leave.stay')"
      destructive
      confirm-testid="leave-confirm"
      cancel-testid="leave-stay"
      @confirm="leave"
    />
  </div>
</template>

<style scoped>
.settings-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr) 320px; gap: 24px; align-items: start; }
.settings-layout--full { grid-template-columns: 200px minmax(0, 1fr); }
.settings-nav { display: flex; flex-direction: column; gap: 2px; position: sticky; top: 80px; }
.settings-nav__item {
  display: flex; align-items: center; gap: 12px; min-height: 40px; padding: 8px 12px; border-radius: 8px;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); text-decoration: none; font-size: .9375rem;
}
.settings-nav__item:hover { background: rgba(var(--v-theme-on-surface), .04); }
.settings-nav__item--active { background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-on-primary-soft)); font-weight: 500; }
.settings-nav__label { flex: 1 1 auto; min-width: 0; }
.settings-nav__locks { display: inline-flex; align-items: center; gap: 2px; font-size: .75rem; font-variant-numeric: tabular-nums; }
.settings-main { min-width: 0; }
.settings-extra { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.webhook-steps { padding-left: 20px; margin: 0; display: grid; gap: 4px; }
.key-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 8px 24px; align-items: center; margin: 0; }
.key-grid dt { font-size: .875rem; font-weight: 500; }
.key-grid dd { margin: 0; font-size: .875rem; }
@media (max-width: 1279px) {
  .settings-layout { grid-template-columns: 200px minmax(0, 1fr); }
  .settings-aside { grid-column: 2; }
}
/* Phones and small tablets: the category list becomes a scrolling row of chips above the form. */
@media (max-width: 959px) {
  .settings-layout, .settings-layout--full { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .settings-aside { grid-column: 1; }
  .settings-nav { position: static; flex-direction: row; overflow-x: auto; gap: 8px; padding-bottom: 4px; scrollbar-width: none; }
  .settings-nav__item { flex: none; min-height: 40px; padding: 6px 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); white-space: nowrap; }
  .settings-nav__item--active { border-color: transparent; }
  .settings-nav__locks { display: none; }
  .key-grid { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
</style>
