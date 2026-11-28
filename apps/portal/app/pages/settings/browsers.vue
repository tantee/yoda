<script setup lang="ts">
import type { ExtensionGrant } from '@yoda/shared'

/** My connected browsers (Yoda Reporter): revoke one when a browser is lost or no longer used. */
definePageMeta({ crumbs: [{ key: 'grants.title' }] })
const { t } = useI18n()
const api = useApi()
const grants = ref<ExtensionGrant[]>([])
const loaded = ref(false)
const loadFailure = ref<unknown>(null)

async function load() {
  try {
    grants.value = await api<ExtensionGrant[]>('/me/extension-grants')
    loadFailure.value = null
  } catch (e) {
    loadFailure.value = e
  } finally {
    loaded.value = true
  }
}
onMounted(load)
</script>

<template>
  <div data-testid="my-browsers">
    <PageHeader :title="t('grants.title')" />
    <p class="text-body-2 text-medium-emphasis mb-4">{{ t('grants.intro') }}</p>
    <ErrorState v-if="loadFailure" :error="loadFailure" @retry="load" />
    <SkeletonList v-else-if="!loaded" />
    <EmptyState v-else-if="!grants.length" :title="t('grants.empty')" icon="mdi-puzzle-outline" data-testid="grants-empty" />
    <v-card v-else>
      <SettingsGrantList :grants="grants" :revoke-path="(g) => `/me/extension-grants/${g.id}`" @changed="load" />
    </v-card>
  </div>
</template>
