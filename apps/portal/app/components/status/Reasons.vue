<script setup lang="ts">
import type { Health, HealthReason } from '@yoda/shared'
import { reasonLink, reasonText } from '~/utils/status'

/**
 * Why a project is at risk or blocked. `callout` (project status tab, proposal §6.7): a soft warning / error box with
 * a title; otherwise a plain list (cards).
 */
defineProps<{ reasons: HealthReason[]; health?: Health; callout?: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="reasons.length && callout"
    class="reasons-callout"
    :class="health === 'blocked' ? 'reasons-callout--error' : 'reasons-callout--warning'"
    role="note"
    data-testid="health-callout"
  >
    <v-icon :icon="health === 'blocked' ? 'mdi-alert-octagon-outline' : 'mdi-alert-outline'" size="20" aria-hidden="true" class="reasons-callout__icon" />
    <div class="min-w-0">
      <div class="reasons-callout__title">{{ t(`status.reasonsTitle.${health ?? 'at_risk'}`) }}</div>
      <ul class="pl-5 text-body-2" data-testid="health-reasons">
        <li v-for="r in reasons" :key="r.code" :data-code="r.code" data-testid="health-reason">
          {{ reasonText(t, r) }}<template v-for="(s, i) in r.sample" :key="s.id"><span>{{ i === 0 ? ': ' : ', ' }}</span><NuxtLink :to="reasonLink(r.code, s.id)" data-testid="reason-sample">{{ s.title }}</NuxtLink></template>
        </li>
      </ul>
    </div>
  </div>
  <ul v-else-if="reasons.length" class="pl-5 text-body-2" data-testid="health-reasons">
    <li v-for="r in reasons" :key="r.code" :data-code="r.code" data-testid="health-reason">
      {{ reasonText(t, r) }}<template v-for="(s, i) in r.sample" :key="s.id"><span class="text-medium-emphasis">{{ i === 0 ? ': ' : ', ' }}</span><NuxtLink :to="reasonLink(r.code, s.id)" data-testid="reason-sample">{{ s.title }}</NuxtLink></template>
    </li>
  </ul>
</template>

<style scoped>
.reasons-callout { display: flex; gap: 12px; padding: 12px 16px; border-radius: 8px; border: 1px solid; overflow-wrap: anywhere; }
.reasons-callout--warning { background: rgb(var(--v-theme-warning-soft)); border-color: rgba(var(--v-theme-warning-dot), .45); }
.reasons-callout--warning .reasons-callout__icon { color: rgb(var(--v-theme-warning)); }
.reasons-callout--error { background: rgb(var(--v-theme-error-soft)); border-color: rgba(var(--v-theme-error-dot), .4); }
.reasons-callout--error .reasons-callout__icon { color: rgb(var(--v-theme-error)); }
.reasons-callout__icon { margin-top: 2px; flex: none; }
.reasons-callout__title { font-weight: 600; margin-bottom: 4px; }
.reasons-callout ul { margin: 0; }
.reasons-callout a { color: rgb(var(--v-theme-primary)); }
.min-w-0 { min-width: 0; }
</style>
