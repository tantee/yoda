<script setup lang="ts">
import type { Person, PersonPatch } from '@yoda/shared'

const { t } = useI18n()
const api = useApi()
const people = ref<Person[]>([])
const loadError = ref('')
const actionError = ref('')
// bumped on every reload so controls reset to server state after a rejected change
const version = ref(0)
const skillDrafts = reactive<Record<string, string[]>>({})

// null = follow Keycloak group, true = force staff, false = force requester
const overrideItems = computed(() => [
  { title: t('people.overrideAuto'), value: null },
  { title: t('people.overrideStaff'), value: true },
  { title: t('people.overrideRequester'), value: false },
])

async function load() {
  try {
    people.value = await api<Person[]>('/people')
    loadError.value = ''
    version.value++
  } catch (e) {
    loadError.value = t(errorKey(e))
    return
  }
  for (const p of people.value) skillDrafts[p.id] = [...p.skills]
}

async function patch(id: string, body: PersonPatch) {
  actionError.value = ''
  try {
    await api(`/people/${id}`, { method: 'PATCH', body })
  } catch (e) {
    const code = (e as { data?: { error?: string } })?.data?.error
    actionError.value = code === 'last_admin' ? t('people.lastAdmin') : t('common.error')
  }
  await load()
}

function saveSkills(p: Person) {
  const next = skillDrafts[p.id] ?? []
  if (next.length === p.skills.length && next.every((x, i) => x === p.skills[i])) return
  return patch(p.id, { skills: next })
}

onMounted(load)
</script>

<template>
  <div>
    <h1 class="text-h5 mb-4">{{ t('nav.admin.people') }}</h1>
    <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>
    <v-alert v-if="actionError" type="error" class="mb-4" data-testid="action-error">{{ actionError }}</v-alert>
    <v-table>
      <thead>
        <tr>
          <th>{{ t('people.name') }}</th>
          <th>{{ t('people.skills') }}</th>
          <th>{{ t('people.staffOverride') }}</th>
          <th>{{ t('people.admin') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in people" :key="p.id">
          <td>{{ p.displayName }}<div class="text-caption text-medium-emphasis">{{ p.username }}</div></td>
          <td style="min-width: 260px">
            <v-combobox
              v-model="skillDrafts[p.id]"
              multiple
              chips
              closable-chips
              density="compact"
              hide-details
              @blur="saveSkills(p)"
            />
          </td>
          <td style="min-width: 200px">
            <v-select
              :key="`ovr-${p.id}-${version}`"
              :model-value="p.staffOverride"
              :items="overrideItems"
              density="compact"
              hide-details
              @update:model-value="(v: boolean | null) => patch(p.id, { staffOverride: v })"
            />
          </td>
          <td>
            <v-switch
              :key="`admin-${p.id}-${version}`"
              :model-value="p.isAdmin"
              color="primary"
              hide-details
              density="compact"
              @update:model-value="(v) => patch(p.id, { isAdmin: !!v })"
            />
          </td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
