<script setup lang="ts">
import { computed, useI18n } from '#imports'
import { errorKind } from '~/utils/stateView'

/** A failed section (proposal §7.1): what failed, network vs server, and a retry. The rest of the page keeps working. */
const props = defineProps<{ error?: unknown; title?: string }>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
const detail = computed(() => {
  const k = errorKind(props.error)
  if (k.kind === 'network') return t('stateView.errorNetwork')
  if (k.kind === 'server') return t('stateView.errorServer', { status: k.status })
  return t('stateView.errorGeneric')
})
</script>

<template>
  <v-card class="error-state pa-6" role="alert" data-testid="error-state">
    <v-icon icon="mdi-alert-circle-outline" color="error" :size="32" aria-hidden="true" />
    <div class="text-subtitle-2 mt-2">{{ title ?? t('stateView.errorTitle') }}</div>
    <div class="text-body-2 text-medium-emphasis">{{ detail }}</div>
    <v-btn class="mt-4" variant="outlined" prepend-icon="mdi-refresh" data-testid="error-retry" @click="emit('retry')">{{ t('stateView.retry') }}</v-btn>
  </v-card>
</template>

<style scoped>
.error-state { display: flex; flex-direction: column; align-items: center; text-align: center; }
</style>
