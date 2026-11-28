<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { normaliseYodaUrl, onConnectClick, type ConnectResult } from '../connect/connect'

/** Connect to a Yoda: the address is checked as typed and its origin shown in large text before approving (T9). */
const emit = defineEmits<{ connected: [profileId: string] }>()
const { t } = useI18n()
const url = ref('')
const busy = ref(false)
const error = ref('')
const checked = computed(() => normaliseYodaUrl(url.value))
const origin = computed(() => (checked.value.ok ? checked.value.origin : ''))

function connect() {
  if (busy.value || !checked.value.ok) return
  error.value = ''
  busy.value = true
  // No await before this call: permissions.request needs the click.
  onConnectClick(url.value)
    .then((r: ConnectResult) => {
      if (r.ok) emit('connected', r.profileId)
      else error.value = t(`connect.error.${r.reason}`)
    })
    .finally(() => {
      busy.value = false
    })
}
</script>

<template>
  <v-card data-testid="connect-dialog">
    <v-card-title class="text-subtitle-1">{{ t('connect.title') }}</v-card-title>
    <v-card-text>
      <p class="text-body-2 mb-3">{{ t('connect.intro') }}</p>
      <v-text-field
        v-model="url"
        :label="t('connect.address')"
        placeholder="https://yoda.example.org"
        autofocus
        spellcheck="false"
        autocapitalize="off"
        :error-messages="url.trim() && !checked.ok ? t(`connect.error.${checked.reason}`) : ''"
        data-testid="connect-url"
        @keyup.enter="connect"
      />
      <div v-if="origin" class="connect-origin mt-2" data-testid="connect-origin">
        <div class="text-caption text-medium-emphasis">{{ t('connect.willOpen') }}</div>
        <div class="text-h6 connect-origin__value">{{ origin }}</div>
      </div>
      <v-alert v-if="error" type="error" class="mt-3" data-testid="connect-error">{{ error }}</v-alert>
    </v-card-text>
    <v-card-actions class="justify-end">
      <v-btn color="primary" variant="flat" :disabled="!checked.ok" :loading="busy" data-testid="connect-submit" @click="connect">{{ t('connect.submit') }}</v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.connect-origin__value { font-family: 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap: anywhere; }
</style>
