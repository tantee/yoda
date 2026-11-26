<script setup lang="ts">
import { useI18n } from '#imports'
import { fieldLabelKey } from '~/utils/settings'

/** Restart-mode settings changed since core started (proposal §5.1): the running process still uses the old values. */
defineProps<{ keys: string[] }>()
const { t } = useI18n()
</script>

<template>
  <v-alert v-if="keys.length" type="warning" variant="tonal" density="compact" class="mb-4" icon="mdi-restart" data-testid="restart-banner">
    <div class="font-weight-medium">{{ t('settings.restart.title') }}</div>
    <div class="text-body-2">{{ t('settings.restart.text', { keys: keys.map(k => t(fieldLabelKey(k))).join(', ') }) }}</div>
    <div class="text-body-2 mt-1">{{ t('settings.restart.how') }} <code>docker compose restart core</code></div>
  </v-alert>
</template>
