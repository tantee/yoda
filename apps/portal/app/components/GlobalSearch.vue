<script setup lang="ts">
import type { SearchResult } from '@yoda/shared'
import { isLocalRoute, isSearchHotkey, SEARCH_ICONS, searchReady } from '~/utils/search'

/**
 * The jump box (proposal §5.3): projects, work items and people for staff, own requests for requesters.
 * A 300 px field on desktop, an icon opening a full-width dialog on mobile; ⌘K / Ctrl K focuses it.
 */
const props = defineProps<{ requester?: boolean; compact?: boolean }>()
const { t } = useI18n()
const api = useApi()

const query = ref('')
const results = ref<SearchResult[]>([])
const loading = ref(false)
const failed = ref(false)
const dialog = ref(false)
const field = ref<{ focus: () => void } | null>(null)
const placeholder = computed(() => (props.requester ? t('shell.search.placeholderRequester') : t('shell.search.placeholder')))
const isMac = import.meta.client && /Mac|iPhone|iPad/.test(navigator.platform)

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
watch(query, (q) => {
  if (timer) clearTimeout(timer)
  failed.value = false
  if (!searchReady(q)) {
    seq++
    results.value = []
    loading.value = false
    return
  }
  loading.value = true
  timer = setTimeout(async () => {
    const mine = ++seq
    try {
      const r = await api<SearchResult[]>('/search', { query: { q: q.trim() } })
      if (mine === seq) results.value = r
    } catch {
      if (mine === seq) {
        results.value = []
        failed.value = true
      }
    } finally {
      if (mine === seq) loading.value = false
    }
  }, 250)
})

const noData = computed(() => {
  if (!searchReady(query.value)) return t('shell.search.hint')
  if (loading.value) return ' '
  return failed.value ? t('shell.search.failed') : t('shell.search.noResults')
})

async function open(r: SearchResult | null) {
  if (!r || !isLocalRoute(r.route)) return
  dialog.value = false
  query.value = ''
  await navigateTo(r.route)
}

function onKey(e: KeyboardEvent) {
  if (!isSearchHotkey(e)) return
  e.preventDefault()
  if (props.compact) dialog.value = true
  else field.value?.focus()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="global-search" role="search">
    <template v-if="!compact">
      <v-autocomplete
        ref="field"
        v-model:search="query"
        :model-value="null"
        :items="results"
        item-title="title"
        item-value="id"
        return-object
        no-filter
        :hide-no-data="false"
        :no-data-text="noData"
        :loading="loading"
        :placeholder="placeholder"
        :aria-label="t('shell.search.label')"
        prepend-inner-icon="mdi-magnify"
        menu-icon=""
        bg-color="background"
        hide-details
        class="global-search__field"
        :menu-props="{ maxWidth: 420, minWidth: 300, maxHeight: 480 }"
        data-testid="search"
        @update:model-value="open"
      >
        <template #append-inner>
          <kbd v-if="!query" class="global-search__kbd">{{ isMac ? '⌘K' : 'Ctrl K' }}</kbd>
        </template>
        <template #item="{ props: itemProps, item }">
          <v-list-item v-bind="itemProps" :title="item.raw.title" :subtitle="item.raw.subtitle ?? undefined" data-testid="search-result">
            <template #prepend><v-icon :icon="SEARCH_ICONS[item.raw.type]" size="20" /></template>
            <template #append><span class="text-caption text-medium-emphasis ml-2">{{ t(`shell.search.types.${item.raw.type}`) }}</span></template>
          </v-list-item>
        </template>
      </v-autocomplete>
    </template>
    <template v-else>
      <v-btn icon="mdi-magnify" variant="text" :aria-label="t('shell.search.label')" :title="t('shell.search.label')" data-testid="search-open" @click="dialog = true" />
      <v-dialog v-model="dialog" fullscreen transition="fade-transition">
        <v-card rounded="0">
          <div class="d-flex align-center ga-2 pa-3">
            <v-btn icon="mdi-arrow-left" variant="text" :aria-label="t('shell.close')" @click="dialog = false" />
            <v-text-field
              v-model="query"
              autofocus
              :placeholder="placeholder"
              :aria-label="t('shell.search.label')"
              prepend-inner-icon="mdi-magnify"
              :loading="loading"
              clearable
              hide-details
              data-testid="search"
            />
          </div>
          <v-divider />
          <v-list v-if="results.length" lines="two">
            <v-list-item
              v-for="r in results"
              :key="`${r.type}-${r.id}`"
              :title="r.title"
              :subtitle="r.subtitle ?? undefined"
              data-testid="search-result"
              @click="open(r)"
            >
              <template #prepend><v-icon :icon="SEARCH_ICONS[r.type]" size="20" /></template>
              <template #append><span class="text-caption text-medium-emphasis ml-2">{{ t(`shell.search.types.${r.type}`) }}</span></template>
            </v-list-item>
          </v-list>
          <p v-else-if="!loading" class="pa-4 text-body-2 text-medium-emphasis">{{ noData }}</p>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>

<style scoped>
.global-search__field { width: 300px; }
.global-search__field :deep(input) { font-size: 13px; }
.global-search__kbd {
  font-size: 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px; padding: 0 5px;
  color: rgba(var(--v-theme-on-surface), .72); background: #fff; font-family: 'IBM Plex Sans', sans-serif; white-space: nowrap;
}
</style>
