<script setup lang="ts">
import type { DepartmentAiSettings, DepartmentAiSettingsPatch } from '@yoda/shared'

/**
 * The department AI budget and the fun-mode switch (proposal §5.2: moved here from the AI budget page, which keeps
 * usage and project budgets). Both still live in `department_settings` (§5.5).
 */
const { t } = useI18n()
const api = useApi()
const settings = ref<DepartmentAiSettings | null>(null)
const failure = ref<unknown>(null)
const budget = ref('')
const budgetError = ref('')
const saved = ref(false)
const busy = ref(false)
const funBusy = ref(false)
const funError = ref('')
const funSaved = ref(false)
const { set: setFunMode } = useFunMode()
const dirty = computed(() => budget.value !== (settings.value?.aiBudgetUsd == null ? '' : String(settings.value.aiBudgetUsd)))

async function load() {
  try {
    const s = await api<DepartmentAiSettings>('/admin/ai-settings')
    settings.value = s
    budget.value = s.aiBudgetUsd == null ? '' : String(s.aiBudgetUsd)
    failure.value = null
  } catch (e) {
    failure.value = e
  }
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

/** The fun-mode switch saves at once and updates the shell (mark, lines, easter egg) without a reload. */
async function saveFun(on: boolean | null) {
  if (!settings.value || on === null) return
  funBusy.value = true
  funError.value = ''
  funSaved.value = false
  try {
    const body: DepartmentAiSettingsPatch = { funMode: !!on }
    const s = await api<DepartmentAiSettings>('/admin/ai-settings', { method: 'PATCH', body })
    settings.value = { ...settings.value, funMode: s.funMode }
    setFunMode(s.funMode)
    funSaved.value = true
  } catch (e) {
    funError.value = t(errorKey(e))
  } finally {
    funBusy.value = false
  }
}

onMounted(load)
</script>

<template>
  <ErrorState v-if="failure && !settings" :error="failure" class="mt-4" @retry="load" />
  <SkeletonList v-else-if="!settings" :rows="2" quiet class="mt-4" />
  <template v-else>
    <v-card class="mt-4" data-testid="budget-card">
      <div class="card-head">
        <h2>{{ t('ai.budgetCard') }}</h2>
        <span class="apply-live text-caption text-medium-emphasis"><v-icon icon="mdi-flash-outline" size="14" aria-hidden="true" />{{ t('settings.apply.live') }}</span>
      </div>
      <div class="card-body">
        <label for="dept-budget" class="setting-label">{{ t('ai.budget') }}</label>
        <div class="d-flex flex-wrap ga-3 align-start">
          <v-text-field
            id="dept-budget"
            v-model="budget"
            :error-messages="budgetError ? [budgetError] : []"
            type="number"
            min="0"
            step="0.01"
            prefix="$"
            hide-details="auto"
            class="dept-budget"
            data-testid="budget-input"
            @keyup.enter="save"
          />
          <v-btn color="primary" class="mt-1" :loading="busy" :disabled="!dirty" data-testid="save-budget" @click="save">{{ t('ai.saveBudget') }}</v-btn>
        </div>
        <p class="setting-meta">{{ t('ai.deptHint') }}</p>
        <p v-if="saved" class="text-caption text-success d-flex align-center ga-1 mt-1 mb-0" data-testid="ai-saved"><v-icon icon="mdi-check" size="14" aria-hidden="true" />{{ t('ai.saved') }}</p>
        <p class="setting-meta"><NuxtLink to="/admin/ai" class="text-primary">{{ t('settings.ai.usageLink') }}</NuxtLink></p>
      </div>
    </v-card>

    <v-card class="mt-4" data-testid="fun-card">
      <div class="card-head"><h2>{{ t('ai.funCard') }}</h2></div>
      <div class="card-body">
        <div class="d-flex align-center ga-4">
          <v-switch
            :model-value="settings.funMode"
            :label="t('ai.funMode')"
            :loading="funBusy"
            :disabled="funBusy"
            color="primary"
            inset
            hide-details
            data-testid="fun-switch"
            @update:model-value="saveFun"
          />
          <AppMark :size="32" :fun="settings.funMode" />
        </div>
        <p class="setting-meta">{{ t('ai.funHint') }}</p>
        <p v-if="funSaved" class="text-caption text-success d-flex align-center ga-1 mt-1 mb-0" role="status" data-testid="fun-saved"><v-icon icon="mdi-check" size="14" aria-hidden="true" />{{ settings.funMode ? t('ai.funOn') : t('ai.funOff') }}</p>
        <p v-if="funError" class="text-caption text-error mt-1 mb-0" role="alert" data-testid="fun-error">{{ funError }}</p>
      </div>
    </v-card>
  </template>
</template>

<style scoped>
.dept-budget { flex: 1 1 200px; max-width: 280px; }
.apply-live { display: inline-flex; align-items: center; gap: 4px; }
</style>
