<script setup lang="ts">
import type { Attachment, Conversation, ProjectDetail, TaskInput, TaskWithContext, WorkItemDetail } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { requesterTaskKind, taskViewFor } from '~/utils/requests'
import { waitingFor } from '~/utils/runners'
import { errorKind } from '~/utils/stateView'
import { taskCrumbs } from '~/utils/todo'

// The trail comes from the task itself (staff: project › work item; requesters: their request).
definePageMeta({ crumbs: [] })

const { t, locale } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const { dateTime, date, relative } = useDateFormat()
const { refresh: refreshCounts } = useCounts()
const id = route.params.id as string

const task = ref<TaskWithContext | null>(null)
const project = ref<ProjectDetail | null>(null)
const workItem = ref<WorkItemDetail | null>(null)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const notFound = ref(false)
const error = ref('')
const busy = ref(false)
const text = ref('')
const attached = ref<Attachment[]>([])
const attachOpen = ref(false)
const intakeId = ref<string | null>(null)
const raiseOpen = ref(false)
const assignOpen = ref(false)
const changesOpen = ref(false)
const changesReason = ref('')
const changesError = ref('')

/**
 * Requesters, and staff who see this task only as its requester (outside the project), get a trimmed view:
 * no project, work item or staff controls; uploads go to their own conversation.
 */
const view = computed(() => taskViewFor(me.value, task.value))
const staff = computed(() => !view.value.requesterView)
const title = computed(() => (task.value ? localized(task.value.title, locale.value) : ''))
/** Requester view (proposal §8.3): what the task asks of them, in plain words; no type, state or priority. */
const askKind = computed(() => (task.value ? requesterTaskKind(task.value) : 'question'))
const pageTitle = computed(() => (staff.value ? title.value : t(`requests.kind.${askKind.value}`)))
useBreadcrumb(() =>
  task.value
    ? taskCrumbs({ ...task.value, title: title.value }, { requesterView: view.value.requesterView, isStaff: !!me.value?.isStaff }, t)
    : [],
)

