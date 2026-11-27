<script setup lang="ts">
import type { TotpEnrolment } from '@yoda/shared'
import { renderSVG } from 'uqr'
import { computed, useI18n } from '#imports'

/**
 * A TOTP seed being enrolled (spike §6): the QR code as an <img> (never v-html) and the base32 secret for typing
 * in. Both live only in this component's props; nothing is stored in the browser.
 */
const props = defineProps<{ enrolment: TotpEnrolment }>()
const { t } = useI18n()
const qr = computed(() => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(props.enrolment.uri))}`)
const grouped = computed(() => props.enrolment.secret.match(/.{1,4}/g)?.join(' ') ?? '')
</script>

<template>
  <div class="totp-enrol" data-testid="totp-enrol">
    <img :src="qr" :alt="t('recovery.totp.qrAlt')" width="176" height="176" class="totp-enrol__qr" data-testid="totp-qr">
    <div class="totp-enrol__text text-body-2">
      <p class="mb-2">{{ t('recovery.totp.scan') }}</p>
      <p class="text-medium-emphasis mb-1">{{ t('recovery.totp.manual') }}</p>
      <code class="totp-enrol__secret" data-testid="totp-secret">{{ grouped }}</code>
    </div>
  </div>
</template>

<style scoped>
.totp-enrol { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
.totp-enrol__qr { background: #fff; padding: 8px; border-radius: 8px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.totp-enrol__text { flex: 1 1 220px; min-width: 0; }
.totp-enrol__secret { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
</style>
