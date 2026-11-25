<script setup lang="ts">
import type { TaskWithContext, TodoWorkItem } from '@yoda/shared'
import { localized } from '~/utils/localized'

/**
 * The To-do task tables (proposal §8.2, §6.3): "waiting for your confirmation" (what it waits for + actions) or
 * "my tasks" (state + due date). 40 px rows with a step track on desktop; stacked rows when `stacked`.
 */
const props = defineProps<{
  rows: TaskWithContext[]
  mode: 'confirmations' | 'mine'
  items: Record<string, TodoWorkItem>
  stacked?: boolean
  busyId?: string | null
}>()
const emit = defineEmits<{ assign: [TaskWithContext]; confirm: [TaskWithContext]; retried: [] }>()
const { t, locale } = useI18n()
const { date } = useDateFormat()

const itemOf = (task: TaskWithContext) => props.items[task.workItemId]
const confirmable = (task: TaskWithContext) => task.state === 'proposed' && !!task.proposedAssigneeId
const due = (task: TaskWithContext) => {
  const d = itemOf(task)?.targetDate
  return d ? t('todo.due', { date: date(d) }) : t('todo.noDue')
}
</script>

<template>
  <div class="task-rows">
    <v-table v-if="!stacked" class="task-rows__table">
      <thead>
        <tr>
          <th class="task-rows__prio">{{ t('todo.cols.priority') }}</th>
          <th>{{ t('todo.cols.task') }}</th>
          <th>{{ t('todo.cols.project') }}</th>
          <th class="task-rows__step">{{ t('todo.cols.step') }}</th>
          <th v-if="mode === 'confirmations'">{{ t('todo.cols.waiting') }}</th>
          <th v-else>{{ t('todo.cols.state') }}</th>
          <th class="text-right">{{ mode === 'confirmations' ? t('todo.cols.actions') : t('todo.cols.due') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in rows" :key="task.id" :data-testid="`todo-row-${task.id}`">
          <td class="task-rows__prio"><PriorityMark :priority="task.workItemPriority" data-testid="priority-chip" /></td>
          <td class="task-rows__title">
            <NuxtLink :to="`/todo/${task.id}`" class="task-rows__link">{{ localized(task.title, locale) }}</NuxtLink>
            <div class="task-rows__sub text-caption">{{ task.workItemTitle }}</div>
          </td>
          <td class="task-rows__project text-body-2 text-medium-emphasis">{{ task.projectName }}</td>
          <td class="task-rows__step">
            <StepTrack v-if="itemOf(task)?.steps.length" :steps="itemOf(task)!.steps" compact class="task-rows__track" />
            <span v-else class="text-medium-emphasis">—</span>
          </td>
          <td v-if="mode === 'confirmations'"><TodoWaiting :task="task" @retried="emit('retried')" /></td>
          <td v-else><StatusChip kind="task" :value="task.state" /></td>
          <td v-if="mode === 'confirmations'" class="text-right task-rows__actions">
            <template v-if="confirmable(task)">
              <v-btn variant="text" color="primary" size="small" data-testid="assign-open-btn" @click="emit('assign', task)">{{ t('todo.changePerson') }}</v-btn>
              <v-btn color="primary" size="small" :loading="busyId === task.id" data-testid="confirm-btn" @click="emit('confirm', task)">{{ t('todo.confirm') }}</v-btn>
            </template>
            <v-btn v-else variant="outlined" size="small" data-testid="assign-open-btn" @click="emit('assign', task)">{{ t('todo.assignPerson') }}</v-btn>
          </td>
          <td v-else class="text-right text-body-2 text-medium-emphasis tabular-nums task-rows__due">{{ due(task) }}</td>
        </tr>
      </tbody>
    </v-table>

    <ul v-else class="task-rows__stack">
      <li v-for="task in rows" :key="task.id" class="task-rows__item" :data-testid="`todo-row-${task.id}`">
        <NuxtLink :to="`/todo/${task.id}`" class="task-rows__link">{{ localized(task.title, locale) }}</NuxtLink>
        <div class="task-rows__sub text-caption">{{ task.workItemTitle }}</div>
        <div class="task-rows__meta text-caption">
          <PriorityMark :priority="task.workItemPriority" data-testid="priority-chip" />
          <span>{{ task.projectName }}</span>
          <StepTrack v-if="itemOf(task)?.steps.length" :steps="itemOf(task)!.steps" compact />
          <TodoWaiting v-if="mode === 'confirmations'" :task="task" @retried="emit('retried')" />
          <template v-else>
            <StatusChip kind="task" :value="task.state" />
            <span class="tabular-nums">{{ due(task) }}</span>
          </template>
        </div>
        <div v-if="mode === 'confirmations'" class="task-rows__stack-actions">
          <template v-if="confirmable(task)">
            <v-btn variant="text" color="primary" size="small" data-testid="assign-open-btn" @click="emit('assign', task)">{{ t('todo.changePerson') }}</v-btn>
            <v-btn color="primary" size="small" :loading="busyId === task.id" data-testid="confirm-btn" @click="emit('confirm', task)">{{ t('todo.confirm') }}</v-btn>
          </template>
          <v-btn v-else variant="outlined" size="small" data-testid="assign-open-btn" @click="emit('assign', task)">{{ t('todo.assignPerson') }}</v-btn>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.task-rows__table :deep(th) { white-space: nowrap; }
.task-rows__prio { width: 104px; }
.task-rows__step { width: 200px; }
.task-rows__title { min-width: 220px; padding-top: 6px !important; padding-bottom: 6px !important; }
.task-rows__link { color: inherit; font-weight: 500; text-decoration: none; overflow-wrap: anywhere; }
.task-rows__link:hover { text-decoration: underline; }
.task-rows__sub { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow-wrap: anywhere; }
.task-rows__project { min-width: 140px; max-width: 200px; overflow-wrap: anywhere; }
.task-rows__actions { white-space: nowrap; }
.task-rows__actions .v-btn + .v-btn { margin-left: 4px; }
.task-rows__due { white-space: nowrap; }
.task-rows__stack { list-style: none; margin: 0; padding: 0; }
.task-rows__item { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; }
.task-rows__item:first-child { border-top: 0; }
.task-rows__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 6px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.task-rows__stack-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
