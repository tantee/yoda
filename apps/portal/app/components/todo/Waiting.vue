<script setup lang="ts">
import type { TaskWithContext } from '@yoda/shared'
import { waitingOf } from '~/utils/todo'

/** "สิ่งที่รออยู่" for a confirmation row: AI drafting / failed (with retry), a runner, a proposed person, nobody. */
const props = defineProps<{ task: TaskWithContext }>()
const emit = defineEmits<{ retried: [] }>()
const { t } = useI18n()
const waiting = computed(() => waitingOf(props.task))
</script>

<template>
  <span class="todo-waiting text-body-2" :data-waiting="waiting">
    <AiStatus v-if="waiting === 'drafting' || waiting === 'failed'" :task="task" can-retry class="todo-waiting__ai" @retried="emit('retried')" />
    <StatusChip v-else-if="waiting === 'runner'" kind="waiting" value="runner" data-testid="waiting-runner" />
    <span v-else-if="waiting === 'ai'" class="todo-waiting__ai"><v-icon icon="mdi-creation-outline" size="16" aria-hidden="true" />{{ t('todo.waitingAi') }}</span>
    <span v-else-if="waiting === 'proposed'"><v-icon icon="mdi-account-check-outline" size="16" class="text-warning" aria-hidden="true" />{{ t('todo.proposedTo', { name: task.proposedAssigneeName }) }}</span>
    <span v-else class="text-warning"><v-icon icon="mdi-account-alert-outline" size="16" aria-hidden="true" />{{ t('todo.needsAssignee') }}</span>
  </span>
</template>

<style scoped>
.todo-waiting, .todo-waiting > span { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.todo-waiting__ai { color: rgb(var(--v-theme-ai)); }
</style>
