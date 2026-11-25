<script setup lang="ts">
import type { BoardColumn } from '@yoda/shared'
import { localized } from '~/utils/localized'

defineProps<{ columns: BoardColumn[] }>()
const { t, locale } = useI18n()
const { date: fmtDate } = useDateFormat()
</script>

<template>
  <div class="status-board d-flex ga-3 pb-2" data-testid="board">
    <div v-for="col in columns" :key="col.stepKey" class="status-board__col" :data-step="col.stepKey" data-testid="board-column">
      <div class="d-flex align-center mb-2 px-1">
        <span class="text-subtitle-2 text-truncate">{{ localized(col.stepName, locale) }}</span>
        <v-spacer />
        <v-chip size="x-small" variant="tonal">{{ col.items.length }}</v-chip>
      </div>
      <v-card v-for="item in col.items" :key="item.id" variant="outlined" class="mb-2" :to="`/work-items/${item.id}`" :data-item="item.id" data-testid="board-card">
        <v-card-text class="pa-3">
          <div class="text-body-2 font-weight-medium mb-1">{{ item.title }}</div>
          <div class="d-flex flex-wrap ga-1 align-center">
            <PriorityMark :priority="item.priority" data-testid="board-priority" />
            <v-chip v-if="item.overdue" size="x-small" color="error" prepend-icon="mdi-calendar-alert" data-testid="board-overdue">{{ t('status.overdue') }}</v-chip>
            <v-chip v-if="item.stuckDays !== null" size="x-small" color="error" variant="outlined" prepend-icon="mdi-timer-sand" data-testid="board-stuck">
              {{ t('status.stuck', { n: item.stuckDays }, item.stuckDays) }}
            </v-chip>
          </div>
          <div class="text-caption text-medium-emphasis mt-1 d-flex flex-wrap ga-2">
            <span><v-icon icon="mdi-account-outline" size="x-small" /> {{ item.ownerName }}</span>
            <span v-if="item.targetDate" :class="{ 'text-error': item.overdue }" data-testid="board-target">
              <v-icon icon="mdi-calendar-outline" size="x-small" /> {{ t('status.due', { date: fmtDate(item.targetDate) }) }}
            </span>
          </div>
        </v-card-text>
      </v-card>
      <p v-if="!col.items.length" class="text-caption text-medium-emphasis px-1">-</p>
    </div>
  </div>
</template>

<style scoped>
.status-board {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.status-board__col {
  flex: 0 0 260px;
  min-width: 260px;
  background: rgba(var(--v-theme-on-surface), 0.04);
  border-radius: 8px;
  padding: 8px;
}
</style>
