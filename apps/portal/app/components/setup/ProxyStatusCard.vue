<script setup lang="ts">
import type { ProxyStatus } from '@yoda/shared'
import { computed, onMounted, ref, useI18n } from '#imports'
import { formatDateTime } from '~/utils/dates'
import { proxyCertState, type SetupFetcher } from '~/utils/setup'

/**
 * The built-in HTTPS proxy (docs/operations.md, section 4b), read-only: whether it is on, its certificate mode and
 * name, and the certificate it presents (core reads it with a TLS handshake to the proxy, never its files). Off is
 * the default: an external reverse proxy gives the portal HTTPS. Nothing here can be changed in the browser; the
 * proxy is set on the install host (.env, install.sh --with-proxy).
 */
const props = defineProps<{ api: SetupFetcher }>()
const { t, locale } = useI18n()
const status = ref<ProxyStatus | null>(null)
const failed = ref(false)

async function load() {
  failed.value = false
  try {
    status.value = await props.api<ProxyStatus>('/proxy')
  } catch {
    failed.value = true
  }
}
onMounted(load)
defineExpose({ load })

const cert = computed(() => status.value?.certificate ?? null)
const state = computed(() => (status.value ? proxyCertState(status.value, new Date()) : null))
const when = (iso: string) => (iso ? formatDateTime(iso, locale.value) : '—')
</script>

<template>
  <v-card class="proxy-card" data-testid="setup-proxy">
    <div class="card-head">
      <h2 class="d-flex align-center ga-2"><v-icon icon="mdi-shield-lock-outline" size="20" aria-hidden="true" />{{ t('setup.proxy.title') }}</h2>
      <v-chip
        v-if="status"
        size="small"
        variant="tonal"
        :color="status.enabled ? (status.reachable ? 'success' : 'error') : undefined"
        :prepend-icon="status.enabled ? (status.reachable ? 'mdi-lock-check-outline' : 'mdi-lock-alert-outline') : 'mdi-power-plug-off-outline'"
        data-testid="setup-proxy-state"
        :data-enabled="status.enabled"
      >{{ status.enabled ? (status.reachable ? t('setup.proxy.on') : t('setup.proxy.unreachable')) : t('setup.proxy.off') }}</v-chip>
    </div>
    <div class="card-body">
      <v-progress-linear v-if="!status && !failed" indeterminate color="primary" />
      <v-alert v-if="failed" type="warning" variant="tonal" density="compact" data-testid="setup-proxy-error">{{ t('setup.proxy.loadFailed') }}</v-alert>

      <template v-if="status && !status.enabled">
        <p class="mb-0">{{ t('setup.proxy.offLead') }}</p>
        <p class="setup-help">{{ t('setup.proxy.offHow') }} <code>install.sh --with-proxy --domain portal.example.org</code></p>
      </template>

      <template v-if="status && status.enabled">
        <dl class="proxy-facts">
          <div>
            <dt>{{ t('setup.proxy.address') }}</dt>
            <dd><code data-testid="setup-proxy-url">{{ status.publicUrl ?? '—' }}</code></dd>
          </div>
          <div>
            <dt>{{ t('setup.proxy.mode') }}</dt>
            <dd data-testid="setup-proxy-mode">{{ status.certMode ? t(`setup.proxy.modes.${status.certMode}`) : '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('setup.proxy.hops') }}</dt>
            <dd><code>YODA_TRUSTED_PROXY_HOPS={{ status.trustedProxyHops }}</code></dd>
          </div>
          <template v-if="cert">
            <div>
              <dt>{{ t('setup.proxy.issuer') }}</dt>
              <dd data-testid="setup-proxy-issuer">{{ cert.issuer || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('setup.proxy.names') }}</dt>
              <dd>{{ cert.names.join(', ') || cert.subject || '—' }}</dd>
            </div>
            <div>
              <dt>{{ t('setup.proxy.validTo') }}</dt>
              <dd data-testid="setup-proxy-expiry" :data-state="state">{{ when(cert.validTo) }}</dd>
            </div>
          </template>
        </dl>
        <p v-if="cert" class="setup-help proxy-fingerprint">{{ t('setup.proxy.fingerprint') }} <code>{{ cert.fingerprint256 }}</code></p>

        <v-alert v-if="status.invalid.length" type="warning" variant="tonal" density="compact" class="mt-3" data-testid="setup-proxy-invalid">{{ t('setup.proxy.invalid', { names: status.invalid.join(', ') }) }}</v-alert>
        <v-alert v-if="status.trustedProxyHops < 2" type="warning" variant="tonal" density="compact" class="mt-3" data-testid="setup-proxy-hops">{{ t('setup.proxy.hopsLow') }}</v-alert>
        <v-alert v-if="!status.reachable" type="error" variant="tonal" density="compact" class="mt-3" role="alert" data-testid="setup-proxy-unreachable">{{ t('setup.proxy.unreachableHint', { code: status.error ?? 'failed' }) }}</v-alert>
        <v-alert v-else-if="state === 'expired'" type="error" variant="tonal" density="compact" class="mt-3" role="alert">{{ t('setup.proxy.expired') }}</v-alert>
        <v-alert v-else-if="state === 'soon'" type="warning" variant="tonal" density="compact" class="mt-3">{{ t('setup.proxy.expiresSoon') }}</v-alert>
        <p v-if="status.certMode === 'internal'" class="setup-help" data-testid="setup-proxy-trust">{{ t('setup.proxy.internalTrust') }} <code>proxy/root.crt</code></p>
        <p v-else-if="status.certMode === 'acme'" class="setup-help">{{ t('setup.proxy.acmeRenew') }}</p>
        <p v-else-if="status.certMode === 'files'" class="setup-help">{{ t('setup.proxy.filesRenew') }} <code>proxy/certs/</code></p>
      </template>
    </div>
  </v-card>
</template>

<style scoped>
.proxy-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px 24px; margin: 0; }
.proxy-facts dt { font-size: .75rem; font-weight: 600; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.proxy-facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.proxy-fingerprint code { overflow-wrap: anywhere; word-break: break-all; }
</style>
