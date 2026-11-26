<script setup lang="ts">
import type { DepartmentStatus, Project, ProjectListItem } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { projectRows } from '~/utils/projects'

const { t } = useI18n()
const { me } = useMe()
const api = useApi()
const { dateTime, relative } = useDateFormat()
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)

const projects = ref<ProjectListItem[]>([])
const status = ref<DepartmentStatus | null>(null)
const loaded = ref(false)
const error = ref('')
const loadFailure = ref<unknown>(null)
const createError = ref('')
const dialog = ref(false)
const form = reactive({ name: '', description: '' })
const tab = ref<'active' | 'archived'>('active')

async function load() {
  try {
    // Health and counts come from the department status; the list still shows without it.
    const [list, s] = await Promise.all([
      api<ProjectListItem[]>('/projects'),
      api<DepartmentStatus>('/status').catch(() => null),
    ])
    projects.value = list
    status.value = s
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
}

async function create() {
  createError.value = ''
  try {
    const p = await api<Project>('/projects', { method: 'POST', body: { name: form.name, description: form.description } })
    dialog.value = false
    form.name = ''
    form.description = ''
    await navigateTo(`/projects/${p.id}`)
  } catch {
    createError.value = t('common.error')
  }
}

const rows = computed(() => projectRows(projects.value, status.value?.projects ?? []))
const shown = computed(() => rows.value[tab.value])
const pms = (p: ProjectListItem) => (p.pmNames.length ? p.pmNames.join(', ') : t('projects.list.noPm'))

onMounted(load)
</script>

<template>
  <div>
    <PageHeader :title="t('projects.title')">
      <template v-if="me?.isAdmin" #actions>
        <v-btn color="primary" prepend-icon="mdi-plus" data-testid="create-project" @click="dialog = true">{{ t('projects.create') }}</v-btn>
      </template>
      <template v-if="loaded && rows.archived.length" #tabs>
        <v-tabs v-model="tab" density="compact" color="primary" data-testid="projects-tabs">
          <v-tab value="active" data-testid="projects-tab-active">{{ t('projects.list.active') }}<span class="count-pill ml-2">{{ rows.active.length }}</span></v-tab>
          <v-tab value="archived" data-testid="projects-tab-archived">{{ t('projects.list.archived') }}<span class="count-pill ml-2">{{ rows.archived.length }}</span></v-tab>
        </v-tabs>
      </template>
    </PageHeader>

    <ErrorState v-if="error && !loaded" :error="loadFailure" class="mb-4" data-testid="load-error" @retry="load" />
    <v-card v-else-if="!loaded" data-testid="projects-loading"><SkeletonList :rows="5" /></v-card>
    <EmptyState
      v-else-if="!shown.length"
      icon="mdi-folder-outline"
      :title="tab === 'archived' ? t('projects.list.emptyArchived') : t('projects.empty')"
      :text="tab === 'archived' ? undefined : t('projects.list.emptyText')"
      data-testid="projects-empty"
    >
      <v-btn v-if="me?.isAdmin && tab === 'active'" color="primary" prepend-icon="mdi-plus" @click="dialog = true">{{ t('projects.create') }}</v-btn>
    </EmptyState>

    <v-card v-else data-testid="projects-list">
      <v-table v-if="!stacked" class="projects-table">
        <thead>
          <tr>
            <th>{{ t('projects.list.cols.name') }}</th>
            <th>{{ t('projects.list.cols.health') }}</th>
            <th>{{ t('projects.list.cols.pm') }}</th>
            <th class="text-right">{{ t('projects.list.cols.active') }}</th>
            <th class="text-right">{{ t('projects.list.cols.overdue') }}</th>
            <th>{{ t('projects.list.cols.lastActivity') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.project.id" :data-project="r.project.id" data-testid="project-row">
            <td class="projects-table__name">
              <NuxtLink :to="`/projects/${r.project.id}`" class="row-link">{{ r.project.name }}</NuxtLink>
              <div v-if="r.project.description" class="projects-table__desc text-caption text-medium-emphasis">{{ r.project.description }}</div>
            </td>
            <td>
              <StatusHealthChip v-if="r.status" :health="r.status.health" />
              <StatusChip v-else-if="r.project.status === 'archived'" kind="project" value="archived" />
            </td>
            <td class="text-body-2">{{ pms(r.project) }}</td>
            <td class="text-right">{{ r.status?.activeItems ?? '–' }}</td>
            <td class="text-right" :class="{ 'text-error font-weight-medium': (r.status?.overdueItems ?? 0) > 0 }">{{ r.status?.overdueItems ?? '–' }}</td>
            <td class="text-body-2 text-medium-emphasis">
              <span v-if="r.project.lastActivityAt" :title="dateTime(r.project.lastActivityAt)">{{ relative(r.project.lastActivityAt) }}</span>
              <span v-else>{{ t('projects.list.noActivity') }}</span>
            </td>
          </tr>
        </tbody>
      </v-table>
      <ul v-else class="projects-stack">
        <li v-for="r in shown" :key="r.project.id" :data-project="r.project.id" data-testid="project-row">
          <div class="d-flex align-start ga-2">
            <NuxtLink :to="`/projects/${r.project.id}`" class="row-link flex-grow-1">{{ r.project.name }}</NuxtLink>
            <StatusHealthChip v-if="r.status" :health="r.status.health" />
          </div>
          <div v-if="r.project.description" class="projects-table__desc text-caption text-medium-emphasis">{{ r.project.description }}</div>
          <div class="projects-stack__meta text-caption text-medium-emphasis">
            <span><v-icon icon="mdi-account-tie-outline" size="14" aria-hidden="true" /> {{ pms(r.project) }}</span>
            <span v-if="r.status">{{ t('projects.list.cols.active') }} {{ r.status.activeItems }}</span>
            <span v-if="r.status" :class="{ 'text-error': r.status.overdueItems > 0 }">{{ t('projects.list.cols.overdue') }} {{ r.status.overdueItems }}</span>
            <span v-if="r.project.lastActivityAt">{{ relative(r.project.lastActivityAt) }}</span>
          </div>
        </li>
      </ul>
    </v-card>

    <v-dialog v-model="dialog" max-width="560" :fullscreen="width < 600">
      <v-card data-testid="create-project-dialog">
        <div class="card-head"><h2>{{ t('projects.list.createTitle') }}</h2></div>
        <v-card-text>
          <v-alert v-if="createError" type="error" variant="tonal" density="compact" class="mb-3">{{ createError }}</v-alert>
          <v-text-field v-model="form.name" :label="t('projects.name')" autofocus class="mb-2" />
          <v-textarea v-model="form.description" :label="t('projects.description')" rows="3" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" :disabled="!form.name.trim()" @click="create">{{ t('projects.create') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.projects-table__name { min-width: 260px; padding-top: 8px !important; padding-bottom: 8px !important; }
.projects-table__desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-width: 560px; }
.projects-table :deep(th) { white-space: nowrap; }
.projects-stack { list-style: none; margin: 0; padding: 0; }
.projects-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; }
.projects-stack li:first-child { border-top: 0; }
.projects-stack__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; }
</style>
