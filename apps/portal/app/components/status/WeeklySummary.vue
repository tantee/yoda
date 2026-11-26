<script setup lang="ts">
import { WeeklySummaryOutcome, type LiveEvent, type WeeklySummary } from '@yoda/shared'
import { formatWeekRange } from '~/utils/projects'
import { outcomeMessageKey } from '~/utils/status'

/** A safety net only: every run announces its outcome, so this fires just when the job never ran. */
const GIVE_UP_MS = 5 * 60_000
const POLL_MS = 10_000

/** `summary`: the newest finished week; `inProgress`: this week's regenerated draft (`currentWeek`), shown below it. */
const props = defineProps<{
  projectId: string
  summary: WeeklySummary | null
  inProgress: WeeklySummary | null
  currentWeek: string
  noAi: boolean
  aiConfigured: boolean
  canManage: boolean
}>()
const emit = defineEmits<{ refresh: [] }>()
const { t, locale } = useI18n()
const api = useApi()
const weekRange = (week: string) => formatWeekRange(week, locale.value)

const confirmOpen = ref(false)
const busy = ref(false)
const generating = ref(false)
/** Why the last regenerate wrote nothing (an i18n key), or null. */
const outcomeKey = ref<string | null>(null)
const error = ref('')
let giveUp: ReturnType<typeof setTimeout> | null = null
let poll: ReturnType<typeof setInterval> | null = null

const one = (s: WeeklySummary | null) => (s ? `${s.entryId}:${s.createdAt}:${s.body}` : '')
/** A regenerate writes the week in progress; either summary changing ends the wait. */
const signature = () => `${one(props.summary)}|${one(props.inProgress)}`
let before = ''

function stop() {
  generating.value = false
  if (giveUp) clearTimeout(giveUp)
  if (poll) clearInterval(poll)
  giveUp = poll = null
}
onBeforeUnmount(stop)

// A new summary ends the wait and clears any stale message.
watch(signature, (now) => {
  if (generating.value && now === before) return
  stop()
  outcomeKey.value = null
  error.value = ''
})

