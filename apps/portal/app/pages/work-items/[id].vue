<script setup lang="ts">
import type { Discussion, ProjectDetail, Task, WorkItemDetail, WorkItemEventsPage, WorkflowTemplateSummary } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { localized } from '~/utils/localized'
import { waitingFor } from '~/utils/runners'
import { bangkokToday, isOverdue } from '~/utils/status'
import { statusStyle } from '~/utils/statusStyle'
import { appendOlder, mergeTimeline } from '~/utils/timeline'
import { daysUntil, reopenTargets, stepGroups } from '~/utils/workItems'

const { t, locale } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const { smAndDown } = useDisplay()
const id = route.params.id as string

const item = ref<WorkItemDetail | null>(null)
const project = ref<ProjectDetail | null>(null)
definePageMeta({ crumbs: [{ key: 'nav.projects', to: '/projects' }] })
useBreadcrumb(() => {
  if (!item.value) return []
  const p = project.value ? [{ label: project.value.name, to: `/projects/${project.value.id}` }] : []
  return [...p, { label: item.value.title }]
})
const templates = ref<WorkflowTemplateSummary[]>([])
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const notFound = ref(false)
const error = ref('')
const busy = ref(false)
const cancelOpen = ref(false)
const reopenOpen = ref(false)
const reopenStep = ref<string | null>(null)
const assignTask = ref<Task | null>(null)
const assignOpen = ref(false)
const raiseOpen = ref(false)
const discussions = ref<Discussion[]>([])
const codePanel = ref<{ reload: () => Promise<void> } | null>(null)
const expanded = ref<Record<string, boolean>>({})

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => !!me.value?.isAdmin || isPm.value)
const isMember = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id))
const canRaise = computed(() => !!item.value && item.value.state === 'active' && (!!me.value?.isAdmin || isMember.value))
const isActive = computed(() => item.value?.state === 'active')
/** PM/admin may send an active item back to an earlier step (e.g. the requester asked for changes). */
const reopenSteps = computed(() => (canManage.value && isActive.value && item.value ? reopenTargets(item.value.steps) : []))
const reopenItems = computed(() => reopenSteps.value.map(s => ({ value: s.key, title: localized(s.name, locale.value) })))
const reopenName = computed(() => reopenItems.value.find(x => x.value === reopenStep.value)?.title ?? '')
const canCancel = computed(() => isActive.value && (canManage.value || item.value?.ownerId === me.value?.id))
const hasMenu = computed(() => reopenSteps.value.length > 0 || canCancel.value)
/** PM/admin, or the owner while still a member, may set the target date of an active item (the server enforces). */
const canSetTarget = computed(() => isActive.value && (canManage.value || (item.value?.ownerId === me.value?.id && isMember.value)))
const today = computed(() => bangkokToday())
const overdue = computed(() => isActive.value && isOverdue(item.value?.targetDate ?? null, today.value))
const daysLeft = computed(() => daysUntil(item.value?.targetDate ?? null, today.value))
const { date: fmtDate, dateTime, dateShort, relative } = useDateFormat()
const templateName = computed(() => {
  const tpl = templates.value.find(x => x.key === item.value?.templateKey)
  return tpl ? localized(tpl.name, locale.value) : (item.value?.templateKey ?? '')
})
const blockers = computed(() => discussions.value.filter(x => x.state === 'open' || x.state === 'scheduled'))
const groups = computed(() => (item.value ? stepGroups(item.value.steps, item.value.tasks) : []))
const isExpanded = (key: string, byDefault: boolean) => expanded.value[key] ?? byDefault
const taskTitles = computed(() => Object.fromEntries((item.value?.tasks ?? []).map(x => [x.id, localized(x.title, locale.value)])))
const runningTasks = computed(() => (item.value?.tasks ?? []).filter(x => x.run && x.run.state === 'running'))

