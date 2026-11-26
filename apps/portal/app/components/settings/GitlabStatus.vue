<script setup lang="ts">
import type { GitLabStatus } from '@yoda/shared'

/** The GitLab connection status (formerly Admin → GitLab): configured, reachable, bot user, last webhook. */
const props = defineProps<{ refresh: number }>()
const { t } = useI18n()
const api = useApi()
const { dateTime: fmt, relative } = useDateFormat()
const status = ref<GitLabStatus | null>(null)
const failure = ref<unknown>(null)
const yesNo = (v: boolean | null) => (v === null ? t('gitlab.admin.unknown') : t(v ? 'gitlab.admin.yes' : 'gitlab.admin.no'))

async function load() {
  try {
    status.value = await api<GitLabStatus>('/admin/gitlab')
    failure.value = null
  } catch (e) {
    failure.value = e
  }
}
watch(() => props.refresh, load, { immediate: true })
</script>

<template>
  <v-card class="mb-4" data-testid="admin-gitlab">
    <div class="card-head">
      <h2>{{ t('gitlab.admin.connection') }}</h2>
      <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-refresh" data-testid="gitlab-refresh" @click="load">{{ t('gitlab.admin.check') }}</v-btn>
    </div>
    <ErrorState v-if="failure && !status" :error="failure" data-testid="gitlab-error" @retry="load" />
    <SkeletonList v-else-if="!status" :rows="2" quiet />
    <template v-else>
      <v-alert v-if="!status.configured" type="info" variant="tonal" density="compact" class="ma-4 mb-0" data-testid="gitlab-not-connected">{{ t('gitlab.notConnected') }}</v-alert>
      <dl class="card-body status-grid" data-testid="gitlab-status">
        <dt>{{ t('gitlab.admin.configured') }}</dt>
        <dd data-testid="gitlab-configured"><StatusChip kind="yesNo" :value="status.configured ? 'yes' : 'no'" :label="yesNo(status.configured)" /></dd>
        <dt>{{ t('gitlab.admin.reachable') }}</dt>
        <dd data-testid="gitlab-reachable">
          <StatusChip v-if="status.reachable !== null" kind="yesNo" :value="status.reachable ? 'yes' : 'no'" :label="yesNo(status.reachable)" />
          <span v-else class="text-medium-emphasis">{{ yesNo(null) }}</span>
        </dd>
        <dt>{{ t('gitlab.admin.botUser') }}</dt>
        <dd data-testid="gitlab-bot">{{ status.botUsername ?? t('gitlab.admin.unknown') }}</dd>
        <dt>{{ t('gitlab.admin.lastWebhook') }}</dt>
        <dd data-testid="gitlab-last-webhook">
          <span v-if="status.lastWebhookAt">{{ fmt(status.lastWebhookAt) }} <span class="text-medium-emphasis">({{ relative(status.lastWebhookAt) }})</span></span>
          <span v-else class="text-medium-emphasis">{{ t('gitlab.admin.never') }}</span>
        </dd>
      </dl>
    </template>
  </v-card>
</template>

<style scoped>
.status-grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 12px 24px; align-items: center; margin: 0; }
.status-grid dt { font-size: .875rem; font-weight: 500; }
.status-grid dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
@media (max-width: 767px) { .status-grid { grid-template-columns: minmax(0, 1fr); gap: 4px; } .status-grid dd { margin-bottom: 8px; } }
</style>
