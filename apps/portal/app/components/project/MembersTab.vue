<script setup lang="ts">
import type { Person, ProjectDetail, ProjectMember, ProjectRole } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { initials } from '~/utils/nav'

const ROLES: ProjectRole[] = ['PM', 'BA', 'SA', 'DEV', 'QC']

/**
 * Members and settings (proposal §8.2): autonomy as two radio cards, a read-only member table, and dialogs to add a
 * member, edit roles or remove one (same endpoints and permissions as before: PM or admin).
 */
const props = defineProps<{ project: ProjectDetail; people: Person[]; canManage: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const api = useApi()
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)

const autonomyError = ref('')
const candidates = computed(() => props.people.filter(p => p.isStaff && !props.project.members.some(m => m.personId === p.id)))

function message(e: unknown): string {
  const code = (e as { data?: { error?: string } })?.data?.error
  return code === 'last_pm' ? t('projects.lastPm') : code === 'not_staff' ? t('projects.notStaff') : t('common.error')
}

async function setAutonomy(v: unknown) {
  autonomyError.value = ''
  try {
    await api(`/projects/${props.project.id}`, { method: 'PATCH', body: { autonomy: v === 'auto-assign' ? 'auto-assign' : 'propose' } })
  } catch (e) {
    autonomyError.value = t(errorKey(e))
  }
  emit('changed') // the page reloads the project (and resets the radio to the server value on failure)
}

// Add / edit roles: one dialog. `editing` null = add.
const rolesOpen = ref(false)
const editing = ref<ProjectMember | null>(null)
const personId = ref<string | null>(null)
const roles = ref<ProjectRole[]>([])
const dialogError = ref('')
const tried = ref(false)
const busy = ref(false)

function openAdd() {
  editing.value = null
  personId.value = null
  roles.value = []
  dialogError.value = ''
  tried.value = false
  rolesOpen.value = true
}
function openEdit(m: ProjectMember) {
  editing.value = m
  personId.value = m.personId
  roles.value = [...m.roles]
  dialogError.value = ''
  tried.value = false
  rolesOpen.value = true
}
async function saveRoles() {
  tried.value = true
  if (!personId.value || !roles.value.length) return
  busy.value = true
  dialogError.value = ''
  try {
    await api(`/projects/${props.project.id}/members/${personId.value}`, { method: 'PUT', body: { roles: roles.value } })
    rolesOpen.value = false
    emit('changed')
  } catch (e) {
    dialogError.value = message(e)
  } finally {
    busy.value = false
  }
}

