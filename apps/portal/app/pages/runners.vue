<script setup lang="ts">
import type { Runner, RunnerSettings } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { runnerStatus, sortRunners, withinHours } from '~/utils/runners'

const { t } = useI18n()
const { me } = useMe()
const api = useApi()
const docsUrl = useRuntimeConfig().public.runnerDocsUrl as string
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)

const isAdmin = computed(() => !!me.value?.isAdmin)
const view = ref<'mine' | 'all'>('mine')
const runners = ref<Runner[]>([])
const loaded = ref(false)
const loadFailure = ref<unknown>(null)
const settings = ref<RunnerSettings | null>(null)
const settingsOpen = ref(false)
const error = ref('')
const settingsError = ref('')
const confirmError = ref('')
const busy = ref(false)
const createOpen = ref(false)
const confirm = ref<{ runner: Runner; action: 'pause' | 'resume' | 'revoke' } | null>(null)
const confirmOpen = computed({
  get: () => !!confirm.value,
  set: (v: boolean) => {
    if (!v) confirm.value = null
  },
})
const now = ref(new Date())

const { dateTime: fmt, relative } = useDateFormat()
const outsideHours = (r: Runner) => r.mode === 'unattended' && !withinHours(r.workingHours, now.value)
const rows = computed(() => sortRunners(runners.value))

