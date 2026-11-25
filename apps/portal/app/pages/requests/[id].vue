<script setup lang="ts">
import type { MyRequest, TaskWithContext } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { answersFor } from '~/utils/requests'

const { t, locale } = useI18n()
const { dateTime } = useDateFormat()
const api = useApi()
const id = useRoute().params.id as string
const request = ref<MyRequest | null>(null)
useBreadcrumb(() => (request.value ? [{ label: request.value.title }] : []))
const answers = ref<TaskWithContext[]>([])
const loaded = ref(false)
const loadError = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const [list, mineAnswers] = await Promise.all([api<MyRequest[]>('/me/requests'), api<TaskWithContext[]>('/me/answers')])
    if (mine !== seq) return
    request.value = list.find(r => r.workItemId === id) ?? null
    answers.value = request.value ? answersFor(request.value, mineAnswers) : []
    loaded.value = true
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
    <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/requests" class="mb-2">{{ t('requests.back') }}</v-btn>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <v-alert v-else-if="loaded && !request" type="warning" class="mb-4" data-testid="request-missing">{{ t('errors.notFound') }}</v-alert>
    <template v-if="request">
      <h1 class="text-h5 mb-2" data-testid="request-title">{{ request.title }}</h1>
      <div class="d-flex flex-wrap ga-2 mb-2">
        <StatusChip kind="request" :value="request.status" audience="requester" data-testid="request-status" />
        <v-chip v-if="request.currentStepName" size="small" variant="outlined" data-testid="request-step">{{ localized(request.currentStepName, locale) }}</v-chip>
        <v-chip size="small" variant="outlined">{{ request.projectName }}</v-chip>
      </div>
      <p class="text-medium-emphasis mb-4">{{ t('requests.updated') }}: {{ dateTime(request.updatedAt) }}</p>
      <p class="mb-4">{{ t(`requests.hint.${request.status}`) }}</p>

      <template v-if="answers.length">
        <h2 class="text-h6 mb-2">{{ t('requests.yourAnswers') }}</h2>
        <v-list border lines="two" class="mb-4" data-testid="request-answers">
          <v-list-item v-for="a in answers" :key="a.id" :to="`/todo/${a.id}`">
            <v-list-item-title>{{ localized(a.title, locale) }}</v-list-item-title>
            <template #append>
              <StatusChip kind="task" :value="a.state" audience="requester" />
            </template>
          </v-list-item>
        </v-list>
      </template>
      <v-btn variant="outlined" to="/chat" prepend-icon="mdi-chat-outline">{{ t('requests.openChat') }}</v-btn>
    </template>
  </div>
</template>
