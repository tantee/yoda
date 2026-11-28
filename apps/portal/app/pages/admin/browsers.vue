<script setup lang="ts">
import type { ExtensionGrant } from '@yoda/shared'
import { filterGrants, REVOKE_ALL_WORD } from '~/utils/grants'

/** Everyone's connected browsers (admins): filter by person, revoke one, or revoke all behind a typed confirm. */
definePageMeta({ crumbs: [{ key: 'grants.adminTitle' }] })
const { t } = useI18n()
const api = useApi()
const grants = ref<ExtensionGrant[]>([])
const loaded = ref(false)
const loadFailure = ref<unknown>(null)
const q = ref('')
const activeOnly = ref(true)
const shown = computed(() => filterGrants(grants.value, q.value))

const allOpen = ref(false)
const typed = ref('')
const busy = ref(false)
const allError = ref('')
const notice = ref('')

async function load() {
  try {
    grants.value = await api<ExtensionGrant[]>(`/admin/extension-grants${activeOnly.value ? '?active=1' : ''}`)
    loadFailure.value = null
  } catch (e) {
    loadFailure.value = e
  } finally {
    loaded.value = true
  }
}
watch(activeOnly, load)

function openAll() {
  typed.value = ''
  allError.value = ''
  allOpen.value = true
}

async function revokeAll() {
  if (typed.value.trim() !== REVOKE_ALL_WORD || busy.value) return
  busy.value = true
  try {
    const { revoked } = await api<{ revoked: number }>('/admin/extension-grants/revoke-all', { method: 'POST' })
    allOpen.value = false
    notice.value = t('grants.revokedAll', { n: revoked })
    await load()
  } catch (e) {
    allError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>

<template>
  <div data-testid="admin-browsers">
    <PageHeader :title="t('grants.adminTitle')">
      <template #actions>
        <v-btn color="error" variant="tonal" prepend-icon="mdi-link-variant-off" data-testid="grants-revoke-all" @click="openAll">{{ t('grants.revokeAll') }}</v-btn>
      </template>
    </PageHeader>
    <p class="text-body-2 text-medium-emphasis mb-4">{{ t('grants.adminIntro') }}</p>
    <v-alert v-if="notice" type="success" variant="tonal" closable class="mb-4" data-testid="grants-notice" @click:close="notice = ''">{{ notice }}</v-alert>
    <div class="filters mb-4">
      <v-text-field v-model="q" :label="t('grants.filterPerson')" prepend-inner-icon="mdi-magnify" clearable hide-details class="filters__q" data-testid="grants-filter" />
      <v-switch v-model="activeOnly" :label="t('grants.activeOnly')" color="primary" inset hide-details data-testid="grants-active-only" />
    </div>
    <ErrorState v-if="loadFailure" :error="loadFailure" @retry="load" />
    <SkeletonList v-else-if="!loaded" />
    <EmptyState v-else-if="!shown.length" :title="t('grants.empty')" icon="mdi-puzzle-outline" data-testid="grants-empty" />
    <v-card v-else>
      <SettingsGrantList :grants="shown" show-person :revoke-path="(g) => `/admin/extension-grants/${g.id}`" @changed="load" />
    </v-card>

    <ConfirmDialog
      v-model="allOpen"
      :title="t('grants.revokeAllTitle')"
      :text="t('grants.revokeAllText')"
      :confirm-label="t('grants.revokeAll')"
      destructive
      :busy="busy"
      :dirty="!!typed"
      :disabled="typed.trim() !== REVOKE_ALL_WORD"
      :error="allError"
      confirm-testid="grants-revoke-all-ok"
      cancel-testid="grants-revoke-all-keep"
      @confirm="revokeAll"
    >
      <v-text-field v-model="typed" class="mt-4" :label="t('grants.revokeAllType', { word: REVOKE_ALL_WORD })" autocomplete="off" spellcheck="false" data-testid="grants-revoke-all-type" />
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; }
.filters__q { flex: 1 1 260px; max-width: 420px; }
</style>
