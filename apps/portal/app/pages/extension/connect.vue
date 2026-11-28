<script setup lang="ts">
import type { ExtensionAuthorizeResponse } from '@yoda/shared'
import { cancelUrl, parseConnectQuery } from '~/utils/extensionConnect'

/**
 * The approve page Yoda Reporter opens with `launchWebAuthFlow` (proposal §7.3). Approving mints a one-minute
 * code for the extension's own `chromiumapp.org` redirect; nothing here is framed (`frame-ancestors 'none'`).
 */
definePageMeta({ crumbs: [{ key: 'extension.connect.title' }] })
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const parsed = computed(() => parseConnectQuery(route.query))
const origin = typeof window === 'undefined' ? '' : window.location.origin
const busy = ref(false)
const error = ref('')
const done = ref(false)

const badQuery = computed(() => (parsed.value.ok ? '' : t('extension.connect.badQuery')))

async function approve() {
  if (!parsed.value.ok || busy.value) return
  const q = parsed.value.value
  busy.value = true
  error.value = ''
  try {
    const res = await api<ExtensionAuthorizeResponse>('/extension/authorize', {
      method: 'POST',
      body: { extensionId: q.ext, redirectUri: q.redirectUri, codeChallenge: q.codeChallenge, codeChallengeMethod: 'S256', state: q.state, browserLabel: q.browser },
    })
    done.value = true
    // Back to the extension's auth window; replace, so Back never offers this page with a used request again.
    window.location.replace(res.redirectTo)
  } catch (e) {
    const reason = (e as { data?: { reason?: string } })?.data?.reason
    error.value = reason === 'extension_not_allowed' ? t('extension.connect.notAllowed') : reason === 'not_staff' ? t('extension.connect.notStaff') : t('extension.connect.failed')
  } finally {
    busy.value = false
  }
}

function cancel() {
  if (!parsed.value.ok) return
  window.location.replace(cancelUrl(parsed.value.value.redirectUri, parsed.value.value.state))
}
</script>

<template>
  <div class="connect" data-testid="extension-connect">
    <PageHeader :title="t('extension.connect.title')" />
    <v-card class="connect__card">
      <div class="card-body">
        <p class="text-body-1 mb-4">{{ t('extension.connect.intro') }}</p>
        <div class="connect__origin" data-testid="connect-origin">
          <div class="text-caption text-medium-emphasis">{{ t('extension.connect.origin') }}</div>
          <div class="text-h5 connect__mono">Yoda · {{ origin }}</div>
        </div>
        <v-alert v-if="badQuery" type="error" variant="tonal" class="mt-4" data-testid="connect-error">{{ badQuery }}</v-alert>
        <template v-else-if="parsed.ok">
          <dl class="connect__facts mt-4">
            <dt class="text-medium-emphasis">{{ t('extension.connect.browser') }}</dt>
            <dd data-testid="connect-browser">{{ parsed.value.browser }}</dd>
            <dt class="text-medium-emphasis">{{ t('extension.connect.extensionId') }}</dt>
            <dd class="connect__mono" data-testid="connect-ext">{{ parsed.value.ext }}</dd>
          </dl>
          <p class="text-subtitle-2 mt-4 mb-1">{{ t('extension.connect.mayDo') }}</p>
          <ul class="connect__list text-body-2">
            <li>{{ t('extension.connect.mayReport') }}</li>
            <li>{{ t('extension.connect.mayListProjects') }}</li>
          </ul>
          <v-alert v-if="error" type="error" variant="tonal" class="mt-4" data-testid="connect-error">{{ error }}</v-alert>
          <v-alert v-else-if="done" type="success" variant="tonal" class="mt-4" data-testid="connect-done">{{ t('extension.connect.done') }}</v-alert>
          <v-alert type="warning" variant="tonal" density="compact" class="mt-4" icon="mdi-shield-alert-outline" data-testid="connect-warning">
            {{ t('extension.connect.onlyAfterConnect') }}
          </v-alert>
        </template>
      </div>
      <div v-if="parsed.ok" class="connect__actions">
        <v-btn variant="text" :disabled="busy || done" autofocus data-testid="connect-cancel" @click="cancel">{{ t('extension.connect.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" :disabled="done" data-testid="connect-approve" @click="approve">{{ t('extension.connect.approve') }}</v-btn>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.connect { max-width: 640px; margin: 0 auto; }
.connect__mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap: anywhere; }
.connect__facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.connect__facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.connect__list { margin: 0; padding-left: 20px; }
.connect__actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
