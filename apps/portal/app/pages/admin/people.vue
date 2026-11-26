<script setup lang="ts">
import type { Person, PersonPatch } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { peopleRows, type PeopleFilter } from '~/utils/people'
import { initials } from '~/utils/nav'

const { t } = useI18n()
const api = useApi()
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)
const people = ref<Person[]>([])
const loaded = ref(false)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const q = ref('')
const filter = ref<PeopleFilter>('all')

// Edit dialog: a draft of the editable fields, saved in one PATCH.
const editing = ref<Person | null>(null)
const editOpen = ref(false)
const draft = reactive<{ skills: string[]; staffOverride: boolean | null; isAdmin: boolean }>({ skills: [], staffOverride: null, isAdmin: false })
const busy = ref(false)
const editError = ref('')

// From the jump box: `?highlight=<person id>` marks that row and scrolls it into view.
const route = useRoute()
const highlight = computed(() => (typeof route.query.highlight === 'string' ? route.query.highlight : null))
watch([highlight, () => people.value.length], async ([id]) => {
  if (!id) return
  q.value = ''
  filter.value = 'all'
  await nextTick()
  document.querySelector(`[data-person-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
})

// null = follow Keycloak group, true = force staff, false = force requester
const overrideItems = computed(() => [
  { title: t('people.overrideAuto'), value: null },
  { title: t('people.overrideStaff'), value: true },
  { title: t('people.overrideRequester'), value: false },
])
const filterItems = computed(() => (['all', 'staff', 'requester', 'admin'] as const).map(v => ({ value: v, title: t(`people.filter.${v}`) })))
const rows = computed(() => peopleRows(people.value, q.value, filter.value))
const dirty = computed(() => {
  const p = editing.value
  if (!p) return false
  return draft.isAdmin !== p.isAdmin || draft.staffOverride !== p.staffOverride || draft.skills.join('\n') !== p.skills.join('\n')
})

async function load() {
  try {
    people.value = await api<Person[]>('/people')
    loaded.value = true
    loadError.value = ''
  } catch (e) {
    loadError.value = t(errorKey(e))
    loadFailure.value = e
  }
}

function openEdit(p: Person) {
  editing.value = p
  draft.skills = [...p.skills]
  draft.staffOverride = p.staffOverride
  draft.isAdmin = p.isAdmin
  editError.value = ''
  editOpen.value = true
}

async function save() {
  const p = editing.value
  if (!p) return
  const body: PersonPatch = {}
  const skills = draft.skills.map(s => s.trim()).filter(Boolean)
  if (skills.join('\n') !== p.skills.join('\n')) body.skills = skills
  if (draft.staffOverride !== p.staffOverride) body.staffOverride = draft.staffOverride
  if (draft.isAdmin !== p.isAdmin) body.isAdmin = draft.isAdmin
  if (!Object.keys(body).length) {
    editOpen.value = false
    return
  }
  busy.value = true
  editError.value = ''
  try {
    await api(`/people/${p.id}`, { method: 'PATCH', body })
    editOpen.value = false
    await load()
  } catch (e) {
    const code = (e as { data?: { error?: string } })?.data?.error
    editError.value = code === 'last_admin' ? t('people.lastAdmin') : t(errorKey(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader :title="t('nav.admin.people')">
      <template #meta><span>{{ t('people.hint') }}</span></template>
    </PageHeader>

    <div class="people-filters mb-4">
      <v-text-field
        v-model="q"
        :label="t('people.search')"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        class="people-filters__q"
        data-testid="people-search"
      />
      <v-select v-model="filter" :items="filterItems" :label="t('people.filterLabel')" hide-details class="people-filters__type" data-testid="people-filter" />
    </div>

    <ErrorState v-if="loadError && !loaded" :error="loadFailure" data-testid="people-error" @retry="load" />
    <v-card v-else-if="!loaded" data-testid="people-loading"><SkeletonList :rows="6" /></v-card>
    <EmptyState v-else-if="!rows.length" icon="mdi-account-search-outline" :title="t('people.empty')" data-testid="people-empty" />
    <v-card v-else data-testid="people-list">
      <v-table v-if="!stacked" class="people-table">
        <thead>
          <tr>
            <th>{{ t('people.name') }}</th>
            <th>{{ t('people.type') }}</th>
            <th>{{ t('people.skills') }}</th>
            <th><span class="d-sr-only">{{ t('people.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in rows"
            :key="p.id"
            :data-person-id="p.id"
            :class="{ 'person-row--highlight': p.id === highlight }"
            data-testid="person-row"
          >
            <td class="people-table__name">
              <div class="d-flex align-center ga-3">
                <v-avatar size="32" color="primary-soft" class="people-avatar" aria-hidden="true">{{ initials(p.displayName) }}</v-avatar>
                <div class="min-w-0">
                  <div class="font-weight-medium">{{ p.displayName }}</div>
                  <div class="text-caption text-medium-emphasis">{{ p.username }}</div>
                </div>
              </div>
            </td>
            <td>
              <div class="d-flex flex-wrap align-center ga-1">
                <v-chip size="x-small" :color="p.isStaff ? 'primary' : undefined" variant="tonal">{{ t(p.isStaff ? 'people.staff' : 'people.requester') }}</v-chip>
                <v-chip v-if="p.isAdmin" size="x-small" color="secondary" variant="tonal" prepend-icon="mdi-shield-account-outline" data-testid="person-admin">{{ t('people.admin') }}</v-chip>
                <span v-if="p.staffOverride !== null" class="text-caption text-medium-emphasis" :title="t('people.overrideNote')">{{ t('people.overridden') }}</span>
              </div>
            </td>
            <td>
              <div v-if="p.skills.length" class="d-flex flex-wrap ga-1">
                <v-chip v-for="s in p.skills" :key="s" size="x-small" variant="outlined">{{ s }}</v-chip>
              </div>
              <span v-else class="text-caption text-medium-emphasis">–</span>
            </td>
            <td class="text-right">
              <v-btn size="small" variant="text" color="primary" :aria-label="t('people.editNamed', { name: p.displayName })" data-testid="person-edit" @click="openEdit(p)">{{ t('people.edit') }}</v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
      <ul v-else class="people-stack">
        <li v-for="p in rows" :key="p.id" :data-person-id="p.id" :class="{ 'person-row--highlight': p.id === highlight }" data-testid="person-row">
          <div class="d-flex align-center ga-3">
            <v-avatar size="32" color="primary-soft" class="people-avatar" aria-hidden="true">{{ initials(p.displayName) }}</v-avatar>
            <div class="flex-grow-1 min-w-0">
              <div class="font-weight-medium">{{ p.displayName }}</div>
              <div class="text-caption text-medium-emphasis">{{ p.username }}</div>
            </div>
            <v-btn size="small" variant="text" color="primary" :aria-label="t('people.editNamed', { name: p.displayName })" data-testid="person-edit" @click="openEdit(p)">{{ t('people.edit') }}</v-btn>
          </div>
          <div class="people-stack__meta">
            <v-chip size="x-small" :color="p.isStaff ? 'primary' : undefined" variant="tonal">{{ t(p.isStaff ? 'people.staff' : 'people.requester') }}</v-chip>
            <v-chip v-if="p.isAdmin" size="x-small" color="secondary" variant="tonal">{{ t('people.admin') }}</v-chip>
            <v-chip v-for="s in p.skills" :key="s" size="x-small" variant="outlined">{{ s }}</v-chip>
          </div>
        </li>
      </ul>
    </v-card>

    <AppDialog v-model="editOpen" :busy="busy" :dirty="dirty" data-testid="person-dialog">
      <template #title>{{ t('people.editTitle') }} <em>{{ editing?.displayName }}</em></template>
      <v-alert v-if="editError" type="error" variant="tonal" density="compact" class="mb-3" data-testid="action-error">{{ editError }}</v-alert>
      <p class="text-body-2 text-medium-emphasis mb-4">{{ editing?.username }}<template v-if="editing?.email"> · {{ editing.email }}</template></p>
      <v-combobox
        v-model="draft.skills"
        :label="t('people.skills')"
        :hint="t('people.skillsHint')"
        persistent-hint
        multiple
        chips
        closable-chips
        class="mb-4"
        data-testid="person-skills"
      />
      <v-select
        v-model="draft.staffOverride"
        :items="overrideItems"
        :label="t('people.staffOverride')"
        :hint="t('people.staffOverrideHint')"
        persistent-hint
        class="mb-4"
        data-testid="person-override"
      />
      <v-switch v-model="draft.isAdmin" :label="t('people.admin')" color="primary" inset hide-details density="compact" data-testid="person-admin-switch" />
      <p class="text-caption text-medium-emphasis mb-0">{{ t('people.adminHint') }}</p>
      <template #actions>
        <v-btn variant="text" :disabled="busy" @click="editOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" data-testid="person-save" @click="save">{{ t('common.save') }}</v-btn>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.people-filters { display: flex; flex-wrap: wrap; gap: 12px; }
.people-filters__q { flex: 1 1 280px; max-width: 420px; }
.people-filters__type { flex: 0 1 220px; min-width: 180px; }
.people-table :deep(th) { white-space: nowrap; }
.people-table__name { min-width: 240px; padding-top: 8px !important; padding-bottom: 8px !important; }
.people-avatar { flex: none; font-size: .75rem; font-weight: 600; color: rgb(var(--v-theme-on-primary-soft)); }
.person-row--highlight > td, li.person-row--highlight { background: rgb(var(--v-theme-primary-soft)); }
.people-stack { list-style: none; margin: 0; padding: 0; }
.people-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; overflow-wrap: anywhere; }
.people-stack li:first-child { border-top: 0; }
.people-stack__meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; padding-left: 44px; }
.min-w-0 { min-width: 0; }
</style>
