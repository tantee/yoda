<script setup lang="ts">
import type { Person, Priority, ProjectMember, WorkflowTemplateSummary } from '@yoda/shared'
import { localized } from '~/utils/localized'

const props = defineProps<{
  modelValue: boolean
  projectId: string
  templates: WorkflowTemplateSummary[]
  members: ProjectMember[]
  defaultOwnerId?: string
  ownerRequired?: boolean
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
const requesterId = ref<string | null>(null)
const people = ref<Person[]>([])
const error = ref('')
const busy = ref(false)
const tried = ref(false)
const dirty = computed(() => !!title.value.trim() || !!description.value.trim())

const templateItems = computed(() => props.templates.map(x => ({ title: localized(x.name, locale.value), value: x.key, steps: x.steps.map(st => localized(st.name, locale.value)).join(' · ') })))
const peopleItems = computed(() => people.value.map(p => ({ title: p.displayName, subtitle: p.username, value: p.id })))
const canSubmit = computed(() => !!title.value.trim() && !!templateKey.value && (!props.ownerRequired || !!ownerId.value))

watch(() => props.modelValue, (open) => {
  if (!open) return
  title.value = ''
  description.value = ''
  templateKey.value = props.templates[0]?.key ?? null
  priority.value = 'normal'
  ownerId.value = props.defaultOwnerId ?? null
  requesterId.value = null
  error.value = ''
  tried.value = false
  if (!people.value.length) {
    api<Person[]>('/people').then((list) => { people.value = list }).catch(() => { people.value = [] })
  }
})

async function submit() {
  tried.value = true
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
    if (requesterId.value) body.requesterId = requesterId.value
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
  <AppDialog
    :model-value="modelValue"
    :title="t('workItems.new')"
    :busy="busy"
    :dirty="dirty"
    scrollable
    data-testid="create-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="wi-form">
      <v-alert v-if="error" type="error" variant="tonal" density="compact" data-testid="create-error">{{ error }}</v-alert>
      <v-text-field
        v-model="title"
        :label="t('workItems.titleRequired')"
        maxlength="200"
        autofocus
        :error-messages="tried && !title.trim() ? [t('workItems.titleMissing')] : []"
        data-testid="wi-title"
      />
      <v-textarea v-model="description" :label="t('workItems.description')" rows="3" auto-grow data-testid="wi-description" />
      <fieldset class="wi-templates">
        <legend class="text-body-2 font-weight-medium mb-2">{{ t('workItems.template') }}</legend>
        <v-radio-group v-model="templateKey" hide-details data-testid="wi-template">
          <label v-for="tpl in templateItems" :key="tpl.value" class="wi-template" :class="{ 'wi-template--on': templateKey === tpl.value }" :data-testid="`wi-template-${tpl.value}`">
            <v-radio :value="tpl.value" density="compact" />
            <span class="wi-template__body">
              <span class="font-weight-medium">{{ tpl.title }}</span>
              <span class="text-caption text-medium-emphasis">{{ tpl.steps }}</span>
            </span>
          </label>
        </v-radio-group>
      </fieldset>
      <div class="wi-pair">
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
          :label="ownerRequired ? t('workItems.ownerRequired') : t('workItems.owner')"
          :clearable="!ownerRequired"
          :error-messages="tried && ownerRequired && !ownerId ? [t('workItems.ownerMissing')] : []"
          data-testid="wi-owner"
        />
      </div>
      <v-autocomplete
        v-model="requesterId"
        :items="peopleItems"
        :label="t('workItems.requester')"
        :hint="t('workItems.requesterHint')"
        persistent-hint
        clearable
        data-testid="wi-requester"
      />
    </div>
    <template #actions>
      <v-btn variant="text" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
      <v-btn color="primary" variant="flat" :loading="busy" data-testid="wi-submit" @click="submit">{{ t('workItems.create') }}</v-btn>
    </template>
  </AppDialog>
</template>

<style scoped>
.wi-form { display: flex; flex-direction: column; gap: 16px; }
.wi-templates { border: 0; padding: 0; margin: 0; }
.wi-templates :deep(.v-selection-control-group) { display: grid; gap: 8px; }
.wi-template { display: flex; align-items: flex-start; gap: 4px; padding: 6px 12px 6px 4px; cursor: pointer; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
.wi-template--on { border-color: rgb(var(--v-theme-primary)); background: rgb(var(--v-theme-primary-soft)); }
.wi-template__body { display: flex; flex-direction: column; min-width: 0; padding-top: 6px; overflow-wrap: anywhere; }
.wi-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 599px) { .wi-pair { grid-template-columns: minmax(0, 1fr); } }
.wi-template :deep(.v-radio) { flex: none; width: auto; }
</style>
