<script setup lang="ts">
import { useI18n } from '#imports'

/**
 * When a saved change takes effect (proposal §5.1): live, reconnect (about a second), or after a restart; `minute`
 * for the backup settings, which the backup container re-reads every minute.
 */
defineProps<{ mode: 'live' | 'reconnect' | 'restart' | 'minute' }>()
const { t } = useI18n()
const ICONS = { live: 'mdi-flash-outline', reconnect: 'mdi-sync', restart: 'mdi-restart', minute: 'mdi-timer-outline' } as const
</script>

<template>
  <span class="apply-hint text-caption text-medium-emphasis" :class="`apply-hint--${mode}`" :data-mode="mode" data-testid="apply-hint">
    <v-icon :icon="ICONS[mode]" size="14" aria-hidden="true" />{{ t(`settings.apply.${mode}`) }}
  </span>
</template>

<style scoped>
.apply-hint { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.apply-hint--restart { color: rgb(var(--v-theme-warning)) !important; }
</style>
