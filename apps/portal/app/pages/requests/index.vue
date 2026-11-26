<script setup lang="ts">
import type { MyRequest, TaskWithContext } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { answersFor, groupRequests, requesterTaskKind } from '~/utils/requests'

const { t, locale } = useI18n()
const { dateTime, date } = useDateFormat()
const api = useApi()
const requests = ref<MyRequest[] | null>(null)
const answers = ref<TaskWithContext[]>([])
const loadError = ref('')
const loadFailure = ref<unknown>(null)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const [list, mineAnswers] = await Promise.all([
      api<MyRequest[]>('/me/requests'),
      api<TaskWithContext[]>('/me/answers').catch(() => [] as TaskWithContext[]),
    ])
    if (mine !== seq) return
    requests.value = list
    answers.value = mineAnswers
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

const groups = computed(() => groupRequests(requests.value ?? []))

/** What a waiting request asks of me: its oldest open question or delivery. */
function waitingTask(r: MyRequest): TaskWithContext | null {
  return answersFor(r, answers.value)[0] ?? null
}
function waitingAsk(r: MyRequest): string {
  const list = answersFor(r, answers.value)
  if (!list.length) return t('requests.hint.waiting_for_you')
  if (list.every(a => requesterTaskKind(a) === 'delivery')) return t('requests.deliveryAsk')
  return list.map(a => localized(a.title, locale.value)).join(' · ')
}
</script>

<template>
  <div class="req-page">
    <PageHeader :title="t('nav.requests')">
      <template #actions>
        <v-btn color="primary" prepend-icon="mdi-plus" to="/chat" data-testid="new-request-btn">{{ t('requests.new') }}</v-btn>
      </template>
      <template #meta><span>{{ t('requests.subtitle') }}</span></template>
    </PageHeader>

    <ErrorState v-if="loadError && !requests" :error="loadFailure" data-testid="load-error" @retry="load" />
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <SkeletonList v-if="!requests && !loadError" :rows="4" />

    <template v-if="requests">
      <v-card v-if="!requests.length">
        <EmptyState icon="mdi-clipboard-text-outline" :title="t('requests.empty')" :text="t('requests.emptyText')" data-testid="requests-empty">
          <v-btn color="primary" to="/chat" prepend-icon="mdi-message-text-outline">{{ t('requests.startChat') }}</v-btn>
        </EmptyState>
      </v-card>

      <template v-else>
        <section v-if="groups.waiting.length" class="req-waiting mb-6" data-testid="requests-waiting">
          <div class="req-waiting__head">
            <v-icon icon="mdi-hand-wave-outline" color="warning" size="20" aria-hidden="true" />
            <h2 class="text-subtitle-1 font-weight-semibold">{{ t('requests.waitingTitle', { n: groups.waiting.length }) }}</h2>
            <span class="req-waiting__hint text-body-2">{{ t('requests.waitingHint') }}</span>
          </div>
          <div v-for="r in groups.waiting" :key="r.workItemId" class="req-row req-row--waiting" data-testid="request-item">
            <div class="req-row__main">
              <NuxtLink :to="`/requests/${r.workItemId}`" class="req-row__title">{{ r.title }}</NuxtLink>
              <div class="req-row__meta text-body-2">
                <span v-if="r.contactName" class="req-row__contact" data-testid="request-contact">
                  <v-icon icon="mdi-account-outline" size="16" aria-hidden="true" />{{ t('requests.contact', { name: r.contactName }) }}
                </span>
                <span v-if="waitingTask(r)" class="tabular-nums">
                  <v-icon icon="mdi-clock-outline" size="16" aria-hidden="true" />{{ t('requests.sentToYou', { date: dateTime(waitingTask(r)!.createdAt) }) }}
                </span>
                <span v-if="r.targetDate" class="tabular-nums">
                  <v-icon icon="mdi-calendar-outline" size="16" aria-hidden="true" />{{ t('requests.expected', { date: date(r.targetDate) }) }}
                </span>
              </div>
            </div>
            <StepTrack v-if="r.steps.length" :steps="r.steps" plain class="req-row__track" />
            <div class="req-row__act">
              <v-btn
                color="primary"
                :to="waitingTask(r) ? `/todo/${waitingTask(r)!.id}` : `/requests/${r.workItemId}`"
                data-testid="request-answer-btn"
              >{{ waitingTask(r) && requesterTaskKind(waitingTask(r)!) === 'delivery' ? t('requests.accept') : t('requests.answer') }}</v-btn>
            </div>
            <div class="req-row__ask text-body-2">
              <v-icon icon="mdi-comment-question-outline" color="warning" size="18" aria-hidden="true" />
              <span>{{ waitingAsk(r) }}</span>
            </div>
          </div>
        </section>

        <section v-if="groups.active.length" class="mb-6" data-testid="request-list">
          <div class="req-section-title">
            <h2 class="text-subtitle-1 font-weight-semibold">{{ t('requests.inProgress') }}</h2>
            <span class="req-count">{{ groups.active.length }}</span>
          </div>
          <v-card>
            <div v-for="r in groups.active" :key="r.workItemId" class="req-row" data-testid="request-item">
              <div class="req-row__main">
                <NuxtLink :to="`/requests/${r.workItemId}`" class="req-row__title">{{ r.title }}</NuxtLink>
                <div class="req-row__meta text-body-2">
                  <span class="tabular-nums"><v-icon icon="mdi-update" size="16" aria-hidden="true" />{{ t('requests.updatedAt', { date: dateTime(r.updatedAt) }) }}</span>
                  <span v-if="r.contactName" class="req-row__contact" data-testid="request-contact">
                    <v-icon icon="mdi-account-outline" size="16" aria-hidden="true" />{{ t('requests.contact', { name: r.contactName }) }}
                  </span>
                  <span v-if="r.targetDate" class="tabular-nums">
                    <v-icon icon="mdi-calendar-outline" size="16" aria-hidden="true" />{{ t('requests.expected', { date: date(r.targetDate) }) }}
                  </span>
                </div>
              </div>
              <StepTrack v-if="r.steps.length" :steps="r.steps" plain class="req-row__track" />
              <StatusChip v-else kind="request" :value="r.status" audience="requester" data-testid="request-status" />
              <div class="req-row__act">
                <v-btn variant="outlined" size="small" :to="`/requests/${r.workItemId}`">{{ t('requests.details') }}</v-btn>
              </div>
            </div>
          </v-card>
        </section>

        <section v-if="groups.done.length" class="mb-6" data-testid="requests-done">
          <div class="req-section-title">
            <h2 class="text-subtitle-1 font-weight-semibold">{{ t('requests.finished') }}</h2>
            <span class="req-count">{{ groups.done.length }}</span>
          </div>
          <v-card>
            <NuxtLink v-for="r in groups.done" :key="r.workItemId" :to="`/requests/${r.workItemId}`" class="req-done" data-testid="request-item">
              <StatusChip kind="request" :value="r.status" audience="requester" data-testid="request-status" />
              <span class="req-done__title">{{ r.title }}</span>
              <span class="req-done__date text-body-2 tabular-nums">{{ date(r.updatedAt) }}</span>
            </NuxtLink>
          </v-card>
        </section>

        <v-card class="req-how" data-testid="request-help">
          <v-icon icon="mdi-message-text-outline" color="primary" size="24" aria-hidden="true" />
          <div class="req-how__text">
            <div class="font-weight-semibold">{{ t('requests.howTitle') }}</div>
            <div class="text-body-2 text-medium-emphasis">{{ t('requests.howText') }}</div>
          </div>
          <v-btn variant="tonal" color="primary" to="/chat">{{ t('requests.startChat') }}</v-btn>
        </v-card>
      </template>
    </template>
  </div>
