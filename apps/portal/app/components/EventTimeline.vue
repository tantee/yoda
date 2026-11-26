<script setup lang="ts">
import type { EventEntry } from '@yoda/shared'
import { guardOf } from '~/utils/guards'
import { eventDot, relativeDay, timelineDays } from '~/utils/timeline'

/** Only task creation / proposal events use a guard name as their reason; elsewhere a reason is free text. */
const guardFor = (ev: EventEntry) =>
  guardOf(ev.payload, ev.type === 'task.created' || ev.type === 'task.proposed' ? ev.reason : null)

/**
 * The timeline (proposal §6.9): grouped by Bangkok day (newest first) with a sticky day heading, time-only rows,
 * key events with a filled dot, AI events hollow indigo, the rest hollow gray. Status timelines pass project
 * events, which also name their work item; the work item page passes its task titles.
 */
const props = defineProps<{
  events: (EventEntry & { seq?: number; workItemId?: string | null; workItemTitle?: string | null })[]
  taskTitles?: Record<string, string>
}>()
const { t, te } = useI18n()
const dateOf = (v: unknown) => (typeof v === 'string' ? v : null)
const { date, dateTime, time } = useDateFormat()
const days = computed(() => timelineDays(props.events))
function dayHeading(day: string): string {
  const rel = relativeDay(day)
  return rel ? t(`timeline.${rel}`, { date: date(day) }) : date(day)
}
const taskTitle = (ev: EventEntry) => (ev.taskId ? props.taskTitles?.[ev.taskId] : undefined)
</script>

<template>
  <div class="event-timeline" data-testid="timeline">
    <section v-for="g in days" :key="g.day" class="et-day" data-testid="timeline-day">
      <h3 class="et-day__head text-body-2">{{ dayHeading(g.day) }}</h3>
      <ol class="et-list">
        <li v-for="ev in g.items" :key="ev.id" class="et-row" :data-dot="eventDot(ev)" data-testid="timeline-item">
          <span class="et-dot" :class="`et-dot--${eventDot(ev)}`" aria-hidden="true" />
          <time class="et-time text-body-2 tabular-nums" :datetime="ev.createdAt" :title="dateTime(ev.createdAt)">{{ time(ev.createdAt) }}</time>
          <div class="et-body text-body-2">
            <div>
              <span class="et-label">{{ t(`events.${ev.type}`) }}</span>
              <strong v-if="taskTitle(ev)" class="et-object">{{ taskTitle(ev) }}</strong>
              <span class="text-medium-emphasis">
                ·
                <span v-if="ev.actorKind === 'ai'" class="et-ai" data-testid="ai-avatar">{{ t('events.aiLabel') }}</span>
                <template v-else>{{ ev.actorName ?? t('events.system') }}</template>
              </span>
            </div>
            <NuxtLink v-if="ev.workItemId && ev.workItemTitle" :to="`/work-items/${ev.workItemId}`" class="et-link" data-testid="timeline-work-item">{{ ev.workItemTitle }}</NuxtLink>
            <div v-if="ev.type === 'work_item.target_date_changed'" class="text-medium-emphasis" data-testid="timeline-target-date">
              {{ dateOf(ev.payload.from) ? date(dateOf(ev.payload.from)) : t('workItems.noTargetDate') }} →
              {{ dateOf(ev.payload.to) ? date(dateOf(ev.payload.to)) : t('workItems.noTargetDate') }}
            </div>
            <GuardNote v-if="guardFor(ev)" :guard="guardFor(ev)!" class="mt-1" />
            <div v-else-if="ev.reason" class="text-medium-emphasis et-reason">{{ te(`events.reason.${ev.reason}`) ? t(`events.reason.${ev.reason}`) : ev.reason }}</div>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.et-day + .et-day { margin-top: 8px; }
.et-day__head {
  position: sticky; top: var(--et-sticky-top, 0px); z-index: 1; margin: 0; padding: 8px 0 4px;
  font-weight: 600; background: rgb(var(--v-theme-surface));
}
.et-list { list-style: none; margin: 0; padding: 0; position: relative; }
.et-row { position: relative; display: grid; grid-template-columns: 12px 44px minmax(0, 1fr); gap: 4px 10px; align-items: start; padding: 5px 0; }
.et-row::before {
  content: ''; position: absolute; left: 5px; top: 0; bottom: 0; width: 1px;
  background: rgba(var(--v-border-color), var(--v-border-opacity));
}
.et-row:first-child::before { top: 12px; }
.et-row:last-child::before { bottom: calc(100% - 12px); }
.et-dot { position: relative; z-index: 1; width: 11px; height: 11px; margin-top: 5px; border-radius: 50%; border: 2px solid rgb(var(--v-theme-neutral-dot)); background: rgb(var(--v-theme-surface)); }
.et-dot--key { border-color: rgb(var(--v-theme-primary)); background: rgb(var(--v-theme-primary)); }
.et-dot--ai { border-color: rgb(var(--v-theme-ai-dot)); }
.et-time { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.et-body { min-width: 0; overflow-wrap: anywhere; }
.et-object { font-weight: 600; margin-left: 4px; }
.et-ai { color: rgb(var(--v-theme-ai)); font-weight: 500; }
.et-link { display: inline-block; }
.et-reason { white-space: pre-wrap; }
</style>
