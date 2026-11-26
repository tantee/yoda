<script setup lang="ts">
import type { Discussion, Priority } from '@yoda/shared'

/** Raise a discussion on a work item, or on a task (which also holds the step until it ends). */
const props = defineProps<{ modelValue: boolean; projectId: string; workItemId: string; workItemTitle?: string; taskId?: string; noAi?: boolean }>()
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
const tried = ref(false)
let counter = 0
const dirty = computed(() => !!question.value.trim() || !!details.value.trim() || options.value.some(o => o.title.trim()))

watch(() => props.modelValue, (open) => {
  if (!open) return
  question.value = ''
  details.value = ''
  priority.value = 'normal'
  options.value = []
  requestBrief.value = !props.noAi
  error.value = ''
  tried.value = false
})

const priorities = computed(() => (['low', 'normal', 'high', 'urgent'] as const).map(p => ({ value: p, title: t(`priority.${p}`) })))
const addOption = () => options.value.push({ key: `opt-${++counter}-${Date.now().toString(36)}`, title: '' })
const filled = computed(() => options.value.filter(o => o.title.trim()).map(o => ({ key: o.key, title: o.title.trim(), pros: '', cons: '' })))

async function submit() {
  tried.value = true
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
  <AppDialog
    :model-value="modelValue"
    size="editor"
    :busy="busy"
    :dirty="dirty"
    scrollable
    data-testid="raise-dialog"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <template #title>
      <template v-if="workItemTitle">{{ t('discussions.raiseOn') }} <em>{{ workItemTitle }}</em></template>
      <template v-else>{{ t('discussions.raise') }}</template>
    </template>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="raise-error">{{ error }}</v-alert>
    <v-text-field
      v-model="question"
      :label="t('discussions.questionRequired')"
      maxlength="500"
      autofocus
      class="mb-3"
      :error-messages="tried && !question.trim() ? [t('discussions.questionMissing')] : []"
      data-testid="raise-question"
    />
    <v-textarea v-model="details" :label="t('discussions.contextLabel')" :hint="t('discussions.contextHint')" persistent-hint rows="3" auto-grow class="mb-3" data-testid="raise-details" />
    <v-select v-model="priority" :items="priorities" :label="t('discussions.priority')" class="raise-priority mb-4" data-testid="raise-priority" />
    <fieldset class="raise-options">
      <legend class="text-body-2 font-weight-medium mb-2">{{ t('discussions.options') }} <span class="text-caption text-medium-emphasis">({{ t('discussions.optional') }})</span></legend>
      <div v-for="(o, i) in options" :key="o.key" class="raise-option">
        <span class="raise-option__n tabular-nums" aria-hidden="true">{{ i + 1 }}</span>
        <v-text-field v-model="o.title" :label="t('discussions.optionTitleN', { n: i + 1 })" maxlength="200" data-testid="raise-option" />
        <v-btn icon="mdi-close" variant="text" size="small" :aria-label="t('discussions.removeOption')" :title="t('discussions.removeOption')" @click="options.splice(i, 1)" />
      </div>
      <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-plus" :disabled="options.length >= 8" data-testid="raise-add-option" @click="addOption">
        {{ t('discussions.addOption') }}
      </v-btn>
    </fieldset>
    <v-checkbox
      v-if="!noAi"
      v-model="requestBrief"
      :label="t('discussions.requestBrief')"
      :hint="t('discussions.requestBriefHint')"
      persistent-hint
      class="mt-2"
      data-testid="raise-brief"
    />
    <template #actions>
      <v-btn variant="text" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
      <v-btn color="primary" variant="flat" :loading="busy" data-testid="raise-submit" @click="submit">{{ t('discussions.raiseSubmit') }}</v-btn>
    </template>
  </AppDialog>
</template>

<style scoped>
.raise-priority { max-width: 240px; }
.raise-options { border: 0; padding: 0; margin: 0; }
.raise-option { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.raise-option__n { flex: none; width: 20px; text-align: center; font-size: .8125rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
</style>
