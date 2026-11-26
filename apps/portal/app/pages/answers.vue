<script setup lang="ts">
import type { TaskWithContext } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { answersByRequest, requesterTaskKind } from '~/utils/requests'

const { t, locale } = useI18n()
const { dateTime } = useDateFormat()
const api = useApi()
const answers = ref<TaskWithContext[] | null>(null)
const loadError = ref('')
const loadFailure = ref<unknown>(null)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<TaskWithContext[]>('/me/answers')
    if (mine !== seq) return
    answers.value = result
    loadError.value = ''
  } catch (e) {
    if (mine === seq) {
      loadError.value = t(errorKey(e))
      loadFailure.value = e
    }
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

const groups = computed(() => answersByRequest(answers.value ?? []))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.answers')">
      <template #meta><span>{{ t('answers.subtitle') }}</span></template>
    </PageHeader>

    <ErrorState v-if="loadError && !answers" :error="loadFailure" data-testid="load-error" @retry="load" />
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <SkeletonList v-if="!answers && !loadError" :rows="3" />

    <template v-if="answers">
      <v-card v-if="!answers.length" data-testid="answers-empty">
        <EmptyState icon="mdi-comment-check-outline" :title="t('answers.empty')" :text="t('answers.emptyText')">
          <v-btn variant="outlined" to="/requests">{{ t('nav.requests') }}</v-btn>
        </EmptyState>
      </v-card>
      <div v-else class="ans-groups" data-testid="answer-list">
        <section v-for="g in groups" :key="g.workItemId" class="ans-group" data-testid="answer-group">
          <div class="ans-group__head">
            <h2 class="ans-group__title text-subtitle-1">{{ g.title }}</h2>
            <v-btn variant="text" size="small" color="primary" :to="`/requests/${g.workItemId}`">{{ t('answers.open') }}</v-btn>
          </div>
          <v-card>
            <div v-for="a in g.answers" :key="a.id" class="ans-row" data-testid="answer-item">
              <div class="ans-row__icon" aria-hidden="true">
                <v-icon :icon="requesterTaskKind(a) === 'delivery' ? 'mdi-package-variant-closed' : 'mdi-comment-question-outline'" size="20" />
              </div>
              <div class="ans-row__body">
                <div v-if="t(`requests.kind.${requesterTaskKind(a)}`) !== localized(a.title, locale)" class="ans-row__kind text-caption">{{ t(`requests.kind.${requesterTaskKind(a)}`) }}</div>
                <NuxtLink :to="`/todo/${a.id}`" class="ans-row__title">{{ localized(a.title, locale) }}</NuxtLink>
                <div class="ans-row__meta text-body-2">
                  <span><v-icon icon="mdi-account-group-outline" size="16" aria-hidden="true" />{{ t('answers.askedBy') }}</span>
                  <span class="tabular-nums"><v-icon icon="mdi-clock-outline" size="16" aria-hidden="true" />{{ t('answers.sentAt', { date: dateTime(a.createdAt) }) }}</span>
                </div>
              </div>
              <v-btn color="primary" :to="`/todo/${a.id}`" class="ans-row__btn" data-testid="answer-btn">
                {{ requesterTaskKind(a) === 'delivery' ? t('requests.accept') : t('requests.answer') }}
              </v-btn>
            </div>
          </v-card>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ans-groups { display: flex; flex-direction: column; gap: 24px; }
.ans-group__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.ans-group__title { margin: 0; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.ans-row {
  display: flex; align-items: center; gap: 12px; padding: 14px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.ans-row:last-child { border-bottom: 0; }
.ans-row__icon {
  flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px;
  background: rgb(var(--v-theme-warning-soft)); color: rgb(var(--v-theme-warning));
}
.ans-row__body { flex: 1 1 auto; min-width: 0; }
.ans-row__kind { color: rgb(var(--v-theme-warning)); font-weight: 600; }
.ans-row__title { display: block; font-weight: 500; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.ans-row__title:hover { text-decoration: underline; }
.ans-row__meta { display: flex; flex-wrap: wrap; gap: 2px 16px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.ans-row__meta .v-icon { margin-right: 4px; }
.ans-row__btn { flex: none; }
@media (max-width: 599px) {
  .ans-row { flex-wrap: wrap; }
  .ans-row__btn { width: 100%; }
}
</style>