</template>

<style scoped>
.req-waiting { border: 1px solid rgb(var(--v-theme-warning-dot)); border-radius: 8px; background: rgb(var(--v-theme-surface)); overflow: hidden; }
.req-waiting__head {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 12px 16px;
  background: rgb(var(--v-theme-warning-soft)); border-bottom: 1px solid rgb(var(--v-theme-warning-dot));
}
.req-waiting__head h2 { margin: 0; }
.req-waiting__hint { margin-left: auto; color: rgb(var(--v-theme-warning)); }
.req-section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.req-section-title h2 { margin: 0; }
.req-count {
  min-width: 22px; padding: 0 6px; border-radius: 11px; text-align: center; font-size: .75rem; line-height: 20px;
  background: rgb(var(--v-theme-neutral-soft)); color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.req-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 280px auto; align-items: center; gap: 8px 24px;
  padding: 14px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.req-row:last-child { border-bottom: 0; }
.req-row__main { min-width: 0; }
.req-row__title { display: block; font-weight: 500; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.req-row__title:hover { text-decoration: underline; }
.req-row__meta { display: flex; flex-wrap: wrap; gap: 2px 16px; margin-top: 2px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.req-row__meta .v-icon { margin-right: 4px; }
.req-row__act { display: flex; justify-content: flex-end; }
.req-row__ask {
  grid-column: 1 / -1; display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 6px;
  background: rgb(var(--v-theme-background)); overflow-wrap: anywhere;
}
.req-done {
  display: flex; align-items: center; gap: 12px; padding: 10px 16px; color: inherit; text-decoration: none;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.req-done:last-child { border-bottom: 0; }
.req-done:hover .req-done__title { text-decoration: underline; }
.req-done__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.req-done__date { flex: none; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.req-how { display: flex; align-items: center; gap: 16px; padding: 16px; }
.req-how__text { flex: 1 1 auto; min-width: 0; }
@media (max-width: 959px) {
  .req-row { grid-template-columns: minmax(0, 1fr) auto; }
  .req-row__track { grid-column: 1 / -1; grid-row: 2; }
  .req-row__act { grid-column: 2; grid-row: 1; }
}
@media (max-width: 599px) {
  .req-waiting__hint { display: none; }
  .req-row { grid-template-columns: minmax(0, 1fr); }
  .req-row__act { grid-column: 1; grid-row: auto; justify-content: flex-start; }
  .req-row__track { grid-row: auto; }
  .req-done__date { display: none; }
  .req-how { flex-wrap: wrap; }
}
</style>
