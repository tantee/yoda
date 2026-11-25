<script setup lang="ts">
import { useI18n } from '#imports'
import StatusChip from './StatusChip.vue'

/**
 * The container for AI-written content (proposal §6.10): an indigo "ร่างโดย AI" strip with optional model/time,
 * a low-confidence chip, and the points the AI is missing. Provenance stays after a person edits.
 */
defineProps<{ confidence?: 'high' | 'low' | null; missing?: string[]; meta?: string; editedBy?: string | null }>()
const { t } = useI18n()
</script>

<template>
  <section class="ai-draft" data-testid="ai-draft">
    <header class="ai-draft__head">
      <span class="ai-draft__label">
        <v-icon icon="mdi-creation-outline" :size="16" aria-hidden="true" />
        {{ editedBy ? t('aiDraft.editedBy', { name: editedBy }) : t('aiDraft.label') }}
      </span>
      <StatusChip v-if="confidence === 'low'" kind="aiDraft" value="low" size="x-small" data-testid="ai-low-confidence" />
      <v-spacer />
      <span v-if="meta" class="text-caption text-medium-emphasis">{{ meta }}</span>
      <slot name="actions" />
    </header>
    <div class="ai-draft__body"><slot /></div>
    <footer v-if="missing?.length" class="ai-draft__missing" data-testid="ai-missing">
      <v-icon icon="mdi-alert-outline" :size="16" aria-hidden="true" />
      <div>
        <strong>{{ t('aiDraft.missingTitle') }}</strong>
        <ul><li v-for="m in missing" :key="m">{{ m }}</li></ul>
        <div class="text-caption">{{ t('aiDraft.missingHint') }}</div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.ai-draft { border: 1px solid #D9D4F3; border-radius: 8px; overflow: hidden; background: rgb(var(--v-theme-surface)); }
.ai-draft__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 6px 12px; background: rgb(var(--v-theme-ai-soft)); }
.ai-draft__label { display: inline-flex; align-items: center; gap: 4px; color: rgb(var(--v-theme-ai)); font-size: .75rem; font-weight: 600; }
.ai-draft__body { padding: 12px 16px; }
.ai-draft__missing { display: flex; gap: 8px; padding: 8px 16px; background: rgb(var(--v-theme-warning-soft)); color: rgb(var(--v-theme-warning)); font-size: .8125rem; }
.ai-draft__missing ul { padding-left: 1.25rem; margin: 2px 0; }
</style>
