<script setup lang="ts">
import type { Person, ProjectDetail, ProjectRole, WorkItem, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'

const ROLES: ProjectRole[] = ['PM', 'BA', 'SA', 'DEV', 'QC']

const { t, locale } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string
const project = ref<ProjectDetail | null>(null)
const loadError = ref('')
const people = ref<Person[]>([])
const error = ref('')
const newPerson = ref<string | null>(null)
const newRoles = ref<ProjectRole[]>([])
const workItems = ref<WorkItem[]>([])
const templates = ref<WorkflowTemplateSummary[]>([])
const itemsError = ref('')
const autonomyError = ref('')
const createOpen = ref(false)
const router = useRouter()
const TABS = ['overview', 'items', 'knowledge', 'ai'] as const
const tab = ref<string>(TABS.includes(route.query.tab as never) ? (route.query.tab as string) : 'overview')
watch(tab, (v) => router.replace({ query: { ...route.query, tab: v } }))

const isMember = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id))
const canCreate = computed(() => isMember.value || !!me.value?.isAdmin)

function stepName(w: WorkItem): string {
  if (!w.currentStepKey) return '-'
  const tpl = templates.value.filter(x => x.key === w.templateKey).sort((a, b) => b.version - a.version)[0]
  const step = tpl?.steps.find(s => s.key === w.currentStepKey)
  return step ? localized(step.name, locale.value) : w.currentStepKey
}
function templateName(w: WorkItem): string {
  const tpl = templates.value.find(x => x.key === w.templateKey)
  return tpl ? localized(tpl.name, locale.value) : w.templateKey
}

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
onBeforeUnmount(() => {
  if (itemsTimer) clearTimeout(itemsTimer)
})

async function setAutonomy(v: boolean | null) {
  autonomyError.value = ''
  try {
    const updated = await api<ProjectDetail>(`/projects/${id}`, {
      method: 'PATCH',
      body: { autonomy: v ? 'auto-assign' : 'propose' },
    })
    if (project.value) project.value.autonomy = updated.autonomy
  } catch (e) {
    autonomyError.value = t(errorKey(e))
    await load() // reset the switch to the server value
  }
}

function onCreated(itemId: string) {
  router.push(`/work-items/${itemId}`)
}

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const canManage = computed(() => !!me.value?.isAdmin || isPm.value)
const candidates = computed(() =>
  people.value.filter(p => p.isStaff && !project.value?.members.some(m => m.personId === p.id)),
)

async function load() {
  try {
    project.value = await api<ProjectDetail>(`/projects/${id}`)
    loadError.value = ''
    if (canManage.value) people.value = await api<Person[]>('/people')
  } catch (e) {
    loadError.value = t(errorKey(e))
  }
}

function fail(e: unknown) {
  const code = (e as { data?: { error?: string } })?.data?.error
  error.value =
    code === 'last_pm' ? t('projects.lastPm') : code === 'not_staff' ? t('projects.notStaff') : t('common.error')
}

async function putRoles(personId: string, roles: ProjectRole[]) {
  error.value = ''
  try {
    await api(`/projects/${id}/members/${personId}`, { method: 'PUT', body: { roles } })
  } catch (e) {
    fail(e)
  }
  await load()
}

async function remove(personId: string) {
  error.value = ''
  try {
    await api(`/projects/${id}/members/${personId}`, { method: 'DELETE' })
  } catch (e) {
    fail(e)
  }
  await load()
}

async function addMember() {
  if (!newPerson.value || !newRoles.value.length) return
  await putRoles(newPerson.value, newRoles.value)
  newPerson.value = null
  newRoles.value = []
}

onMounted(() => {
  load()
  loadItems()
})
useLiveEvents((e) => {
  if (e.projectId === id) loadItemsSoon()
}, loadItemsSoon)
</script>

