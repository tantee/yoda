<script setup lang="ts">
import type { AiUsage, ProjectDetail } from '@yoda/shared'

const props = defineProps<{ project: ProjectDetail; canManage: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const api = useApi()
const usage = ref<AiUsage | null>(null)
const budget = ref('')
const error = ref('')

const percent = computed(() => {
  const u = usage.value
  if (!u || u.budgetUsd == null) return 0
  if (u.budgetUsd <= 0) return u.costUsd > 0 ? 100 : 0
  return Math.min(100, (u.costUsd / u.budgetUsd) * 100)
})
const barColor = computed(() => (percent.value >= 100 ? 'error' : percent.value >= 80 ? 'warning' : 'primary'))

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
  const raw = budget.value.trim()
  if (!raw) return patch({ aiBudgetUsd: null })
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    error.value = t('ai.invalidBudget')
    return
  }
  return patch({ aiBudgetUsd: n })
}

onMounted(loadUsage)
</script>

<template>
  <div data-testid="ai-settings">
    <v-alert v-if="error" type="error" class="mb-4" data-testid="ai-error">{{ error }}</v-alert>
    <p v-if="!canManage" class="text-medium-emphasis mb-2" data-testid="ai-readonly">{{ t('ai.readOnly') }}</p>
    <v-switch
      :model-value="project.noAi"
      :label="t('ai.noAi')"
      :disabled="!canManage"
      color="warning"
      hide-details
      data-testid="no-ai-switch"
      @update:model-value="(v) => patch({ noAi: !!v })"
    />
    <v-alert type="warning" variant="tonal" density="compact" class="mb-6" data-testid="no-ai-warning">{{ t('ai.noAiWarning') }}</v-alert>

    <div class="d-flex ga-4 align-start mb-6" style="max-width: 480px">
      <v-text-field
        v-model="budget"
        :label="t('ai.budget')"
        :hint="t('ai.budgetHint')"
        persistent-hint
        type="number"
        min="0"
        step="0.01"
        :disabled="!canManage"
        data-testid="budget-input"
        @keyup.enter="saveBudget"
      />
      <v-btn v-if="canManage" color="primary" class="mt-2" data-testid="save-budget" @click="saveBudget">{{ t('ai.saveBudget') }}</v-btn>
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
