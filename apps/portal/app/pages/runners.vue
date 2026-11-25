<script setup lang="ts">
import type { Runner, RunnerSettings } from '@yoda/shared'
import { withinHours } from '~/utils/runners'

const { t } = useI18n()
const { me } = useMe()
const api = useApi()
const docsUrl = useRuntimeConfig().public.runnerDocsUrl as string

const isAdmin = computed(() => !!me.value?.isAdmin)
const view = ref<'mine' | 'all'>('mine')
const runners = ref<Runner[]>([])
const loaded = ref(false)
const settings = ref<RunnerSettings | null>(null)
const error = ref('')
const settingsError = ref('')
const busy = ref(false)
const createOpen = ref(false)
const confirm = ref<{ runner: Runner; action: 'pause' | 'resume' | 'revoke' } | null>(null)
const now = ref(new Date())

const { dateTime: fmt } = useDateFormat()
const outsideHours = (r: Runner) => r.mode === 'unattended' && !withinHours(r.workingHours, now.value)

async function load() {
  try {
    runners.value = await api<Runner[]>('/runners', { query: view.value === 'all' && isAdmin.value ? { all: '1' } : {} })
    now.value = new Date()
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    loaded.value = true
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

async function confirmAction() {
  const c = confirm.value
  if (!c) return
  error.value = ''
  busy.value = true
  try {
    if (c.action === 'revoke') await api(`/runners/${c.runner.id}`, { method: 'DELETE' })
    else await api(`/runners/${c.runner.id}`, { method: 'PATCH', body: { paused: c.action === 'pause' } })
    confirm.value = null
  } catch (e) {
    error.value = t(errorKey(e))
    confirm.value = null
  } finally {
    busy.value = false
  }
  await load()
}

watch(view, load)
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
    <div class="d-flex align-center mb-2">
      <h1 class="text-h5">{{ t('runners.title') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" data-testid="runner-create" @click="createOpen = true">{{ t('runners.create') }}</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mb-4" style="max-width: 760px">
      {{ t('runners.intro') }}
      <a :href="docsUrl" target="_blank" rel="noopener" data-testid="runner-docs">{{ t('runners.docs') }}</a>
    </p>

    <v-card v-if="isAdmin && settings" variant="outlined" class="mb-6" style="max-width: 760px" data-testid="runner-settings">
      <v-card-title class="text-subtitle-1">{{ t('runners.settings.title') }}</v-card-title>
      <v-card-text>
        <v-alert v-if="settingsError" type="error" density="compact" class="mb-2">{{ settingsError }}</v-alert>
        <v-switch
          :model-value="settings.paused"
          :label="t('runners.settings.pauseAll')"
          color="warning"
          hide-details
          data-testid="runner-pause-all"
          @update:model-value="v => saveSetting({ paused: !!v })"
        />
        <p class="text-caption text-medium-emphasis mb-4">{{ t('runners.settings.pauseAllHint') }}</p>
        <v-switch
          :model-value="settings.allowPersonalUnattended"
          :label="t('runners.settings.allowPersonalUnattended')"
          color="primary"
          hide-details
          data-testid="runner-allow-personal"
          @update:model-value="v => saveSetting({ allowPersonalUnattended: !!v })"
        />
        <v-alert type="warning" variant="tonal" density="compact" class="mt-2" data-testid="runner-personal-caveat">{{ t('runners.settings.personalCaveat') }}</v-alert>
      </v-card-text>
    </v-card>

    <v-btn-toggle v-if="isAdmin" v-model="view" mandatory density="compact" variant="outlined" class="mb-3" data-testid="runner-view">
      <v-btn value="mine">{{ t('runners.mine') }}</v-btn>
      <v-btn value="all" data-testid="runner-view-all">{{ t('runners.all') }}</v-btn>
    </v-btn-toggle>

    <v-alert v-if="error" type="error" class="mb-4" data-testid="runners-error">{{ error }}</v-alert>
    <v-progress-linear v-if="!loaded" indeterminate class="mb-4" data-testid="runners-loading" />
    <p v-else-if="!runners.length && !error" class="text-medium-emphasis" data-testid="runners-empty">{{ t('runners.empty') }}</p>
    <v-table v-else-if="runners.length" density="compact" class="text-no-wrap" data-testid="runners-table">
      <thead>
        <tr>
          <th>{{ t('runners.col.name') }}</th>
          <th>{{ t('runners.col.kind') }}</th>
          <th>{{ t('runners.col.owner') }}</th>
          <th>{{ t('runners.col.accountType') }}</th>
          <th>{{ t('runners.col.mode') }}</th>
          <th>{{ t('runners.col.capabilities') }}</th>
          <th>{{ t('runners.col.lastSeen') }}</th>
          <th>{{ t('runners.col.activeRuns') }}</th>
          <th>{{ t('runners.col.status') }}</th>
          <th>{{ t('runners.col.actions') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in runners" :key="r.id" data-testid="runner-row" :data-name="r.name">
          <td class="font-weight-medium">{{ r.name }}</td>
          <td>{{ t(`runners.kind.${r.kind}`) }}</td>
          <td>{{ r.ownerName }}</td>
          <td>{{ t(`runners.accountType.${r.accountType}`) }}</td>
          <td>{{ t(`runners.mode.${r.mode}`) }}</td>
          <td>
            <v-chip v-for="c in r.capabilities" :key="c" size="x-small" class="mr-1">{{ t(`runners.capability.${c}`) }}</v-chip>
          </td>
          <td>{{ r.lastSeenAt ? fmt(r.lastSeenAt) : t('runners.never') }}</td>
          <td data-testid="runner-active-runs">{{ r.activeRuns }}</td>
          <td data-testid="runner-status">
            <StatusChip kind="runner" :value="r.revokedAt ? 'revoked' : r.paused ? 'paused' : 'active'" size="x-small" />
            <v-chip v-if="!r.revokedAt && outsideHours(r)" size="x-small" variant="outlined" class="ml-1" data-testid="runner-outside-hours">{{ t('runners.outsideHours') }}</v-chip>
          </td>
          <td class="text-no-wrap">
            <template v-if="!r.revokedAt">
              <v-btn
                size="small"
                variant="text"
                :data-testid="r.paused ? 'runner-resume' : 'runner-pause'"
                @click="confirm = { runner: r, action: r.paused ? 'resume' : 'pause' }"
              >{{ r.paused ? t('runners.resume') : t('runners.pause') }}</v-btn>
              <v-btn size="small" variant="text" color="error" data-testid="runner-revoke" @click="confirm = { runner: r, action: 'revoke' }">{{ t('runners.revoke') }}</v-btn>
            </template>
          </td>
        </tr>
      </tbody>
    </v-table>

    <RunnerDialog v-if="me" v-model="createOpen" :is-admin="isAdmin" :me-id="me.id" @created="load" />

    <v-dialog :model-value="!!confirm" max-width="440" @update:model-value="v => { if (!v) confirm = null }">
      <v-card v-if="confirm" :title="t(`runners.confirm.${confirm.action}Title`)" data-testid="runner-confirm">
        <v-card-text>
          <p class="font-weight-medium mb-2">{{ confirm.runner.name }}</p>
          <p>{{ t(`runners.confirm.${confirm.action}Text`) }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirm = null">{{ t('runners.keep') }}</v-btn>
          <v-btn
            :color="confirm.action === 'revoke' ? 'error' : 'primary'"
            :loading="busy"
            data-testid="runner-confirm-btn"
            @click="confirmAction"
          >{{ t(`runners.${confirm.action}`) }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
