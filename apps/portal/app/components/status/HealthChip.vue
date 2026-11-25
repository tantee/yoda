<script setup lang="ts">
import type { Health } from '@yoda/shared'
import { healthColor } from '~/utils/status'

defineProps<{ health: Health; size?: string }>()
const { t } = useI18n()
const ICONS: Record<Health, string> = { on_track: 'mdi-check-circle-outline', at_risk: 'mdi-alert-outline', blocked: 'mdi-octagon-outline' }
</script>

<template>
  <v-chip :color="healthColor(health)" :size="size ?? 'small'" :prepend-icon="ICONS[health]" variant="flat" :data-health="health" data-testid="health-chip">
    {{ t(`status.health.${health}`) }}
  </v-chip>
</template>
