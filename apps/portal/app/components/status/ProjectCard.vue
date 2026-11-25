<script setup lang="ts">
import type { ProjectStatusSummary } from '@yoda/shared'
import { usageColor } from '~/utils/aiBudget'
import { spendPercent, usd } from '~/utils/status'

const props = defineProps<{ project: ProjectStatusSummary; stepName: (key: string) => string }>()
const { t } = useI18n()
const percent = computed(() => spendPercent(props.project.aiSpendUsd, props.project.aiBudgetUsd))
const steps = computed(() => Object.entries(props.project.countsByStep).filter(([, n]) => n > 0))
</script>

<template>
  <v-card variant="outlined" class="h-100 d-flex flex-column" :data-project="project.projectId" data-testid="project-card">
    <v-card-item>
      <v-card-title class="d-flex align-center ga-2">
        <NuxtLink :to="`/projects/${project.projectId}?tab=status`" class="text-truncate text-decoration-none text-high-emphasis" data-testid="project-link">{{ project.name }}</NuxtLink>
        <v-spacer />
        <StatusHealthChip :health="project.health" />
      </v-card-title>
    </v-card-item>
    <v-card-text class="flex-grow-1">
      <StatusReasons :reasons="project.reasons" class="mb-3" />
      <div class="d-flex flex-wrap ga-4 mb-3 text-body-2">
        <div data-testid="card-active"><div class="text-caption text-medium-emphasis">{{ t('status.card.active') }}</div><div class="text-h6">{{ project.activeItems }}</div></div>
        <div data-testid="card-overdue">
          <div class="text-caption text-medium-emphasis">{{ t('status.card.overdue') }}</div>
          <div class="text-h6" :class="{ 'text-error': project.overdueItems > 0 }">{{ project.overdueItems }}</div>
        </div>
        <div data-testid="card-discussions"><div class="text-caption text-medium-emphasis">{{ t('status.card.discussions') }}</div><div class="text-h6">{{ project.openDiscussions }}</div></div>
      </div>
      <div class="mb-3" data-testid="card-ai">
        <div class="text-caption text-medium-emphasis">{{ t('status.card.aiSpend') }}</div>
        <template v-if="percent !== null">
          <div class="text-body-2">{{ t('status.card.ofBudget', { spend: usd(project.aiSpendUsd), budget: usd(project.aiBudgetUsd ?? 0) }) }}</div>
          <v-progress-linear :model-value="percent" :color="usageColor(percent)" height="6" rounded data-testid="ai-budget-bar" />
        </template>
        <div v-else class="text-body-2">{{ t('status.card.noBudget', { amount: usd(project.aiSpendUsd) }) }}</div>
      </div>
      <div v-if="steps.length" class="d-flex flex-wrap ga-1" data-testid="step-counts">
        <v-chip v-for="[key, n] in steps" :key="key" size="x-small" variant="tonal">{{ stepName(key) }} · {{ n }}</v-chip>
      </div>
    </v-card-text>
  </v-card>
</template>
