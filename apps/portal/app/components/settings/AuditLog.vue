<script setup lang="ts">
import { SettingCategory, type SettingsAuditEntry, type SettingsAuditPage } from '@yoda/shared'
import AuditList from './AuditList.vue'

/** The full change log (proposal §5.2, §5.4), newest first, filtered by category and key, 50 at a time. */
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const initial = SettingCategory.safeParse(route.query.category)
const category = ref<SettingCategory | null>(initial.success ? initial.data : null)
const key = ref(typeof route.query.key === 'string' ? route.query.key : '')
const entries = ref<SettingsAuditEntry[] | null>(null)
const next = ref<number | null>(null)
const failure = ref<unknown>(null)
const more = ref(false)
const categories = computed(() => [
  { value: null, title: t('settings.audit.allCategories') },
  ...SettingCategory.options.map(c => ({ value: c, title: t(`settings.category.${c}`) })),
])

async function fetchPage(cursor?: number) {
  return api<SettingsAuditPage>('/admin/settings/audit', {
    query: { limit: 50, ...(category.value ? { category: category.value } : {}), ...(key.value.trim() ? { key: key.value.trim() } : {}), ...(cursor ? { cursor } : {}) },
  })
}
async function load() {
  entries.value = null
  failure.value = null
  try {
    const p = await fetchPage()
    entries.value = p.entries
    next.value = p.nextCursor
  } catch (e) {
    failure.value = e
  }
}
async function loadMore() {
  if (!next.value || !entries.value) return
  more.value = true
  try {
    const p = await fetchPage(next.value)
    entries.value = [...entries.value, ...p.entries]
    next.value = p.nextCursor
  } catch (e) {
    failure.value = e
  } finally {
    more.value = false
  }
}
watch(category, load)
onMounted(load)
</script>

<template>
  <v-card data-testid="audit-log">
    <div class="card-head">
      <h2>{{ t('settings.page.audit') }}</h2>
      <div class="d-flex flex-wrap ga-2 audit-filters">
        <v-select v-model="category" :items="categories" :label="t('settings.audit.category')" density="compact" hide-details class="audit-filter" data-testid="audit-filter-category" />
        <v-text-field v-model="key" :label="t('settings.audit.key')" density="compact" hide-details clearable class="audit-filter" spellcheck="false" data-testid="audit-filter-key" @keyup.enter="load" @click:clear="key = ''; load()" />
      </div>
    </div>
    <ErrorState v-if="failure && !entries" :error="failure" @retry="load" />
    <SkeletonList v-else-if="!entries" :rows="5" quiet />
    <p v-else-if="!entries.length" class="card-body text-body-2 text-medium-emphasis mb-0" data-testid="audit-empty">{{ t('settings.audit.empty') }}</p>
    <template v-else>
      <AuditList :entries="entries" />
      <div v-if="next" class="card-body text-center">
        <v-btn variant="outlined" :loading="more" data-testid="audit-more" @click="loadMore">{{ t('settings.audit.more') }}</v-btn>
      </div>
    </template>
    <p class="card-body setting-meta mb-0">{{ t('settings.audit.kept') }}</p>
  </v-card>
</template>

<style scoped>
.audit-filter { min-width: 180px; flex: 1 1 180px; }
.audit-filters { flex: 1 1 360px; justify-content: flex-end; }
</style>
