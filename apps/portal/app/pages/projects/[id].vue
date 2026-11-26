<script setup lang="ts">
import type { KnowledgeEntry, LiveEvent, Person, ProjectDetail, ProjectStatus, WorkflowTemplateSummary, WorkItem } from '@yoda/shared'
import { debounceMax } from '~/utils/status'

const { t } = useI18n()
const { me } = useMe()
const route = useRoute()
const router = useRouter()
const api = useApi()
const id = route.params.id as string
const project = ref<ProjectDetail | null>(null)
useBreadcrumb(() => (project.value ? [{ label: project.value.name }] : []))
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const notFound = computed(() => (loadFailure.value as { statusCode?: number } | null)?.statusCode === 404)
const people = ref<Person[]>([])
const workItems = ref<WorkItem[] | null>(null)
const templates = ref<WorkflowTemplateSummary[]>([])
const itemsError = ref('')
const createOpen = ref(false)
const status = ref<ProjectStatus | null>(null)
const statusError = ref('')
const knowledgeTotal = ref<number | null>(null)
/** Bumped by the overdue KPI: the work items tab turns its overdue filter on. */
const overdueRequest = ref(0)
const TABS = ['status', 'items', 'overview', 'repos', 'knowledge', 'ai'] as const
// Only staff reach project pages (a staff path), so the status tab is the default.
const tab = ref<string>(TABS.includes(route.query.tab as never) ? (route.query.tab as string) : 'status')
const statusTab = ref<{ onLive: (e: LiveEvent) => void } | null>(null)
watch(tab, (v) => router.replace({ query: { ...route.query, tab: v } }))

const isMember = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id))
const canCreate = computed(() => (isMember.value || !!me.value?.isAdmin) && project.value?.status !== 'archived')
const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => !!me.value?.isAdmin || isPm.value)
const pmNames = computed(() => project.value?.members.filter(m => m.roles.includes('PM')).map(m => m.displayName) ?? [])
const activeItems = computed(() => workItems.value?.filter(w => w.state === 'active').length ?? null)

let itemsSeq = 0
async function loadItems() {
  const mine = ++itemsSeq
  try {
    const [items, tpls] = await Promise.all([
      api<WorkItem[]>(`/projects/${id}/work-items`),
      templates.value.length ? Promise.resolve(templates.value) : api<WorkflowTemplateSummary[]>('/workflow-templates'),
    ])
    if (mine !== itemsSeq) return
    workItems.value = items
    templates.value = tpls
    itemsError.value = ''
  } catch (e) {
    if (mine === itemsSeq) itemsError.value = t(errorKey(e))
  }
}

let itemsTimer: ReturnType<typeof setTimeout> | null = null
function loadItemsSoon() {
  if (itemsTimer) clearTimeout(itemsTimer)
  itemsTimer = setTimeout(loadItems, 200)
}

let statusSeq = 0
async function loadStatus() {
  const mine = ++statusSeq
  try {
    const s = await api<ProjectStatus>(`/projects/${id}/status`)
    if (mine !== statusSeq) return
    status.value = s
    statusError.value = ''
  } catch (e) {
    if (mine === statusSeq) statusError.value = t(errorKey(e))
  }
}
const loadStatusSoon = debounceMax(loadStatus, 400, 5000)

/** The knowledge tab count: one row is enough, the total comes in a header. */
async function loadKnowledgeTotal() {
  try {
    const res = await api.raw<KnowledgeEntry[]>('/knowledge', { query: { projectId: id, limit: 1 } })
    const n = Number(res.headers.get('x-total-count'))
    knowledgeTotal.value = Number.isFinite(n) ? n : null
  } catch {
    knowledgeTotal.value = null
  }
}

onBeforeUnmount(() => {
  if (itemsTimer) clearTimeout(itemsTimer)
  loadStatusSoon.cancel()
})

function onCreated(itemId: string) {
  router.push(`/work-items/${itemId}`)
}

async function load() {
  try {
    project.value = await api<ProjectDetail>(`/projects/${id}`)
    loadError.value = ''
    if (canManage.value) people.value = await api<Person[]>('/people')
  } catch (e) {
    loadError.value = t(errorKey(e))
    loadFailure.value = e
  }
}

onMounted(() => {
  load()
  loadItems()
  loadStatus()
  loadKnowledgeTotal()
})

const QUIET = ['run.heartbeat', 'message.created', 'notification.created', 'status.weekly_summary_outcome']
useLiveEvents((e) => {
  if (e.projectId !== id) return
  loadItemsSoon()
  statusTab.value?.onLive(e)
  if (!QUIET.includes(e.type)) loadStatusSoon()
  if (e.type.startsWith('knowledge.')) loadKnowledgeTotal()
}, () => {
  loadItemsSoon()
  loadStatusSoon()
})
</script>

