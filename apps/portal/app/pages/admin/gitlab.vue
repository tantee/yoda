<script setup lang="ts">
import type { GitLabStatus } from '@yoda/shared'

const { t, locale } = useI18n()
const api = useApi()
const status = ref<GitLabStatus | null>(null)
const error = ref('')

// GitLab posts to the portal; its /api proxy forwards the X-Gitlab-* headers and the raw body to core.
const webhookUrl = computed(() => `${window.location.origin}/api/gitlab/webhook`)
const yesNo = (v: boolean | null) => (v === null ? t('gitlab.admin.unknown') : t(v ? 'gitlab.admin.yes' : 'gitlab.admin.no'))
const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')

async function load() {
  try {
    status.value = await api<GitLabStatus>('/admin/gitlab')
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(webhookUrl.value)
  } catch {
    // the URL stays visible to copy by hand
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-gitlab">
    <h1 class="text-h5 mb-4">{{ t('gitlab.admin.title') }}</h1>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="gitlab-error">{{ error }}</v-alert>
    <v-alert v-if="status && !status.configured" type="info" variant="tonal" class="mb-4" data-testid="gitlab-not-connected">{{ t('gitlab.notConnected') }}</v-alert>
    <v-table v-if="status" class="mb-6" style="max-width: 640px" data-testid="gitlab-status">
      <tbody>
        <tr>
          <td>{{ t('gitlab.admin.configured') }}</td>
          <td data-testid="gitlab-configured">{{ yesNo(status.configured) }}</td>
        </tr>
        <tr>
          <td>{{ t('gitlab.admin.reachable') }}</td>
          <td data-testid="gitlab-reachable">
            <v-chip v-if="status.reachable !== null" size="small" :color="status.reachable ? 'success' : 'error'">{{ yesNo(status.reachable) }}</v-chip>
            <template v-else>{{ yesNo(null) }}</template>
          </td>
        </tr>
        <tr>
          <td>{{ t('gitlab.admin.botUser') }}</td>
          <td data-testid="gitlab-bot">{{ status.botUsername ?? t('gitlab.admin.unknown') }}</td>
        </tr>
        <tr>
          <td>{{ t('gitlab.admin.lastWebhook') }}</td>
          <td data-testid="gitlab-last-webhook">{{ status.lastWebhookAt ? fmt(status.lastWebhookAt) : t('gitlab.admin.never') }}</td>
        </tr>
      </tbody>
    </v-table>

    <h2 class="text-subtitle-1 mb-2">{{ t('gitlab.admin.webhookUrl') }}</h2>
    <div class="d-flex ga-2 align-center mb-2" style="max-width: 640px">
      <v-text-field :model-value="webhookUrl" readonly hide-details density="compact" data-testid="gitlab-webhook-url" />
      <v-btn variant="outlined" prepend-icon="mdi-content-copy" @click="copy">{{ t('gitlab.admin.copy') }}</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis" style="max-width: 640px">{{ t('gitlab.admin.webhookHint') }}</p>
  </div>
</template>
