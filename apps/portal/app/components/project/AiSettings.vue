<script setup lang="ts">
import type { AiUsage, ProjectDetail } from '@yoda/shared'

const props = defineProps<{ project: ProjectDetail; canManage: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t, locale } = useI18n()
const api = useApi()
const usage = ref<AiUsage | null>(null)
const budget = ref('')
const error = ref('')

const percent = computed(() => usagePercent(usage.value))
const barColor = computed(() => usageColor(percent.value))

let seq = 0
async function loadUsage() {
  const mine = ++seq
  try {
    const u = await api<AiUsage>(`/projects/${props.project.id}/ai-usage`)
    if (mine === seq) usage.value = u
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}

watch(() => props.project.aiBudgetUsd, (v) => {
  budget.value = v == null ? '' : String(v)
}, { immediate: true })

async function patch(body: { noAi?: boolean; aiBudgetUsd?: number | null }) {
  error.value = ''
  try {
    await api(`/projects/${props.project.id}`, { method: 'PATCH', body })
  } catch (e) {
    error.value = t(errorKey(e))
  }
  emit('changed')
  await loadUsage()
}

function saveBudget() {
  const n = parseBudgetInput(budget.value)
  if (n === undefined) {
    error.value = t('ai.invalidBudget')
    return
  }
  return patch({ aiBudgetUsd: n })
}

/** `YYYY-MM` → "พฤศจิกายน 2569" / "November 2026". */
const monthLabel = (m: string) =>
  /^\d{4}-\d{2}$/.test(m)
    ? new Intl.DateTimeFormat(locale.value === 'en' ? 'en-GB' : 'th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`))
    : m
const money = (n: number) => `$${n.toFixed(2)}`

onMounted(loadUsage)
</script>

<template>
  <div data-testid="ai-settings">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" data-testid="ai-error">{{ error }}</v-alert>
    <v-card class="mb-4">
      <div class="card-head">
        <h2>{{ t('ai.budgetSection') }}</h2>
        <span v-if="!canManage" class="text-caption text-medium-emphasis" data-testid="ai-readonly">{{ t('ai.readOnly') }}</span>
      </div>
      <div class="card-body">
        <div class="ai-grid">
          <div class="text-body-2 font-weight-medium">{{ t('ai.title') }}</div>
          <div>
            <v-switch
              :model-value="project.noAi"
              :label="t('ai.noAi')"
              :disabled="!canManage"
              color="warning"
              hide-details
              inset
              data-testid="no-ai-switch"
              @update:model-value="(v) => patch({ noAi: !!v })"
            />
            <p class="text-caption text-medium-emphasis mb-2">{{ t('ai.noAiHelp') }}</p>
            <v-alert type="warning" variant="tonal" density="compact" data-testid="no-ai-warning">{{ t('ai.noAiWarning') }}</v-alert>
          </div>

          <div class="text-body-2 font-weight-medium">{{ t('ai.budget') }}</div>
          <div class="d-flex flex-wrap ga-3 align-start">
            <v-text-field
              v-model="budget"
              :label="t('ai.budget')"
              :hint="t('ai.budgetHint')"
              persistent-hint
              type="number"
              min="0"
              step="0.01"
              prefix="$"
              :disabled="!canManage"
              class="ai-budget-field"
              data-testid="budget-input"
              @keyup.enter="saveBudget"
            />
            <v-btn v-if="canManage" color="primary" class="mt-1" data-testid="save-budget" @click="saveBudget">{{ t('ai.saveBudget') }}</v-btn>
          </div>
        </div>
      </div>
    </v-card>

    <v-card>
      <div class="card-head">
        <h2>{{ t('ai.usage') }}</h2>
        <span v-if="usage" class="text-body-2 text-medium-emphasis">{{ monthLabel(usage.month) }}</span>
      </div>
      <div class="card-body">
        <SkeletonList v-if="!usage && !error" :rows="1" :two-line="false" quiet />
        <div v-if="usage" class="ai-usage" data-testid="ai-usage">
          <div class="d-flex flex-wrap align-baseline ga-2">
            <strong class="text-h5 tabular-nums" data-testid="ai-spend">{{ money(usage.costUsd) }}</strong>
            <span class="text-body-2 text-medium-emphasis">
              {{ usage.budgetUsd == null ? t('status.kpi.noBudget') : t('status.kpi.ofBudget', { budget: money(usage.budgetUsd) }) }}
            </span>
            <v-spacer />
            <span class="text-body-2 text-medium-emphasis">{{ t('ai.calls') }}: <span class="tabular-nums" data-testid="ai-calls">{{ usage.calls }}</span></span>
          </div>
          <v-progress-linear
            v-if="usage.budgetUsd != null"
            :model-value="percent"
            :color="barColor"
            bg-color="neutral-soft"
            bg-opacity="1"
            height="10"
            rounded
            class="mt-3"
            :aria-label="t('ai.usage')"
            data-testid="ai-bar"
            :data-color="barColor"
          />
          <div v-if="usage.budgetUsd != null" class="text-caption text-medium-emphasis mt-1 tabular-nums">{{ Math.round(percent) }}%</div>
        </div>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.ai-grid { display: grid; grid-template-columns: 200px minmax(0, 680px); gap: 16px 24px; align-items: start; }
@media (max-width: 767px) { .ai-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
.ai-budget-field { flex: 1 1 200px; max-width: 280px; }
</style>
