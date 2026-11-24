<script setup lang="ts">
import type { ProjectDetail, Task, WorkItemDetail, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'

const { t, locale } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string

const item = ref<WorkItemDetail | null>(null)
const project = ref<ProjectDetail | null>(null)
const templates = ref<WorkflowTemplateSummary[]>([])
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const cancelOpen = ref(false)
const assigningId = ref<string | null>(null)
const assignee = ref<string | null>(null)

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => !!me.value?.isAdmin || isPm.value)
const isActive = computed(() => item.value?.state === 'active')
const canCancel = computed(() => isActive.value && (canManage.value || item.value?.ownerId === me.value?.id))
const templateName = computed(() => {
  const tpl = templates.value.find(x => x.key === item.value?.templateKey)
  return tpl ? localized(tpl.name, locale.value) : (item.value?.templateKey ?? '')
})

function tasksFor(stepKey: string): Task[] {
  return (item.value?.tasks ?? []).filter(x => x.stepKey === stepKey)
}
const taskOpen = (x: Task) => ['proposed', 'open', 'in_progress'].includes(x.state)
const waitingForAi = (x: Task) => x.executor === 'ai' && !x.assigneeId && x.state === 'open'
const showConfirm = (x: Task) => canManage.value && x.state === 'proposed' && !!x.proposedAssigneeId
const showAssign = (x: Task) => canManage.value && isActive.value && taskOpen(x)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const loaded = await api<WorkItemDetail>(`/work-items/${id}`)
    if (mine !== seq) return
    item.value = loaded
    loadError.value = ''
    if (!project.value) {
      try {
        project.value = await api<ProjectDetail>(`/projects/${loaded.projectId}`)
      } catch {
        project.value = null
      }
    }
    if (!templates.value.length) {
      try {
        templates.value = await api<WorkflowTemplateSummary[]>('/workflow-templates')
      } catch {
        templates.value = []
      }
    }
  } catch (e) {
    if (mine === seq) loadError.value = t(errorKey(e))
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

async function act(fn: () => Promise<unknown>) {
  error.value = ''
  busy.value = true
  try {
    await fn()
    seq++ // drop any in-flight older load
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
}

const confirmTask = (taskId: string) => act(() => api(`/tasks/${taskId}/confirm`, { method: 'POST' }))
async function assign(taskId: string) {
  if (!assignee.value) return
  const personId = assignee.value
  await act(() => api(`/tasks/${taskId}/assign`, { method: 'POST', body: { personId } }))
  assigningId.value = null
  assignee.value = null
}
async function cancelItem() {
  cancelOpen.value = false
  await act(() => api(`/work-items/${id}/cancel`, { method: 'POST' }))
}
function toggleAssign(taskId: string) {
  assigningId.value = assigningId.value === taskId ? null : taskId
  assignee.value = null
}

onMounted(load)
useLiveEvents((e) => {
  if (e.workItemId === id) loadSoon()
}, loadSoon)
</script>

<template>
  <div>
    <v-btn
      variant="text"
      prepend-icon="mdi-arrow-left"
      :to="item ? `/projects/${item.projectId}` : '/projects'"
      class="mb-2"
    >{{ t('workItems.back') }}</v-btn>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="item">
      <div class="d-flex align-center mb-2">
        <h1 class="text-h5">{{ item.title }}</h1>
        <v-spacer />
        <v-btn v-if="canCancel" color="error" variant="outlined" data-testid="cancel-btn" @click="cancelOpen = true">{{ t('workItems.cancel') }}</v-btn>
      </div>
      <div class="d-flex flex-wrap ga-2 mb-2">
        <v-chip size="small" data-testid="state-chip">{{ t(`workItems.stateName.${item.state}`) }}</v-chip>
        <v-chip size="small" variant="outlined" data-testid="priority-chip">{{ t(`priority.${item.priority}`) }}</v-chip>
        <v-chip size="small" variant="outlined" data-testid="template-chip">{{ templateName }}</v-chip>
        <v-chip size="small" variant="outlined" data-testid="owner-chip" prepend-icon="mdi-account-outline">{{ item.ownerName }}</v-chip>
      </div>
      <p v-if="item.description" class="mb-4" style="white-space: pre-wrap">{{ item.description }}</p>
      <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

      <v-stepper :model-value="item.steps.findIndex(s => s.status === 'current')" flat class="mb-4" data-testid="stepper">
        <v-stepper-header>
          <template v-for="(s, i) in item.steps" :key="s.key">
            <v-divider v-if="i > 0" />
            <v-stepper-item
              :title="localized(s.name, locale)"
              :value="i"
              :complete="s.status === 'done'"
              :color="s.status === 'pending' ? undefined : 'primary'"
              :subtitle="t(`steps.${s.status}`)"
              :data-status="s.status"
              data-testid="step"
              readonly
            />
          </template>
        </v-stepper-header>
      </v-stepper>

      <h2 class="text-h6 mb-2">{{ t('workItems.tasks') }}</h2>
      <template v-for="s in item.steps" :key="s.key">
        <template v-if="tasksFor(s.key).length">
          <h3 class="text-subtitle-1 mt-3 mb-1">{{ localized(s.name, locale) }}</h3>
          <v-card v-for="task in tasksFor(s.key)" :key="task.id" variant="outlined" class="mb-2" data-testid="task-card">
            <v-card-text>
              <div class="d-flex flex-wrap align-center ga-2">
                <NuxtLink :to="`/todo/${task.id}`" class="font-weight-medium">{{ localized(task.title, locale) }}</NuxtLink>
                <span v-if="task.attempt > 1" class="text-caption" data-testid="attempt">{{ t('workItems.attempt', { n: task.attempt }) }}</span>
                <v-chip size="x-small" :color="task.executor === 'ai' ? 'secondary' : undefined" data-testid="executor-chip">
                  {{ task.executor === 'ai' ? t('workItems.executorAi') : (task.assigneeName ?? task.proposedAssigneeName ?? t('task.unassigned')) }}
                </v-chip>
                <v-chip size="x-small" variant="outlined" data-testid="task-state">{{ t(`task.state.${task.state}`) }}</v-chip>
                <v-spacer />
                <v-chip v-if="waitingForAi(task)" size="x-small" color="warning" data-testid="waiting-ai">{{ t('workItems.waitingForAi') }}</v-chip>
                <v-btn v-if="showConfirm(task)" size="small" color="primary" :loading="busy" data-testid="confirm-btn" @click="confirmTask(task.id)">{{ t('task.confirm') }}</v-btn>
                <v-btn v-if="showAssign(task)" size="small" variant="outlined" data-testid="assign-toggle" @click="toggleAssign(task.id)">
                  {{ waitingForAi(task) ? t('workItems.assignToPerson') : t('task.assign') }}
                </v-btn>
              </div>
              <p class="text-caption text-medium-emphasis mt-1">
                {{ t('task.assignee') }}: {{ task.assigneeName ?? t('task.unassigned') }}
                <template v-if="task.state === 'proposed' && task.proposedAssigneeName"> · {{ t('task.proposedAssignee') }}: {{ task.proposedAssigneeName }}</template>
              </p>
              <div v-if="assigningId === task.id && project" class="d-flex ga-4 mt-2">
                <v-select
                  v-model="assignee"
                  :items="project.members"
                  item-title="displayName"
                  item-value="personId"
                  :label="t('task.assignee')"
                  density="compact"
                  hide-details
                  data-testid="assignee-select"
                />
                <v-btn color="primary" :disabled="!assignee" :loading="busy" data-testid="assign-btn" @click="assign(task.id)">{{ t('task.assign') }}</v-btn>
              </div>
            </v-card-text>
          </v-card>
        </template>
      </template>

      <h2 class="text-h6 mt-6 mb-2">{{ t('workItems.timeline') }}</h2>
      <EventTimeline :events="item.events" />

      <v-dialog v-model="cancelOpen" max-width="420">
        <v-card :title="t('workItems.cancelTitle')" :text="t('workItems.cancelConfirm')">
          <v-card-actions>
            <v-spacer />
            <v-btn @click="cancelOpen = false">{{ t('workItems.keep') }}</v-btn>
            <v-btn color="error" :loading="busy" data-testid="cancel-confirm" @click="cancelItem">{{ t('workItems.cancel') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>