const taskOpen = (x: Task) => ['proposed', 'open', 'in_progress'].includes(x.state)
const waitingForAi = (x: Task) => x.executor === 'ai' && !x.assigneeId && x.state === 'open'
const showConfirm = (x: Task) => canManage.value && x.state === 'proposed' && !!x.proposedAssigneeId
const showAssign = (x: Task) => canManage.value && isActive.value && taskOpen(x)
const typeStyle = (x: Task) => statusStyle('taskType', x.type)

let seq = 0
async function load() {
  const mine = ++seq
  void loadTimeline()
  try {
    const loaded = await api<WorkItemDetail>(`/work-items/${id}`)
    if (mine !== seq) return
    item.value = loaded
    loadError.value = ''
    notFound.value = false
    void codePanel.value?.reload()
    try {
      const all = await api<Discussion[]>('/discussions', { query: { projectId: loaded.projectId } })
      if (mine === seq) discussions.value = all.filter(x => x.workItemId === id)
    } catch {
      discussions.value = []
    }
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
    if (mine !== seq) return
    const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status
    notFound.value = status === 404
    loadError.value = t(errorKey(e))
    loadFailure.value = e
  }
}

/** Rows per timeline page (proposal §6.9: about two days, at most 20 rows). */
const TIMELINE_PAGE = 20
// The timeline is paged (newest first): a refresh reloads the newest page and keeps older pages already shown.
// Key events by default (proposal §6.9); switching the filter starts over.
const timelineKind = ref<'key' | 'all'>('key')
const timeline = ref<WorkItemEventsPage>({ events: [], nextBefore: null })
const timelineLoaded = ref(false)
const timelineError = ref<unknown>(null)
const loadingMore = ref(false)
const moreError = ref('')
let timelineSeq = 0
async function loadTimeline() {
  const mine = ++timelineSeq
  const kind = timelineKind.value
  try {
    const page = await api<WorkItemEventsPage>(`/work-items/${id}/events`, { query: { limit: TIMELINE_PAGE, kind } })
    if (mine !== timelineSeq || kind !== timelineKind.value) return
    timeline.value = mergeTimeline(timeline.value, page)
    timelineLoaded.value = true
    timelineError.value = null
  } catch (e) {
    if (mine === timelineSeq && !timelineLoaded.value) timelineError.value = e
  }
}
watch(timelineKind, () => {
  timeline.value = { events: [], nextBefore: null }
  timelineLoaded.value = false
  timelineError.value = null
  moreError.value = ''
  void loadTimeline()
})
async function loadMore() {
  const before = timeline.value.nextBefore
  if (before === null || loadingMore.value) return
  loadingMore.value = true
  moreError.value = ''
  const kind = timelineKind.value
  try {
    const page = await api<WorkItemEventsPage>(`/work-items/${id}/events`, { query: { before, limit: TIMELINE_PAGE, kind } })
    // A live refresh in the meantime keeps the cursor, so the page still applies; a reset makes it stale.
    const next = kind === timelineKind.value ? appendOlder(timeline.value, before, page) : null
    if (next) timeline.value = next
  } catch {
    moreError.value = t('workItems.timelineMoreFailed')
  } finally {
    loadingMore.value = false
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
function openAssign(x: Task) {
  assignTask.value = x
  assignOpen.value = true
}
async function advance() {
  await act(() => api(`/work-items/${id}/advance`, { method: 'POST' }))
}
function openReopen() {
  reopenStep.value = null
  error.value = ''
  reopenOpen.value = true
}
async function reopen() {
  const stepKey = reopenStep.value
  if (!stepKey) return
  const ok = await act(() => api(`/work-items/${id}/reopen`, { method: 'POST', body: { stepKey } }))
  if (ok) reopenOpen.value = false
}
async function cancelItem() {
  const ok = await act(() => api(`/work-items/${id}/cancel`, { method: 'POST' }))
  if (ok) cancelOpen.value = false
}
const setTargetDate = (targetDate: string | null) => act(() => api(`/work-items/${id}`, { method: 'PATCH', body: { targetDate } }))
// Dialog errors show inside the dialog only, and go away with it.
watch([cancelOpen, reopenOpen], ([c, r]) => {
  if (!c && !r) error.value = ''
})
function toggleStep(key: string, byDefault: boolean) {
  expanded.value = { ...expanded.value, [key]: !isExpanded(key, byDefault) }
}

onMounted(load)
useLiveEvents((e) => {
  if (e.workItemId === id || (e.type.startsWith('discussion.') && e.projectId === item.value?.projectId)) loadSoon()
}, loadSoon)
</script>

<template>
  <div>
    <template v-if="loadError && !item">
      <EmptyState v-if="notFound" wisdom="notFound" :title="t('workItems.notFound')" :text="t('workItems.notFoundHint')" icon="mdi-file-search-outline" data-testid="load-error">
        <v-btn color="primary" variant="flat" to="/projects">{{ t('workItems.toProjects') }}</v-btn>
      </EmptyState>
      <ErrorState v-else :error="loadFailure" data-testid="load-error" @retry="load" />
    </template>
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <SkeletonDetail v-else-if="!item" />

    <template v-if="item">
      <PageHeader :title="item.title" class="mb-3">
        <template #context>
          <StatusChip kind="workItem" :value="item.state" data-testid="state-chip" />
          <PriorityMark :priority="item.priority" data-testid="priority-chip" />
          <v-chip size="x-small" variant="outlined" data-testid="template-chip">{{ templateName }}</v-chip>
        </template>
        <template #actions>
          <v-btn
            v-if="canManage && item.awaitingAdvance && !item.openDiscussions"
            color="primary"
            variant="flat"
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
          <v-menu v-if="hasMenu" location="bottom end">
            <template #activator="{ props: menu }">
              <v-btn v-bind="menu" icon="mdi-dots-horizontal" variant="outlined" size="small" :aria-label="t('workItems.more')" :title="t('workItems.more')" data-testid="more-btn" />
            </template>
            <v-list density="compact" min-width="220" data-testid="more-menu">
              <v-list-item v-if="reopenSteps.length" prepend-icon="mdi-undo-variant" :title="t('workItems.reopenEllipsis')" data-testid="reopen-btn" @click="openReopen" />
              <template v-if="canCancel">
                <v-divider v-if="reopenSteps.length" class="my-1" />
                <v-list-item
                  prepend-icon="mdi-close-circle-outline"
                  base-color="error"
                  :title="t('workItems.cancelEllipsis')"
                  data-testid="cancel-btn"
                  @click="cancelOpen = true"
                />
              </template>
            </v-list>
          </v-menu>
        </template>
        <template #meta>
          <NuxtLink v-if="project" :to="`/projects/${project.id}`" class="wi-meta-link d-inline-flex align-center ga-1">
            <v-icon icon="mdi-folder-outline" size="16" aria-hidden="true" />{{ project.name }}
          </NuxtLink>
          <span v-if="item.targetDate" class="d-inline-flex align-center ga-1" :class="{ 'text-error': overdue }" data-testid="target-chip">
            <v-icon :icon="overdue ? 'mdi-calendar-alert' : 'mdi-calendar-outline'" size="16" aria-hidden="true" />
            {{ t('status.due', { date: fmtDate(item.targetDate) }) }}
            <span v-if="overdue" class="font-weight-medium" data-testid="overdue-chip">· {{ t('status.overdue') }}</span>
          </span>
          <span class="d-inline-flex align-center ga-1" :title="dateTime(item.updatedAt)">
            <v-icon icon="mdi-update" size="16" aria-hidden="true" />{{ t('task.updatedAgo', { time: relative(item.updatedAt) }) }}
          </span>
        </template>
      </PageHeader>

      <StepTrack :steps="item.steps" :show-names="!smAndDown" class="mb-4" data-testid="stepper" />

      <v-alert v-if="error && !cancelOpen && !reopenOpen" type="error" variant="tonal" class="mb-4" closable data-testid="action-error" @click:close="error = ''">{{ error }}</v-alert>

      <v-alert
        v-if="item.openDiscussions > 0"
        color="warning-soft"
        variant="flat"
        icon="mdi-forum-outline"
        class="mb-4 wi-banner"
        data-testid="blocked-banner"
      >
        <div class="font-weight-medium">{{ t('discussions.blocked', { n: item.openDiscussions }, item.openDiscussions) }}</div>
        <div class="text-body-2">{{ t('discussions.blockedHint') }}</div>
        <ul class="wi-banner__list">
          <li v-for="b in blockers" :key="b.id"><NuxtLink :to="`/discussions/${b.id}`" data-testid="blocker-link">{{ b.question }}</NuxtLink></li>
        </ul>
      </v-alert>

      <div class="wi-layout">
        <div class="wi-main">
          <section class="mb-6" :aria-labelledby="'wi-tasks-title'">
            <h2 id="wi-tasks-title" class="text-subtitle-1 wi-section-title">
              {{ t('workItems.tasks') }} <span class="wi-count tabular-nums">{{ item.tasks.length }}</span>
            </h2>
            <v-card class="wi-steps">
              <template v-for="(g, i) in groups" :key="g.step.key">
                <div class="wi-step" :class="`wi-step--${g.step.status}`" data-testid="step-group" :data-step="g.step.key">
                  <button
                    type="button"
                    class="wi-step__head"
                    :aria-expanded="isExpanded(g.step.key, g.expanded)"
                    :data-testid="`step-toggle-${g.step.key}`"
                    @click="toggleStep(g.step.key, g.expanded)"
                  >
                    <v-icon :icon="isExpanded(g.step.key, g.expanded) ? 'mdi-chevron-down' : 'mdi-chevron-right'" size="20" aria-hidden="true" />
                    <span class="wi-step__name">{{ i + 1 }}. {{ localized(g.step.name, locale) }}</span>
                    <StatusChip v-if="g.step.status !== 'pending'" kind="step" :value="g.step.status" size="x-small" />
                    <span class="wi-step__count text-body-2 tabular-nums">
                      <template v-if="!g.total">{{ t('workItems.stepNotStarted') }}</template>
                      <template v-else-if="g.step.status === 'current'">{{ t('workItems.stepProgress', { done: g.done, total: g.total }) }}</template>
                      <template v-else>{{ t('workItems.stepTasks', { n: g.total }, g.total) }}</template>
                    </span>
                  </button>
                  <div v-if="isExpanded(g.step.key, g.expanded) && g.tasks.length" class="wi-tasks">
                    <div v-for="task in g.tasks" :key="task.id" class="wi-task" data-testid="task-card">
                      <span class="wi-task__icon" :class="`wi-task__icon--${typeStyle(task).tone}`" :title="t(typeStyle(task).labelKey)">
                        <v-icon :icon="typeStyle(task).icon" size="18" aria-hidden="true" />
                      </span>
                      <div class="wi-task__main">
                        <div class="wi-task__title">
                          <NuxtLink :to="`/todo/${task.id}`">{{ localized(task.title, locale) }}</NuxtLink>
                          <span v-if="task.attempt > 1" class="text-caption text-medium-emphasis" data-testid="attempt">{{ t('workItems.attempt', { n: task.attempt }) }}</span>
                        </div>
                        <div class="wi-task__meta text-body-2 text-medium-emphasis">
                          <span class="d-inline-flex align-center ga-1" data-testid="executor-chip">
                            <v-icon :icon="task.executor === 'ai' ? 'mdi-creation-outline' : 'mdi-account-outline'" size="14" aria-hidden="true" />
                            {{ task.executor === 'ai' ? t('workItems.executorAi') : (task.assigneeName ?? task.proposedAssigneeName ?? t('task.unassigned')) }}
                          </span>
                          <span v-if="task.state === 'proposed' && task.proposedAssigneeName">{{ t('task.proposedAssignee') }}: {{ task.proposedAssigneeName }}</span>
                          <RunnerRunChip v-if="task.run" :run="task.run" />
                          <StatusChip v-if="waitingFor(task) === 'runner'" kind="waiting" value="runner" size="x-small" data-testid="waiting-runner" />
                          <StatusChip v-else-if="waitingFor(task) === 'ai'" kind="waiting" value="ai" size="x-small" data-testid="waiting-ai" />
                          <AiStatus v-if="task.aiStatus" :task="task" :can-retry="canManage && isActive" @retried="load" />
                        </div>
                      </div>
                      <div class="wi-task__side">
                        <StatusChip kind="task" :value="task.state" size="x-small" data-testid="task-state" />
                        <div v-if="showConfirm(task) || showAssign(task)" class="wi-task__actions">
                          <v-btn v-if="showAssign(task)" size="small" variant="text" color="primary" data-testid="assign-toggle" @click="openAssign(task)">
                            {{ waitingForAi(task) ? t('workItems.assignToPerson') : (task.assigneeId || task.proposedAssigneeId ? t('todo.changePerson') : t('task.assign')) }}
                          </v-btn>
                          <v-btn v-if="showConfirm(task)" size="small" color="primary" variant="flat" :loading="busy" data-testid="confirm-btn" @click="confirmTask(task.id)">{{ t('task.confirm') }}</v-btn>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
            </v-card>
          </section>

          <section :aria-labelledby="'wi-timeline-title'">
            <div class="wi-timeline-head">
              <h2 id="wi-timeline-title" class="text-subtitle-1 wi-section-title mb-0">{{ t('workItems.timeline') }}</h2>
              <v-btn-toggle
                v-model="timelineKind"
                mandatory
                density="compact"
                variant="outlined"
                divided
                color="primary"
                :aria-label="t('workItems.timelineFilter')"
                data-testid="timeline-filter"
              >
                <v-btn value="key" size="small" data-testid="timeline-filter-key">{{ t('workItems.timelineKey') }}</v-btn>
                <v-btn value="all" size="small" data-testid="timeline-filter-all">{{ t('workItems.timelineAll') }}</v-btn>
              </v-btn-toggle>
            </div>
            <ErrorState v-if="timelineError" :error="timelineError" :title="t('workItems.timelineFailed')" data-testid="timeline-error" @retry="loadTimeline" />
            <v-card v-else class="wi-timeline">
              <SkeletonList v-if="!timelineLoaded" :rows="4" quiet data-testid="timeline-loading" />
              <p v-else-if="!timeline.events.length" class="text-body-2 text-medium-emphasis pa-4 ma-0">{{ timelineKind === 'key' ? t('workItems.timelineEmptyKey') : t('workItems.timelineEmpty') }}</p>
              <EventTimeline v-else :events="timeline.events" :task-titles="taskTitles" class="px-4 pb-2" />
              <div v-if="timeline.nextBefore !== null" class="wi-timeline__more">
                <div v-if="moreError" class="text-body-2 text-error text-center pt-2" role="alert" data-testid="timeline-more-error">{{ moreError }}</div>
                <v-btn variant="text" color="primary" block :loading="loadingMore" data-testid="timeline-load-more" @click="loadMore">
                  {{ t('workItems.timelineMore', { date: timeline.events.length ? dateShort(timeline.events[timeline.events.length - 1]!.createdAt) : '' }) }}
                </v-btn>
              </div>
            </v-card>
          </section>
        </div>

        <aside class="wi-side" :aria-label="t('workItems.side.label')">
          <v-card class="mb-4" data-testid="side-details">
            <div class="wi-card-head"><h2 class="text-subtitle-2">{{ t('workItems.side.details') }}</h2></div>
            <div class="wi-card-body">
              <p v-if="item.description" class="text-body-2 mb-4 wi-description" data-testid="description">{{ item.description }}</p>
              <dl class="wi-facts">
                <dt>{{ t('workItems.owner') }}</dt>
                <dd data-testid="owner-chip">{{ item.ownerName }}</dd>
                <template v-if="item.requesterName">
                  <dt>{{ t('workItems.requester') }}</dt>
                  <dd data-testid="requester-chip">{{ item.requesterName }}</dd>
                </template>
                <dt>{{ t('workItems.targetDate') }}</dt>
                <dd class="wi-facts__target" data-testid="target-date">
                  <span :class="{ 'text-error': overdue }">
                    <template v-if="item.targetDate">
                      <span class="tabular-nums">{{ fmtDate(item.targetDate) }}</span>
                      <span v-if="isActive && daysLeft !== null" class="text-caption text-medium-emphasis ml-1" data-testid="days-left">
                        ({{ daysLeft >= 0 ? t('workItems.daysLeft', { n: daysLeft }) : t('workItems.daysLate', { n: -daysLeft }) }})
                      </span>
                    </template>
                    <span v-else class="text-medium-emphasis">{{ t('workItems.noTargetDate') }}</span>
                  </span>
                  <WorkItemTargetDateMenu v-if="canSetTarget" :value="item.targetDate" :busy="busy" @save="setTargetDate" />
                </dd>
                <dt>{{ t('workItems.template') }}</dt>
                <dd>{{ templateName }}</dd>
                <dt>{{ t('workItems.side.created') }}</dt>
                <dd class="tabular-nums">{{ dateTime(item.createdAt) }}</dd>
              </dl>
            </div>
          </v-card>

          <v-card v-if="runningTasks.length" class="mb-4" data-testid="side-runs">
            <div class="wi-card-head"><h2 class="text-subtitle-2">{{ t('workItems.side.runs') }}</h2></div>
            <div class="wi-card-body d-flex flex-column ga-2">
              <div v-for="x in runningTasks" :key="x.id" class="text-body-2">
                <NuxtLink :to="`/todo/${x.id}`">{{ localized(x.title, locale) }}</NuxtLink>
                <div class="mt-1"><RunnerRunChip :run="x.run!" /></div>
              </div>
            </div>
          </v-card>

          <WorkItemCodePanel
            v-if="me?.isStaff"
            ref="codePanel"
            :work-item-id="item.id"
            :project-id="item.projectId"
            :can-manage="canManage"
            :active="isActive"
          />

          <v-card v-if="discussions.length" class="mb-4" data-testid="side-discussions">
            <div class="wi-card-head"><h2 class="text-subtitle-2">{{ t('workItems.side.discussions') }}</h2></div>
            <div class="wi-card-body d-flex flex-column ga-3">
              <div v-for="d in discussions" :key="d.id" class="text-body-2">
                <NuxtLink :to="`/discussions/${d.id}`" class="wi-discussion">{{ d.question }}</NuxtLink>
                <div class="mt-1"><StatusChip kind="discussion" :value="d.state" size="x-small" /></div>
              </div>
            </div>
          </v-card>
        </aside>
      </div>

      <DiscussionsRaiseDiscussionDialog
        v-model="raiseOpen"
        :project-id="item.projectId"
        :work-item-id="item.id"
        :work-item-title="item.title"
        :no-ai="project?.noAi"
        @raised="(did: string) => navigateTo(`/discussions/${did}`)"
      />

      <TaskAssignDialog
        v-if="canManage && project && assignTask"
        v-model="assignOpen"
        :task="assignTask"
        :members="project.members"
        @assigned="load"
      />

      <AppDialog v-model="reopenOpen" :title="t('workItems.reopenTitle')" size="confirm" :busy="busy" data-testid="reopen-dialog">
        <p class="text-body-2 mb-4">{{ t('workItems.reopenConfirm') }}</p>
        <v-select
          v-model="reopenStep"
          autofocus
          :items="reopenItems"
          :label="t('workItems.reopenStep')"
          hide-details
          data-testid="reopen-step-select"
        />
        <v-alert v-if="error" type="error" variant="tonal" class="mt-4" density="compact">{{ error }}</v-alert>
        <template #actions>
          <v-btn variant="text" :disabled="busy" @click="reopenOpen = false">{{ t('workItems.keep') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!reopenStep" :loading="busy" data-testid="reopen-confirm" @click="reopen">
            {{ reopenStep ? t('workItems.reopenTo', { step: reopenName }) : t('workItems.reopen') }}
          </v-btn>
        </template>
      </AppDialog>

      <ConfirmDialog
        v-model="cancelOpen"
        :title="t('workItems.cancelTitleNamed', { title: item.title })"
        :text="t('workItems.cancelConfirm')"
        :confirm-label="t('workItems.cancel')"
        :cancel-label="t('workItems.keep')"
        destructive
        :busy="busy"
        :error="error"
        confirm-testid="cancel-confirm"
        cancel-testid="cancel-keep"
        data-testid="cancel-dialog"
        @confirm="cancelItem"
      />
    </template>
  </div>
</template>

<style scoped>
.wi-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
@media (min-width: 1280px) { .wi-layout { grid-template-columns: minmax(0, 1fr) 340px; } }
.wi-main, .wi-side { min-width: 0; }
.wi-section-title { font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.wi-count { font-size: .75rem; font-weight: 500; padding: 0 8px; border-radius: 10px; background: rgb(var(--v-theme-neutral-soft)); color: rgb(var(--v-theme-neutral)); }
.wi-meta-link { color: inherit; }
.wi-banner { color: rgb(var(--v-theme-warning)) !important; border: 1px solid rgba(var(--v-theme-warning-dot), .35); }
.wi-banner :deep(a) { color: rgb(var(--v-theme-primary)); }
.wi-banner__list { padding-left: 20px; margin-top: 4px; }

.wi-step + .wi-step { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.wi-step__head {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 48px; padding: 8px 16px;
  text-align: left; background: none; border: 0; cursor: pointer; color: inherit; font: inherit;
}
.wi-step__head:hover { background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity)); }
.wi-step__name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.wi-step--pending .wi-step__name { font-weight: 400; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.wi-step__count { margin-left: auto; flex: none; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.wi-tasks { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.wi-task { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 4px 12px; padding: 12px 16px 12px 44px; align-items: start; }
.wi-task + .wi-task { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.wi-task__icon { width: 28px; height: 28px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; }
.wi-task__icon--ai { background: rgb(var(--v-theme-ai-soft)); color: rgb(var(--v-theme-ai)); }
.wi-task__icon--info { background: rgb(var(--v-theme-info-soft)); color: rgb(var(--v-theme-info)); }
.wi-task__icon--neutral { background: rgb(var(--v-theme-neutral-soft)); color: rgb(var(--v-theme-neutral)); }
.wi-task__main { min-width: 0; }
.wi-task__title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-weight: 500; overflow-wrap: anywhere; }
.wi-task__title a { color: inherit; }
.wi-task__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 2px; }
.wi-task__side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.wi-task__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
@media (max-width: 599px) {
  .wi-task { grid-template-columns: 28px minmax(0, 1fr); padding-left: 16px; }
  .wi-task__side { grid-column: 2; align-items: flex-start; }
  .wi-task__actions { justify-content: flex-start; }
}

.wi-timeline-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.wi-timeline { overflow: visible; --et-sticky-top: var(--v-layout-top, 56px); }
.wi-timeline__more { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); padding: 4px 8px; }

.wi-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 8px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.wi-card-head h2 { margin: 0; font-weight: 600; }
.wi-card-body { padding: 16px; min-width: 0; overflow-wrap: anywhere; }
.wi-description { white-space: pre-wrap; }
.wi-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: .875rem; align-items: center; }
.wi-facts dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.wi-facts dd { margin: 0; overflow-wrap: anywhere; }
.wi-facts__target { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.wi-discussion { color: inherit; font-weight: 500; }
</style>
