<script setup lang="ts">
import { WeeklySummaryOutcome, type LiveEvent, type WeeklySummary } from '@yoda/shared'
import { outcomeMessageKey } from '~/utils/status'

/** A safety net only: every run announces its outcome, so this fires just when the job never ran. */
const GIVE_UP_MS = 5 * 60_000
const POLL_MS = 10_000

const props = defineProps<{ projectId: string; summary: WeeklySummary | null; noAi: boolean; aiConfigured: boolean; canManage: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
const { t, locale } = useI18n()
const api = useApi()

const confirmOpen = ref(false)
const busy = ref(false)
const generating = ref(false)
/** Why the last regenerate wrote nothing (an i18n key), or null. */
const outcomeKey = ref<string | null>(null)
const error = ref('')
let giveUp: ReturnType<typeof setTimeout> | null = null
let poll: ReturnType<typeof setInterval> | null = null

const signature = (s: WeeklySummary | null) => (s ? `${s.entryId}:${s.createdAt}:${s.body}` : '')
let before = ''

function stop() {
  generating.value = false
  if (giveUp) clearTimeout(giveUp)
  if (poll) clearInterval(poll)
  giveUp = poll = null
}
onBeforeUnmount(stop)

// A new summary ends the wait and clears any stale message.
watch(() => signature(props.summary), (now) => {
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
    before = signature(props.summary)
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

const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')
</script>

<template>
  <v-card variant="outlined" data-testid="weekly-summary">
    <v-card-item>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        <span>{{ t('status.weekly.title') }}</span>
        <template v-if="summary">
          <span class="text-body-2 text-medium-emphasis">{{ t('status.weekly.week', { week: summary.week }) }}</span>
          <v-chip v-if="summary.status === 'draft'" size="x-small" color="warning" variant="tonal" data-testid="weekly-draft">{{ t('status.weekly.draft') }}</v-chip>
        </template>
        <v-spacer />
        <v-btn
          v-if="canManage && !noAi && aiConfigured"
          size="small"
          variant="outlined"
          prepend-icon="mdi-refresh"
          :disabled="generating"
          data-testid="weekly-regenerate"
          @click="confirmOpen = true"
        >{{ t('status.weekly.regenerate') }}</v-btn>
      </v-card-title>
      <v-card-subtitle v-if="summary">{{ fmt(summary.createdAt) }}</v-card-subtitle>
    </v-card-item>
    <v-card-text>
      <v-alert v-if="error" type="error" density="compact" class="mb-3" data-testid="weekly-error">{{ error }}</v-alert>
      <div v-if="generating" class="d-flex align-center ga-2 mb-3" data-testid="weekly-generating">
        <v-progress-circular indeterminate size="18" width="2" />
        <span class="text-body-2">{{ t('status.weekly.generating') }}</span>
      </div>
      <v-alert v-if="outcomeKey" type="info" variant="tonal" density="compact" class="mb-3" data-testid="weekly-outcome">{{ t(outcomeKey) }}</v-alert>
      <v-alert v-if="!noAi && !aiConfigured" type="info" variant="tonal" density="compact" class="mb-3" data-testid="weekly-not-configured">{{ t('status.weekly.notConfigured') }}</v-alert>
      <p v-if="noAi" class="text-medium-emphasis" data-testid="weekly-no-ai">{{ t('status.weekly.noAi') }}</p>
      <MarkdownView v-else-if="summary" :source="summary.body" data-testid="weekly-body" />
      <p v-else class="text-medium-emphasis" data-testid="weekly-empty">{{ t('status.weekly.empty') }}</p>
    </v-card-text>

    <v-dialog v-model="confirmOpen" max-width="460">
      <v-card :title="t('status.weekly.confirmTitle')" data-testid="weekly-confirm-dialog">
        <v-card-text>{{ t('status.weekly.confirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirmOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" data-testid="weekly-confirm" @click="regenerate">{{ t('status.weekly.regenerate') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
