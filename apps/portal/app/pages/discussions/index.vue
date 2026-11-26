<script setup lang="ts">
import type { Discussion, Project } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { briefFailKey, sortDiscussions } from '~/utils/discussions'

const { t } = useI18n()
const api = useApi()
const { date } = useDateFormat()
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)

type Tab = 'open' | 'scheduled' | 'decided'
const tab = ref<Tab>('open')
const projectId = ref<string | null>(null)
const sort = ref<'priority' | 'created' | 'project'>('priority')
// Open and scheduled come in one call (the list's default); decided ones are loaded when that tab opens.
const active = ref<Discussion[]>([])
const decided = ref<Discussion[] | null>(null)
const projects = ref<Project[]>([])
const loaded = ref(false)
const loadError = ref('')
const loadFailure = ref<unknown>(null)

let seq = 0
async function load() {
  const mine = ++seq
  const query = projectId.value ? { projectId: projectId.value } : {}
  try {
    const [list, done] = await Promise.all([
      api<Discussion[]>('/discussions', { query }),
      tab.value === 'decided' || decided.value ? api<Discussion[]>('/discussions', { query: { ...query, state: 'decided' } }) : Promise.resolve(null),
    ])
    if (mine !== seq) return
    active.value = list
    decided.value = done
    loaded.value = true
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
watch(projectId, () => {
  decided.value = null
  void load()
})
watch(tab, (v) => {
  if (v === 'decided' && !decided.value) void load()
})
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

const byState = (s: Tab) => (s === 'decided' ? decided.value ?? [] : active.value.filter(d => d.state === s))
const counts = computed(() => ({ open: byState('open').length, scheduled: byState('scheduled').length, decided: decided.value?.length ?? null }))
const rows = computed(() => sortDiscussions(byState(tab.value), sort.value))
const waiting = computed(() => tab.value === 'decided' && !decided.value)
const projectItems = computed(() => [{ id: null, name: t('discussions.allProjects') }, ...projects.value])
const sortItems = computed(() => (['priority', 'created', 'project'] as const).map(v => ({ value: v, title: t(`discussions.sort.${v}`) })))
const votes = (d: Discussion) => Object.values(d.voteCounts).reduce((a, b) => a + b, 0)
const briefLabel = (d: Discussion) =>
  d.brief?.status === 'pending' ? t('discussions.brief.preparing') : d.brief?.status === 'failed' ? t('discussions.brief.failed', { reason: t(briefFailKey(d.brief.failReason)) }) : ''
</script>

<template>
  <div>
    <PageHeader :title="t('discussions.title')">
      <template #actions>
        <v-btn variant="outlined" prepend-icon="mdi-calendar-text-outline" to="/agendas" data-testid="agendas-link">{{ t('discussions.agendas') }}</v-btn>
      </template>
      <template #tabs>
        <v-tabs v-model="tab" density="compact" color="primary" data-testid="discussion-tabs">
          <v-tab v-for="k in (['open', 'scheduled', 'decided'] as const)" :key="k" :value="k" :data-testid="`tab-${k}`">
            {{ t(`discussions.tabs.${k}`) }}<span v-if="counts[k] !== null" class="count-pill ml-2">{{ counts[k] }}</span>
          </v-tab>
        </v-tabs>
      </template>
    </PageHeader>

    <div class="disc-filters mb-4">
      <v-select
        v-model="projectId"
        :items="projectItems"
        item-title="name"
        item-value="id"
        :label="t('discussions.filterProject')"
        density="compact"
        hide-details
        prepend-inner-icon="mdi-folder-outline"
        data-testid="project-filter"
      />
      <v-select v-model="sort" :items="sortItems" :label="t('discussions.sortBy')" density="compact" hide-details prepend-inner-icon="mdi-sort" data-testid="sort-select" />
    </div>

    <ErrorState v-if="loadError && !loaded" :error="loadFailure" data-testid="load-error" @retry="load" />
    <v-card v-else-if="!loaded || waiting" data-testid="discussions-loading"><SkeletonList :rows="5" /></v-card>
    <template v-else>
      <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
      <EmptyState
        v-if="!rows.length"
        icon="mdi-forum-outline"
        :title="t(`discussions.emptyTab.${tab}`)"
        :text="t('discussions.emptyText')"
        data-testid="discussions-empty"
      />
      <v-card v-else data-testid="discussion-list">
        <v-table v-if="!stacked" class="disc-table">
          <thead>
            <tr>
              <th>{{ t('discussions.cols.question') }}</th>
              <th>{{ t('discussions.cols.workItem') }}</th>
              <th>{{ t('discussions.cols.priority') }}</th>
              <th>{{ t('discussions.cols.brief') }}</th>
              <th class="text-right">{{ t('discussions.cols.votes') }}</th>
              <th>{{ t('discussions.cols.raised') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in rows" :key="d.id" data-testid="discussion-row">
              <td class="disc-table__question">
                <NuxtLink :to="`/discussions/${d.id}`" class="row-link">{{ d.question }}</NuxtLink>
                <div class="text-caption text-medium-emphasis">
                  {{ d.projectName ?? t('discussions.department') }}
                  <template v-if="d.agendaId"> · <v-icon icon="mdi-calendar-text-outline" size="12" aria-hidden="true" /> {{ t('discussions.onAgenda') }}</template>
                </div>
              </td>
              <td class="disc-table__item text-body-2">
                <NuxtLink v-if="d.workItemId" :to="`/work-items/${d.workItemId}`" class="row-link font-weight-regular">{{ d.workItemTitle }}</NuxtLink>
                <span v-else class="text-medium-emphasis">–</span>
              </td>
              <td><PriorityMark :priority="d.priority" data-testid="priority-chip" /></td>
              <td>
                <StatusChip v-if="d.brief?.status === 'pending' || d.brief?.status === 'failed'" kind="brief" :value="d.brief.status" :label="briefLabel(d)" size="x-small" class="disc-brief" data-testid="brief-status" />
                <StatusChip v-else-if="d.state === 'decided'" kind="discussion" value="decided" size="x-small" />
                <span v-else-if="d.brief?.status === 'ready'" class="text-caption text-medium-emphasis">{{ t('discussions.brief.ready') }}</span>
              </td>
              <td class="text-right tabular-nums">{{ votes(d) }}</td>
              <td class="text-body-2 text-medium-emphasis text-no-wrap">{{ date(d.createdAt) }}</td>
            </tr>
          </tbody>
        </v-table>
        <ul v-else class="disc-stack">
          <li v-for="d in rows" :key="d.id" data-testid="discussion-row">
            <NuxtLink :to="`/discussions/${d.id}`" class="row-link">{{ d.question }}</NuxtLink>
            <div class="text-caption text-medium-emphasis">
              {{ d.projectName ?? t('discussions.department') }}<template v-if="d.workItemTitle"> · {{ d.workItemTitle }}</template>
            </div>
            <div class="disc-stack__meta">
              <PriorityMark :priority="d.priority" data-testid="priority-chip" />
              <StatusChip v-if="d.brief?.status === 'pending' || d.brief?.status === 'failed'" kind="brief" :value="d.brief.status" :label="briefLabel(d)" size="x-small" class="disc-brief" data-testid="brief-status" />
              <span class="text-caption text-medium-emphasis">{{ t('discussions.votes', { n: votes(d) }) }}</span>
              <span v-if="d.agendaId" class="text-caption text-medium-emphasis">{{ t('discussions.onAgenda') }}</span>
            </div>
          </li>
        </ul>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.disc-filters { display: flex; flex-wrap: wrap; gap: 12px; }
.disc-filters > * { flex: 0 1 240px; min-width: 180px; }
.disc-table :deep(th) { white-space: nowrap; }
.disc-table__question { min-width: 280px; padding-top: 8px !important; padding-bottom: 8px !important; overflow-wrap: anywhere; }
.disc-table__item { max-width: 260px; overflow-wrap: anywhere; }
.disc-brief { max-width: 220px; }
.disc-stack { list-style: none; margin: 0; padding: 0; }
.disc-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; overflow-wrap: anywhere; }
.disc-stack li:first-child { border-top: 0; }
.disc-stack__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 6px; }
</style>