const isAssignee = computed(() => !!task.value?.assigneeId && task.value.assigneeId === me.value?.id)
const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => staff.value && (!!me.value?.isAdmin || isPm.value))
const active = computed(() => ['proposed', 'open', 'in_progress', 'submitted'].includes(task.value?.state ?? ''))
const workable = computed(() => task.value?.state === 'open' || task.value?.state === 'in_progress')
const isDecision = computed(() => task.value?.type === 'review' || task.value?.type === 'approval')
const canRaise = computed(() => staff.value && active.value && (isAssignee.value || canManage.value))
const showConfirm = computed(() => canManage.value && task.value?.state === 'proposed' && !!task.value.proposedAssigneeId)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const loaded = await api<TaskWithContext>(`/tasks/${id}`)
    if (mine !== seq) return
    task.value = loaded
    loadError.value = ''
    notFound.value = false
    if (!staff.value) void loadIntake()
    else {
      // Staff only: the project (members, PM role) and the work item (steps, dates) for the side panel.
      const [p, w] = await Promise.all([
        project.value ? Promise.resolve(project.value) : api<ProjectDetail>(`/projects/${loaded.projectId}`).catch(() => null),
        api<WorkItemDetail>(`/work-items/${loaded.workItemId}`).catch(() => null),
      ])
      if (mine !== seq) return
      project.value = p
      workItem.value = w
    }
  } catch (e) {
    if (mine === seq) {
      notFound.value = errorKind(e).status === 404
      loadError.value = t(errorKey(e))
      loadFailure.value = e
    }
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

/** Runs a task action; true when it went through. */
async function act(path: string, body?: Record<string, unknown>): Promise<boolean> {
  error.value = ''
  busy.value = true
  try {
    const updated = await api<TaskWithContext>(`/tasks/${id}/${path}`, { method: 'POST', body })
    seq++ // drop any in-flight older load
    task.value = updated
    if (path !== 'start') {
      // Starting keeps the draft text and uploads; only a submit consumes them.
      text.value = ''
      attached.value = []
      attachOpen.value = false
    }
    void refreshCounts()
    return true
  } catch (e) {
    error.value = t(errorKey(e))
    await load() // drop stale action buttons
    return false
  } finally {
    busy.value = false
  }
}

const start = () => act('start')
const attachmentIds = () => attached.value.map(a => a.id)
const submit = () => act('submit', { text: text.value, attachmentIds: attachmentIds() })
const approve = () => act('submit', { text: text.value, decision: 'approve', attachmentIds: attachmentIds() })
const copyInput = (input: TaskInput) => {
  text.value = input.result.text
}
const confirmTask = () => act('confirm')

function openChanges() {
  changesReason.value = text.value
  changesError.value = ''
  changesOpen.value = true
}
async function sendChanges() {
  if (!changesReason.value.trim()) {
    changesError.value = t('task.changesReasonRequired')
    return
  }
  changesError.value = ''
  text.value = changesReason.value
  const ok = await act('submit', { text: changesReason.value, decision: 'changes', attachmentIds: attachmentIds() })
  if (ok) changesOpen.value = false
  else {
    // Shown once, in the dialog the person is looking at.
    changesError.value = error.value
    error.value = ''
  }
}

function onAssigned(updated: TaskWithContext) {
  seq++
  task.value = updated
  void refreshCounts()
}

async function loadIntake() {
  if (intakeId.value) return
  try {
    intakeId.value = (await api<Conversation>('/conversations/personal')).id
  } catch {
    intakeId.value = null // upload is hidden; the answer can still be sent as text
  }
}

onMounted(load)
useLiveEvents((e) => {
  if (e.taskId === id || e.workItemId === task.value?.workItemId) loadSoon()
}, loadSoon)
</script>

<template>
  <div>
    <template v-if="loadError && !task">
      <EmptyState v-if="notFound" wisdom="notFound" :title="t('todo.notFound')" :text="t('todo.notFoundText')" icon="mdi-clipboard-remove-outline" data-testid="load-error">
        <v-btn v-if="me?.isStaff" color="primary" variant="flat" to="/todo">{{ t('todo.back') }}</v-btn>
        <v-btn v-else color="primary" variant="flat" to="/requests">{{ t('requests.back') }}</v-btn>
      </EmptyState>
      <ErrorState v-else :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    </template>
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <SkeletonDetail v-else-if="!task" />

    <template v-if="task">
      <PageHeader :title="pageTitle">
        <template v-if="staff" #context>
          <StatusChip kind="task" :value="task.state" data-testid="state-chip" />
          <StatusChip kind="taskType" :value="task.type" />
          <PriorityMark :priority="task.workItemPriority" data-testid="priority-chip" />
          <StepTrack v-if="workItem?.steps.length" :steps="workItem.steps" compact data-testid="task-step-track" />
        </template>
        <template v-if="canRaise" #actions>
          <v-btn variant="outlined" prepend-icon="mdi-forum-outline" data-testid="raise-btn" @click="raiseOpen = true">
            {{ t('workItems.raiseDiscussion') }}
          </v-btn>
        </template>
        <template #meta>
          <template v-if="!staff">
            <span v-if="askKind === 'question'" class="font-weight-medium" data-testid="requester-task-title">{{ title }}</span>
            <NuxtLink :to="`/requests/${task.workItemId}`" class="d-inline-flex align-center ga-1" data-testid="requester-context">
              <v-icon icon="mdi-clipboard-text-outline" size="16" aria-hidden="true" />{{ task.workItemTitle }}
            </NuxtLink>
          </template>
          <template v-else>
            <span class="d-inline-flex align-center ga-1">
              <v-icon icon="mdi-account-outline" size="16" aria-hidden="true" />{{ task.assigneeName ?? t('task.unassigned') }}
            </span>
            <span v-if="workItem?.targetDate" class="d-inline-flex align-center ga-1">
              <v-icon icon="mdi-calendar-outline" size="16" aria-hidden="true" />{{ t('todo.due', { date: date(workItem.targetDate) }) }}
            </span>
            <span class="d-inline-flex align-center ga-1" :title="dateTime(task.updatedAt)">
              <v-icon icon="mdi-update" size="16" aria-hidden="true" />{{ t('task.updatedAgo', { time: relative(task.updatedAt) }) }}
            </span>
          </template>
        </template>
      </PageHeader>

      <DiscussionsRaiseDiscussionDialog
        v-if="canRaise"
        v-model="raiseOpen"
        :project-id="task.projectId"
        :work-item-id="task.workItemId"
        :task-id="task.id"
        :work-item-title="task.workItemTitle"
        :no-ai="project?.noAi"
        @raised="(did: string) => navigateTo(`/discussions/${did}`)"
      />

      <div class="task-layout" :class="{ 'task-layout--side': staff }">
        <div class="task-main">
          <v-alert v-if="task.feedback" type="warning" class="mb-4" :title="t('task.changesRequested')" data-testid="feedback">
            <span style="white-space: pre-wrap">{{ task.feedback }}</span>
          </v-alert>

          <v-alert v-if="!staff && !active" type="success" variant="tonal" class="mb-4" data-testid="requester-done">{{ t('task.requester.done') }}</v-alert>

          <v-alert v-if="error" type="error" class="mb-4" closable data-testid="action-error" @click:close="error = ''">{{ error }}</v-alert>

          <div
            v-if="staff && (task.aiStatus || task.run || waitingFor(task) === 'runner')"
            class="task-status mb-4"
          >
            <div v-if="task.aiStatus" data-testid="ai-status">
              <AiStatus :task="task" :can-retry="canManage" @retried="load" />
            </div>
            <div v-if="task.run || waitingFor(task) === 'runner'" class="d-flex align-center flex-wrap ga-2" data-testid="run-status">
              <RunnerRunChip v-if="task.run" :run="task.run" />
              <StatusChip v-if="waitingFor(task) === 'runner'" kind="waiting" value="runner" data-testid="waiting-runner" />
            </div>
          </div>

          <v-card class="mb-4" data-testid="task-instructions">
            <div class="task-card-head"><h2 class="text-subtitle-1">{{ t('task.instructions') }}</h2></div>
            <div class="task-card-body text-body-1" style="white-space: pre-wrap">{{ localized(task.instructions, locale) }}</div>
          </v-card>

          <section v-if="task.inputs.length" class="mb-4">
            <h2 class="text-subtitle-1 task-section-title">
              {{ staff ? t('task.fromPrevious') : askKind === 'delivery' ? t('task.requester.delivered') : t('task.requester.question') }}
            </h2>
            <v-card v-for="input in task.inputs" :key="input.templateTaskKey" class="mb-3" data-testid="task-input">
              <div class="task-card-head">
                <h3 class="text-subtitle-2">{{ localized(input.title, locale) }}</h3>
                <v-btn
                  v-if="isAssignee && workable && input.result.text"
                  size="small"
                  variant="text"
                  color="primary"
                  prepend-icon="mdi-content-copy"
                  data-testid="copy-input-btn"
                  @click="copyInput(input)"
                >{{ t('task.copyIntoResult') }}</v-btn>
              </div>
              <div class="task-card-body">
                <AiDraft
                  v-if="staff && input.executor === 'ai' && input.result.text"
                  :confidence="input.result.confidence"
                  :missing="input.result.missing"
                  data-testid="ai-draft-chip"
                >
                  <MarkdownView :source="input.result.text" />
                </AiDraft>
                <MarkdownView v-else-if="input.result.text" :source="input.result.text" />
                <p v-else class="text-medium-emphasis">{{ t('task.noPreviousText') }}</p>
                <AttachmentList :attachments="input.attachments" class="mt-2" />
              </div>
            </v-card>
          </section>

          <section v-else-if="!staff && askKind === 'delivery' && active" class="mb-4">
            <h2 class="text-subtitle-1 task-section-title">{{ t('task.requester.delivered') }}</h2>
            <v-card class="task-card-body text-body-2 text-medium-emphasis" data-testid="no-delivery">{{ t('task.requester.noDelivery') }}</v-card>
          </section>

          <v-card v-if="!active && task.result" class="mb-4 task-result" data-testid="task-result">
            <div class="task-card-head">
              <h2 class="text-subtitle-1">{{ staff ? t('task.result') : t('task.requester.answerLabel') }}</h2>
              <v-chip
                v-if="task.result.decision"
                :color="task.result.decision === 'approve' ? 'success' : 'warning'"
                :prepend-icon="task.result.decision === 'approve' ? 'mdi-check-circle-outline' : 'mdi-undo-variant'"
                data-testid="result-decision"
              >
                <template v-if="staff">{{ t('task.decision') }}: {{ task.result.decision === 'approve' ? t('task.approve') : t('task.requestChanges') }}</template>
                <template v-else>{{ task.result.decision === 'approve' ? t('requests.event.accepted') : t('requests.event.changes') }}</template>
              </v-chip>
            </div>
            <div class="task-card-body">
              <AiDraft v-if="staff && task.executor === 'ai' && task.result.text" :confidence="task.result.confidence" :missing="task.result.missing">
                <MarkdownView :source="task.result.text" data-testid="result-text" />
              </AiDraft>
              <MarkdownView v-else :source="task.result.text" data-testid="result-text" />
              <AttachmentList :attachments="task.attachments" class="mt-2" />
            </div>
          </v-card>

          <v-card v-if="isAssignee && workable" class="mb-4 task-work" data-testid="task-work">
            <div class="task-card-head">
              <h2 class="text-subtitle-1">
                <template v-if="staff">{{ isDecision ? t('task.yourDecision') : t('task.yourWork') }}</template>
                <template v-else>{{ isDecision ? t('task.requester.deliveryAsk') : t('task.requester.answerLabel') }}</template>
              </h2>
            </div>
            <div class="task-card-body">
              <v-textarea v-model="text" :label="staff ? t('task.comment') : t('task.requester.answerLabel')" rows="3" auto-grow data-testid="result-input" />
              <AttachmentList :attachments="attached" class="mt-2" />
              <template v-if="staff || intakeId">
                <v-btn
                  v-if="!attachOpen"
                  variant="text"
                  color="primary"
                  size="small"
                  prepend-icon="mdi-paperclip"
                  class="mt-2"
                  data-testid="attach-open-btn"
                  @click="attachOpen = true"
                >{{ t('task.attachFile') }}</v-btn>
                <div v-else class="mt-2">
                  <h3 class="text-subtitle-2 mb-1">{{ t('task.resultAttachments') }}</h3>
                  <AttachmentUpload v-if="staff" :project-id="task.projectId" :work-item-id="task.workItemId" :task-id="task.id" @uploaded="a => attached.push(a)" />
                  <AttachmentUpload v-else-if="intakeId" :conversation-id="intakeId" @uploaded="a => attached.push(a)" />
                </div>
              </template>
            </div>
            <div class="task-card-actions">
              <template v-if="isDecision">
                <v-btn variant="outlined" :disabled="busy" data-testid="changes-btn" @click="openChanges">
                  {{ staff ? t('task.requestChangesEllipsis') : t('task.requester.notYet') }}
                </v-btn>
                <v-btn color="primary" prepend-icon="mdi-check" :loading="busy" data-testid="approve-btn" @click="approve">
                  {{ staff ? t('task.approve') : t('task.requester.accept') }}
                </v-btn>
              </template>
              <v-btn v-else-if="!staff" color="primary" :loading="busy" data-testid="submit-btn" @click="submit">{{ t('task.requester.send') }}</v-btn>
              <template v-else-if="task.state === 'open'">
                <v-btn variant="outlined" :disabled="busy" data-testid="submit-btn" @click="submit">{{ t('task.submit') }}</v-btn>
                <v-btn color="primary" :loading="busy" data-testid="start-btn" @click="start">{{ t('task.start') }}</v-btn>
              </template>
              <v-btn v-else color="primary" :loading="busy" data-testid="submit-btn" @click="submit">{{ t('task.submit') }}</v-btn>
            </div>
          </v-card>
        </div>

        <aside v-if="staff" class="task-side" :aria-label="t('task.side.label')">
          <v-card class="mb-4" data-testid="side-work-item">
            <div class="task-card-head"><h2 class="text-subtitle-2">{{ t('todo.workItem') }}</h2></div>
            <div class="task-card-body task-facts">
              <NuxtLink :to="`/work-items/${task.workItemId}`" class="task-facts__title">{{ task.workItemTitle }}</NuxtLink>
              <StepTrack v-if="workItem?.steps.length" :steps="workItem.steps" />
              <dl>
                <dt>{{ t('todo.project') }}</dt>
                <dd><NuxtLink :to="`/projects/${task.projectId}`">{{ task.projectName }}</NuxtLink></dd>
                <template v-if="workItem">
                  <dt>{{ t('task.side.owner') }}</dt>
                  <dd>{{ workItem.ownerName }}</dd>
                  <template v-if="workItem.requesterName">
                    <dt>{{ t('task.side.requester') }}</dt>
                    <dd>{{ workItem.requesterName }}</dd>
                  </template>
                  <dt>{{ t('task.side.target') }}</dt>
                  <dd class="tabular-nums">{{ workItem.targetDate ? date(workItem.targetDate) : t('todo.noDue') }}</dd>
                </template>
              </dl>
            </div>
          </v-card>

          <v-card class="mb-4" data-testid="side-people">
            <div class="task-card-head"><h2 class="text-subtitle-2">{{ t('task.assignee') }}</h2></div>
            <div class="task-card-body task-facts">
              <div class="d-flex align-center ga-2" data-testid="assignee-name">
                <v-icon icon="mdi-account-outline" size="18" aria-hidden="true" />
                <span>{{ task.assigneeName ?? t('task.unassigned') }}</span>
              </div>
              <div v-if="task.proposedAssigneeName && task.state === 'proposed'" class="text-body-2 text-medium-emphasis" data-testid="proposed-assignee">
                {{ t('task.proposedAssignee') }}: {{ task.proposedAssigneeName }}
              </div>
              <div v-if="canManage && active" class="task-side__actions">
                <v-btn v-if="project" variant="outlined" size="small" data-testid="assign-open-btn" @click="assignOpen = true">
                  {{ task.assigneeId || task.proposedAssigneeId ? t('todo.changePerson') : t('todo.assignPerson') }}
                </v-btn>
                <v-btn v-if="showConfirm" color="primary" size="small" :loading="busy" data-testid="confirm-btn" @click="confirmTask">{{ t('task.confirm') }}</v-btn>
              </div>
            </div>
          </v-card>

          <v-card data-testid="side-dates">
            <div class="task-card-head"><h2 class="text-subtitle-2">{{ t('task.side.dates') }}</h2></div>
            <div class="task-card-body task-facts">
              <dl>
                <dt>{{ t('task.side.created') }}</dt>
                <dd class="tabular-nums">{{ dateTime(task.createdAt) }}</dd>
                <dt>{{ t('task.side.updated') }}</dt>
                <dd class="tabular-nums">{{ dateTime(task.updatedAt) }}</dd>
              </dl>
            </div>
          </v-card>
        </aside>
      </div>

      <TaskAssignDialog v-if="canManage && project" v-model="assignOpen" :task="task" :members="project.members" @assigned="onAssigned" />

      <AppDialog
        v-model="changesOpen"
        :title="staff ? t('task.changesTitle', { title }) : t('task.requester.changesTitle', { title: task.workItemTitle })"
        :busy="busy"
        :dirty="!!changesReason.trim()"
        data-testid="changes-dialog"
      >
        <p class="text-body-2 text-medium-emphasis mb-3">{{ staff ? t('task.changesHint') : t('task.requester.changesHint') }}</p>
        <v-textarea
          v-model="changesReason"
          :label="staff ? t('task.changesReason') : t('task.requester.changesReason')"
          :error-messages="changesError ? [changesError] : []"
          rows="4"
          auto-grow
          autofocus
          data-testid="changes-reason"
        />
        <template #actions>
          <v-btn variant="text" :disabled="busy" data-testid="changes-cancel" @click="changesOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy" data-testid="changes-submit" @click="sendChanges">{{ staff ? t('task.sendBack') : t('task.requester.sendChanges') }}</v-btn>
        </template>
      </AppDialog>
    </template>
  </div>
</template>

<style scoped>
.task-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
@media (min-width: 1280px) { .task-layout--side { grid-template-columns: minmax(0, 1fr) 340px; } }
.task-main, .task-side { min-width: 0; }
.task-section-title { font-weight: 600; margin-bottom: 8px; }
.task-card-head {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px; justify-content: space-between;
  min-height: 48px; padding: 8px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.task-card-head h2, .task-card-head h3 { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.task-card-body { padding: 16px; min-width: 0; overflow-wrap: anywhere; }
.task-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 0 16px 16px; }
.task-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 10px 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; background: rgb(var(--v-theme-surface)); }
.task-facts { display: flex; flex-direction: column; gap: 12px; }
.task-facts__title { font-weight: 500; color: inherit; }
.task-facts dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: .875rem; }
.task-facts dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.task-facts dd { margin: 0; overflow-wrap: anywhere; }
.task-side__actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
