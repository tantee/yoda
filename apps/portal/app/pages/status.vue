<script setup lang="ts">
import type { DepartmentStatus, LiveEvent, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { usd } from '~/utils/status'

const { t, locale } = useI18n()
const api = useApi()
const status = ref<DepartmentStatus | null>(null)
const templates = ref<WorkflowTemplateSummary[]>([])
const error = ref('')

/** Step keys are shared across templates; the newest template that has the key names it. */
function stepName(key: string): string {
  const step = [...templates.value].sort((a, b) => b.version - a.version).flatMap(x => x.steps).find(s => s.key === key)
  return step ? localized(step.name, locale.value) : key
}

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const s = await api<DepartmentStatus>('/status')
    if (mine !== seq) return
    status.value = s
    error.value = ''
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
  if (!templates.value.length) {
    try {
      templates.value = await api<WorkflowTemplateSummary[]>('/workflow-templates')
    } catch {
      // Step chips fall back to their keys.
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 1000)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
onMounted(load)

const RELOAD_ON = ['work_item.', 'task.', 'discussion.', 'gitlab.issue_sync', 'ai.budget']
useLiveEvents((e: LiveEvent) => {
  if (RELOAD_ON.some(p => e.type.startsWith(p))) loadSoon()
}, loadSoon)

const totals = computed(() => {
  const s = status.value
  if (!s) return []
  return [
    { key: 'activeItems', value: String(s.totals.activeItems) },
    { key: 'overdueItems', value: String(s.totals.overdueItems), alert: s.totals.overdueItems > 0 },
    { key: 'openDiscussions', value: String(s.totals.openDiscussions) },
    { key: 'aiSpend', value: usd(s.totals.aiSpendUsd) },
  ]
})
</script>

<template>
  <div>
    <h1 class="text-h5">{{ t('status.title') }}</h1>
    <p class="text-medium-emphasis mb-4">{{ t('status.subtitle') }}</p>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="status-error">{{ error }}</v-alert>
    <v-progress-linear v-if="!status && !error" indeterminate class="mb-4" data-testid="status-loading" />
    <template v-if="status">
      <v-row class="mb-2" dense data-testid="status-totals">
        <v-col v-for="x in totals" :key="x.key" cols="6" md="3">
          <v-card variant="tonal" :data-total="x.key">
            <v-card-text>
              <div class="text-caption text-medium-emphasis">{{ t(`status.totals.${x.key}`) }}</div>
              <div class="text-h5" :class="{ 'text-error': x.alert }">{{ x.value }}</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
      <p v-if="status.departmentAiSpendUsd > 0" class="text-caption text-medium-emphasis mb-4" data-testid="department-ai">
        {{ t('status.totals.departmentAiSpend', { amount: usd(status.departmentAiSpendUsd) }) }}
      </p>
      <p v-if="!status.projects.length" class="text-medium-emphasis" data-testid="status-empty">{{ t('status.empty') }}</p>
      <v-row v-else>
        <v-col v-for="p in status.projects" :key="p.projectId" cols="12" sm="6" lg="4">
          <StatusProjectCard :project="p" :step-name="stepName" />
        </v-col>
      </v-row>
    </template>
  </div>
</template>
