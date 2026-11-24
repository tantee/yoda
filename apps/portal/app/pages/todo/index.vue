<script setup lang="ts">
import type { Todo } from '@yoda/shared'
import { localized } from '~/utils/localized'

const { t, locale } = useI18n()
const api = useApi()
const todo = ref<Todo | null>(null)
const loadError = ref('')
const error = ref('')

async function load() {
  try {
    todo.value = await api<Todo>('/me/todo')
    loadError.value = ''
  } catch (e) {
    loadError.value = t(errorKey(e))
  }
}

async function confirm(id: string) {
  error.value = ''
  try {
    await api(`/tasks/${id}/confirm`, { method: 'POST' })
  } catch (e) {
    error.value = t(errorKey(e))
  }
  await load()
}

onMounted(load)
useLiveEvents(() => load())

const isEmpty = computed(() => !todo.value?.tasks.length && !todo.value?.confirmations.length)
</script>

<template>
  <div>
    <h1 class="text-h5 mb-4">{{ t('nav.todo') }}</h1>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>
    <template v-if="todo">
      <p v-if="isEmpty" class="text-medium-emphasis" data-testid="todo-empty">{{ t('todo.empty') }}</p>

      <template v-if="todo.tasks.length">
        <h2 class="text-h6 mb-2">{{ t('todo.myTasks') }}</h2>
        <v-list class="mb-6" border lines="two" data-testid="my-tasks">
          <v-list-item v-for="task in todo.tasks" :key="task.id" :to="`/todo/${task.id}`">
            <v-list-item-title>{{ localized(task.title, locale) }}</v-list-item-title>
            <v-list-item-subtitle>{{ task.projectName }} · {{ task.workItemTitle }}</v-list-item-subtitle>
            <template #append>
              <v-chip size="small">{{ t(`task.state.${task.state}`) }}</v-chip>
            </template>
          </v-list-item>
        </v-list>
      </template>

      <template v-if="todo.confirmations.length">
        <h2 class="text-h6 mb-2">{{ t('todo.confirmations') }}</h2>
        <v-list border lines="two" data-testid="confirmations">
          <v-list-item v-for="task in todo.confirmations" :key="task.id" :to="`/todo/${task.id}`">
            <v-list-item-title>{{ localized(task.title, locale) }}</v-list-item-title>
            <v-list-item-subtitle>
              {{ task.projectName }} · {{ task.workItemTitle }} ·
              {{ task.proposedAssigneeName ?? t('todo.needsAssignee') }}
            </v-list-item-subtitle>
            <template #append>
              <v-btn
                v-if="task.state === 'proposed' && task.proposedAssigneeId"
                color="primary"
                size="small"
                data-testid="confirm-btn"
                @click.prevent.stop="confirm(task.id)"
              >{{ t('todo.confirm') }}</v-btn>
            </template>
          </v-list-item>
        </v-list>
      </template>
    </template>
  </div>
</template>
