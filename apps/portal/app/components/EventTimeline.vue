<script setup lang="ts">
import type { EventEntry } from '@yoda/shared'

defineProps<{ events: EventEntry[] }>()
const { t, locale } = useI18n()
const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')
</script>

<template>
  <v-timeline density="compact" side="end" align="start" data-testid="timeline">
    <v-timeline-item v-for="ev in events" :key="ev.id" size="x-small" data-testid="timeline-item">
      <div class="font-weight-medium">{{ t(`events.${ev.type}`) }}</div>
      <div class="text-caption text-medium-emphasis">
        {{ ev.actorName ?? t('events.system') }} · {{ fmt(ev.createdAt) }}
      </div>
      <div v-if="ev.reason" class="text-body-2" style="white-space: pre-wrap">{{ ev.reason }}</div>
    </v-timeline-item>
  </v-timeline>
</template>
