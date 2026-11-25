<script setup lang="ts">
import type { EventEntry } from '@yoda/shared'
import { guardOf } from '~/utils/guards'

/** Only task creation / proposal events use a guard name as their reason; elsewhere a reason is free text. */
const guardFor = (ev: EventEntry) =>
  guardOf(ev.payload, ev.type === 'task.created' || ev.type === 'task.proposed' ? ev.reason : null)

defineProps<{ events: EventEntry[] }>()
const { t, te, locale } = useI18n()
const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')
</script>

<template>
  <v-timeline density="compact" side="end" align="start" data-testid="timeline">
    <v-timeline-item v-for="ev in events" :key="ev.id" size="x-small" :dot-color="ev.actorKind === 'ai' ? 'secondary' : undefined" data-testid="timeline-item">
      <div class="font-weight-medium">{{ t(`events.${ev.type}`) }}</div>
      <div class="text-caption text-medium-emphasis d-flex align-center ga-1">
        <v-avatar v-if="ev.actorKind === 'ai'" color="secondary" size="18" data-testid="ai-avatar"><span style="font-size: 9px">AI</span></v-avatar>
        <template v-if="ev.actorKind === 'ai'">{{ t('events.aiLabel') }}</template>
        <template v-else>{{ ev.actorName ?? t('events.system') }}</template>
        · {{ fmt(ev.createdAt) }}
      </div>
      <GuardNote v-if="guardFor(ev)" :guard="guardFor(ev)!" class="mt-1" />
      <div v-else-if="ev.reason" class="text-body-2" style="white-space: pre-wrap">{{ te(`events.reason.${ev.reason}`) ? t(`events.reason.${ev.reason}`) : ev.reason }}</div>
    </v-timeline-item>
  </v-timeline>
</template>
