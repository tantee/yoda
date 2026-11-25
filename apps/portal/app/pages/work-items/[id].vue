<script setup lang="ts">
import type { Discussion, ProjectDetail, Task, WorkItemDetail, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { waitingFor } from '~/utils/runners'
import { bangkokToday, isOverdue } from '~/utils/status'
import { reopenTargets } from '~/utils/workItems'

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
const reopenOpen = ref(false)
const reopenStep = ref<string | null>(null)
const assigningId = ref<string | null>(null)
const assignee = ref<string | null>(null)
const raiseOpen = ref(false)
const blockers = ref<Discussion[]>([])
const codePanel = ref<{ reload: () => Promise<void> } | null>(null)

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => !!me.value?.isAdmin || isPm.value)
const isMember = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id))
const canRaise = computed(() => !!item.value && item.value.state === 'active' && (!!me.value?.isAdmin || isMember.value))
const isActive = computed(() => item.value?.state === 'active')
/** PM/admin may send an active item back to an earlier step (e.g. the requester asked for changes). */
const reopenSteps = computed(() => (canManage.value && isActive.value && item.value ? reopenTargets(item.value.steps) : []))
const reopenItems = computed(() => reopenSteps.value.map(s => ({ value: s.key, title: localized(s.name, locale.value) })))
const canCancel = computed(() => isActive.value && (canManage.value || item.value?.ownerId === me.value?.id))
/** PM/admin, or the owner while still a member, may set the target date of an active item (the server enforces). */
const canSetTarget = computed(() => isActive.value && (canManage.value || (item.value?.ownerId === me.value?.id && isMember.value)))
const overdue = computed(() => isActive.value && isOverdue(item.value?.targetDate ?? null, bangkokToday()))
const targetInput = ref('')
watch(() => item.value?.targetDate, (v) => (targetInput.value = v ?? ''), { immediate: true })
const { date: fmtDate } = useDateFormat()
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
    void codePanel.value?.reload()
    if (loaded.openDiscussions > 0) {
      try {
        const all = await api<Discussion[]>('/discussions', { query: { projectId: loaded.projectId } })
        if (mine === seq) blockers.value = all.filter(x => x.workItemId === id && (x.state === 'open' || x.state === 'scheduled'))
      } catch {
        blockers.value = []
      }
    } else blockers.value = []
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

