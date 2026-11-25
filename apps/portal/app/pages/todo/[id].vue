<script setup lang="ts">
import type { Attachment, Conversation, ProjectDetail, TaskInput, TaskWithContext } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { taskViewFor } from '~/utils/requests'

const { t, locale } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string

const task = ref<TaskWithContext | null>(null)
const project = ref<ProjectDetail | null>(null)
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const text = ref('')
const newAssignee = ref<string | null>(null)
const attached = ref<Attachment[]>([])
const intakeId = ref<string | null>(null)

/**
 * Requesters, and staff who see this task only as its requester (outside the project), get a trimmed view:
 * no project, work item or staff controls; uploads go to their own conversation.
 */
const view = computed(() => taskViewFor(me.value, task.value))
const staff = computed(() => !view.value.requesterView)

const isAssignee = computed(() => !!task.value?.assigneeId && task.value.assigneeId === me.value?.id)
const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => staff.value && (!!me.value?.isAdmin || isPm.value))
const active = computed(() => ['proposed', 'open', 'in_progress', 'submitted'].includes(task.value?.state ?? ''))
const workable = computed(() => task.value?.state === 'open' || task.value?.state === 'in_progress')
const isDecision = computed(() => task.value?.type === 'review' || task.value?.type === 'approval')
const showConfirm = computed(() => canManage.value && task.value?.state === 'proposed' && !!task.value.proposedAssigneeId)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const loaded = await api<TaskWithContext>(`/tasks/${id}`)
    if (mine !== seq) return
    task.value = loaded
    loadError.value = ''
    if (!staff.value) void loadIntake()
    else if (!project.value) {
      try {
        project.value = await api<ProjectDetail>(`/projects/${loaded.projectId}`)
      } catch {
        project.value = null
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

async function act(path: string, body?: Record<string, unknown>) {
  error.value = ''
  busy.value = true
  try {
    const updated = await api<TaskWithContext>(`/tasks/${id}/${path}`, { method: 'POST', body })
    seq++ // drop any in-flight older load
    task.value = updated
    newAssignee.value = null
    if (path !== 'start') {
      // Starting keeps the draft text and uploads; only a submit consumes them.
      text.value = ''
      attached.value = []
    }
  } catch (e) {
    error.value = t(errorKey(e))
    await load() // drop stale action buttons
  } finally {
    busy.value = false
  }
}

const start = () => act('start')
const attachmentIds = () => attached.value.map(a => a.id)
const submit = () => act('submit', { text: text.value, attachmentIds: attachmentIds() })
const decide = (decision: 'approve' | 'changes') => act('submit', { text: text.value, decision, attachmentIds: attachmentIds() })
const copyInput = (input: TaskInput) => {
  text.value = input.result.text
}
const confirmTask = () => act('confirm')
const assign = () => newAssignee.value && act('assign', { personId: newAssignee.value })

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
    <v-btn variant="text" prepend-icon="mdi-arrow-left" :to="view.back" class="mb-2">{{ view.back === '/todo' ? t('todo.back') : t('answers.back') }}</v-btn>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="task">
      <h1 class="text-h5 mb-2">{{ localized(task.title, locale) }}</h1>
      <div class="d-flex ga-2 mb-2">
        <v-chip size="small" data-testid="state-chip">{{ t(`task.state.${task.state}`) }}</v-chip>
        <v-chip size="small" variant="outlined">{{ t(`task.type.${task.type}`) }}</v-chip>
        <v-chip size="small" variant="outlined" data-testid="priority-chip">{{ t(`priority.${task.workItemPriority}`) }}</v-chip>
      </div>
      <p v-if="!staff" class="text-medium-emphasis mb-4" data-testid="requester-context">{{ task.workItemTitle }}</p>
      <p v-else class="text-medium-emphasis mb-4">
        {{ t('todo.workItem') }}:
        <NuxtLink :to="`/work-items/${task.workItemId}`">{{ task.workItemTitle }}</NuxtLink>
        · {{ t('todo.project') }}: <NuxtLink :to="`/projects/${task.projectId}`">{{ task.projectName }}</NuxtLink>
        · {{ t('task.assignee') }}: {{ task.assigneeName ?? task.proposedAssigneeName ?? t('task.unassigned') }}
      </p>

      <h2 class="text-h6 mb-1">{{ t('task.instructions') }}</h2>
      <p class="mb-4" style="white-space: pre-wrap">{{ localized(task.instructions, locale) }}</p>

      <v-alert v-if="task.feedback" type="warning" variant="tonal" class="mb-4" :title="t('task.changesRequested')" data-testid="feedback">
        {{ task.feedback }}
      </v-alert>

      <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

      <div v-if="task.aiStatus && staff" class="mb-4" data-testid="ai-status">
        <AiStatus :task="task" :can-retry="canManage" @retried="load" />
      </div>

      <template v-if="task.inputs.length">
        <h2 class="text-h6 mb-2">{{ t('task.fromPrevious') }}</h2>
        <v-card v-for="input in task.inputs" :key="input.templateTaskKey" variant="outlined" class="mb-3" data-testid="task-input">
          <v-card-text>
            <div class="d-flex flex-wrap align-center ga-2 mb-2">
              <span class="font-weight-medium">{{ localized(input.title, locale) }}</span>
              <v-chip v-if="input.executor === 'ai'" size="x-small" color="secondary" data-testid="ai-draft-chip">{{ t('task.aiDraft') }}</v-chip>
              <v-spacer />
              <v-btn
                v-if="isAssignee && workable && input.result.text"
                size="small"
                variant="outlined"
                prepend-icon="mdi-content-copy"
                data-testid="copy-input-btn"
                @click="copyInput(input)"
              >{{ t('task.copyIntoResult') }}</v-btn>
            </div>
            <MarkdownView v-if="input.result.text" :source="input.result.text" />
            <p v-else class="text-medium-emphasis">{{ t('task.noPreviousText') }}</p>
            <AttachmentList :attachments="input.attachments" class="mt-2" />
          </v-card-text>
        </v-card>
      </template>

      <template v-if="!active && task.result">
        <h2 class="text-h6 mb-1">{{ t('task.result') }}</h2>
        <p v-if="task.result.decision" class="mb-1">
          {{ t('task.decision') }}: {{ task.result.decision === 'approve' ? t('task.approve') : t('task.requestChanges') }}
        </p>
        <MarkdownView :source="task.result.text" data-testid="result-text" />
        <AttachmentList :attachments="task.attachments" class="mb-4" />
      </template>

      <template v-if="isAssignee && workable">
        <v-textarea v-model="text" :label="t('task.comment')" rows="3" auto-grow data-testid="result-input" />
        <h3 class="text-subtitle-2 mb-1">{{ t('task.resultAttachments') }}</h3>
        <AttachmentList :attachments="attached" class="mb-2" />
        <AttachmentUpload v-if="staff" class="mb-4" :project-id="task.projectId" :work-item-id="task.workItemId" :task-id="task.id" @uploaded="a => attached.push(a)" />
        <AttachmentUpload v-else-if="intakeId" class="mb-4" :conversation-id="intakeId" @uploaded="a => attached.push(a)" />
        <div class="d-flex ga-2 mb-4">
          <v-btn v-if="task.state === 'open'" color="primary" :loading="busy" data-testid="start-btn" @click="start">{{ t('task.start') }}</v-btn>
          <template v-if="isDecision">
            <v-btn color="success" :loading="busy" data-testid="approve-btn" @click="decide('approve')">{{ t('task.approve') }}</v-btn>
            <v-btn color="warning" :loading="busy" data-testid="changes-btn" @click="decide('changes')">{{ t('task.requestChanges') }}</v-btn>
          </template>
          <v-btn v-else color="primary" :loading="busy" data-testid="submit-btn" @click="submit">{{ t('task.submit') }}</v-btn>
        </div>
      </template>

      <template v-if="canManage && active">
        <div v-if="showConfirm" class="mb-4">
          <p class="mb-2">{{ t('task.proposedAssignee') }}: {{ task.proposedAssigneeName }}</p>
          <v-btn color="primary" :loading="busy" data-testid="confirm-btn" @click="confirmTask">{{ t('task.confirm') }}</v-btn>
        </div>
        <v-card v-if="project" :title="t('task.changeAssignee')" variant="outlined" class="mb-4">
          <v-card-text class="d-flex ga-4">
            <v-select
              v-model="newAssignee"
              :items="project.members"
              item-title="displayName"
              item-value="personId"
              :label="t('task.assignee')"
              hide-details
              data-testid="assignee-select"
            />
            <v-btn color="primary" :disabled="!newAssignee" :loading="busy" data-testid="assign-btn" @click="assign">{{ t('task.assign') }}</v-btn>
          </v-card-text>
        </v-card>
      </template>
    </template>
  </div>
</template>
