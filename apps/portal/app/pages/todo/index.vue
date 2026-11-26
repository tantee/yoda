<script setup lang="ts">
import type { Project, ProjectDetail, TaskWithContext, Todo, WorkflowTemplateSummary } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { byPriority, filterTodo, TODO_TABS, todoCounts, todoProjects, visibleRows, type TodoTab } from '~/utils/todo'

const { t } = useI18n()
const api = useApi()
const { me } = useMe()
const { refresh: refreshCounts } = useCounts()
const { dateTime } = useDateFormat()
const { width } = useDisplay()
// Stacked rows below 1024 px (proposal §6.3).
const stacked = computed(() => width.value < 1024)

const todo = ref<Todo | null>(null)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const error = ref('')
const loadedAt = ref<Date | null>(null)
const tab = ref<TodoTab>('all')
const projectId = ref<string | null>(null)
const showAllConfirmations = ref(false)
const CONFIRMATION_ROWS = 8

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<Todo>('/me/todo')
    if (mine !== seq) return
    todo.value = result
    loadError.value = ''
    loadedAt.value = new Date()
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

async function afterAction() {
  await load()
  void refreshCounts()
}

const advancing = ref<string | null>(null)
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
  await afterAction()
}

const confirming = ref<string | null>(null)
async function confirm(task: TaskWithContext) {
  error.value = ''
  confirming.value = task.id
  try {
    await api(`/tasks/${task.id}/confirm`, { method: 'POST' })
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    confirming.value = null
  }
  await afterAction()
}

