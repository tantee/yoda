<script setup lang="ts">
import type { SettingsTestResult, TelegramWebhookBody } from '@yoda/shared'
import { saveError, type ReauthStash } from '~/utils/settings'
import ConfirmDialog from '../ConfirmDialog.vue'
import CopyField from './CopyField.vue'
import ReauthDialog from './ReauthDialog.vue'
import TestResult from './TestResult.vue'

/**
 * Registers the Telegram webhook with the saved token and secret at `<public URL>/api/webhooks/telegram`.
 * Dropping the updates Telegram still holds is opt-in and confirmed first. It sends the secret, so it needs a
 * recent sign-in like a save.
 */
const props = defineProps<{ url: string; disabled?: boolean }>()
const emit = defineEmits<{ done: [] }>()
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const dropPending = ref(false)
const confirmOpen = ref(false)
const busy = ref(false)
const result = ref<SettingsTestResult | null>(null)
const error = ref('')
const reauthOpen = ref(false)
const stash = ref<ReauthStash | null>(null)

function start() {
  if (dropPending.value) confirmOpen.value = true
  else void register()
}

async function register() {
  busy.value = true
  error.value = ''
  result.value = null
  try {
    const body: TelegramWebhookBody = { dropPending: dropPending.value }
    result.value = await api<SettingsTestResult>('/admin/settings/telegram/webhook', { method: 'POST', body })
    confirmOpen.value = false
    emit('done')
  } catch (e) {
    confirmOpen.value = false
    const err = saveError(e)
    if (err.kind === 'reauth') {
      stash.value = { category: 'telegram', path: route.fullPath, values: {}, clears: [], secretsToRetype: [], action: 'webhook' }
      reauthOpen.value = true
    } else if (err.kind === 'rateLimited') error.value = t('settings.save.rateLimited', { s: err.retryAfter ?? 60 })
    else error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="telegram-webhook" data-testid="telegram-webhook">
    <CopyField :label="t('settings.channels.webhookUrl')" :value="url" testid="telegram-webhook-url" />
    <div class="d-flex flex-wrap align-center ga-3 mt-3">
      <v-btn variant="tonal" color="primary" prepend-icon="mdi-webhook" :loading="busy && !confirmOpen" :disabled="disabled" data-testid="telegram-register" @click="start">{{ t('settings.telegram.register') }}</v-btn>
      <v-checkbox v-model="dropPending" :label="t('settings.telegram.dropPending')" density="compact" hide-details :disabled="disabled" data-testid="telegram-drop-pending" />
    </div>
    <p class="setting-meta">{{ t('settings.telegram.registerHint') }}</p>
    <TestResult v-if="result" :result="result" class="mt-3" />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
    <ConfirmDialog
      v-model="confirmOpen"
      :title="t('settings.telegram.dropTitle')"
      :text="t('settings.telegram.dropText')"
      :confirm-label="t('settings.telegram.dropConfirm')"
      destructive
      :busy="busy"
      confirm-testid="telegram-drop-confirm"
      @confirm="register"
    />
    <ReauthDialog v-model="reauthOpen" :stash="stash" />
  </div>
</template>

<style scoped>
.telegram-webhook { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