async function regenerate() {
  error.value = ''
  busy.value = true
  try {
    await api(`/projects/${props.projectId}/weekly-summary`, { method: 'POST' })
    confirmOpen.value = false
    before = signature()
    outcomeKey.value = null
    generating.value = true
    poll = setInterval(() => emit('refresh'), POLL_MS)
    giveUp = setTimeout(() => {
      stop()
      outcomeKey.value = 'status.weekly.notWritten'
    }, GIVE_UP_MS)
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

/** The parent forwards this project's live events: a written summary reloads, a skipped run says why. */
function onLive(e: LiveEvent) {
  if (e.type === 'status.weekly_summary') emit('refresh')
  if (e.type !== 'status.weekly_summary_outcome' || !generating.value) return
  const parsed = WeeklySummaryOutcome.safeParse(e.payload)
  if (!parsed.success) return
  const key = outcomeMessageKey(parsed.data)
  if (key === null) {
    emit('refresh') // the new summary arrives with the reload and ends the wait
    return
  }
  stop()
  outcomeKey.value = key
}
defineExpose({ onLive })

/** PM or admin: confirm the draft (a new confirmed version of the knowledge entry). */
const publishing = ref(false)
async function publish(entryId: string) {
  error.value = ''
  publishing.value = true
  try {
    await api(`/knowledge/${entryId}/confirm`, { method: 'POST' })
    emit('refresh')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    publishing.value = false
  }
}

const { dateTime: fmt } = useDateFormat()
</script>

<template>
  <v-card data-testid="weekly-summary">
    <div class="card-head">
      <h2>{{ t('status.weekly.title') }}</h2>
      <span v-if="summary" class="text-body-2 text-medium-emphasis tabular-nums" :title="summary.week" data-testid="weekly-week">{{ weekRange(summary.week) }}</span>
    </div>
    <div class="card-body">
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="weekly-error">{{ error }}</v-alert>
      <div v-if="generating" class="d-flex align-center ga-2 mb-3" data-testid="weekly-generating">
        <v-progress-circular indeterminate size="18" width="2" />
        <span class="text-body-2">{{ t('status.weekly.generating') }}</span>
      </div>
      <v-alert v-if="outcomeKey" type="info" variant="tonal" density="compact" class="mb-3" data-testid="weekly-outcome">{{ t(outcomeKey) }}</v-alert>
      <v-alert v-if="!noAi && !aiConfigured" type="info" variant="tonal" density="compact" class="mb-3" data-testid="weekly-not-configured">{{ t('status.weekly.notConfigured') }}</v-alert>
      <p v-if="noAi" class="text-medium-emphasis mb-0" data-testid="weekly-no-ai">{{ t('status.weekly.noAi') }}</p>
      <template v-else>
        <template v-if="summary">
          <div class="weekly-labels mb-3">
            <span class="weekly-ai"><v-icon icon="mdi-creation-outline" size="16" aria-hidden="true" />{{ t('status.weekly.aiLabel') }}</span>
            <StatusChip v-if="summary.status === 'draft'" kind="knowledge" value="draft" :label="t('status.weekly.draftPending')" size="x-small" data-testid="weekly-draft" />
            <StatusChip v-else kind="knowledge" value="confirmed" :label="t('status.weekly.published')" size="x-small" />
            <v-spacer />
            <span class="text-caption text-medium-emphasis">{{ t('status.weekly.created', { time: fmt(summary.createdAt) }) }}</span>
          </div>
          <MarkdownView :source="summary.body" data-testid="weekly-body" />
        </template>
        <p v-else-if="!inProgress" class="text-medium-emphasis mb-0" data-testid="weekly-empty">{{ t('status.weekly.empty') }}</p>
        <section v-if="inProgress" :class="{ 'mt-4 pt-4 border-t': summary }" data-testid="weekly-in-progress">
          <div class="weekly-labels mb-2">
            <span class="text-subtitle-2">{{ t('status.weekly.thisWeek') }}</span>
            <span class="text-body-2 text-medium-emphasis tabular-nums" :title="inProgress.week">{{ weekRange(inProgress.week) }}</span>
            <StatusChip v-if="inProgress.status === 'draft'" kind="knowledge" value="draft" :label="t('status.weekly.draft')" size="x-small" />
            <v-spacer />
            <span class="text-caption text-medium-emphasis">{{ fmt(inProgress.createdAt) }}</span>
          </div>
          <MarkdownView :source="inProgress.body" data-testid="weekly-in-progress-body" />
        </section>
      </template>
      <div v-if="canManage && !noAi" class="weekly-actions mt-4">
        <v-btn
          v-if="aiConfigured"
          variant="text"
          color="primary"
          size="small"
          :disabled="generating"
          data-testid="weekly-regenerate"
          @click="confirmOpen = true"
        >{{ t('status.weekly.regenerateEllipsis') }}</v-btn>
        <v-btn
          v-if="summary?.status === 'draft'"
          variant="tonal"
          color="primary"
          size="small"
          :loading="publishing"
          data-testid="weekly-publish"
          @click="publish(summary.entryId)"
        >{{ t('status.weekly.publish') }}</v-btn>
      </div>
    </div>

    <ConfirmDialog
      v-model="confirmOpen"
      :title="t('status.weekly.confirmTitle')"
      :text="t('status.weekly.confirm', { week: weekRange(currentWeek) })"
      :confirm-label="t('status.weekly.regenerate')"
      :busy="busy"
      confirm-testid="weekly-confirm"
      data-testid="weekly-confirm-dialog"
      @confirm="regenerate"
    />
  </v-card>
</template>

<style scoped>
.weekly-labels { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.weekly-ai { display: inline-flex; align-items: center; gap: 4px; color: rgb(var(--v-theme-ai)); font-size: .8125rem; font-weight: 500; }
.weekly-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
</style>
