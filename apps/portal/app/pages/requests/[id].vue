<script setup lang="ts">
import type { MyRequestDetail, TaskWithContext } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { localized } from '~/utils/localized'
import { answersFor, plainSteps, requestEventText, requesterStepKey, requesterTaskKind } from '~/utils/requests'
import { errorKind } from '~/utils/stateView'

const { t, locale } = useI18n()
const { dateTime, date } = useDateFormat()
const api = useApi()
const { xs } = useDisplay()
const id = useRoute().params.id as string
const request = ref<MyRequestDetail | null>(null)
useBreadcrumb(() => (request.value ? [{ label: request.value.title }] : []))
const answers = ref<TaskWithContext[]>([])
const loaded = ref(false)
const missing = ref(false)
const loadError = ref('')
const loadFailure = ref<unknown>(null)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    // The request (own only; 404 otherwise) and my open questions / deliveries, which belong to it.
    const [detail, mineAnswers] = await Promise.all([
      api<MyRequestDetail>(`/me/requests/${id}`),
      api<TaskWithContext[]>('/me/answers').catch(() => [] as TaskWithContext[]),
    ])
    if (mine !== seq) return
    request.value = detail
    answers.value = answersFor(detail, mineAnswers)
    missing.value = false
    loaded.value = true
    loadError.value = ''
  } catch (e) {
    if (mine !== seq) return
    if (errorKind(e).status === 404 || errorKind(e).status === 400) {
      request.value = null
      missing.value = true
      loaded.value = true
      loadError.value = ''
    } else {
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

const steps = computed(() => (request.value ? plainSteps(request.value.steps, t) : []))
const stepWords = (key: string | null, name: string) => {
  const k = requesterStepKey(key)
  return k ? t(k) : name
}
const timeline = computed(() =>
  (request.value?.timeline ?? []).map((e, i) => {
    const { key, params } = requestEventText(e, stepWords, date, locale.value)
    return { id: `${e.at}-${i}`, at: e.at, kind: e.kind, text: t(key, params) }
  }),
)
const EVENT_ICONS: Record<string, string> = {
  received: 'mdi-inbox-arrow-down-outline',
  step: 'mdi-arrow-right-circle-outline',
  reopened: 'mdi-undo-variant',
  question: 'mdi-comment-question-outline',
  delivery: 'mdi-package-variant-closed',
  answered: 'mdi-comment-check-outline',
  accepted: 'mdi-check-decagram-outline',
  changes: 'mdi-pencil-outline',
  expected_date: 'mdi-calendar-outline',
  done: 'mdi-check-circle-outline',
  cancelled: 'mdi-close-circle-outline',
}
</script>

<template>
  <div class="rq">
    <ErrorState v-if="loadError && !request" :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <v-card v-else-if="missing" data-testid="request-missing">
      <EmptyState icon="mdi-file-question-outline" wisdom="notFound" :title="t('requests.notFound')" :text="t('requests.notFoundText')">
        <v-btn color="primary" to="/requests">{{ t('requests.back') }}</v-btn>
      </EmptyState>
    </v-card>
    <SkeletonDetail v-else-if="!loaded" />

    <template v-if="request">
      <PageHeader :title="request.title" data-testid="request-title">
        <template #context>
          <StatusChip kind="request" :value="request.status" audience="requester" data-testid="request-status" />
        </template>
        <template #actions>
          <v-btn variant="outlined" to="/chat" prepend-icon="mdi-message-text-outline">{{ t('requests.openChat') }}</v-btn>
        </template>
        <template #meta>
          <span>{{ t(`requests.hint.${request.status}`) }}</span>
        </template>
      </PageHeader>

      <v-card v-if="steps.length" class="rq-track mb-4" data-testid="request-step">
        <StepTrack :steps="steps" plain :show-names="!xs" />
      </v-card>

      <div class="rq-layout">
        <div class="rq-main">
          <section class="mb-4" data-testid="request-todo">
            <h2 class="rq-section-title text-subtitle-1">{{ t('requests.todo') }}</h2>
            <div v-if="answers.length" class="rq-actions" data-testid="request-answers">
              <v-card v-for="a in answers" :key="a.id" class="rq-action" data-testid="request-action">
                <div class="rq-action__icon" aria-hidden="true">
                  <v-icon :icon="requesterTaskKind(a) === 'delivery' ? 'mdi-package-variant-closed' : 'mdi-comment-question-outline'" size="20" />
                </div>
                <div class="rq-action__body">
                  <div v-if="t(`requests.kind.${requesterTaskKind(a)}`) !== localized(a.title, locale)" class="rq-action__kind text-caption">{{ t(`requests.kind.${requesterTaskKind(a)}`) }}</div>
                  <div class="rq-action__title">{{ localized(a.title, locale) }}</div>
                  <div class="text-body-2 text-medium-emphasis tabular-nums">{{ t('requests.sentToYou', { date: dateTime(a.createdAt) }) }}</div>
                </div>
                <v-btn color="primary" :to="`/todo/${a.id}`" class="rq-action__btn" data-testid="request-action-btn">
                  {{ requesterTaskKind(a) === 'delivery' ? t('requests.accept') : t('requests.answer') }}
                </v-btn>
              </v-card>
            </div>
            <v-card v-else class="rq-nothing text-body-2 text-medium-emphasis" data-testid="request-nothing">
              <v-icon icon="mdi-check-circle-outline" size="20" aria-hidden="true" />{{ t('requests.nothingToDo') }}
            </v-card>
          </section>

          <section v-if="request.delivered" class="mb-4" data-testid="request-delivered">
            <h2 class="rq-section-title text-subtitle-1">{{ t('requests.delivered') }}</h2>
            <v-card class="rq-card-body"><MarkdownView :source="request.delivered" /></v-card>
          </section>

          <section data-testid="request-timeline">
            <h2 class="rq-section-title text-subtitle-1">{{ t('requests.timeline') }}</h2>
            <v-card>
              <p v-if="!timeline.length" class="rq-card-body text-body-2 text-medium-emphasis mb-0">{{ t('requests.timelineEmpty') }}</p>
              <ol v-else class="rq-timeline">
                <li v-for="e in timeline" :key="e.id" class="rq-timeline__row" data-testid="request-event">
                  <span class="rq-timeline__dot" :class="`rq-timeline__dot--${e.kind}`" aria-hidden="true">
                    <v-icon :icon="EVENT_ICONS[e.kind] ?? 'mdi-circle-small'" size="16" />
                  </span>
                  <span class="rq-timeline__text">{{ e.text }}</span>
                  <time class="rq-timeline__at text-body-2 tabular-nums" :datetime="e.at">{{ dateTime(e.at) }}</time>
                </li>
              </ol>
            </v-card>
          </section>
        </div>

        <aside class="rq-side" :aria-label="t('requests.about')">
          <v-card data-testid="request-about">
            <div class="rq-card-head"><h2 class="text-subtitle-2">{{ t('requests.about') }}</h2></div>
            <dl class="rq-facts rq-card-body">
              <template v-if="request.contactName">
                <dt>{{ t('requests.contactLabel') }}</dt>
                <dd data-testid="request-contact">{{ request.contactName }}</dd>
              </template>
              <dt>{{ t('requests.project') }}</dt>
              <dd>{{ request.projectName }}</dd>
              <dt>{{ t('requests.expectedDate') }}</dt>
              <dd class="tabular-nums">{{ request.targetDate ? date(request.targetDate) : t('requests.noExpected') }}</dd>
              <dt>{{ t('requests.lastUpdate') }}</dt>
              <dd class="tabular-nums">{{ dateTime(request.updatedAt) }}</dd>
            </dl>
          </v-card>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rq-track { padding: 16px; }
.rq-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
@media (min-width: 1280px) { .rq-layout { grid-template-columns: minmax(0, 1fr) 320px; } }
.rq-main, .rq-side { min-width: 0; }
.rq-section-title { font-weight: 600; margin: 0 0 8px; }
.rq-card-head { display: flex; align-items: center; min-height: 48px; padding: 8px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.rq-card-head h2 { margin: 0; font-weight: 600; }
.rq-card-body { padding: 16px; min-width: 0; overflow-wrap: anywhere; }
.rq-actions { display: flex; flex-direction: column; gap: 8px; }
.rq-action {
  display: flex; align-items: center; gap: 12px; padding: 14px 16px;
  border-left: 4px solid rgb(var(--v-theme-warning-dot));
}
.rq-action__icon {
  flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px;
  background: rgb(var(--v-theme-warning-soft)); color: rgb(var(--v-theme-warning));
}
.rq-action__body { flex: 1 1 auto; min-width: 0; }
.rq-action__kind { color: rgb(var(--v-theme-warning)); font-weight: 600; }
.rq-action__title { font-weight: 500; overflow-wrap: anywhere; }
.rq-action__btn { flex: none; }
.rq-nothing { display: flex; align-items: center; gap: 8px; padding: 14px 16px; }
.rq-timeline { list-style: none; margin: 0; padding: 4px 0; }
.rq-timeline__row {
  display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: start; gap: 4px 12px;
  padding: 10px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.rq-timeline__row:last-child { border-bottom: 0; }
.rq-timeline__dot {
  display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%;
  background: rgb(var(--v-theme-neutral-soft)); color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.rq-timeline__dot--question, .rq-timeline__dot--delivery { background: rgb(var(--v-theme-warning-soft)); color: rgb(var(--v-theme-warning)); }
.rq-timeline__dot--done, .rq-timeline__dot--accepted, .rq-timeline__dot--answered { background: rgb(var(--v-theme-success-soft)); color: rgb(var(--v-theme-success)); }
.rq-timeline__text { padding-top: 3px; overflow-wrap: anywhere; }
.rq-timeline__at { padding-top: 3px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); white-space: nowrap; }
.rq-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 12px; margin: 0; font-size: .875rem; }
.rq-facts dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.rq-facts dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 599px) {
  .rq-action { flex-wrap: wrap; }
  .rq-action__btn { width: 100%; }
  .rq-timeline__row { grid-template-columns: 28px minmax(0, 1fr); }
  .rq-timeline__at { grid-column: 2; padding-top: 0; }
}
</style>
