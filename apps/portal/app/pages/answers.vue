<script setup lang="ts">
import type { TaskWithContext } from '@yoda/shared'
import { localized } from '~/utils/localized'

const { t, locale } = useI18n()
const api = useApi()
const answers = ref<TaskWithContext[] | null>(null)
const loadError = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<TaskWithContext[]>('/me/answers')
    if (mine !== seq) return
    answers.value = result
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
    <h1 class="text-h5 mb-4">{{ t('nav.answers') }}</h1>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="answers">
      <p v-if="!answers.length" class="text-medium-emphasis" data-testid="answers-empty">{{ t('answers.empty') }}</p>
      <v-list v-else border lines="two" data-testid="answer-list">
        <v-list-item v-for="a in answers" :key="a.id" :to="`/todo/${a.id}`" data-testid="answer-item">
          <v-list-item-title>{{ localized(a.title, locale) }}</v-list-item-title>
          <v-list-item-subtitle>{{ a.workItemTitle }}</v-list-item-subtitle>
          <template #append>
            <v-chip size="small">{{ t(`task.state.${a.state}`) }}</v-chip>
          </template>
        </v-list-item>
      </v-list>
    </template>
  </div>
</template>
