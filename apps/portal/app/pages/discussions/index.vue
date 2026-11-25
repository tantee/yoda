<script setup lang="ts">
import type { Discussion, Project } from '@yoda/shared'
import { briefFailKey, sortDiscussions } from '~/utils/discussions'

const { t } = useI18n()
const api = useApi()

const tab = ref<'open' | 'scheduled' | 'decided'>('open')
const projectId = ref<string | null>(null)
const sort = ref<'priority' | 'created' | 'project'>('priority')
const list = ref<Discussion[]>([])
const projects = ref<Project[]>([])
const loadError = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const result = await api<Discussion[]>('/discussions', {
      query: { state: tab.value, ...(projectId.value ? { projectId: projectId.value } : {}) },
    })
    if (mine !== seq) return
    list.value = result
    loadError.value = ''
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
watch([tab, projectId], load)
onMounted(async () => {
  void load()
  try {
    projects.value = await api<Project[]>('/projects')
  } catch {
    projects.value = []
  }
})
useLiveEvents((e) => {
  if (e.type.startsWith('discussion.')) loadSoon()
}, loadSoon)

const rows = computed(() => sortDiscussions(list.value, sort.value))
const projectItems = computed(() => [{ id: null, name: t('discussions.allProjects') }, ...projects.value])
const sortItems = computed(() => (['priority', 'created', 'project'] as const).map(v => ({ value: v, title: t(`discussions.sort.${v}`) })))
const votes = (d: Discussion) => Object.values(d.voteCounts).reduce((a, b) => a + b, 0)
</script>

<template>
  <div>
    <div class="d-flex align-center mb-2">
      <h1 class="text-h5">{{ t('discussions.title') }}</h1>
      <v-spacer />
      <v-btn variant="outlined" prepend-icon="mdi-calendar-text-outline" to="/agendas" data-testid="agendas-link">{{ t('discussions.agendas') }}</v-btn>
    </div>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <v-tabs v-model="tab" class="mb-2" data-testid="discussion-tabs">
      <v-tab value="open" data-testid="tab-open">{{ t('discussions.tabs.open') }}</v-tab>
      <v-tab value="scheduled" data-testid="tab-scheduled">{{ t('discussions.tabs.scheduled') }}</v-tab>
      <v-tab value="decided" data-testid="tab-decided">{{ t('discussions.tabs.decided') }}</v-tab>
    </v-tabs>
    <div class="d-flex ga-4 mb-2">
      <v-select v-model="projectId" :items="projectItems" item-title="name" item-value="id" :label="t('discussions.filterProject')" density="compact" hide-details data-testid="project-filter" />
      <v-select v-model="sort" :items="sortItems" :label="t('discussions.sortBy')" density="compact" hide-details data-testid="sort-select" />
    </div>
    <p v-if="!rows.length" class="text-medium-emphasis" data-testid="discussions-empty">{{ t('discussions.empty') }}</p>
    <v-list v-else border lines="three" data-testid="discussion-list">
      <v-list-item v-for="d in rows" :key="d.id" :to="`/discussions/${d.id}`" data-testid="discussion-row">
        <v-list-item-title>{{ d.question }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ d.projectName ?? t('discussions.department') }}<template v-if="d.workItemTitle"> · {{ d.workItemTitle }}</template>
        </v-list-item-subtitle>
        <div class="d-flex flex-wrap align-center ga-1 mt-1">
          <PriorityMark :priority="d.priority" class="mr-2" data-testid="priority-chip" />
          <StatusChip v-if="d.brief?.status === 'pending'" kind="brief" value="pending" :label="t('discussions.brief.preparing')" size="x-small" data-testid="brief-status" />
          <StatusChip
            v-else-if="d.brief?.status === 'failed'"
            kind="brief"
            value="failed"
            :label="t('discussions.brief.failed', { reason: t(briefFailKey(d.brief.failReason)) })"
            size="x-small"
            data-testid="brief-status"
          />
          <v-chip size="x-small" variant="outlined">{{ t('discussions.votes', { n: votes(d) }) }}</v-chip>
          <v-chip v-if="d.agendaId" size="x-small" variant="outlined" prepend-icon="mdi-calendar-text-outline">{{ t('discussions.onAgenda') }}</v-chip>
        </div>
      </v-list-item>
    </v-list>
  </div>
</template>