const removeOpen = ref(false)
const removing = ref<ProjectMember | null>(null)
function openRemove(m: ProjectMember) {
  removing.value = m
  dialogError.value = ''
  removeOpen.value = true
}
async function remove() {
  if (!removing.value) return
  busy.value = true
  dialogError.value = ''
  try {
    await api(`/projects/${props.project.id}/members/${removing.value.personId}`, { method: 'DELETE' })
    removeOpen.value = false
    emit('changed')
  } catch (e) {
    dialogError.value = message(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div data-testid="members-tab">
    <v-card class="mb-4">
      <div class="card-head">
        <h2>{{ t('projects.members') }} <span class="count-pill ml-1">{{ project.members.length }}</span></h2>
        <v-btn v-if="canManage" color="primary" variant="tonal" size="small" prepend-icon="mdi-account-plus-outline" data-testid="add-member-open" @click="openAdd">{{ t('projects.addMember') }}</v-btn>
      </div>
      <p v-if="!project.members.length" class="card-body text-medium-emphasis mb-0">{{ t('status.peopleEmpty') }}</p>
      <v-table v-else-if="!stacked" class="members-table" data-testid="members">
        <thead>
          <tr>
            <th>{{ t('projects.membersCols.name') }}</th>
            <th>{{ t('projects.membersCols.roles') }}</th>
            <th class="text-right">{{ t('projects.membersCols.load') }}</th>
            <th v-if="canManage" class="text-right"><span class="d-sr-only">{{ t('projects.membersCols.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in project.members" :key="m.personId" :data-person="m.personId" data-testid="member-row">
            <td>
              <div class="d-flex align-center ga-2">
                <v-avatar size="28" color="primary-soft" class="members-avatar" aria-hidden="true">{{ initials(m.displayName) }}</v-avatar>
                <span class="font-weight-medium">{{ m.displayName }}</span>
              </div>
            </td>
            <td>
              <span class="d-inline-flex flex-wrap ga-1" data-testid="member-roles">
                <v-chip v-for="r in m.roles" :key="r" size="small" variant="outlined">{{ r }}</v-chip>
              </span>
            </td>
            <td class="text-right">{{ m.openTasks ?? '–' }}</td>
            <td v-if="canManage" class="text-right members-actions">
              <v-btn variant="text" color="primary" size="small" data-testid="edit-roles" @click="openEdit(m)">{{ t('projects.editRoles') }}</v-btn>
              <v-menu>
                <template #activator="{ props: menuProps }">
                  <v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" size="small" :aria-label="t('projects.memberMenu', { name: m.displayName })" data-testid="member-menu" />
                </template>
                <v-list density="compact">
                  <v-list-item base-color="error" :title="t('projects.removeEllipsis')" prepend-icon="mdi-account-remove-outline" data-testid="remove-member" @click="openRemove(m)" />
                </v-list>
              </v-menu>
            </td>
          </tr>
        </tbody>
      </v-table>
      <ul v-else class="members-stack" data-testid="members">
        <li v-for="m in project.members" :key="m.personId" :data-person="m.personId" data-testid="member-row">
          <div class="d-flex align-center ga-2">
            <v-avatar size="28" color="primary-soft" class="members-avatar" aria-hidden="true">{{ initials(m.displayName) }}</v-avatar>
            <span class="font-weight-medium flex-grow-1">{{ m.displayName }}</span>
            <template v-if="canManage">
              <v-btn variant="text" color="primary" size="small" data-testid="edit-roles" @click="openEdit(m)">{{ t('projects.editRoles') }}</v-btn>
              <v-menu>
                <template #activator="{ props: menuProps }">
                  <v-btn v-bind="menuProps" icon="mdi-dots-horizontal" variant="text" size="small" :aria-label="t('projects.memberMenu', { name: m.displayName })" data-testid="member-menu" />
                </template>
                <v-list density="compact">
                  <v-list-item base-color="error" :title="t('projects.removeEllipsis')" prepend-icon="mdi-account-remove-outline" data-testid="remove-member" @click="openRemove(m)" />
                </v-list>
              </v-menu>
            </template>
          </div>
          <div class="members-stack__meta text-caption text-medium-emphasis">
            <v-chip v-for="r in m.roles" :key="r" size="x-small" variant="outlined">{{ r }}</v-chip>
            <span v-if="m.openTasks !== undefined">{{ t('projects.membersCols.load') }} {{ m.openTasks }}</span>
          </div>
        </li>
      </ul>
    </v-card>

    <v-card>
      <div class="card-head"><h2>{{ t('projects.settings') }}</h2></div>
      <div class="card-body">
        <div class="settings-grid">
          <div class="text-body-2 font-weight-medium">{{ t('projects.autonomy') }}</div>
          <div>
            <v-radio-group
              v-if="canManage"
              :model-value="project.autonomy"
              hide-details
              class="autonomy-options"
              data-testid="autonomy-switch"
              @update:model-value="setAutonomy"
            >
              <label v-for="opt in (['propose', 'auto-assign'] as const)" :key="opt" class="autonomy-card" :class="{ 'autonomy-card--on': project.autonomy === opt }">
                <v-radio :value="opt" color="primary" :data-testid="`autonomy-${opt}`">
                  <template #label>
                    <span>
                      <span class="d-block font-weight-medium">{{ t(opt === 'auto-assign' ? 'projects.autoAssign' : 'projects.propose') }}</span>
                      <span class="d-block text-caption text-medium-emphasis">{{ t(opt === 'auto-assign' ? 'projects.autonomyHelp.autoAssign' : 'projects.autonomyHelp.propose') }}</span>
                    </span>
                  </template>
                </v-radio>
              </label>
            </v-radio-group>
            <p v-else class="mb-0 text-body-2" data-testid="autonomy-label">
              {{ t('projects.autonomy') }}: {{ t(project.autonomy === 'auto-assign' ? 'projects.autoAssign' : 'projects.propose') }}
              <span class="d-block text-caption text-medium-emphasis">{{ t(project.autonomy === 'auto-assign' ? 'projects.autonomyHelp.autoAssign' : 'projects.autonomyHelp.propose') }}</span>
            </p>
            <v-alert v-if="autonomyError" type="error" variant="tonal" density="compact" class="mt-2" data-testid="autonomy-error">{{ autonomyError }}</v-alert>
          </div>
        </div>
      </div>
    </v-card>

    <AppDialog
      v-model="rolesOpen"
      :title="editing ? t('projects.editRolesTitle', { name: editing.displayName }) : t('projects.addMember')"
      :busy="busy"
      data-testid="roles-dialog"
    >
      <v-alert v-if="dialogError" type="error" variant="tonal" density="compact" class="mb-3" data-testid="roles-error">{{ dialogError }}</v-alert>
      <v-autocomplete
        v-if="!editing"
        v-model="personId"
        autofocus
        :items="candidates"
        item-title="displayName"
        item-value="id"
        :label="t('projects.person')"
        :no-data-text="t('projects.noCandidates')"
        :error-messages="tried && !personId ? [t('projects.personRequired')] : []"
        class="mb-3"
        data-testid="member-person"
      />
      <fieldset class="roles-field">
        <legend class="text-body-2 mb-1">{{ t('projects.roles') }}</legend>
        <div class="d-flex flex-wrap ga-2">
          <v-checkbox
            v-for="r in ROLES"
            :key="r"
            v-model="roles"
            :value="r"
            :label="r"
            hide-details
            density="compact"
            :data-testid="`member-role-${r}`"
          />
        </div>
        <p v-if="tried && !roles.length" class="text-caption text-error mt-1 mb-0 d-flex align-center ga-1" data-testid="roles-required">
          <v-icon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />{{ t('projects.rolesRequired') }}
        </p>
      </fieldset>
      <template #actions>
        <v-btn variant="text" :disabled="busy" @click="rolesOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" data-testid="roles-save" @click="saveRoles">{{ editing ? t('common.save') : t('projects.add') }}</v-btn>
      </template>
    </AppDialog>

    <ConfirmDialog
      v-model="removeOpen"
      :title="removing ? t('projects.removeTitle', { name: removing.displayName }) : ''"
      :text="removing ? t('projects.removeText', { name: removing.displayName }) : ''"
      :confirm-label="t('projects.removeConfirm')"
      destructive
      :busy="busy"
      :error="dialogError"
      confirm-testid="remove-confirm"
      cancel-testid="remove-keep"
      data-testid="remove-dialog"
      @confirm="remove"
    />
  </div>
</template>

<style scoped>
.members-table :deep(th) { white-space: nowrap; }
.members-avatar { font-size: .75rem; font-weight: 600; color: rgb(var(--v-theme-on-primary-soft)); flex: none; }
.members-actions { white-space: nowrap; }
.members-stack { list-style: none; margin: 0; padding: 0; }
.members-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.members-stack li:first-child { border-top: 0; }
.members-stack__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 6px; padding-left: 36px; }
.settings-grid { display: grid; grid-template-columns: 200px minmax(0, 680px); gap: 8px 24px; align-items: start; }
@media (max-width: 767px) { .settings-grid { grid-template-columns: minmax(0, 1fr); } }
.autonomy-options :deep(.v-selection-control-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 767px) { .autonomy-options :deep(.v-selection-control-group) { grid-template-columns: minmax(0, 1fr); } }
.autonomy-card { display: block; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; padding: 8px 12px 8px 4px; cursor: pointer; }
.autonomy-card--on { border-color: rgb(var(--v-theme-primary)); background: rgb(var(--v-theme-primary-soft)); }
.autonomy-card :deep(.v-selection-control) { align-items: flex-start; }
.autonomy-card :deep(.v-label) { opacity: 1; white-space: normal; }
.roles-field { border: 0; padding: 0; margin: 0; }
</style>
