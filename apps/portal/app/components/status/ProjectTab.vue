<script setup lang="ts">
import type { LiveEvent, ProjectStatus } from '@yoda/shared'

/**
 * The project status tab (proposal §8.2, mockup §9.3): KPI tiles, the reasons callout, the step board, then the
 * weekly summary and recent events beside member load and open discussions. The page owns loading and live reloads.
 */
const props = defineProps<{ projectId: string; status: ProjectStatus | null; noAi: boolean; canManage: boolean }>()
const emit = defineEmits<{ refresh: []; showOverdue: [] }>()
const { t } = useI18n()
const weekly = ref<{ onLive: (e: LiveEvent) => void } | null>(null)
const { date } = useDateFormat()
const EVENT_ROWS = 5
const allEvents = ref(false)
const events = computed(() => (props.status ? (allEvents.value ? props.status.recentEvents : props.status.recentEvents.slice(0, EVENT_ROWS)) : []))
const boardCount = computed(() => props.status?.board.reduce((n, c) => n + c.items.length, 0) ?? 0)

/** The page forwards this project's live events. */
function onLive(e: LiveEvent) {
  weekly.value?.onLive(e)
}
defineExpose({ onLive })
</script>

<template>
  <div data-testid="status-tab">
    <div v-if="!status" data-testid="status-loading">
      <div class="status-kpis mb-4"><v-skeleton-loader v-for="i in 4" :key="i" type="article" class="status-skeleton" /></div>
      <v-skeleton-loader type="table-row@4" class="status-skeleton" />
    </div>
    <template v-else>
      <StatusKpiTiles
        :active="status.activeItems"
        :overdue="status.overdueItems"
        :discussions="status.openDiscussions"
        :spend="status.aiSpendUsd"
        :budget="status.aiBudgetUsd"
        overdue-link
        class="mb-4"
        @show-overdue="emit('showOverdue')"
      />
      <StatusReasons :reasons="status.reasons" :health="status.health" callout class="mb-6" />

      <section class="mb-6" aria-labelledby="status-board-title">
        <div class="status-section-title">
          <h2 id="status-board-title" class="text-subtitle-1">{{ t('status.board') }}</h2>
          <span class="count-pill">{{ boardCount }}</span>
          <v-spacer />
          <span class="text-caption text-medium-emphasis d-none d-sm-inline">{{ t('status.boardHint') }}</span>
        </div>
        <p v-if="!status.board.some(c => c.items.length)" class="text-medium-emphasis mb-2" data-testid="board-empty">{{ t('status.boardEmpty') }}</p>
        <StatusBoard v-if="status.board.length" :columns="status.board" />
      </section>

      <div class="status-grid">
        <div class="status-grid__main">
          <StatusWeeklySummary
            ref="weekly"
            :project-id="projectId"
            :summary="status.weeklySummary"
            :in-progress="status.weeklyInProgress"
            :current-week="status.currentWeek"
            :no-ai="noAi"
            :ai-configured="status.aiConfigured"
            :can-manage="canManage"
            class="mb-4"
            @refresh="emit('refresh')"
          />
          <v-card class="mb-4" data-testid="status-events">
            <div class="card-head">
              <h2>{{ t('status.recentEvents') }}</h2>
              <v-btn
                v-if="status.recentEvents.length > EVENT_ROWS"
                variant="text"
                color="primary"
                size="small"
                data-testid="events-show-all"
                @click="allEvents = !allEvents"
              >{{ allEvents ? t('status.showLess') : t('status.showMoreEvents') }}</v-btn>
            </div>
            <div class="card-body pt-2">
              <p v-if="!status.recentEvents.length" class="text-medium-emphasis mb-0">{{ t('status.eventsEmpty') }}</p>
              <EventTimeline v-else :events="events" />
            </div>
          </v-card>
        </div>
        <div class="status-grid__side">
          <v-card class="mb-4">
            <div class="card-head"><h2>{{ t('status.people') }}</h2></div>
            <StatusPeopleLoad :people="status.people" />
          </v-card>
          <v-card class="mb-4">
            <div class="card-head"><h2>{{ t('status.discussions') }}</h2><span class="count-pill">{{ status.discussions.length }}</span></div>
            <p v-if="!status.discussions.length" class="card-body text-medium-emphasis mb-0">{{ t('status.discussionsEmpty') }}</p>
            <ul v-else class="status-discussions" data-testid="status-discussions">
              <li v-for="d in status.discussions" :key="d.id" data-testid="status-discussion">
                <NuxtLink :to="`/discussions/${d.id}`" class="row-link">{{ d.question }}</NuxtLink>
                <div class="status-discussions__meta text-caption text-medium-emphasis">
                  <PriorityMark :priority="d.priority" />
                  <StatusChip kind="discussion" :value="d.state" size="x-small" />
                  <span v-if="d.workItemTitle" class="text-truncate">{{ d.workItemTitle }}</span>
                  <span>{{ t('status.openedOn', { date: date(d.createdAt) }) }}</span>
                </div>
              </li>
            </ul>
          </v-card>
          <v-card class="mb-4">
            <div class="card-head"><h2>{{ t('status.repos') }}</h2><span class="count-pill">{{ status.repos.length }}</span></div>
            <p v-if="!status.repos.length" class="card-body text-medium-emphasis mb-0">{{ t('status.reposEmpty') }}</p>
            <v-list v-else density="compact" data-testid="status-repos">
              <v-list-item v-for="r in status.repos" :key="r.id" :href="r.webUrl" target="_blank" rel="noopener noreferrer" prepend-icon="mdi-gitlab" append-icon="mdi-open-in-new">
                <v-list-item-title class="text-body-2">{{ r.pathWithNamespace }}</v-list-item-title>
              </v-list-item>
            </v-list>
          </v-card>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.status-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 959px) { .status-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.status-skeleton { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
.status-section-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.status-section-title h2 { margin: 0; font-weight: 600; }
.status-grid { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 0 16px; }
@media (max-width: 1279px) { .status-grid { grid-template-columns: minmax(0, 1fr); } }
.status-discussions { list-style: none; margin: 0; padding: 0; }
.status-discussions li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.status-discussions li:first-child { border-top: 0; }
.status-discussions__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 4px; min-width: 0; }
</style>