<template>
  <div>
    <EmptyState
      v-if="loadError && !project && notFound"
      icon="mdi-folder-lock-outline"
      wisdom="notFound"
      :title="t('projects.notFound')"
      :text="t('projects.notFoundHint')"
      data-testid="load-error"
    >
      <v-btn color="primary" variant="flat" to="/projects">{{ t('projects.toProjects') }}</v-btn>
    </EmptyState>
    <ErrorState v-else-if="loadError && !project" :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    <SkeletonDetail v-else-if="!project" />
    <template v-if="project">
      <PageHeader :title="project.name">
        <template #actions>
          <v-btn v-if="canCreate" color="primary" prepend-icon="mdi-plus" data-testid="new-work-item" @click="createOpen = true">{{ t('workItems.new') }}</v-btn>
        </template>
        <template #meta>
          <StatusHealthChip v-if="status" :health="status.health" />
          <StatusChip v-if="project.status === 'archived'" kind="project" value="archived" />
          <span class="d-inline-flex align-center ga-1" data-testid="project-pm">
            <v-icon icon="mdi-account-tie-outline" size="16" aria-hidden="true" />
            {{ pmNames.length ? t('projects.meta.pm', { names: pmNames.join(', ') }) : t('projects.meta.noPm') }}
          </span>
          <span class="d-inline-flex align-center ga-1">
            <v-icon icon="mdi-account-multiple-outline" size="16" aria-hidden="true" />{{ t('projects.meta.members', { n: project.members.length }) }}
          </span>
          <span class="d-inline-flex align-center ga-1">
            <v-icon icon="mdi-robot-outline" size="16" aria-hidden="true" />{{ t(project.autonomy === 'auto-assign' ? 'projects.autoAssign' : 'projects.propose') }}
          </span>
        </template>
        <template #tabs>
          <v-tabs v-model="tab" density="compact" color="primary" show-arrows data-testid="project-tabs">
            <v-tab value="status" data-testid="tab-status">{{ t('projects.tabs.status') }}</v-tab>
            <v-tab value="items" data-testid="tab-items">
              {{ t('projects.tabs.items') }}<span v-if="activeItems !== null" class="count-pill ml-2">{{ activeItems }}</span>
            </v-tab>
            <v-tab value="overview" data-testid="tab-overview">{{ t('projects.tabs.overview') }}</v-tab>
            <v-tab value="repos" data-testid="tab-repos">
              {{ t('projects.tabs.repos') }}<span v-if="status" class="count-pill ml-2">{{ status.repos.length }}</span>
            </v-tab>
            <v-tab value="knowledge" data-testid="tab-knowledge">
              {{ t('projects.tabs.knowledge') }}<span v-if="knowledgeTotal !== null" class="count-pill ml-2">{{ knowledgeTotal }}</span>
            </v-tab>
            <v-tab value="ai" data-testid="tab-ai">{{ t('projects.tabs.ai') }}</v-tab>
          </v-tabs>
        </template>
      </PageHeader>
      <v-alert v-if="project.status === 'archived'" type="info" variant="tonal" class="mb-4" data-testid="archived-banner">{{ t('projects.archivedBanner') }}</v-alert>

      <v-window v-model="tab" :touch="false" class="project-window">
        <v-window-item value="status">
          <ErrorState v-if="statusError && !status" class="mb-4" data-testid="status-error" @retry="loadStatus" />
          <StatusProjectTab
            v-else
            ref="statusTab"
            :project-id="id"
            :status="status"
            :no-ai="project.noAi"
            :can-manage="canManage"
            @refresh="loadStatusSoon"
            @show-overdue="overdueRequest++; tab = 'items'"
          />
        </v-window-item>
        <v-window-item value="items">
          <ProjectWorkItemsTab
            :items="workItems"
            :templates="templates"
            :error="itemsError"
            :can-create="canCreate"
            :initial-overdue="route.query.overdue === '1'"
            :overdue-request="overdueRequest"
            @create="createOpen = true"
            @retry="loadItems"
          />
        </v-window-item>
        <v-window-item value="overview">
          <ProjectMembersTab :project="project" :people="people" :can-manage="canManage" @changed="load" />
        </v-window-item>
        <v-window-item value="repos">
          <ProjectReposTab :project-id="id" :can-manage="canManage" :can-import="canCreate" @changed="loadStatusSoon" />
        </v-window-item>
        <v-window-item value="knowledge">
          <ProjectKnowledgeTab :project-id="id" :is-member="isMember" @changed="loadKnowledgeTotal" />
        </v-window-item>
        <v-window-item value="ai">
          <ProjectAiSettings :project="project" :can-manage="!!me?.isAdmin" @changed="load" />
        </v-window-item>
      </v-window>

      <WorkItemCreateDialog
        v-model="createOpen"
        :project-id="id"
        :templates="templates"
        :members="project.members"
        :default-owner-id="isMember ? me?.id : (project.members.find(m => m.roles.includes('PM')) ?? project.members[0])?.personId"
        :owner-required="!isMember"
        @created="onCreated"
      />
    </template>
  </div>
</template>

<style scoped>
/* v-window clips its items: room for the floating labels of the filter fields at the top of a tab. */
.project-window :deep(.v-window-item) { padding-top: 8px; }
</style>
