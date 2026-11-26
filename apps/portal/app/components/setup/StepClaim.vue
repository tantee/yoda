<script setup lang="ts">
import type { OidcSignInStart, SetupClaimResult, SetupProgress } from '@yoda/shared'
import { computed, ref, useI18n } from '#imports'
import TestResult from '~/components/settings/TestResult.vue'
import { setupError, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'

/**
 * Step 10 (proposal §4.2, §7.2, §8.1): sign in through Keycloak to become the first portal administrator. The
 * sign-in is a real one (PKCE, the portal's client) and checks what core will check of every token; the person
 * who signs in is made an admin. Finishing locks setup: every /setup route is gone, the setup session ends, and
 * the portal opens normally (signed in already, through the same Keycloak session).
 */
const props = defineProps<{ api: SetupFetcher; progress: SetupProgress; result: SetupClaimResult | null; callbackBusy: boolean }>()
const emit = defineEmits<{ back: []; finished: [] }>()
const { t } = useI18n()
const busy = ref('')
const error = ref('')
const claimed = computed(() => props.progress.claimed)
const missing = computed(() => props.progress.missing.filter(s => s !== 'claim'))

async function signIn() {
  busy.value = 'signin'
  error.value = ''
  try {
    const r = await props.api<OidcSignInStart>('/claim/start', { method: 'POST' })
    window.location.assign(r.authorizeUrl)
  } catch (e) {
    const m = setupError(e)
    error.value = t(m.key, m.named ?? {})
    busy.value = ''
  }
}

async function finish() {
  busy.value = 'finish'
  error.value = ''
  try {
    await props.api('/complete', { method: 'POST' })
    emit('finished')
  } catch (e) {
    const m = setupError(e)
    error.value = t(m.key, m.named ?? {})
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <StepFrame
    :kicker="t('setup.claim.kicker')"
    :title="t('setup.claim.title')"
    :lead="t('setup.claim.lead')"
    :hint="claimed ? t('setup.claim.lockHint') : t('setup.claim.hint')"
    hint-icon="mdi-lock-check-outline"
    back
    :next-label="t('setup.claim.finish')"
    :next-disabled="!claimed || missing.length > 0"
    :busy="busy === 'finish'"
    @back="emit('back')"
    @next="finish"
  >
    <v-progress-linear v-if="callbackBusy" indeterminate color="primary" class="mb-4" />
    <v-alert v-if="claimed" type="success" variant="tonal" density="compact" class="mb-4" data-testid="setup-claimed">{{ t('setup.claim.claimed', { username: claimed.username }) }}</v-alert>
    <template v-else>
      <p class="text-body-2 mb-4">{{ t('setup.claim.how') }}</p>
      <v-btn color="primary" variant="flat" prepend-icon="mdi-login" :loading="busy === 'signin'" :disabled="callbackBusy" data-testid="setup-claim-signin" @click="signIn">{{ t('setup.claim.signIn') }}</v-btn>
    </template>
    <TestResult v-if="result" :result="{ action: 'oidc', ok: result.ok, checks: result.checks }" class="mt-4" />
    <v-btn v-if="claimed" variant="text" size="small" class="px-0 mt-2" :loading="busy === 'signin'" data-testid="setup-claim-again" @click="signIn">{{ t('setup.claim.again') }}</v-btn>

    <v-alert v-if="missing.length" type="info" variant="tonal" density="compact" class="mt-4" data-testid="setup-claim-missing">
      {{ t('setup.claim.missing', { steps: missing.map(s => t(`setup.step.${s}`)).join(', ') }) }}
    </v-alert>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert" data-testid="setup-claim-error">{{ error }}</v-alert>
  </StepFrame>
</template>
