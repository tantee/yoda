<script setup lang="ts">
import type { BoardColumn } from '@yoda/shared'
import { localized } from '~/utils/localized'

/**
 * The project board (proposal §4.2, §6.5): one column per step, `minmax(176px, 1fr)` so six fit at 1,440 px, scrolling
 * with snap inside its own container on narrow screens. Cards: title, priority glyph + due date, flags (overdue in
 * red with the date, idle days) with a red left edge, owner.
 */
defineProps<{ columns: BoardColumn[] }>()
const { t, locale } = useI18n()
const { date, dateShort } = useDateFormat()
</script>

<template>
  <div class="status-board" :style="{ '--board-cols': columns.length }" data-testid="board">
    <section v-for="col in columns" :key="col.stepKey" class="status-board__col" :data-step="col.stepKey" data-testid="board-column">
      <header class="status-board__head">
        <h3 class="text-body-2 font-weight-medium text-truncate">{{ localized(col.stepName, locale) }}</h3>
        <span class="count-pill">{{ col.items.length }}</span>
      </header>
      <NuxtLink
        v-for="item in col.items"
        :key="item.id"
        :to="`/work-items/${item.id}`"
        class="board-card"
        :class="{ 'board-card--flag': item.overdue || item.stuckDays !== null }"
        :data-item="item.id"
        data-testid="board-card"
      >
        <div class="board-card__title text-body-2">{{ item.title }}</div>
        <div class="board-card__meta text-caption">
          <PriorityMark :priority="item.priority" data-testid="board-priority" />
          <span v-if="item.targetDate && !item.overdue" class="d-inline-flex align-center ga-1 text-medium-emphasis" :title="date(item.targetDate)" data-testid="board-target">
            <v-icon icon="mdi-calendar-outline" size="14" aria-hidden="true" />{{ dateShort(item.targetDate) }}
          </span>
        </div>
        <div v-if="item.overdue || item.stuckDays !== null" class="board-card__flags text-caption">
          <span v-if="item.overdue" class="board-card__overdue" data-testid="board-overdue">
            <v-icon icon="mdi-calendar-alert" size="14" aria-hidden="true" />
            <span v-if="item.targetDate" :title="date(item.targetDate)" data-testid="board-target">{{ t('status.overdueOn', { date: dateShort(item.targetDate) }) }}</span>
            <span v-else>{{ t('status.overdue') }}</span>
          </span>
          <v-chip v-if="item.stuckDays !== null" size="x-small" color="error" prepend-icon="mdi-timer-sand" data-testid="board-stuck">
            {{ t('status.stuckShort', { n: item.stuckDays }) }}
          </v-chip>
        </div>
        <div class="board-card__owner text-caption text-medium-emphasis">
          <v-icon icon="mdi-account-outline" size="14" aria-hidden="true" /> {{ item.ownerName }}
        </div>
      </NuxtLink>
      <p v-if="!col.items.length" class="status-board__empty text-caption">{{ t('status.columnEmpty') }}</p>
    </section>
  </div>
</template>

<style scoped>
.status-board {
  display: grid; grid-template-columns: repeat(var(--board-cols), minmax(176px, 1fr)); gap: 12px;
  overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch;
}
@media (max-width: 1279px) {
  .status-board { scroll-snap-type: x mandatory; grid-template-columns: repeat(var(--board-cols), minmax(220px, 1fr)); }
  .status-board__col { scroll-snap-align: start; }
}
@media (max-width: 599px) {
  .status-board { grid-template-columns: repeat(var(--board-cols), 78%); }
}
.status-board__col { background: rgb(var(--v-theme-surface-light)); border-radius: 8px; padding: 8px; min-width: 0; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.status-board__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 0; }
.status-board__head h3 { margin: 0; min-width: 0; }
.status-board__empty { color: #556275; text-align: center; margin: 12px 0 0; }
.board-card {
  display: block; background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px; padding: 10px 12px; color: inherit; text-decoration: none; min-width: 0;
}
.board-card:hover { border-color: rgb(var(--v-theme-primary)); }
.board-card--flag { border-left: 3px solid rgb(var(--v-theme-error)); }
.board-card__title { font-weight: 500; overflow-wrap: anywhere; }
.board-card__meta, .board-card__flags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 6px; }
.board-card__overdue { display: inline-flex; align-items: center; gap: 4px; color: rgb(var(--v-theme-error)); font-weight: 500; }
.board-card__owner { margin-top: 6px; overflow-wrap: anywhere; }
</style>
