<script setup lang="ts">
import type { MyRequest } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { requestStatusColor } from '~/utils/requests'

const { t, locale } = useI18n()
const api = useApi()
const requests = ref<MyRequest[] | null>(null)
const loadError = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<MyRequest[]>('/me/requests')
    if (mine !== seq) return
    requests.value = result
    loadError.value = ''
  } catch (e) {
    if (mine === seq) loadError.value = t(errorKey(e))
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 200)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

onMounted(load)
useLiveEvents(loadSoon, loadSoon)
</script>

<template>
  <div>
    <h1 class="text-h5 mb-4">{{ t('nav.requests') }}</h1>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="requests">
      <div v-if="!requests.length" data-testid="requests-empty">
        <p class="text-medium-emphasis mb-3">{{ t('requests.empty') }}</p>
        <v-btn color="primary" to="/chat" prepend-icon="mdi-chat-outline">{{ t('requests.startChat') }}</v-btn>
      </div>
      <v-list v-else border lines="two" data-testid="request-list">
        <v-list-item v-for="r in requests" :key="r.workItemId" :to="`/requests/${r.workItemId}`" data-testid="request-item">
          <v-list-item-title>{{ r.title }}</v-list-item-title>
          <v-list-item-subtitle>
            {{ r.projectName }}<template v-if="r.currentStepName"> · {{ localized(r.currentStepName, locale) }}</template>
          </v-list-item-subtitle>
          <template #append>
            <v-chip size="small" :color="requestStatusColor(r.status)" data-testid="request-status">{{ t(`requests.status.${r.status}`) }}</v-chip>
          </template>
        </v-list-item>
      </v-list>
    </template>
  </div>
</template>
