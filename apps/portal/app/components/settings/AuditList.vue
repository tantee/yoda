<script setup lang="ts">
import type { SettingsAuditEntry } from '@yoda/shared'
import { useI18n } from '#imports'
import { formatDateTime } from '~/utils/dates'
import { initials } from '~/utils/nav'
import { auditLine, auditTestName } from '~/utils/settings'

/**
 * Settings changes, newest first (proposal §5.4): who, what, old → new for plain values, fingerprints only for
 * secrets, when, the source and the address. `compact` (the side panel) leaves out the address.
 */
defineProps<{ entries: SettingsAuditEntry[]; compact?: boolean }>()
const { t, locale } = useI18n()
const who = (e: SettingsAuditEntry) => e.actor.label ?? t('settings.audit.system')
const testLabel = (e: SettingsAuditEntry) => {
  const name = auditTestName(e)
  const result = e.result === 'ok' ? t('settings.audit.resultOk') : t('settings.audit.resultFailed', { code: e.result ?? '' })
  return `${name ?? ''} · ${result}`
}
</script>

<template>
  <ol class="audit-list" data-testid="audit-list">
    <li v-for="e in entries" :key="e.id" class="audit-row" :data-action="e.action" data-testid="audit-row">
      <span class="audit-avatar" aria-hidden="true">
        <v-icon v-if="!e.actor.personId" :icon="e.source === 'recovery' ? 'mdi-shield-alert-outline' : 'mdi-cog-outline'" size="16" />
        <template v-else>{{ initials(who(e)) }}</template>
      </span>
      <div class="audit-main">
        <div class="text-body-2">
          <span class="font-weight-medium">{{ who(e) }}</span>
          {{ t(auditLine(e).actionKey) }}
          <code v-if="auditLine(e).key" class="setting-code">{{ auditLine(e).key }}</code>
          <span v-if="e.action === 'test'" class="text-medium-emphasis">{{ testLabel(e) }}</span>
        </div>
        <div v-if="auditLine(e).from !== null || auditLine(e).to !== null" class="text-caption audit-change" data-testid="audit-change">
          <span v-if="auditLine(e).from !== null" class="audit-old">{{ auditLine(e).from }}</span>
          <span v-if="auditLine(e).from !== null" aria-hidden="true"> → </span>
          <span class="font-weight-medium">{{ auditLine(e).to ?? t('settings.audit.cleared') }}</span>
        </div>
        <div class="text-caption text-medium-emphasis d-flex flex-wrap align-center ga-2">
          <span>{{ formatDateTime(e.at, locale) }}</span>
          <span class="audit-source">{{ e.source }}</span>
          <span v-if="!compact && e.ip">{{ e.ip }}</span>
        </div>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.audit-list { list-style: none; margin: 0; padding: 0; }
.audit-row { display: flex; gap: 12px; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.audit-row:first-child { border-top: 0; }
.audit-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%;
  font-size: .6875rem; font-weight: 600; background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-on-primary-soft));
}
.audit-main { min-width: 0; overflow-wrap: anywhere; }
.audit-change { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.audit-old { text-decoration: line-through; }
.audit-source { padding: 0 6px; border-radius: 4px; background: rgb(var(--v-theme-neutral-soft)); color: rgb(var(--v-theme-neutral)); }
</style>
