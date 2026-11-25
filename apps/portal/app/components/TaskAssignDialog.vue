<script setup lang="ts">
import type { LocalizedText, ProjectDetail, ProjectMember, ProjectStatus, TaskWithContext } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { localized } from '~/utils/localized'

/**
 * The person picker for a task (proposal §8.5 "Assign task"): project members with their roles and current
 * load ("งานค้าง 5"), the proposed person (or current assignee) pre-selected. Assigns with
 * `POST /tasks/:id/assign` and hands the updated task back.
 */
const props = defineProps<{
  modelValue: boolean
  task: { id: string; title: LocalizedText; projectId: string; assigneeId: string | null; proposedAssigneeId: string | null }
  /** Members when the page already has them; loaded from the project otherwise. */
  members?: ProjectMember[]
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; assigned: [TaskWithContext] }>()

const { t, locale } = useI18n()
const api = useApi()
const { xs } = useDisplay()
const chosen = ref<string | null>(null)
const loaded = ref<ProjectMember[]>([])
const load = ref<Map<string, number>>(new Map())
const busy = ref(false)
const error = ref('')

const people = computed(() => props.members ?? loaded.value)
const items = computed(() =>
  people.value.map(m => ({ value: m.personId, title: m.displayName, roles: m.roles, open: load.value.get(m.personId) })),
)

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    error.value = ''
    chosen.value = props.task.proposedAssigneeId ?? props.task.assigneeId ?? null
    if (!props.members) {
      try {
        loaded.value = (await api<ProjectDetail>(`/projects/${props.task.projectId}`)).members
      } catch (e) {
        error.value = t(errorKey(e))
      }
    }
    // Load is a hint only: the picker works without it.
    api<ProjectStatus>(`/projects/${props.task.projectId}/status`)
      .then((s) => { load.value = new Map(s.people.map(p => [p.personId, p.openTasks])) })
      .catch(() => { load.value = new Map() })
  },
  { immediate: true },
)

const close = () => emit('update:modelValue', false)

async function assign() {
  if (!chosen.value) return
  error.value = ''
  busy.value = true
  try {
    const updated = await api<TaskWithContext>(`/tasks/${props.task.id}/assign`, { method: 'POST', body: { personId: chosen.value } })
    emit('assigned', updated)
    close()
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="480" :fullscreen="xs" :persistent="busy" @update:model-value="v => emit('update:modelValue', v)">
    <v-card data-testid="assign-dialog">
      <v-card-title class="text-wrap">{{ t('task.assignTitle', { title: localized(task.title, locale) }) }}</v-card-title>
      <v-card-text>
        <v-autocomplete
          v-model="chosen"
          :items="items"
          :label="t('task.assignee')"
          prepend-inner-icon="mdi-account-search-outline"
          auto-select-first
          data-testid="assignee-select"
        >
          <template #item="{ props: itemProps, item }">
            <v-list-item v-bind="itemProps" :data-testid="`assignee-option-${item.raw.value}`">
              <template #append>
                <span class="d-flex align-center ga-1">
                  <v-chip v-for="r in item.raw.roles" :key="r" size="x-small" variant="tonal">{{ r }}</v-chip>
                  <span v-if="item.raw.open !== undefined" class="text-caption text-medium-emphasis ml-2 tabular-nums">
                    {{ t('task.openLoad', { n: item.raw.open }) }}
                  </span>
                </span>
              </template>
              <v-list-item-subtitle v-if="item.raw.value === task.proposedAssigneeId">{{ t('task.proposedAssignee') }}</v-list-item-subtitle>
            </v-list-item>
          </template>
        </v-autocomplete>
        <v-alert v-if="error" type="error" class="mt-3" data-testid="assign-error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="close">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!chosen" :loading="busy" data-testid="assign-btn" @click="assign">{{ t('task.assign') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
