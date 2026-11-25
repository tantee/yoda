<script setup lang="ts">
import type { LocalizedText, ProjectDetail, ProjectMember, TaskWithContext } from '@yoda/shared'
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
const titleId = `assign-title-${useId()}`
const chosen = ref<string | null>(null)
const loaded = ref<ProjectMember[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')

// The members' load (`openTasks`) comes with the project detail (`GET /projects/:id`).
const people = computed(() => props.members ?? loaded.value)
const items = computed(() =>
  people.value.map(m => ({ value: m.personId, title: m.displayName, roles: m.roles, open: m.openTasks })),
)

let seq = 0
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    // Fresh state each time it opens; responses from an earlier opening are dropped.
    const mine = ++seq
    error.value = ''
    busy.value = false
    chosen.value = props.task.proposedAssigneeId ?? props.task.assigneeId ?? null
    if (props.members) return
    loaded.value = []
    loading.value = true
    try {
      const detail = await api<ProjectDetail>(`/projects/${props.task.projectId}`)
      if (mine === seq) loaded.value = detail.members
    } catch (e) {
      if (mine === seq) error.value = t(errorKey(e))
    } finally {
      if (mine === seq) loading.value = false
    }
  },
  { immediate: true },
)

const close = () => emit('update:modelValue', false)

async function assign() {
  if (!chosen.value) return
  const mine = seq
  error.value = ''
  busy.value = true
  try {
    const updated = await api<TaskWithContext>(`/tasks/${props.task.id}/assign`, { method: 'POST', body: { personId: chosen.value } })
    emit('assigned', updated)
    if (mine === seq) close()
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  } finally {
    if (mine === seq) busy.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" :aria-labelledby="titleId" max-width="480" :fullscreen="xs" :persistent="busy" @update:model-value="v => emit('update:modelValue', v)">
    <v-card data-testid="assign-dialog">
      <v-card-title :id="titleId" class="text-wrap">{{ t('task.assignTitle', { title: localized(task.title, locale) }) }}</v-card-title>
      <v-card-text>
        <v-autocomplete
          v-model="chosen"
          :items="items"
          :label="t('task.assignee')"
          prepend-inner-icon="mdi-account-search-outline"
          auto-select-first
          :loading="loading"
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
