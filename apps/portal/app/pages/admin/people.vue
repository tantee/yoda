<script setup lang="ts">
import type { Person, PersonPatch } from '@yoda/shared'

const { t } = useI18n()
const api = useApi()
const people = ref<Person[]>([])
const error = ref('')
const skillDrafts = reactive<Record<string, string[]>>({})

// null = follow Keycloak group, true = force staff, false = force requester
const overrideItems = computed(() => [
  { title: t('people.overrideAuto'), value: null },
  { title: t('people.overrideStaff'), value: true },
  { title: t('people.overrideRequester'), value: false },
])

async function load() {
  people.value = await api<Person[]>('/people')
  for (const p of people.value) skillDrafts[p.id] = [...p.skills]
}

async function patch(id: string, body: PersonPatch) {
  error.value = ''
  try {
    await api(`/people/${id}`, { method: 'PATCH', body })
  } catch (e) {
    const code = (e as { data?: { error?: string } })?.data?.error
    error.value = code === 'last_admin' ? t('people.lastAdmin') : t('common.error')
  }
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <h1 class="text-h5 mb-4">{{ t('nav.admin.people') }}</h1>
    <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>
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
              @blur="patch(p.id, { skills: skillDrafts[p.id] ?? [] })"
            />
          </td>
          <td style="min-width: 200px">
            <v-select
              :model-value="p.staffOverride"
              :items="overrideItems"
              density="compact"
              hide-details
              @update:model-value="(v: boolean | null) => patch(p.id, { staffOverride: v })"
            />
          </td>
          <td>
            <v-switch
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
