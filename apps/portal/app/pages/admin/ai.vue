<script setup lang="ts">
import type { DepartmentAiSettings, DepartmentStatus } from '@yoda/shared'
import { usd } from '~/utils/status'

// Usage and project budgets. The department budget and the fun-mode switch moved to System settings → AI (§5.2).
const { t } = useI18n()
const { month } = useDateFormat()
const api = useApi()
const settings = ref<DepartmentAiSettings | null>(null)
const status = ref<DepartmentStatus | null>(null)
const error = ref('')
const loadFailure = ref<unknown>(null)

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

async function load() {
  try {
    settings.value = await api<DepartmentAiSettings>('/admin/ai-settings')
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
  status.value = await api<DepartmentStatus>('/status').catch(() => null)
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-ai">
    <PageHeader :title="t('ai.deptTitle')">
      <template #actions>
        <v-btn variant="outlined" prepend-icon="mdi-cog-outline" to="/admin/settings/ai" data-testid="ai-settings-link">{{ t('settings.ai.budgetLink') }}</v-btn>
      </template>
    </PageHeader>
    <ErrorState v-if="error && !settings" :error="loadFailure" data-testid="ai-error" @retry="load" />
    <SkeletonList v-else-if="!settings" :rows="3" />
    <template v-else>
      <v-card v-if="usage">
        <div class="card-head">
          <h2>{{ t('ai.usage') }}</h2>
          <span class="text-body-2 text-medium-emphasis">{{ month(usage.month) }}</span>
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
.ai-split-head { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