async function load() {
  try {
    runners.value = await api<Runner[]>('/runners', { query: view.value === 'all' && isAdmin.value ? { all: '1' } : {} })
    now.value = new Date()
    error.value = ''
    loaded.value = true
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
}

async function loadSettings() {
  if (!isAdmin.value) return
  try {
    settings.value = await api<RunnerSettings>('/admin/runner-settings')
    settingsError.value = ''
  } catch (e) {
    settingsError.value = t(errorKey(e))
  }
}

async function saveSetting(patch: Partial<RunnerSettings>) {
  settingsError.value = ''
  try {
    settings.value = await api<RunnerSettings>('/admin/runner-settings', { method: 'PATCH', body: patch })
  } catch (e) {
    settingsError.value = t(errorKey(e))
    await loadSettings()
  }
}

function ask(runner: Runner, action: 'pause' | 'resume' | 'revoke') {
  confirmError.value = ''
  confirm.value = { runner, action }
}

async function confirmAction() {
  const c = confirm.value
  if (!c) return
  confirmError.value = ''
  busy.value = true
  try {
    if (c.action === 'revoke') await api(`/runners/${c.runner.id}`, { method: 'DELETE' })
    else await api(`/runners/${c.runner.id}`, { method: 'PATCH', body: { paused: c.action === 'pause' } })
    confirm.value = null
    await load()
  } catch (e) {
    confirmError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

watch(view, load)
watch(isAdmin, (v) => {
  if (v && !settings.value) void loadSettings()
})
onMounted(() => {
  void load()
  void loadSettings()
})
useLiveEvents((e) => {
  if (e.type.startsWith('run.')) void load()
}, load)
</script>

<template>
  <div data-testid="runners-page">
    <PageHeader :title="t('runners.title')">
      <template #actions>
        <v-btn color="primary" prepend-icon="mdi-plus" data-testid="runner-create" @click="createOpen = true">{{ t('runners.create') }}</v-btn>
      </template>
      <template #meta>
        <span class="runners-intro">
          {{ t('runners.intro') }}
          <a :href="docsUrl" target="_blank" rel="noopener" data-testid="runner-docs">{{ t('runners.docs') }}<v-icon icon="mdi-open-in-new" size="14" class="ml-1" aria-hidden="true" /></a>
        </span>
      </template>
      <template v-if="isAdmin" #tabs>
        <v-tabs v-model="view" density="compact" color="primary" data-testid="runner-view">
          <v-tab value="mine">{{ t('runners.mine') }}</v-tab>
          <v-tab value="all" data-testid="runner-view-all">{{ t('runners.all') }}</v-tab>
        </v-tabs>
      </template>
    </PageHeader>

    <v-card v-if="isAdmin && settings" class="mb-4" data-testid="runner-settings">
      <button type="button" class="card-head settings-toggle" :aria-expanded="settingsOpen" data-testid="runner-settings-toggle" @click="settingsOpen = !settingsOpen">
        <h2>{{ t('runners.settings.titleAdmin') }}</h2>
        <span class="d-flex align-center ga-2">
          <StatusChip v-if="settings.paused" kind="runner" value="paused" :label="t('runners.settings.allPaused')" size="x-small" />
          <v-icon :icon="settingsOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" aria-hidden="true" />
        </span>
      </button>
      <div v-show="settingsOpen" class="card-body">
        <v-alert v-if="settingsError" type="error" variant="tonal" density="compact" class="mb-3">{{ settingsError }}</v-alert>
        <div class="settings-grid">
          <div class="text-body-2 font-weight-medium">{{ t('runners.settings.pauseAll') }}</div>
          <div>
            <v-switch
              :model-value="settings.paused"
              :label="settings.paused ? t('runners.settings.on') : t('runners.settings.off')"
              color="warning"
              hide-details
              inset
              density="compact"
              data-testid="runner-pause-all"
              @update:model-value="v => saveSetting({ paused: !!v })"
            />
            <p class="text-caption text-medium-emphasis mb-0">{{ t('runners.settings.pauseAllHint') }}</p>
          </div>
          <div class="text-body-2 font-weight-medium">{{ t('runners.settings.allowPersonalUnattended') }}</div>
          <div>
            <v-switch
              :model-value="settings.allowPersonalUnattended"
              :label="settings.allowPersonalUnattended ? t('runners.settings.on') : t('runners.settings.off')"
              color="primary"
              hide-details
              inset
              density="compact"
              data-testid="runner-allow-personal"
              @update:model-value="v => saveSetting({ allowPersonalUnattended: !!v })"
            />
            <v-alert type="warning" variant="tonal" density="compact" class="mt-2 text-body-2 runners-caveat" data-testid="runner-personal-caveat">{{ t('runners.settings.personalCaveat') }}</v-alert>
          </div>
        </div>
      </div>
    </v-card>

    <ErrorState v-if="error && !loaded" :error="loadFailure" data-testid="runners-error" @retry="load" />
    <v-card v-else-if="!loaded" data-testid="runners-loading"><SkeletonList :rows="4" /></v-card>
    <template v-else>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="runners-error">{{ error }}</v-alert>
      <EmptyState v-if="!rows.length" icon="mdi-server-network-outline" :title="t('runners.empty')" :text="t('runners.emptyText')" data-testid="runners-empty">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="createOpen = true">{{ t('runners.create') }}</v-btn>
      </EmptyState>
      <v-card v-else>
        <v-table v-if="!stacked" class="runners-table" data-testid="runners-table">
          <thead>
            <tr>
              <th>{{ t('runners.col.name') }}</th>
              <th>{{ t('runners.col.owner') }}</th>
              <th>{{ t('runners.col.accountType') }}</th>
              <th>{{ t('runners.col.capabilities') }}</th>
              <th>{{ t('runners.col.lastSeen') }}</th>
              <th class="text-right">{{ t('runners.col.activeRuns') }}</th>
              <th>{{ t('runners.col.status') }}</th>
              <th><span class="d-sr-only">{{ t('runners.col.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" data-testid="runner-row" :data-name="r.name" :class="{ 'runner-row--revoked': r.revokedAt }">
              <td class="runners-table__name">
                <div class="font-weight-medium">{{ r.name }}</div>
                <div class="text-caption text-medium-emphasis">{{ t(`runners.kind.${r.kind}`) }} · {{ t(`runners.mode.${r.mode}`) }}</div>
              </td>
              <td class="text-body-2">{{ r.ownerName }}</td>
              <td class="text-body-2">{{ t(`runners.accountType.${r.accountType}`) }}</td>
              <td>
                <div class="d-flex flex-wrap ga-1">
                  <v-chip v-for="c in r.capabilities" :key="c" size="x-small" variant="outlined">{{ t(`runners.capability.${c}`) }}</v-chip>
                </div>
              </td>
              <td class="text-body-2 text-medium-emphasis text-no-wrap">
                <span v-if="r.lastSeenAt" :title="fmt(r.lastSeenAt)">{{ relative(r.lastSeenAt) }}</span>
                <span v-else>{{ t('runners.never') }}</span>
              </td>
              <td class="text-right" data-testid="runner-active-runs">{{ r.activeRuns }}</td>
              <td data-testid="runner-status">
                <div class="d-flex flex-wrap ga-1">
                  <StatusChip kind="runner" :value="runnerStatus(r)" size="x-small" />
                  <v-chip v-if="!r.revokedAt && outsideHours(r)" size="x-small" variant="outlined" prepend-icon="mdi-clock-outline" data-testid="runner-outside-hours">{{ t('runners.outsideHours') }}</v-chip>
                </div>
              </td>
              <td class="text-right text-no-wrap">
                <template v-if="!r.revokedAt">
                  <v-btn
                    size="small"
                    variant="text"
                    color="primary"
                    :data-testid="r.paused ? 'runner-resume' : 'runner-pause'"
                    @click="ask(r, r.paused ? 'resume' : 'pause')"
                  >{{ r.paused ? t('runners.resume') : t('runners.pause') }}</v-btn>
                  <v-menu location="bottom end">
                    <template #activator="{ props: act }">
                      <v-btn v-bind="act" icon="mdi-dots-horizontal" size="small" variant="text" :aria-label="t('runners.more', { name: r.name })" data-testid="runner-more" />
                    </template>
                    <v-list density="compact">
                      <v-list-item base-color="error" prepend-icon="mdi-cancel" :title="t('runners.revokeMenu')" data-testid="runner-revoke" @click="ask(r, 'revoke')" />
                    </v-list>
                  </v-menu>
                </template>
              </td>
            </tr>
          </tbody>
        </v-table>
        <ul v-else class="runners-stack" data-testid="runners-table">
          <li v-for="r in rows" :key="r.id" data-testid="runner-row" :data-name="r.name" :class="{ 'runner-row--revoked': r.revokedAt }">
            <div class="d-flex align-start ga-2">
              <div class="flex-grow-1 min-w-0">
                <div class="font-weight-medium">{{ r.name }}</div>
                <div class="text-caption text-medium-emphasis">{{ r.ownerName }} · {{ t(`runners.kind.${r.kind}`) }} · {{ t(`runners.mode.${r.mode}`) }}</div>
              </div>
              <StatusChip kind="runner" :value="runnerStatus(r)" size="x-small" data-testid="runner-status" />
            </div>
            <div class="runners-stack__meta text-caption text-medium-emphasis">
              <span v-for="c in r.capabilities" :key="c">{{ t(`runners.capability.${c}`) }}</span>
              <span>{{ r.lastSeenAt ? relative(r.lastSeenAt) : t('runners.never') }}</span>
              <span>{{ t('runners.col.activeRuns') }} <span data-testid="runner-active-runs">{{ r.activeRuns }}</span></span>
              <span v-if="!r.revokedAt && outsideHours(r)" data-testid="runner-outside-hours">{{ t('runners.outsideHours') }}</span>
            </div>
            <div v-if="!r.revokedAt" class="runners-stack__actions">
              <v-btn size="small" variant="outlined" :data-testid="r.paused ? 'runner-resume' : 'runner-pause'" @click="ask(r, r.paused ? 'resume' : 'pause')">{{ r.paused ? t('runners.resume') : t('runners.pause') }}</v-btn>
              <v-btn size="small" variant="text" color="error" data-testid="runner-revoke" @click="ask(r, 'revoke')">{{ t('runners.revokeMenu') }}</v-btn>
            </div>
          </li>
        </ul>
      </v-card>
    </template>

    <RunnerDialog v-if="me" v-model="createOpen" :is-admin="isAdmin" :me-id="me.id" @created="load" />

    <ConfirmDialog
      v-model="confirmOpen"
      :title="confirm ? t(`runners.confirm.${confirm.action}Title`, { name: confirm.runner.name }) : ''"
      :text="confirm ? t(`runners.confirm.${confirm.action}Text`) : ''"
      :confirm-label="confirm ? t(`runners.${confirm.action}`) : ''"
      :cancel-label="t('runners.keep')"
      :destructive="confirm?.action === 'revoke'"
      :busy="busy"
      :error="confirmError"
      confirm-testid="runner-confirm-btn"
      data-testid="runner-confirm"
      @confirm="confirmAction"
    />
  </div>
</template>

<style scoped>
.runners-intro { display: block; max-width: 760px; }
.settings-toggle { width: 100%; background: none; border: 0; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); cursor: pointer; text-align: left; font: inherit; color: inherit; }
.settings-toggle[aria-expanded='false'] { border-bottom: 0; }
.settings-grid { display: grid; grid-template-columns: 240px minmax(0, 640px); gap: 16px 24px; align-items: start; }
@media (max-width: 767px) { .settings-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
.runners-table :deep(th) { white-space: nowrap; }
.runners-table__name { min-width: 200px; padding-top: 8px !important; padding-bottom: 8px !important; }
.runner-row--revoked { opacity: .6; }
.runners-stack { list-style: none; margin: 0; padding: 0; }
.runners-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; overflow-wrap: anywhere; }
.runners-stack li:first-child { border-top: 0; }
.runners-stack__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
.runners-stack__actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.min-w-0 { min-width: 0; }
</style>
