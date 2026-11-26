<script setup lang="ts">
import type { LocalSession } from '@yoda/shared'
import { computed, ref, useI18n } from '#imports'
import { TOKEN_GROUPS, setupError, tokenComplete, tokenValue, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'
import TokenInput from './TokenInput.vue'

/**
 * Step 0 (proposal §4.2, §8.2, mockup `installer-token.html`): the setup token from core's log exchanges for a
 * setup session. Over plain HTTP it says so and recommends an SSH tunnel or HTTPS (D8).
 */
const props = defineProps<{ api: SetupFetcher; https: boolean }>()
const emit = defineEmits<{ session: [session: LocalSession] }>()
const { t } = useI18n()
const groups = ref<string[]>(Array.from({ length: TOKEN_GROUPS }, () => ''))
const busy = ref(false)
const error = ref('')
const complete = computed(() => tokenComplete(groups.value))

async function start() {
  if (!complete.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await props.api<LocalSession>('/session', { method: 'POST', body: { token: tokenValue(groups.value) } })
    emit('session', session)
  } catch (e) {
    const m = setupError(e)
    error.value = t(m.key, m.named ?? {})
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <StepFrame :kicker="t('setup.token.kicker')" :title="t('setup.token.title')" :lead="t('setup.token.lead')" bare>
    <label class="setup-label" for="setup-token-0">{{ t('setup.token.label') }}</label>
    <TokenInput v-model="groups" @submit="start" />
    <p class="setup-help">{{ t('setup.token.help') }}</p>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert" data-testid="setup-token-error">{{ error }}</v-alert>

    <h2 class="setup-subhead mt-6">{{ t('setup.token.whereTitle') }}</h2>
    <ol class="setup-how">
      <li>{{ t('setup.token.where1') }}</li>
    </ol>
    <pre class="setup-term" :aria-label="t('setup.token.termLabel')"><span class="setup-term__dim">$</span> docker compose exec core yoda-admin setup-token</pre>
    <ol class="setup-how" start="2">
      <li>{{ t('setup.token.where2') }} <code>docker compose logs core | grep -A3 "Yoda setup"</code></li>
    </ol>

    <v-alert v-if="!https" type="warning" variant="tonal" density="compact" icon="mdi-lock-open-alert-outline" class="mt-4" data-testid="setup-insecure">
      <div class="font-weight-medium">{{ t('setup.insecure.title') }}</div>
      <div>{{ t('setup.insecure.token') }} <code>ssh -L 3000:127.0.0.1:3000 yoda-host</code></div>
    </v-alert>

    <div class="setup-token-foot">
      <span class="setup-help"><v-icon icon="mdi-shield-lock-outline" size="15" aria-hidden="true" /> {{ t('setup.token.limit') }}</span>
      <v-btn color="primary" variant="flat" append-icon="mdi-arrow-right" :disabled="!complete" :loading="busy" data-testid="setup-token-submit" @click="start">{{ t('setup.token.submit') }}</v-btn>
    </div>
  </StepFrame>
</template>

<style scoped>
.setup-token-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; justify-content: space-between; margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
