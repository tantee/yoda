<script setup lang="ts">
import { computed, useI18n } from '#imports'
import { statusStyle, type StatusAudience, type StatusKind } from '~/utils/statusStyle'

/** The one status/health/AI chip (proposal §6.5): soft background, strong text, a dot, icon or spinner. */
const props = defineProps<{ kind: StatusKind; value: string; label?: string; size?: 'small' | 'x-small'; audience?: StatusAudience }>()
const { t } = useI18n()
const style = computed(() => statusStyle(props.kind, props.value, props.audience))
const text = computed(() => props.label ?? t(style.value.labelKey))
</script>

<template>
  <span
    class="status-chip"
    :class="[`status-chip--${style.tone}`, { 'status-chip--x-small': size === 'x-small' }]"
    :data-kind="kind"
    :data-value="value"
    :title="text"
  >
    <v-progress-circular v-if="style.spinner" indeterminate :size="10" :width="2" class="status-chip__marker" aria-hidden="true" />
    <v-icon v-else-if="style.icon" :icon="style.icon" :size="14" class="status-chip__marker" aria-hidden="true" />
    <span v-else class="status-chip__dot status-chip__marker" aria-hidden="true" />
    <span class="status-chip__label">{{ text }}</span>
  </span>
</template>

<style scoped>
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 24px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: .75rem;
  font-weight: 500;
  line-height: 1.5;
  letter-spacing: 0;
  vertical-align: middle;
  background: rgb(var(--tone-soft));
  color: rgb(var(--tone));
}
.status-chip--x-small { min-height: 20px; padding: 0 8px; }
.status-chip__marker { flex: none; }
.status-chip__dot { width: 6px; height: 6px; border-radius: 50%; background: rgb(var(--tone-dot)); }
.status-chip__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.status-chip--success { --tone: var(--v-theme-success); --tone-soft: var(--v-theme-success-soft); --tone-dot: var(--v-theme-success-dot); }
.status-chip--warning { --tone: var(--v-theme-warning); --tone-soft: var(--v-theme-warning-soft); --tone-dot: var(--v-theme-warning-dot); }
.status-chip--error { --tone: 168, 38, 29; --tone-soft: var(--v-theme-error-soft); --tone-dot: var(--v-theme-error-dot); }
.status-chip--info { --tone: var(--v-theme-info); --tone-soft: var(--v-theme-info-soft); --tone-dot: var(--v-theme-info-dot); }
.status-chip--neutral { --tone: var(--v-theme-neutral); --tone-soft: var(--v-theme-neutral-soft); --tone-dot: var(--v-theme-neutral-dot); }
.status-chip--ai { --tone: var(--v-theme-ai); --tone-soft: var(--v-theme-ai-soft); --tone-dot: var(--v-theme-ai-dot); }
@media (prefers-reduced-motion: reduce) {
  .status-chip :deep(.v-progress-circular__overlay) { animation: none; }
}
</style>
