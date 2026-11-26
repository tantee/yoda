<script setup lang="ts">
import { usageColor } from '~/utils/aiBudget'
import { spendPercent, usd } from '~/utils/status'

/**
 * The four KPI tiles of the project status tab and the department status page (proposal §8.2): active items,
 * overdue (red, with a link to the list when the page has one), open discussions, and this month's AI spend with
 * a budget bar. `budget` undefined hides the budget line (department totals have no single budget).
 */
const props = defineProps<{
  active: number
  overdue: number
  discussions: number
  spend: number
  budget?: number | null
  /** Show "ดูรายการ" under the overdue count (the project page switches to the filtered work items). */
  overdueLink?: boolean
}>()
const emit = defineEmits<{ showOverdue: [] }>()
const { t } = useI18n()
const percent = computed(() => (props.budget === undefined ? null : spendPercent(props.spend, props.budget)))
</script>

<template>
  <div class="kpi-tiles" data-testid="status-totals">
    <v-card class="kpi" data-total="activeItems" data-testid="kpi-active">
      <div class="kpi__label"><v-icon icon="mdi-progress-clock" size="16" aria-hidden="true" />{{ t('status.totals.activeItems') }}</div>
      <div class="kpi__value text-h5">{{ active }}</div>
    </v-card>
    <v-card class="kpi" data-total="overdueItems" data-testid="kpi-overdue">
      <div class="kpi__label"><v-icon icon="mdi-calendar-alert" size="16" aria-hidden="true" />{{ t('status.totals.overdueItems') }}</div>
      <div class="kpi__value text-h5" :class="{ 'text-error': overdue > 0 }">{{ overdue }}</div>
      <a v-if="overdueLink && overdue > 0" href="#" class="kpi__sub text-primary" data-testid="kpi-overdue-link" @click.prevent="emit('showOverdue')">{{ t('status.kpi.overdueLink') }}</a>
    </v-card>
    <v-card class="kpi" data-total="openDiscussions" data-testid="kpi-discussions">
      <div class="kpi__label"><v-icon icon="mdi-forum-outline" size="16" aria-hidden="true" />{{ t('status.totals.openDiscussions') }}</div>
      <div class="kpi__value text-h5">{{ discussions }}</div>
      <NuxtLink v-if="discussions > 0" to="/discussions" class="kpi__sub text-primary">{{ t('status.kpi.discussionsLink') }}</NuxtLink>
    </v-card>
    <v-card class="kpi" data-total="aiSpend" data-testid="kpi-ai">
      <div class="kpi__label"><v-icon icon="mdi-cash-multiple" size="16" aria-hidden="true" />{{ t('status.totals.aiSpend') }}</div>
      <div class="kpi__value">
        <span class="text-h5 tabular-nums">{{ usd(spend) }}</span>
        <span v-if="budget != null" class="text-body-2 text-medium-emphasis ml-1">{{ t('status.kpi.ofBudget', { budget: usd(budget) }) }}</span>
      </div>
      <v-progress-linear v-if="percent !== null && budget != null" :model-value="percent" :color="usageColor(percent)" height="6" rounded class="mt-2" :aria-label="t('status.totals.aiSpend')" data-testid="ai-budget-bar" />
      <div v-else-if="budget === null" class="kpi__sub text-medium-emphasis">{{ t('status.kpi.noBudget') }}</div>
    </v-card>
  </div>
</template>

<style scoped>
.kpi-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 959px) { .kpi-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.kpi { padding: 16px; min-width: 0; }
.kpi__label { display: flex; align-items: center; gap: 6px; font-size: .8125rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.kpi__value { margin-top: 4px; font-weight: 600; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.kpi__sub { display: inline-block; margin-top: 4px; font-size: .8125rem; text-decoration: none; }
a.kpi__sub:hover { text-decoration: underline; }
</style>
