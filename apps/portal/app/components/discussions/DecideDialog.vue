<script setup lang="ts">
import type { Discussion } from '@yoda/shared'

const props = defineProps<{ modelValue: boolean; discussion: Discussion }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; decided: [] }>()
const { t } = useI18n()
const api = useApi()

const optionKey = ref<string | null>(null)
const decision = ref('')
const busy = ref(false)
const error = ref('')
const items = computed(() => [
  { value: null, title: t('discussions.decide.none') },
  ...(props.discussion.brief?.options ?? []).map(o => ({ value: o.key, title: o.title })),
])

watch(() => props.modelValue, (open) => {
  if (!open) return
  optionKey.value = null
  decision.value = ''
  error.value = ''
})

async function submit() {
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${props.discussion.id}/decide`, {
      method: 'POST',
      body: { decision: decision.value.trim(), ...(optionKey.value ? { optionKey: optionKey.value } : {}) },
    })
    emit('update:modelValue', false)
    emit('decided')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="520" @update:model-value="v => emit('update:modelValue', v)">
    <v-card :title="t('discussions.decide.title')" data-testid="decide-dialog">
      <v-card-text>
        <p class="mb-3 font-weight-medium">{{ discussion.question }}</p>
        <v-select v-model="optionKey" :items="items" :label="t('discussions.decide.option')" data-testid="decide-option" />
        <v-textarea v-model="decision" :label="t('discussions.decide.text')" rows="3" auto-grow data-testid="decide-text" />
        <v-alert v-if="error" type="error" density="compact" data-testid="decide-error">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" :loading="busy" :disabled="!decision.trim()" data-testid="decide-submit" @click="submit">{{ t('discussions.decide.submit') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
