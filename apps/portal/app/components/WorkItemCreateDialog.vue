<script setup lang="ts">
import type { Priority, ProjectMember, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'

const props = defineProps<{
  modelValue: boolean
  projectId: string
  templates: WorkflowTemplateSummary[]
  members: ProjectMember[]
  defaultOwnerId?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; created: [string] }>()

const { t, locale } = useI18n()
const api = useApi()
const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']

const title = ref('')
const description = ref('')
const templateKey = ref<string | null>(null)
const priority = ref<Priority>('normal')
const ownerId = ref<string | null>(null)
const error = ref('')
const busy = ref(false)

const templateItems = computed(() => props.templates.map(x => ({ title: localized(x.name, locale.value), value: x.key })))
const canSubmit = computed(() => !!title.value.trim() && !!templateKey.value)

watch(() => props.modelValue, (open) => {
  if (!open) return
  title.value = ''
  description.value = ''
  templateKey.value = props.templates[0]?.key ?? null
  priority.value = 'normal'
  ownerId.value = props.defaultOwnerId ?? null
  error.value = ''
})

async function submit() {
  if (!canSubmit.value) return
  error.value = ''
  busy.value = true
  try {
    const body: Record<string, unknown> = {
      title: title.value.trim(),
      description: description.value,
      templateKey: templateKey.value,
      priority: priority.value,
    }
    if (ownerId.value) body.ownerId = ownerId.value
    const created = await api<{ id: string }>(`/projects/${props.projectId}/work-items`, { method: 'POST', body })
    emit('update:modelValue', false)
    emit('created', created.id)
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="t('workItems.new')">
      <v-card-text class="d-flex flex-column ga-2">
        <v-alert v-if="error" type="error" data-testid="create-error">{{ error }}</v-alert>
        <v-text-field v-model="title" :label="t('workItems.title')" maxlength="200" data-testid="wi-title" />
        <v-textarea v-model="description" :label="t('workItems.description')" rows="3" auto-grow data-testid="wi-description" />
        <v-select v-model="templateKey" :items="templateItems" :label="t('workItems.template')" data-testid="wi-template" />
        <v-select
          v-model="priority"
          :items="PRIORITIES.map(p => ({ title: t(`priority.${p}`), value: p }))"
          :label="t('workItems.priority')"
          data-testid="wi-priority"
        />
        <v-select
          v-model="ownerId"
          :items="members"
          item-title="displayName"
          item-value="personId"
          :label="t('workItems.owner')"
          clearable
          data-testid="wi-owner"
        />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :disabled="!canSubmit" :loading="busy" data-testid="wi-submit" @click="submit">{{ t('workItems.create') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
