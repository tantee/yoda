<script setup lang="ts">
import type { SettingsTestResult } from '@yoda/shared'
import { useI18n } from '#imports'
import { checkDetails, checkLabelKey, testCodeMessage } from '~/utils/settings'

/**
 * The result of a test button (proposal §5.2, 8.5): pass or fail, then each check with its time and, on failure,
 * what the short code means. Core returns codes only, never a server's own text.
 */
defineProps<{ result: SettingsTestResult; draft?: boolean }>()
const { t } = useI18n()
const message = (code: string | undefined) => {
  const m = testCodeMessage(code)
  return t(m.key, m.named ?? {})
}
const secs = (ms: number) => (ms / 1000).toFixed(1)
</script>

<template>
  <v-alert
    :type="result.ok ? 'success' : 'error'"
    variant="tonal"
    density="compact"
    class="test-result"
    role="status"
    :data-ok="result.ok"
    data-testid="test-result"
  >
    <div class="font-weight-medium">{{ result.ok ? t('settings.test.passed') : t('settings.test.failed') }}</div>
    <ul class="test-result__checks text-body-2">
      <li v-for="c in result.checks" :key="c.id" :data-check="c.id" :data-ok="c.ok" data-testid="test-check">
        <v-icon :icon="c.ok ? 'mdi-check' : 'mdi-close'" size="16" aria-hidden="true" />
        <span>
          <span class="font-weight-medium">{{ t(checkLabelKey(c.id)) }}</span>
          <span class="text-medium-emphasis"> · {{ t('settings.test.seconds', { s: secs(c.ms) }) }}</span>
          <span v-if="!c.ok"> · <span data-testid="test-code">{{ message(c.code) }}</span></span>
          <span v-for="d in checkDetails(c)" :key="d" class="setting-code ml-1">{{ d }}</span>
        </span>
      </li>
    </ul>
    <div v-if="draft" class="text-caption text-medium-emphasis mt-1">{{ t('settings.test.draftNote') }}</div>
  </v-alert>
</template>

<style scoped>
.test-result__checks { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
.test-result__checks li { display: flex; align-items: flex-start; gap: 6px; overflow-wrap: anywhere; }
.test-result__checks .v-icon { margin-top: 2px; flex: none; }
</style>