<template>
  <div>
    <v-btn v-if="!project" variant="text" prepend-icon="mdi-arrow-left" to="/projects" class="mb-2">{{ t('nav.projects') }}</v-btn>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="project">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/projects" class="mb-2">{{ t('nav.projects') }}</v-btn>
    <h1 class="text-h5">{{ project.name }}</h1>
    <p class="text-medium-emphasis mb-4">{{ project.description }}</p>
    <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>
    <v-tabs v-model="tab" class="mb-4" data-testid="project-tabs">
      <v-tab value="overview" data-testid="tab-overview">{{ t('projects.tabs.overview') }}</v-tab>
      <v-tab value="items" data-testid="tab-items">{{ t('projects.tabs.items') }}</v-tab>
      <v-tab value="knowledge" data-testid="tab-knowledge">{{ t('projects.tabs.knowledge') }}</v-tab>
      <v-tab value="ai" data-testid="tab-ai">{{ t('projects.tabs.ai') }}</v-tab>
    </v-tabs>
    <v-window v-model="tab" :touch="false">
      <v-window-item value="overview">
    <v-switch
      v-if="canManage"
      :model-value="project.autonomy === 'auto-assign'"
      :label="t('projects.autonomy') + ': ' + t(project.autonomy === 'auto-assign' ? 'projects.autoAssign' : 'projects.propose')"
      :hint="t('projects.autonomyHint')"
      persistent-hint
      color="primary"
      class="mb-4"
      data-testid="autonomy-switch"
      @update:model-value="setAutonomy"
    />
    <p v-else class="mb-4" data-testid="autonomy-label">
      {{ t('projects.autonomy') }}: {{ t(project.autonomy === 'auto-assign' ? 'projects.autoAssign' : 'projects.propose') }}
    </p>
    <v-alert v-if="autonomyError" type="error" class="mb-4" data-testid="autonomy-error">{{ autonomyError }}</v-alert>

    <h2 class="text-h6 mb-2">{{ t('projects.members') }}</h2>
    <v-table class="mb-4">
      <tbody>
        <tr v-for="m in project.members" :key="m.personId">
          <td>{{ m.displayName }}</td>
          <td>
            <v-select
              v-if="canManage"
              :model-value="m.roles"
              :items="ROLES"
              multiple
              chips
              density="compact"
              hide-details
              @update:model-value="(v: ProjectRole[]) => (v.length ? putRoles(m.personId, v) : load())"
            />
            <span v-else>{{ m.roles.join(', ') }}</span>
          </td>
          <td v-if="canManage" class="text-right">
            <v-btn icon="mdi-delete-outline" variant="text" :title="t('projects.removeMember')" @click="remove(m.personId)" />
          </td>
        </tr>
      </tbody>
    </v-table>
    <v-card v-if="canManage" :title="t('projects.addMember')" variant="outlined">
      <v-card-text class="d-flex ga-4">
        <v-select
          v-model="newPerson"
          :items="candidates"
          item-title="displayName"
          item-value="id"
          :label="t('projects.person')"
          hide-details
        />
        <v-select v-model="newRoles" :items="ROLES" multiple chips :label="t('projects.roles')" hide-details />
        <v-btn color="primary" :disabled="!newPerson || !newRoles.length" @click="addMember">{{ t('projects.add') }}</v-btn>
      </v-card-text>
    </v-card>
      </v-window-item>
      <v-window-item value="items">
    <div class="d-flex align-center mb-2">
      <h2 class="text-h6">{{ t('workItems.heading') }}</h2>
      <v-spacer />
      <v-btn v-if="canCreate" color="primary" prepend-icon="mdi-plus" data-testid="new-work-item" @click="createOpen = true">{{ t('workItems.new') }}</v-btn>
    </div>
    <v-alert v-if="itemsError" type="error" class="mb-4" data-testid="items-error">{{ itemsError }}</v-alert>
    <p v-if="!workItems.length && !itemsError" class="text-medium-emphasis mb-4" data-testid="items-empty">{{ t('workItems.empty') }}</p>
    <v-table v-else-if="workItems.length" class="mb-6" data-testid="work-items">
      <thead>
        <tr>
          <th>{{ t('workItems.title') }}</th>
          <th>{{ t('workItems.template') }}</th>
          <th>{{ t('workItems.currentStep') }}</th>
          <th>{{ t('workItems.priority') }}</th>
          <th>{{ t('workItems.state') }}</th>
          <th>{{ t('workItems.owner') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="w in workItems" :key="w.id" data-testid="work-item-row">
          <td><NuxtLink :to="`/work-items/${w.id}`">{{ w.title }}</NuxtLink></td>
          <td>{{ templateName(w) }}</td>
          <td>{{ stepName(w) }}</td>
          <td>{{ t(`priority.${w.priority}`) }}</td>
          <td>{{ t(`workItems.stateName.${w.state}`) }}</td>
          <td>{{ w.ownerName }}</td>
        </tr>
      </tbody>
    </v-table>
    <WorkItemCreateDialog
      v-model="createOpen"
      :project-id="id"
      :templates="templates"
      :members="project.members"
      :default-owner-id="isMember ? me?.id : (project.members.find(m => m.roles.includes('PM')) ?? project.members[0])?.personId"
      :owner-required="!isMember"
      @created="onCreated"
    />

      </v-window-item>
      <v-window-item value="knowledge">
        <ProjectKnowledgeTab :project-id="id" />
      </v-window-item>
      <v-window-item value="ai">
        <ProjectAiSettings :project="project" :can-manage="canManage" @changed="load" />
      </v-window-item>
    </v-window>
    </template>
  </div>
</template>
