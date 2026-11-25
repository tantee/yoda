<script setup lang="ts">
import type { Discussion, Priority } from '@yoda/shared'

/** Raise a discussion on a work item, or on a task (which also holds the step until it ends). */
const props = defineProps<{ modelValue: boolean; projectId: string; workItemId: string; taskId?: string; noAi?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; raised: [id: string] }>()
const { t } = useI18n()
const api = useApi()

const question = ref('')
const details = ref('')
const priority = ref<Priority>('normal')
const options = ref<{ key: string; title: string }[]>([])
const requestBrief = ref(true)
const busy = ref(false)
const error = ref('')
let counter = 0

watch(() => props.modelValue, (open) => {
  if (!open) return
  question.value = ''
  details.value = ''
  priority.value = 'normal'
  options.value = []
  requestBrief.value = !props.noAi
  error.value = ''
})

const priorities = computed(() => (['low', 'normal', 'high', 'urgent'] as const).map(p => ({ value: p, title: t(`priority.${p}`) })))
const addOption = () => options.value.push({ key: `opt-${++counter}-${Date.now().toString(36)}`, title: '' })
const filled = computed(() => options.value.filter(o => o.title.trim()).map(o => ({ key: o.key, title: o.title.trim(), pros: '', cons: '' })))

async function submit() {
  if (!question.value.trim()) return
  busy.value = true
  error.value = ''
  const common = {
    question: question.value.trim(),
    details: details.value,
    priority: priority.value,
    options: filled.value,
    requestBrief: requestBrief.value && !props.noAi,
  }
  try {
    const created = props.taskId
      ? await api<Discussion>(`/tasks/${props.taskId}/raise-discussion`, { method: 'POST', body: common })
      : await api<Discussion>('/discussions', {
        method: 'POST',
        body: { ...common, projectId: props.projectId, workItemId: props.workItemId },
      })
    emit('update:modelValue', false)
    emit('raised', created.id)
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="640" @update:model-value="v => emit('update:modelValue', v)">
    <v-card :title="t('discussions.raise')" data-testid="raise-dialog">
      <v-card-text>
        <v-text-field v-model="question" :label="t('discussions.question')" maxlength="500" data-testid="raise-question" />
        <v-textarea v-model="details" :label="t('discussions.details')" rows="3" auto-grow data-testid="raise-details" />
        <v-select v-model="priority" :items="priorities" :label="t('discussions.priority')" data-testid="raise-priority" />
        <h3 class="text-subtitle-2 mb-1">{{ t('discussions.options') }}</h3>
        <div v-for="(o, i) in options" :key="o.key" class="d-flex ga-2 align-center">
          <v-text-field v-model="o.title" :label="t('discussions.optionTitle')" density="compact" maxlength="200" data-testid="raise-option" />
          <v-btn icon="mdi-close" variant="text" size="small" :title="t('discussions.removeOption')" @click="options.splice(i, 1)" />
        </div>
        <v-btn size="small" variant="text" prepend-icon="mdi-plus" :disabled="options.length >= 8" data-testid="raise-add-option" @click="addOption">
          {{ t('discussions.addOption') }}
        </v-btn>
        <v-checkbox
          v-if="!noAi"
          v-model="requestBrief"
          :label="t('discussions.requestBrief')"
          :hint="t('discussions.requestBriefHint')"
          persistent-hint
          data-testid="raise-brief"
        />
        <v-alert v-if="error" type="error" density="compact" class="mt-2" data-testid="raise-error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="busy" :disabled="!question.trim()" data-testid="raise-submit" @click="submit">{{ t('discussions.raiseSubmit') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
