<script setup lang="ts">
import { computed, useI18n } from '#imports'
import { LOCK_REASONS, lockHowKey, lockNamed } from '~/utils/settings'

/**
 * Why a setting cannot be changed here (proposal §5.2, 8.6): "กำหนดโดย environment · SMTP_HOST" for env, plus
 * bootstrap-only, read-only, recovery-only and managed on the install host. The tooltip (and `title`) says how to
 * change it; `howKey` (from `fieldRules`) picks the wording that fits the key's state.
 */
const props = defineProps<{ reason: string; envName?: string | null; container?: string | null; howKey?: string | null }>()
const { t } = useI18n()
const reasonKey = computed(() => (LOCK_REASONS.includes(props.reason) ? props.reason : 'readonly'))
const named = computed(() => lockNamed(props))
const label = computed(() => t(`settings.lock.${reasonKey.value}`, named.value))
const how = computed(() => t(props.howKey ?? lockHowKey(reasonKey.value, { envName: props.envName }), named.value))
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
