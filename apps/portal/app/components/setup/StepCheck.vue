<script setup lang="ts">
import type { SettingsCategoryView, SettingsTestResult } from '@yoda/shared'
import { onMounted, ref, useI18n } from '#imports'
import CategorySection from '~/components/settings/CategorySection.vue'
import TestResult from '~/components/settings/TestResult.vue'
import { setupError, type SetupFetcher } from '~/utils/setup'
import ProxyStatusCard from './ProxyStatusCard.vue'
import StepFrame from './StepFrame.vue'

/**
 * Step 3 (proposal §4.2, D9): a read-only system check: the database (and pgvector), the storage bucket and the
 * job queue. The storage settings come from the install host's env or bootstrap volume and are shown read-only, as
 * is the built-in HTTPS proxy's status (on or off, its certificate).
 */
const props = defineProps<{ api: SetupFetcher; storage: SettingsCategoryView | null }>()
const emit = defineEmits<{ back: []; next: [] }>()
const { t } = useI18n()
const result = ref<SettingsTestResult | null>(null)
const busy = ref(false)
const error = ref('')
const proxy = ref<InstanceType<typeof ProxyStatusCard> | null>(null)

async function run() {
  busy.value = true
  error.value = ''
  try {
    result.value = await props.api<SettingsTestResult>('/check', { method: 'POST' })
  } catch (e) {
    const m = setupError(e)
    error.value = t(m.key, m.named ?? {})
  } finally {
    busy.value = false
  }
}
onMounted(run)
/** "Check again" also asks the proxy card again (it loads itself once on mount). */
function again() {
  void proxy.value?.load()
  void run()
}
</script>

<template>
  <StepFrame
    :kicker="t('setup.check.kicker')"
    :title="t('setup.check.title')"
    :lead="t('setup.check.lead')"
    :hint="result && !result.ok ? t('setup.check.failedHint') : t('setup.check.hint')"
    back
    :next-label="t('setup.nav.nextTo', { step: t('setup.step.signin') })"
    @back="emit('back')"
    @next="emit('next')"
  >
    <div class="d-flex align-center flex-wrap ga-3 mb-3">
      <h2 class="setup-subhead flex-grow-1 mb-0">{{ t('setup.check.results') }}</h2>
      <v-btn variant="tonal" color="primary" prepend-icon="mdi-refresh" :loading="busy" data-testid="setup-check-run" @click="again">{{ t('setup.check.again') }}</v-btn>
    </div>
    <v-progress-linear v-if="busy && !result" indeterminate color="primary" />
    <TestResult v-if="result" :result="result" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3" role="alert" data-testid="setup-check-error">{{ error }}</v-alert>

    <ProxyStatusCard ref="proxy" class="mt-6" :api="api" />

    <CategorySection
      v-if="storage"
      class="mt-6"
      category="storage"
      :view="storage"
      :title="t('settings.category.storage')"
      icon="mdi-database-outline"
      :client="api"
      base-path="/settings"
    />
  </StepFrame>
</template>