async function act(fn: () => Promise<unknown>): Promise<boolean> {
  error.value = ''
  busy.value = true
  let ok = false
  try {
    await fn()
    seq++ // drop any in-flight older load
    ok = true
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
  return ok
}

const confirmTask = (taskId: string) => act(() => api(`/tasks/${taskId}/confirm`, { method: 'POST' }))
async function assign(taskId: string) {
  if (!assignee.value) return
  const personId = assignee.value
  const ok = await act(() => api(`/tasks/${taskId}/assign`, { method: 'POST', body: { personId } }))
  if (!ok) return // keep the picker open so the user can retry
  assigningId.value = null
  assignee.value = null
}
async function advance() {
  await act(() => api(`/work-items/${id}/advance`, { method: 'POST' }))
}
function openReopen() {
  reopenStep.value = null
  reopenOpen.value = true
}
async function reopen() {
  const stepKey = reopenStep.value
  if (!stepKey) return
  const ok = await act(() => api(`/work-items/${id}/reopen`, { method: 'POST', body: { stepKey } }))
  if (ok) reopenOpen.value = false
}
async function cancelItem() {
  cancelOpen.value = false
  await act(() => api(`/work-items/${id}/cancel`, { method: 'POST' }))
}
async function setTargetDate(targetDate: string | null) {
  const ok = await act(() => api(`/work-items/${id}`, { method: 'PATCH', body: { targetDate } }))
  if (!ok) targetInput.value = item.value?.targetDate ?? ''
}
function toggleAssign(taskId: string) {
  assigningId.value = assigningId.value === taskId ? null : taskId
  assignee.value = null
}

onMounted(load)
useLiveEvents((e) => {
  if (e.workItemId === id || (e.type.startsWith('discussion.') && e.projectId === item.value?.projectId)) loadSoon()
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
      <PageHeader :title="item.title" class="mb-2">
        <template #actions>
          <v-btn
            v-if="canManage && item.awaitingAdvance && !item.openDiscussions"
            color="primary"
            :loading="busy"
            data-testid="advance-btn"
            @click="advance"
          >{{ t('workItems.advance') }}</v-btn>
          <v-btn
            v-if="canRaise"
            variant="outlined"
            prepend-icon="mdi-forum-outline"
            data-testid="raise-btn"
            @click="raiseOpen = true"
          >{{ t('workItems.raiseDiscussion') }}</v-btn>
          <v-btn
            v-if="reopenSteps.length"
            variant="outlined"
            prepend-icon="mdi-undo-variant"
            data-testid="reopen-btn"
            @click="openReopen"
          >{{ t('workItems.reopen') }}</v-btn>
          <v-btn v-if="canCancel" color="error" variant="outlined" data-testid="cancel-btn" @click="cancelOpen = true">{{ t('workItems.cancel') }}</v-btn>
        </template>
        <template #meta>
          <StatusChip kind="workItem" :value="item.state" data-testid="state-chip" />
          <PriorityMark :priority="item.priority" data-testid="priority-chip" />
          <v-chip size="small" variant="outlined" data-testid="template-chip">{{ templateName }}</v-chip>
          <v-chip size="small" variant="outlined" data-testid="owner-chip" prepend-icon="mdi-account-outline">{{ item.ownerName }}</v-chip>
          <v-chip v-if="item.requesterName" size="small" variant="outlined" data-testid="requester-chip" prepend-icon="mdi-account-voice">
            {{ t('workItems.requester') }}: {{ item.requesterName }}
          </v-chip>
          <v-chip v-if="item.targetDate && !canSetTarget" size="small" variant="outlined" prepend-icon="mdi-calendar-outline" data-testid="target-chip">
            {{ t('status.due', { date: fmtDate(item.targetDate) }) }}
          </v-chip>
          <v-chip v-if="overdue" size="small" color="error" prepend-icon="mdi-calendar-alert" data-testid="overdue-chip">{{ t('status.overdue') }}</v-chip>
        </template>
      </PageHeader>
      <div v-if="canSetTarget" class="d-flex flex-wrap align-center ga-2 mb-2" data-testid="target-date">
        <v-text-field
          v-model="targetInput"
          type="date"
          :label="t('workItems.targetDate')"
          :hint="t('workItems.targetDateHint')"
          persistent-hint
          density="compact"
          style="max-width: 260px"
          data-testid="target-date-input"
        />
        <v-btn
          size="small"
          color="primary"
          :loading="busy"
          :disabled="!targetInput || targetInput === (item.targetDate ?? '')"
          data-testid="target-date-save"
          @click="setTargetDate(targetInput)"
        >{{ t('workItems.saveTargetDate') }}</v-btn>
        <v-btn v-if="item.targetDate" size="small" variant="text" :loading="busy" data-testid="target-date-clear" @click="setTargetDate(null)">{{ t('workItems.clearTargetDate') }}</v-btn>
      </div>
      <p v-if="item.description" class="mb-4" style="white-space: pre-wrap">{{ item.description }}</p>
      <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

      <v-alert v-if="item.openDiscussions > 0" type="warning" variant="tonal" class="mb-4" data-testid="blocked-banner">
        <div class="font-weight-medium">{{ t('discussions.blocked', { n: item.openDiscussions }, item.openDiscussions) }}</div>
        <div class="text-body-2">{{ t('discussions.blockedHint') }}</div>
        <ul class="pl-5">
          <li v-for="b in blockers" :key="b.id"><NuxtLink :to="`/discussions/${b.id}`" data-testid="blocker-link">{{ b.question }}</NuxtLink></li>
        </ul>
      </v-alert>

      <StepTrack :steps="item.steps" show-names class="mb-4" data-testid="stepper" />

      <WorkItemCodePanel
        v-if="me?.isStaff"
        ref="codePanel"
        :work-item-id="item.id"
        :project-id="item.projectId"
        :can-manage="canManage"
        :active="isActive"
      />

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
                <StatusChip kind="task" :value="task.state" size="x-small" data-testid="task-state" />
                <v-spacer />
                <RunnerRunChip v-if="task.run" :run="task.run" />
                <StatusChip v-if="waitingFor(task) === 'runner'" kind="waiting" value="runner" size="x-small" data-testid="waiting-runner" />
                <StatusChip v-else-if="waitingFor(task) === 'ai'" kind="waiting" value="ai" size="x-small" data-testid="waiting-ai" />
                <AiStatus v-if="task.aiStatus" :task="task" :can-retry="canManage && isActive" @retried="load" />
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

      <DiscussionsRaiseDiscussionDialog
        v-model="raiseOpen"
        :project-id="item.projectId"
        :work-item-id="item.id"
        :no-ai="project?.noAi"
        @raised="(did: string) => navigateTo(`/discussions/${did}`)"
      />

      <v-dialog v-model="reopenOpen" max-width="480">
        <v-card :title="t('workItems.reopenTitle')" data-testid="reopen-dialog">
          <v-card-text>
            <p class="mb-4">{{ t('workItems.reopenConfirm') }}</p>
            <v-select
              v-model="reopenStep"
              :items="reopenItems"
              :label="t('workItems.reopenStep')"
              hide-details
              data-testid="reopen-step-select"
            />
            <v-alert v-if="error" type="error" class="mt-4" density="compact">{{ error }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="reopenOpen = false">{{ t('workItems.keep') }}</v-btn>
            <v-btn color="primary" :disabled="!reopenStep" :loading="busy" data-testid="reopen-confirm" @click="reopen">{{ t('workItems.reopen') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>

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
