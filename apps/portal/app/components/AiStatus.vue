<script setup lang="ts">
import type { Task } from '@yoda/shared'

const props = defineProps<{ task: Pick<Task, 'id' | 'aiStatus' | 'aiFailReason'>; canRetry?: boolean }>()
const emit = defineEmits<{ retried: [] }>()
const { t, te } = useI18n()
const api = useApi()
const busy = ref(false)
const error = ref('')

const reason = computed(() => {
  const r = props.task.aiFailReason
  if (!r) return ''
  return te(`events.reason.${r}`) ? t(`events.reason.${r}`) : r
})

async function retry() {
  error.value = ''
  busy.value = true
  try {
    await api(`/tasks/${props.task.id}/retry-ai`, { method: 'POST' })
    emit('retried')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span v-if="task.aiStatus === 'drafting'" class="d-inline-flex align-center ga-1" data-testid="ai-drafting">
    <v-progress-circular indeterminate size="14" width="2" />
    {{ t('ai.drafting') }}
  </span>
  <span v-else-if="task.aiStatus === 'failed'" class="d-inline-flex align-center flex-wrap ga-2" data-testid="ai-failed">
    <v-icon icon="mdi-alert-outline" color="warning" size="small" />
    {{ t('ai.failed', { reason }) }}
    <v-btn v-if="canRetry" size="small" variant="outlined" :loading="busy" data-testid="retry-ai-btn" @click.prevent.stop="retry">{{ t('ai.retry') }}</v-btn>
    <span v-if="error" class="text-error text-caption" data-testid="retry-error">{{ error }}</span>
  </span>
</template>
