<script setup lang="ts">
import type { Todo } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { proposalFallbackKey } from '~/utils/requests'
import { guardOf } from '~/utils/guards'
import { waitingFor } from '~/utils/runners'

const { t, locale } = useI18n()
const api = useApi()
const todo = ref<Todo | null>(null)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const error = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<Todo>('/me/todo')
    if (mine !== seq) return
    todo.value = result
    loadError.value = ''
  } catch (e) {
    if (mine !== seq) return
    loadError.value = t(errorKey(e))
    loadFailure.value = e
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 200)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function advance(workItemId: string) {
  error.value = ''
  advancing.value = workItemId
  try {
    await api(`/work-items/${workItemId}/advance`, { method: 'POST' })
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    advancing.value = null
  }
  await load()
}
const advancing = ref<string | null>(null)

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
useLiveEvents(loadSoon, loadSoon)

const isEmpty = computed(
  () =>
    !todo.value?.tasks.length &&
    !todo.value?.confirmations.length &&
    !todo.value?.proposals.length &&
    !todo.value?.awaitingAdvance.length,
)
</script>

<template>
  <div>
    <PageHeader :title="t('nav.todo')" />
    <ErrorState v-if="loadError && !todo" :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <SkeletonList v-else-if="!todo" />
    <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>
    <template v-if="todo">
      <EmptyState v-if="isEmpty" icon="mdi-check-circle-outline" :title="t('todo.empty')" data-testid="todo-empty" />

      <template v-if="todo.tasks.length">
        <h2 class="text-h6 mb-2">{{ t('todo.myTasks') }}</h2>
        <v-list class="mb-6" border lines="two" data-testid="my-tasks">
          <v-list-item v-for="task in todo.tasks" :key="task.id" :to="`/todo/${task.id}`">
            <v-list-item-title>{{ localized(task.title, locale) }}</v-list-item-title>
            <v-list-item-subtitle>{{ task.projectName }} · {{ task.workItemTitle }}</v-list-item-subtitle>
            <template #append>
              <PriorityMark :priority="task.workItemPriority" class="mr-3" data-testid="priority-chip" />
              <StatusChip kind="task" :value="task.state" />
            </template>
          </v-list-item>
        </v-list>
      </template>

      <template v-if="todo.proposals.length || todo.awaitingAdvance.length">
        <h2 class="text-h6 mb-2">{{ t('todo.proposals') }}</h2>
        <v-card
          v-for="w in todo.awaitingAdvance"
          :key="w.id"
          variant="outlined"
          class="mb-3"
          data-testid="awaiting-advance-item"
        >
          <v-card-text class="d-flex flex-wrap align-center ga-2">
            <div>
              <div class="font-weight-medium">{{ t('todo.awaitingAdvance') }}</div>
              <NuxtLink :to="`/work-items/${w.id}`" class="text-caption">{{ w.title }}</NuxtLink>
            </div>
            <v-spacer />
            <v-btn
              color="primary"
              size="small"
              v-if="!w.openDiscussions"
              :loading="advancing === w.id"
              data-testid="todo-advance-btn"
              @click="advance(w.id)"
            >{{ t('workItems.advance') }}</v-btn>
          </v-card-text>
        </v-card>
        <v-card
          v-for="p in todo.proposals"
          :key="p.id"
          variant="outlined"
          class="mb-3"
          data-testid="proposal-item"
        >
          <v-card-text>
            <div class="font-weight-medium" data-testid="proposal-summary">{{ p.summary || (proposalFallbackKey(p) ? t(proposalFallbackKey(p)!) : '') }}</div>
            <ProposalPreview :proposal="p" />
            <GuardNote v-if="guardOf(p.payload)" :guard="guardOf(p.payload)!" />
            <div v-else-if="p.reason" class="text-caption text-medium-emphasis">{{ p.reason }}</div>
            <div v-if="p.requesterName" class="text-caption" data-testid="proposal-requester">{{ t('chat.card.requester') }}: {{ p.requesterName }}</div>
            <div v-if="p.workItemId" class="text-caption">
              <NuxtLink :to="`/work-items/${p.workItemId}`">{{ t('todo.workItem') }}</NuxtLink>
            </div>
            <ProposalDecide :proposal="p" @decided="load" />
          </v-card-text>
        </v-card>
        <div class="mb-6" />
      </template>

      <template v-if="todo.confirmations.length">
        <h2 class="text-h6 mb-2">{{ t('todo.confirmations') }}</h2>
        <v-list border lines="two" data-testid="confirmations">
          <v-list-item v-for="task in todo.confirmations" :key="task.id" :to="`/todo/${task.id}`">
            <v-list-item-title>{{ localized(task.title, locale) }}</v-list-item-title>
            <v-list-item-subtitle>
              {{ task.projectName }} · {{ task.workItemTitle }} ·
              {{ task.proposedAssigneeName ?? (task.executor === 'ai' && !task.assigneeId ? t(waitingFor(task) === 'runner' ? 'todo.waitingForRunner' : 'todo.waitingForAi') : t('todo.needsAssignee')) }}
              <template v-if="task.aiStatus"> · <AiStatus :task="task" can-retry @retried="load" /></template>
            </v-list-item-subtitle>
            <template #append>
              <PriorityMark :priority="task.workItemPriority" class="mr-3" data-testid="priority-chip" />
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
