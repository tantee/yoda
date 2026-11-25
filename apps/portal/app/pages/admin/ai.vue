<script setup lang="ts">
import type { DepartmentAiSettings, DepartmentAiSettingsPatch } from '@yoda/shared'

const { t } = useI18n()
const api = useApi()
const settings = ref<DepartmentAiSettings | null>(null)
const budget = ref('')
const error = ref('')
const saved = ref(false)

const usage = computed(() => settings.value?.usage ?? null)
const percent = computed(() => usagePercent(usage.value))
const barColor = computed(() => usageColor(percent.value))

async function load() {
  try {
    const s = await api<DepartmentAiSettings>('/admin/ai-settings')
    settings.value = s
    budget.value = s.aiBudgetUsd == null ? '' : String(s.aiBudgetUsd)
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function save() {
  error.value = ''
  saved.value = false
  const n = parseBudgetInput(budget.value)
  if (n === undefined) {
    error.value = t('ai.invalidBudget')
    return
  }
  try {
    const body: DepartmentAiSettingsPatch = { aiBudgetUsd: n }
    const s = await api<DepartmentAiSettings>('/admin/ai-settings', { method: 'PATCH', body })
    settings.value = s
    budget.value = s.aiBudgetUsd == null ? '' : String(s.aiBudgetUsd)
    saved.value = true
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-ai">
    <h1 class="text-h5 mb-4">{{ t('ai.deptTitle') }}</h1>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="ai-error">{{ error }}</v-alert>
    <v-alert v-if="saved" type="success" variant="tonal" density="compact" class="mb-4" data-testid="ai-saved">{{ t('ai.saved') }}</v-alert>

    <div class="d-flex ga-4 align-start mb-6" style="max-width: 480px">
      <v-text-field
        v-model="budget"
        :label="t('ai.budget')"
        :hint="t('ai.deptHint')"
        persistent-hint
        type="number"
        min="0"
        step="0.01"
        data-testid="budget-input"
        @keyup.enter="save"
      />
      <v-btn color="primary" class="mt-2" data-testid="save-budget" @click="save">{{ t('ai.saveBudget') }}</v-btn>
    </div>

    <h3 class="text-subtitle-1 mb-2">{{ t('ai.usage') }}<span v-if="usage" class="text-medium-emphasis"> ({{ usage.month }})</span></h3>
    <div v-if="usage" data-testid="ai-usage">
      <p>
        {{ t('ai.spend') }}: <strong data-testid="ai-spend">${{ usage.costUsd.toFixed(4) }}</strong>
        / {{ usage.budgetUsd == null ? t('ai.noLimit') : '$' + usage.budgetUsd }}
        &middot; {{ t('ai.calls') }}: <span data-testid="ai-calls">{{ usage.calls }}</span>
      </p>
      <v-progress-linear
        v-if="usage.budgetUsd != null"
        :model-value="percent"
        :color="barColor"
        height="12"
        rounded
        class="mt-2"
        data-testid="ai-bar"
        :data-color="barColor"
      />
    </div>
  </div>
</template>