const assignTask = ref<TaskWithContext | null>(null)
const assignOpen = ref(false)
function openAssign(task: TaskWithContext) {
  assignTask.value = task
  assignOpen.value = true
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
const projects = computed(() => (todo.value ? todoProjects(todo.value) : []))
// A project that dropped out of the list (its rows are done) clears the filter.
watch(projects, (list) => {
  if (projectId.value && !list.some(p => p.id === projectId.value)) projectId.value = null
})
const counts = computed(() => (todo.value ? todoCounts(todo.value, projectId.value) : null))
const totalCount = computed(() => (todo.value ? todoCounts(todo.value, null).all : 0))
const view = computed(() => (todo.value ? filterTodo(todo.value, { tab: tab.value, projectId: projectId.value }) : null))
const confirmations = computed(() => (view.value ? byPriority(view.value.confirmations) : []))
const shownConfirmations = computed(() => visibleRows(confirmations.value, showAllConfirmations.value, CONFIRMATION_ROWS))
const viewEmpty = computed(() => !!view.value && !view.value.decisions.length && !view.value.confirmations.length && !view.value.mine.length)

// "New work item": pick a project, then the usual create dialog.
const createProjects = ref<Project[] | null>(null)
const createProject = ref<ProjectDetail | null>(null)
const templates = ref<WorkflowTemplateSummary[]>([])
const createOpen = ref(false)
async function loadCreateProjects() {
  if (createProjects.value) return
  try {
    createProjects.value = (await api<Project[]>('/projects')).filter(p => p.status === 'active')
  } catch (e) {
    createProjects.value = null
    error.value = t(errorKey(e))
  }
}
async function startCreate(id: string) {
  error.value = ''
  try {
    const [detail, tpls] = await Promise.all([
      api<ProjectDetail>(`/projects/${id}`),
      templates.value.length ? Promise.resolve(templates.value) : api<WorkflowTemplateSummary[]>('/workflow-templates'),
    ])
    createProject.value = detail
    templates.value = tpls
    createOpen.value = true
  } catch (e) {
    error.value = t(errorKey(e))
  }
}
const createIsMember = computed(() => !!createProject.value?.members.some(m => m.personId === me.value?.id))
</script>

<template>
  <div>
    <PageHeader :title="t('nav.todo')">
      <template #actions>
        <v-select
          v-if="projects.length > 1"
          v-model="projectId"
          :items="projects"
          item-title="name"
          item-value="id"
          :placeholder="t('todo.allProjects')"
          :aria-label="t('todo.project')"
          prepend-inner-icon="mdi-filter-variant"
          clearable
          persistent-placeholder
          class="todo-project-filter"
          data-testid="todo-project-filter"
        />
        <v-menu @update:model-value="(open: boolean) => open && loadCreateProjects()">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" color="primary" prepend-icon="mdi-plus" data-testid="todo-create-btn">{{ t('workItems.new') }}</v-btn>
          </template>
          <v-list density="compact" min-width="240" max-height="360" data-testid="todo-create-projects">
            <v-list-subheader>{{ t('todo.createIn') }}</v-list-subheader>
            <v-list-item v-if="!createProjects" :title="t('todo.loadingProjects')" disabled />
            <v-list-item v-else-if="!createProjects.length" :title="t('todo.noProjects')" disabled />
            <v-list-item
              v-for="p in createProjects ?? []"
              :key="p.id"
              :title="p.name"
              prepend-icon="mdi-folder-outline"
              :data-testid="`todo-create-in-${p.id}`"
              @click="startCreate(p.id)"
            />
          </v-list>
        </v-menu>
      </template>
      <template v-if="todo" #meta>
        <span data-testid="todo-total">{{ t('todo.pending', { n: totalCount }) }}</span>
        <span v-if="loadedAt" class="d-inline-flex align-center ga-1">
          <v-icon icon="mdi-update" size="16" aria-hidden="true" />{{ t('todo.updated', { time: dateTime(loadedAt) }) }}
        </span>
      </template>
    </PageHeader>

    <ErrorState v-if="loadError && !todo" :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    <v-alert v-else-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <div v-else-if="!todo" data-testid="todo-loading">
      <div class="todo-decisions mb-6">
        <v-skeleton-loader v-for="i in 2" :key="i" type="article" class="todo-skeleton-card" />
      </div>
      <SkeletonList :rows="6" />
    </div>
    <v-alert v-if="error" type="error" class="mb-4" closable data-testid="action-error" @click:close="error = ''">{{ error }}</v-alert>

    <template v-if="todo && counts && view">
      <EmptyState
        v-if="isEmpty"
        wisdom="empty"
        icon="mdi-check-circle-outline"
        :title="t('todo.empty')"
        :text="t('todo.emptyText')"
        data-testid="todo-empty"
      />
      <template v-else>
        <div class="todo-filters mb-5">
          <v-btn-toggle v-model="tab" mandatory divided variant="outlined" density="compact" color="primary" class="todo-tabs" data-testid="todo-tabs">
            <v-btn v-for="k in TODO_TABS" :key="k" :value="k" :data-testid="`todo-tab-${k}`">
              {{ t(`todo.tabs.${k}`) }}
              <span class="todo-count ml-2">{{ counts[k] }}</span>
            </v-btn>
          </v-btn-toggle>
        </div>

        <EmptyState
          v-if="viewEmpty"
          icon="mdi-filter-off-outline"
          :title="t('todo.filterEmpty')"
          :text="t('todo.filterEmptyText')"
          data-testid="todo-filter-empty"
        />

        <section v-if="view.decisions.length" class="mb-7" aria-labelledby="todo-decisions-title">
          <div class="todo-section-title">
            <h2 id="todo-decisions-title" class="text-subtitle-1">{{ t('todo.proposals') }}</h2>
            <span class="todo-count">{{ view.decisions.length }}</span>
          </div>
          <div class="todo-decisions">
            <TodoDecisionCard
              v-for="d in view.decisions"
              :key="d.type === 'advance' ? `a-${d.item.id}` : d.proposal.id"
              :decision="d"
              :item="todo.workItems[d.type === 'advance' ? d.item.id : (d.proposal.workItemId ?? '')]"
              :project-name="todo.projectNames[(d.type === 'advance' ? d.item.projectId : d.proposal.projectId) ?? '']"
              :advancing="d.type === 'advance' && advancing === d.item.id"
              @advance="advance"
              @decided="afterAction"
            />
          </div>
        </section>

        <section v-if="view.confirmations.length" class="mb-7" aria-labelledby="todo-confirmations-title">
          <div class="todo-section-title">
            <h2 id="todo-confirmations-title" class="text-subtitle-1">{{ t('todo.confirmations') }}</h2>
            <span class="todo-count">{{ view.confirmations.length }}</span>
            <span v-if="!stacked" class="text-caption text-medium-emphasis">{{ t('todo.sortHint') }}</span>
          </div>
          <v-card data-testid="confirmations">
            <TodoTaskRows
              :rows="shownConfirmations"
              mode="confirmations"
              :items="todo.workItems"
              :stacked="stacked"
              :busy-id="confirming"
              @assign="openAssign"
              @confirm="confirm"
              @retried="load"
            />
            <div v-if="confirmations.length > CONFIRMATION_ROWS" class="todo-more">
              <span class="text-caption text-medium-emphasis tabular-nums">{{ t('todo.showing', { n: shownConfirmations.length, total: confirmations.length }) }}</span>
              <v-btn variant="text" color="primary" size="small" data-testid="todo-show-all" @click="showAllConfirmations = !showAllConfirmations">
                {{ showAllConfirmations ? t('todo.showLess') : t('todo.showAll') }}
              </v-btn>
            </div>
          </v-card>
        </section>

        <section v-if="view.mine.length" class="mb-7" aria-labelledby="todo-mine-title">
          <div class="todo-section-title">
            <h2 id="todo-mine-title" class="text-subtitle-1">{{ t('todo.myTasks') }}</h2>
            <span class="todo-count">{{ view.mine.length }}</span>
          </div>
          <v-card data-testid="my-tasks">
            <TodoTaskRows :rows="view.mine" mode="mine" :items="todo.workItems" :stacked="stacked" />
          </v-card>
        </section>
      </template>
    </template>

    <TaskAssignDialog v-if="assignTask" v-model="assignOpen" :task="assignTask" @assigned="afterAction" />
    <WorkItemCreateDialog
      v-if="createProject"
      v-model="createOpen"
      :project-id="createProject.id"
      :templates="templates"
      :members="createProject.members"
      :default-owner-id="createIsMember ? me?.id : (createProject.members.find(m => m.roles.includes('PM')) ?? createProject.members[0])?.personId"
      :owner-required="!createIsMember"
      @created="(id: string) => navigateTo(`/work-items/${id}`)"
    />
  </div>
</template>

<style scoped>
.todo-project-filter { width: 220px; flex: 0 1 220px; }
.todo-filters { overflow-x: auto; max-width: 100%; }
.todo-tabs { flex-wrap: nowrap; }
.todo-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px;
  border-radius: 10px; font-size: .75rem; font-weight: 600; font-variant-numeric: tabular-nums;
  background: rgb(var(--v-theme-background)); color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.v-btn--active .todo-count { background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.todo-section-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.todo-section-title h2 { margin: 0; font-weight: 600; }
.todo-decisions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 1023px) { .todo-decisions { grid-template-columns: minmax(0, 1fr); } }
.todo-skeleton-card { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
.todo-more { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
