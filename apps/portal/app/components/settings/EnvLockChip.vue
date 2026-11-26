<script setup lang="ts">
import { computed, useI18n } from '#imports'

/**
 * Why a setting cannot be changed here (proposal §5.2, 8.6): "กำหนดโดย environment · SMTP_HOST" for env, plus
 * bootstrap-only, read-only and recovery-only. The tooltip (and `title`) says how to change it.
 */
const props = defineProps<{ reason: string; envName?: string | null }>()
const { t } = useI18n()
const REASONS = ['env', 'bootstrap', 'readonly', 'recovery_only', 'bound_secret_in_env']
const reasonKey = computed(() => (REASONS.includes(props.reason) ? props.reason : 'readonly'))
const label = computed(() => t(`settings.lock.${reasonKey.value}`, { name: props.envName ?? '' }))
const how = computed(() => t(`settings.lock.how.${reasonKey.value}`, { name: props.envName ?? '' }))
</script>

<template>
  <v-tooltip :text="how" location="bottom" max-width="320">
    <template #activator="{ props: tip }">
      <span v-bind="tip" class="lock-chip" tabindex="0" :title="how" :data-reason="reasonKey" data-testid="env-lock-chip">
        <v-icon icon="mdi-lock-outline" size="14" aria-hidden="true" />
        <span class="lock-chip__label">{{ label }}</span>
      </span>
    </template>
  </v-tooltip>
</template>

<style scoped>
.lock-chip {
  display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-height: 24px; padding: 2px 10px;
  border-radius: 999px; font-size: .75rem; font-weight: 500; line-height: 1.5;
  background: rgb(var(--v-theme-neutral-soft)); color: rgb(var(--v-theme-neutral));
}
.lock-chip__label { overflow-wrap: anywhere; }
</style>
