<script setup lang="ts">
import type { Person, ProjectDetail, ProjectRole } from '@yoda/shared'

const ROLES: ProjectRole[] = ['PM', 'BA', 'SA', 'DEV', 'QC']

const { t } = useI18n()
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

onMounted(load)
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
              @update:model-value="(v: ProjectRole[]) => v.length && putRoles(m.personId, v)"
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
    </template>
  </div>
</template>
