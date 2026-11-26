<script setup lang="ts">
import type { GitLabStatus } from '@yoda/shared'

const { t } = useI18n()
const api = useApi()
const status = ref<GitLabStatus | null>(null)
const error = ref('')
const loadFailure = ref<unknown>(null)
const copied = ref(false)

// GitLab posts to the portal; its /api proxy forwards the X-Gitlab-* headers and the raw body to core.
const webhookUrl = computed(() => `${window.location.origin}/api/gitlab/webhook`)
const yesNo = (v: boolean | null) => (v === null ? t('gitlab.admin.unknown') : t(v ? 'gitlab.admin.yes' : 'gitlab.admin.no'))
const { dateTime: fmt, relative } = useDateFormat()

async function load() {
  try {
    status.value = await api<GitLabStatus>('/admin/gitlab')
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(webhookUrl.value)
    copied.value = true
  } catch {
    // the URL stays visible to copy by hand
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-gitlab">
    <PageHeader :title="t('gitlab.admin.title')" />
    <ErrorState v-if="error && !status" :error="loadFailure" data-testid="gitlab-error" @retry="load" />
    <SkeletonList v-else-if="!status" :rows="3" />
    <template v-else>
      <v-alert v-if="!status.configured" type="info" variant="tonal" density="compact" class="mb-4" data-testid="gitlab-not-connected">{{ t('gitlab.notConnected') }}</v-alert>
      <v-card class="mb-4">
        <div class="card-head">
          <h2>{{ t('gitlab.admin.connection') }}</h2>
          <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-refresh" data-testid="gitlab-refresh" @click="load">{{ t('gitlab.admin.check') }}</v-btn>
        </div>
        <dl class="card-body admin-grid" data-testid="gitlab-status">
          <dt>{{ t('gitlab.admin.configured') }}</dt>
          <dd data-testid="gitlab-configured">
            <StatusChip kind="yesNo" :value="status.configured ? 'yes' : 'no'" :label="yesNo(status.configured)" />
          </dd>
          <dt>{{ t('gitlab.admin.reachable') }}</dt>
          <dd data-testid="gitlab-reachable">
            <StatusChip v-if="status.reachable !== null" kind="yesNo" :value="status.reachable ? 'yes' : 'no'" :label="yesNo(status.reachable)" />
            <span v-else class="text-medium-emphasis">{{ yesNo(null) }}</span>
          </dd>
          <dt>{{ t('gitlab.admin.botUser') }}</dt>
          <dd data-testid="gitlab-bot">{{ status.botUsername ?? t('gitlab.admin.unknown') }}</dd>
          <dt>{{ t('gitlab.admin.lastWebhook') }}</dt>
          <dd data-testid="gitlab-last-webhook">
            <span v-if="status.lastWebhookAt" :title="fmt(status.lastWebhookAt)">{{ fmt(status.lastWebhookAt) }} <span class="text-medium-emphasis">({{ relative(status.lastWebhookAt) }})</span></span>
            <span v-else class="text-medium-emphasis">{{ t('gitlab.admin.never') }}</span>
          </dd>
        </dl>
      </v-card>

      <v-card>
        <div class="card-head"><h2>{{ t('gitlab.admin.webhookTitle') }}</h2></div>
        <div class="card-body admin-grid">
          <label for="webhook-url" class="text-body-2 font-weight-medium">{{ t('gitlab.admin.webhookUrl') }}</label>
          <div class="webhook-row">
            <v-text-field id="webhook-url" :model-value="webhookUrl" readonly hide-details class="webhook-field" data-testid="gitlab-webhook-url" @focus="($event.target as HTMLInputElement).select()" />
            <v-btn :variant="copied ? 'tonal' : 'outlined'" :color="copied ? 'success' : undefined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" data-testid="gitlab-copy" @click="copy">
              {{ copied ? t('runners.copied') : t('gitlab.admin.copy') }}
            </v-btn>
          </div>
          <div class="text-body-2 font-weight-medium">{{ t('gitlab.admin.stepsTitle') }}</div>
          <ol class="webhook-steps text-body-2">
            <li v-for="n in 4" :key="n">{{ t(`gitlab.admin.steps.${n}`) }}</li>
          </ol>
        </div>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.admin-grid { display: grid; grid-template-columns: 200px minmax(0, 680px); gap: 12px 24px; align-items: center; margin: 0; }
.admin-grid dt { font-size: .875rem; font-weight: 500; }
.admin-grid dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
@media (max-width: 767px) { .admin-grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } .admin-grid dd { margin-bottom: 8px; } }
.webhook-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.webhook-field { flex: 1 1 280px; min-width: 0; }
.webhook-field :deep(input) { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
.webhook-steps { padding-left: 20px; margin: 0; display: grid; gap: 4px; align-self: start; }
</style>
