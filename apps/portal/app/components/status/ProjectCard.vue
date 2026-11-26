<script setup lang="ts">
import type { ProjectStatusSummary } from '@yoda/shared'
import { usageColor } from '~/utils/aiBudget'
import { localized } from '~/utils/localized'
import { reasonText, spendPercent, usd } from '~/utils/status'

/**
 * One project on the department status page (proposal §8.2 Status): name + health, the top reason (the rest in a
 * menu), active / overdue / discussions as numbers, AI spend with a budget bar, and a mini board (items per step).
 */
const props = defineProps<{ project: ProjectStatusSummary }>()
const { t, locale } = useI18n()
const percent = computed(() => spendPercent(props.project.aiSpendUsd, props.project.aiBudgetUsd))
const steps = computed(() => Object.entries(props.project.countsByStep))
const stepName = (key: string) => {
  const name = props.project.stepNames[key]
  return name ? localized(name, locale.value) : key
}
const top = computed(() => props.project.reasons[0] ?? null)
const more = computed(() => props.project.reasons.length - 1)
</script>

<template>
  <v-card class="project-card" :data-project="project.projectId" data-testid="project-card">
    <div class="card-head">
      <NuxtLink :to="`/projects/${project.projectId}?tab=status`" class="row-link project-card__name" data-testid="project-link">{{ project.name }}</NuxtLink>
      <StatusHealthChip :health="project.health" />
    </div>
    <div class="card-body project-card__body">
      <div class="project-card__reason text-body-2" data-testid="health-reasons">
        <template v-if="top">
          <v-icon :icon="project.health === 'blocked' ? 'mdi-alert-octagon-outline' : 'mdi-alert-outline'" :color="project.health === 'blocked' ? 'error' : 'warning'" size="16" aria-hidden="true" />
          <span :data-code="top.code" data-testid="health-reason">{{ reasonText(t, top) }}</span>
          <v-menu v-if="more > 0" location="bottom start">
            <template #activator="{ props: menuProps }">
              <button v-bind="menuProps" type="button" class="project-card__more text-primary" data-testid="reasons-more">{{ t('status.card.moreReasons', { n: more }) }}</button>
            </template>
            <v-card class="pa-3" max-width="360">
              <StatusReasons :reasons="project.reasons" />
            </v-card>
          </v-menu>
        </template>
        <span v-else class="text-medium-emphasis">{{ t('status.card.noReasons') }}</span>
      </div>

      <div class="project-card__numbers">
        <div data-testid="card-active"><div class="text-caption text-medium-emphasis">{{ t('status.card.active') }}</div><div class="text-h6 tabular-nums">{{ project.activeItems }}</div></div>
        <div data-testid="card-overdue">
          <div class="text-caption text-medium-emphasis">{{ t('status.card.overdue') }}</div>
          <div class="text-h6 tabular-nums" :class="{ 'text-error': project.overdueItems > 0 }">{{ project.overdueItems }}</div>
        </div>
        <div data-testid="card-discussions"><div class="text-caption text-medium-emphasis">{{ t('status.card.discussions') }}</div><div class="text-h6 tabular-nums">{{ project.openDiscussions }}</div></div>
      </div>

      <div data-testid="card-ai">
        <div class="text-caption text-medium-emphasis">{{ t('status.card.aiSpend') }}</div>
        <template v-if="percent !== null">
          <div class="text-body-2 tabular-nums">{{ t('status.card.ofBudget', { spend: usd(project.aiSpendUsd), budget: usd(project.aiBudgetUsd ?? 0) }) }}</div>
          <v-progress-linear :model-value="percent" :color="usageColor(percent)" bg-color="neutral-soft" bg-opacity="1" height="6" rounded class="mt-1" data-testid="ai-budget-bar" />
        </template>
        <div v-else class="text-body-2 text-medium-emphasis tabular-nums">{{ t('status.card.noBudgetShort', { amount: usd(project.aiSpendUsd) }) }}</div>
      </div>

      <div v-if="steps.length" class="project-card__steps" :aria-label="t('status.card.byStep')" data-testid="step-counts">
        <div v-for="[key, n] in steps" :key="key" class="project-card__step" :class="{ 'project-card__step--zero': !n }">
          <span class="project-card__step-n tabular-nums">{{ n }}</span>
          <span class="project-card__step-name">{{ stepName(key) }}</span>
        </div>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.project-card { height: 100%; display: flex; flex-direction: column; }
.project-card__name { min-width: 0; flex: 1 1 auto; }
.project-card__body { display: flex; flex-direction: column; gap: 16px; flex: 1 1 auto; }
.project-card__reason { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-height: 22px; }
.project-card__more { background: none; border: 0; padding: 0; font: inherit; font-size: .8125rem; cursor: pointer; }
.project-card__more:hover { text-decoration: underline; }
.project-card__numbers { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.project-card__steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: 4px; margin-top: auto; padding-top: 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.project-card__step { display: flex; flex-direction: column; align-items: center; text-align: center; min-width: 0; padding: 4px 2px; border-radius: 6px; background: rgb(var(--v-theme-primary-soft)); }
.project-card__step--zero { background: rgb(var(--v-theme-surface-light)); }
.project-card__step-n { font-weight: 600; font-size: .9375rem; }
.project-card__step--zero .project-card__step-n { color: #6B7789; }
.project-card__step-name { font-size: .75rem; line-height: 1.3; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow-wrap: anywhere; }
</style>
