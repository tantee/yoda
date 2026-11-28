<script setup lang="ts">
import type { ExtensionGrant } from '@yoda/shared'
import { grantStatus, sortGrants } from '~/utils/grants'

/** Connected browsers (Yoda Reporter grants): label, created, last use and IP, with Revoke behind a confirm. */
const props = defineProps<{ grants: ExtensionGrant[]; showPerson?: boolean; revokePath: (g: ExtensionGrant) => string }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const api = useApi()
const now = ref(new Date())
const rows = computed(() => sortGrants(props.grants, now.value))
const revoking = ref<ExtensionGrant | null>(null)
/** Kept while the dialog closes, so its text never flashes empty. */
const revokingLabel = ref('')
const busy = ref(false)
const error = ref('')

function ask(g: ExtensionGrant) {
  error.value = ''
  revokingLabel.value = g.browserLabel
  revoking.value = g
}

async function revoke() {
  const g = revoking.value
  if (!g || busy.value) return
  busy.value = true
  try {
    await api(props.revokePath(g), { method: 'DELETE' })
    revoking.value = null
    emit('changed')
  } catch (e) {
    error.value = t(errorKey(e))
    // It may be gone already (revoked elsewhere): show the list as it is now.
    emit('changed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <ul class="grant-list" data-testid="grant-list">
      <li v-for="g in rows" :key="g.id" class="grant-row" :data-grant-id="g.id" data-testid="grant-row">
        <v-icon icon="mdi-puzzle-outline" size="22" class="text-medium-emphasis" aria-hidden="true" />
        <div class="grant-row__main">
          <div class="text-body-1 grant-row__label">
            {{ g.browserLabel }}<span v-if="showPerson" class="text-medium-emphasis"> · {{ g.person.displayName }}</span>
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ t('grants.created') }} {{ formatDate(g.createdAt, locale) }} ·
            {{ t('grants.lastUsed') }} {{ g.lastUsedAt ? formatRelative(g.lastUsedAt, locale, now) : t('grants.never') }}<template v-if="g.lastIp"> · {{ g.lastIp }}</template>
          </div>
          <div v-if="g.revokedAt && g.revokeReason" class="text-caption text-medium-emphasis" data-testid="grant-reason">
            {{ t('grants.revokedReason', { when: formatDate(g.revokedAt, locale), reason: t(`grants.reason.${g.revokeReason}`) }) }}
          </div>
        </div>
        <StatusChip kind="grant" :value="grantStatus(g, now)" size="x-small" data-testid="grant-status" />
        <v-btn v-if="!g.revokedAt" variant="text" color="error" size="small" prepend-icon="mdi-link-off" data-testid="grant-revoke" @click="ask(g)">{{ t('grants.revoke') }}</v-btn>
      </li>
    </ul>
    <ConfirmDialog
      :model-value="!!revoking"
      :title="t('grants.revokeTitle')"
      :text="t('grants.revokeText', { browser: revokingLabel })"
      :confirm-label="t('grants.revoke')"
      destructive
      :busy="busy"
      :error="error"
      confirm-testid="grant-revoke-ok"
      cancel-testid="grant-revoke-keep"
      @update:model-value="(v) => { if (!v) revoking = null }"
      @confirm="revoke"
    />
  </div>
</template>

<style scoped>
.grant-list { list-style: none; margin: 0; padding: 0; }
.grant-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; flex-wrap: wrap; }
.grant-row + .grant-row { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.grant-row__main { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; }
</style>
