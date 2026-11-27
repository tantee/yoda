<script setup lang="ts">
import type { SettingCategory, SettingsAuditEntry, SettingsAuditPage } from '@yoda/shared'
import AuditList from './AuditList.vue'

/**
 * The last 10 changes of the page's categories (proposal §5.2, right column; below the form on narrow screens),
 * with a link to the full change log. `refresh` reloads it after a save or a test.
 */
const props = defineProps<{ categories: SettingCategory[]; refresh: number }>()
const { t } = useI18n()
const api = useApi()
const entries = ref<SettingsAuditEntry[] | null>(null)
const failed = ref<unknown>(null)

async function load() {
  try {
    const pages = await Promise.all(props.categories.map(c => api<SettingsAuditPage>('/admin/settings/audit', { query: { category: c, limit: 10 } })))
    entries.value = pages.flatMap(p => p.entries).sort((a, b) => b.id - a.id).slice(0, 10)
    failed.value = null
  } catch (e) {
    failed.value = e
  }
}
watch(() => [props.categories.join(','), props.refresh], load, { immediate: true })
const allLink = computed(() => ({ path: '/admin/settings/audit', query: props.categories.length === 1 ? { category: props.categories[0] } : {} }))
</script>

<template>
  <v-card data-testid="audit-panel">
    <div class="card-head">
      <h2>{{ t('settings.audit.recent') }}</h2>
      <NuxtLink :to="allLink" class="text-body-2 text-primary" data-testid="audit-all">{{ t('settings.audit.seeAll') }}</NuxtLink>
    </div>
    <ErrorState v-if="failed && !entries" :error="failed" @retry="load" />
    <SkeletonList v-else-if="!entries" :rows="3" quiet />
    <p v-else-if="!entries.length" class="card-body text-body-2 text-medium-emphasis mb-0" data-testid="audit-empty">{{ t('settings.audit.empty') }}</p>
    <AuditList v-else :entries="entries" compact />
  </v-card>
</template>
