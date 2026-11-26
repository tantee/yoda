<script setup lang="ts">
import type { DepartmentAiSettings, DepartmentAiSettingsPatch, DepartmentStatus } from '@yoda/shared'
import { usd } from '~/utils/status'

const { t, locale } = useI18n()
const api = useApi()
const settings = ref<DepartmentAiSettings | null>(null)
const status = ref<DepartmentStatus | null>(null)
const budget = ref('')
const error = ref('')
const loadFailure = ref<unknown>(null)
const budgetError = ref('')
const saved = ref(false)
const busy = ref(false)

const usage = computed(() => settings.value?.usage ?? null)
const percent = computed(() => usagePercent(usage.value))
const barColor = computed(() => usageColor(percent.value))
// Per-project spend this month, from the department status (best effort: the page works without it).
const projectSpend = computed(() => {
  if (!status.value) return []
  const rows = status.value.projects.filter(p => p.aiSpendUsd > 0 || p.aiBudgetUsd != null).map(p => ({ id: p.projectId, name: p.name, spend: p.aiSpendUsd, budget: p.aiBudgetUsd }))
  rows.sort((a, b) => b.spend - a.spend)
  return rows
})
const dirty = computed(() => budget.value !== (settings.value?.aiBudgetUsd == null ? '' : String(settings.value.aiBudgetUsd)))

/** `YYYY-MM` → "พฤศจิกายน 2569" / "November 2026". */
const monthLabel = (m: string) =>
  /^\d{4}-\d{2}$/.test(m)
    ? new Intl.DateTimeFormat(locale.value === 'en' ? 'en-GB' : 'th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-15T00:00:00Z`))
    : m

async function load() {
  try {
    const s = await api<DepartmentAiSettings>('/admin/ai-settings')
    settings.value = s
    budget.value = s.aiBudgetUsd == null ? '' : String(s.aiBudgetUsd)
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
  status.value = await api<DepartmentStatus>('/status').catch(() => null)
}

async function save() {
  budgetError.value = ''
  saved.value = false
  const n = parseBudgetInput(budget.value)
  if (n === undefined) {
    budgetError.value = t('ai.invalidBudget')
    return
  }
  busy.value = true
  try {
    const body: DepartmentAiSettingsPatch = { aiBudgetUsd: n }
    const s = await api<DepartmentAiSettings>('/admin/ai-settings', { method: 'PATCH', body })
    settings.value = s
    budget.value = s.aiBudgetUsd == null ? '' : String(s.aiBudgetUsd)
    saved.value = true
  } catch (e) {
    budgetError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-ai">
    <PageHeader :title="t('ai.deptTitle')" />
    <ErrorState v-if="error && !settings" :error="loadFailure" data-testid="ai-error" @retry="load" />
    <SkeletonList v-else-if="!settings" :rows="3" />
    <template v-else>
      <v-card class="mb-4">
        <div class="card-head"><h2>{{ t('ai.budgetCard') }}</h2></div>
        <div class="card-body">
          <div class="admin-grid">
            <label for="dept-budget" class="text-body-2 font-weight-medium">{{ t('ai.budget') }}</label>
            <div>
              <div class="d-flex flex-wrap ga-3 align-start">
                <v-text-field
                  id="dept-budget"
                  v-model="budget"
                  :label="t('ai.budget')"
                  :error-messages="budgetError ? [budgetError] : []"
                  type="number"
                  min="0"
                  step="0.01"
                  prefix="$"
                  class="admin-budget"
                  data-testid="budget-input"
                  @keyup.enter="save"
                />
                <v-btn color="primary" class="mt-1" :loading="busy" :disabled="!dirty" data-testid="save-budget" @click="save">{{ t('ai.saveBudget') }}</v-btn>
              </div>
              <p class="text-caption text-medium-emphasis mt-1 mb-0">{{ t('ai.deptHint') }}</p>
              <p v-if="saved" class="text-caption text-success d-flex align-center ga-1 mt-1 mb-0" data-testid="ai-saved"><v-icon icon="mdi-check" size="14" aria-hidden="true" />{{ t('ai.saved') }}</p>
            </div>
          </div>
        </div>
      </v-card>

      <v-card v-if="usage">
        <div class="card-head">
          <h2>{{ t('ai.usage') }}</h2>
          <span class="text-body-2 text-medium-emphasis">{{ monthLabel(usage.month) }}</span>
        </div>
        <div class="card-body" data-testid="ai-usage">
          <div class="d-flex flex-wrap align-baseline ga-2">
            <strong class="text-h5 tabular-nums" data-testid="ai-spend">{{ usd(usage.costUsd) }}</strong>
            <span class="text-body-2 text-medium-emphasis">
              {{ usage.budgetUsd == null ? t('status.kpi.noBudget') : t('status.kpi.ofBudget', { budget: usd(usage.budgetUsd) }) }}
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
        <template v-if="status">
          <div class="card-head ai-split-head"><h3>{{ t('ai.byProject') }}</h3></div>
          <v-table density="compact" data-testid="ai-projects">
            <thead>
              <tr>
                <th>{{ t('ai.project') }}</th>
                <th class="text-right">{{ t('ai.spend') }}</th>
                <th class="text-right">{{ t('ai.projectBudget') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in projectSpend" :key="p.id">
                <td><NuxtLink :to="`/projects/${p.id}?tab=ai`" class="row-link">{{ p.name }}</NuxtLink></td>
                <td class="text-right">{{ usd(p.spend) }}</td>
                <td class="text-right text-medium-emphasis">{{ p.budget == null ? t('ai.noLimit') : usd(p.budget) }}</td>
              </tr>
              <tr>
                <td class="text-medium-emphasis">{{ t('ai.departmentCalls') }}</td>
                <td class="text-right">{{ usd(status.departmentAiSpendUsd) }}</td>
                <td class="text-right text-medium-emphasis">–</td>
              </tr>
            </tbody>
          </v-table>
        </template>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.admin-grid { display: grid; grid-template-columns: 200px minmax(0, 680px); gap: 16px 24px; align-items: start; }
@media (max-width: 767px) { .admin-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
.admin-budget { flex: 1 1 200px; max-width: 280px; }
.ai-split-head { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
