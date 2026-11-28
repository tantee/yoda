<script setup lang="ts">
import type { ExtensionLatest } from '@yoda/shared'
import CopyField from '~/components/settings/CopyField.vue'

/** Help: Yoda Reporter, the browser extension that files defects (plan A12): download, install, connect, privacy. */
const { t } = useI18n()
const api = useApi()
const { config } = usePublicConfig()
const latest = ref<ExtensionLatest>(null)
const loaded = ref(false)
const origin = typeof window === 'undefined' ? '' : window.location.origin
const enabled = computed(() => config.value?.extension?.enabled !== false)
const mediaDays = computed(() => config.value?.extension?.mediaRetentionDays ?? 180)
const logDays = computed(() => config.value?.extension?.logRetentionDays ?? 90)
const keep = (days: number) => (days > 0 ? t('help.reporter.keepDays', { n: days }) : t('help.reporter.keepForever'))

onMounted(async () => {
  try {
    latest.value = enabled.value ? await api<ExtensionLatest>('/extension/latest') : null
  } catch {
    latest.value = null
  } finally {
    loaded.value = true
  }
})
</script>

<template>
  <div class="help" data-testid="help-page">
    <PageHeader :title="t('help.title')" />
    <v-card class="mb-4" data-testid="help-reporter">
      <div class="card-head"><h2>{{ t('help.reporter.title') }}</h2></div>
      <div class="card-body">
        <p class="text-body-1">{{ t('help.reporter.what') }}</p>
        <v-alert v-if="!enabled" type="info" variant="tonal" class="mb-4" data-testid="help-disabled">{{ t('help.reporter.disabled') }}</v-alert>
        <template v-else>
          <h3 class="text-subtitle-1 mt-4 mb-2">{{ t('help.reporter.download') }}</h3>
          <div v-if="latest" class="d-flex flex-wrap ga-2 align-center">
            <v-btn color="primary" :href="latest.zipUrl" prepend-icon="mdi-download" data-testid="help-download">{{ t('help.reporter.downloadZip', { v: latest.version }) }}</v-btn>
          </div>
          <p v-else-if="loaded" class="text-body-2 text-medium-emphasis" data-testid="help-no-download">
            {{ t('help.reporter.notAvailable') }} <code>pnpm --filter @yoda/extension build:zip</code>
          </p>

          <h3 class="text-subtitle-1 mt-6 mb-2">{{ t('help.reporter.install') }}</h3>
          <ol class="help__steps text-body-2" data-testid="help-install">
            <li>{{ t('help.reporter.step1') }}</li>
            <li>{{ t('help.reporter.step2') }} <code>chrome://extensions</code> / <code>edge://extensions</code></li>
            <li>{{ t('help.reporter.step3') }}</li>
            <li>{{ t('help.reporter.step4') }}</li>
          </ol>

          <h3 class="text-subtitle-1 mt-6 mb-2">{{ t('help.reporter.connect') }}</h3>
          <p class="text-body-2">{{ t('help.reporter.connectText') }}</p>
          <CopyField :label="t('help.reporter.address')" :value="origin" testid="help-address" />

          <h3 class="text-subtitle-1 mt-6 mb-2">{{ t('help.reporter.privacy') }}</h3>
          <ul class="help__steps text-body-2" data-testid="help-privacy">
            <li>{{ t('help.reporter.noMasking') }}</li>
            <li>{{ t('help.reporter.noAi') }}</li>
            <li>{{ t('help.reporter.retention', { media: keep(mediaDays), logs: keep(logDays) }) }}</li>
            <li>{{ t('help.reporter.production') }}</li>
          </ul>
        </template>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.help { max-width: 860px; }
.help__steps { padding-left: 20px; margin: 0; }
.help__steps li + li { margin-top: 4px; }
code { overflow-wrap: anywhere; }
</style>
