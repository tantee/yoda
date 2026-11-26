<script setup lang="ts">
import type { Attachment, KnowledgeEntry, KnowledgeSearchHit, KnowledgeStatus, KnowledgeType } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { knowledgePreview, pageCount } from '~/utils/projects'

const TYPES: KnowledgeType[] = ['fact', 'decision', 'document', 'progress', 'memory']
const STATUSES: KnowledgeStatus[] = ['draft', 'confirmed']
const PAGE = 5

interface Group {
  key: string
  type: KnowledgeType
  status: KnowledgeStatus | null
  /** Progress drafts start collapsed (proposal §8.2). */
  collapsible: boolean
}
interface GroupState {
  entries: KnowledgeEntry[]
  total: number
  page: number
  loading: boolean
  error: string
  open: boolean
}

/**
 * Project knowledge (proposal §8.2): entries grouped by type, each group paged on the server (`limit` / `offset`,
 * total from `x-total-count`), progress drafts collapsed in their own group; a search shows a flat result list.
 * Uploading is a button; files are listed in a table.
 */
const props = defineProps<{ projectId: string; isMember?: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const api = useApi()
const { download } = useUpload()
const { date } = useDateFormat()
const { width } = useDisplay()

const q = ref('')
const type = ref<KnowledgeType | null>(null)
const status = ref<KnowledgeStatus | null>(null)
const hits = ref<KnowledgeSearchHit[] | null>(null)
const attachments = ref<Attachment[]>([])
const error = ref('')
const dialogOpen = ref(false)
const dialogEntryId = ref<string | null>(null)
const uploadOpen = ref(false)

const groups = computed<Group[]>(() => {
  const list: Group[] = []
  for (const ty of TYPES) {
    if (type.value && type.value !== ty) continue
    if (ty !== 'progress') {
      list.push({ key: ty, type: ty, status: status.value, collapsible: false })
      continue
    }
    if (status.value !== 'draft') list.push({ key: 'progress', type: ty, status: status.value ?? 'confirmed', collapsible: false })
    if (status.value !== 'confirmed') list.push({ key: 'progressDrafts', type: ty, status: 'draft', collapsible: true })
  }
  return list
})
const state = reactive<Record<string, GroupState>>({})
const seqs: Record<string, number> = {}

function groupState(g: Group): GroupState {
  state[g.key] ??= { entries: [], total: 0, page: 1, loading: true, error: '', open: !g.collapsible }
  return state[g.key]!
}

async function loadGroup(g: Group) {
  const s = groupState(g)
  const mine = (seqs[g.key] = (seqs[g.key] ?? 0) + 1)
  s.loading = true
  try {
    const res = await api.raw<KnowledgeEntry[]>('/knowledge', {
      query: { projectId: props.projectId, type: g.type, status: g.status ?? undefined, limit: PAGE, offset: (s.page - 1) * PAGE },
    })
    if (mine !== seqs[g.key]) return
    s.entries = res._data ?? []
    s.total = Number(res.headers.get('x-total-count') ?? s.entries.length)
    // A page past the end (an entry was superseded) falls back to the last page.
    if (!s.entries.length && s.page > 1 && s.total > 0) {
      s.page = pageCount(s.total, PAGE)
      return loadGroup(g)
    }
    s.error = ''
  } catch (e) {
    if (mine === seqs[g.key]) s.error = t(errorKey(e))
  } finally {
    if (mine === seqs[g.key]) s.loading = false
  }
}

const loadingAll = computed(() => groups.value.some(g => state[g.key]?.loading))
const shownGroups = computed(() => groups.value.filter(g => (state[g.key]?.total ?? 0) > 0 || state[g.key]?.error))
const groupsEmpty = computed(() => !loadingAll.value && !shownGroups.value.length)

let searchSeq = 0
async function loadSearch(term: string) {
  const mine = ++searchSeq
  try {
    let list = await api<KnowledgeSearchHit[]>('/knowledge/search', { query: { q: term, projectId: props.projectId } })
    if (type.value) list = list.filter(e => e.type === type.value)
    if (status.value) list = list.filter(e => e.status === status.value)
    if (mine !== searchSeq) return
    hits.value = list
    error.value = ''
  } catch (e) {
    if (mine === searchSeq) error.value = t(errorKey(e))
  }
}

async function loadEntries() {
  const term = (q.value ?? '').trim()
  if (term) return loadSearch(term)
  searchSeq++
  hits.value = null
  await Promise.all(groups.value.map(loadGroup))
}

function setPage(g: Group, page: number) {
  groupState(g).page = page
  loadGroup(g)
}

let attSeq = 0
async function loadAttachments() {
  const mine = ++attSeq
  try {
    const list = await api<Attachment[]>(`/projects/${props.projectId}/attachments`)
    if (mine === attSeq) attachments.value = list
  } catch (e) {
    if (mine === attSeq) error.value = t(errorKey(e))
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
watch(q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(loadEntries, 300)
})
watch([type, status], () => {
  for (const k of Object.keys(state)) state[k]!.page = 1
  loadEntries()
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
onMounted(() => {
  loadEntries()
  loadAttachments()
})

function open(id: string | null) {
  dialogEntryId.value = id
  dialogOpen.value = true
}

async function onSaved() {
  await loadEntries()
  emit('changed')
}

async function onUploaded() {
  uploadOpen.value = false
  await Promise.all([loadEntries(), loadAttachments()])
  emit('changed')
}

async function toggleNoAi(a: Attachment, v: boolean | null) {
  try {
    await api(`/attachments/${a.id}`, { method: 'PATCH', body: { noAi: !!v } })
  } catch (e) {
    error.value = t(errorKey(e))
  }
  await loadAttachments()
}

async function save(a: Attachment) {
  try {
    await download(a.id, a.fileName)
  } catch (e) {
    error.value = t((e as { key?: string }).key ?? 'errors.generic')
  }
}

const groupTitle = (g: Group) => (g.key === 'progressDrafts' ? t('knowledge.groupDrafts') : t(`knowledge.types.${g.type}`))
const preview = (e: KnowledgeEntry | KnowledgeSearchHit) => ('snippet' in e && e.snippet ? e.snippet : knowledgePreview(e.body))
const source = (e: KnowledgeEntry) => t(`knowledge.sources.${e.sourceKind}`)
</script>

<template>
  <div data-testid="knowledge-tab">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" data-testid="knowledge-error">{{ error }}</v-alert>
    <div class="knowledge-filters mb-4">
      <v-text-field v-model="q" :placeholder="t('knowledge.search')" :aria-label="t('knowledge.search')" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" class="knowledge-filters__search" data-testid="knowledge-search" />
      <v-select v-model="type" :items="TYPES.map(x => ({ title: t(`knowledge.types.${x}`), value: x }))" :label="t('knowledge.type')" clearable hide-details density="compact" class="knowledge-filters__select" data-testid="knowledge-type" />
      <v-select v-model="status" :items="STATUSES.map(x => ({ title: t(`knowledge.statuses.${x}`), value: x }))" :label="t('knowledge.status')" clearable hide-details density="compact" class="knowledge-filters__select" data-testid="knowledge-status" />
      <v-spacer />
      <v-btn variant="outlined" prepend-icon="mdi-upload-outline" data-testid="upload-open" @click="uploadOpen = true">{{ t('knowledge.uploadFile') }}</v-btn>
      <v-btn color="primary" prepend-icon="mdi-plus" data-testid="add-entry" @click="open(null)">{{ t('knowledge.add') }}</v-btn>
    </div>

    <!-- Search: one flat list of hits. -->
    <template v-if="hits">
      <EmptyState v-if="!hits.length" icon="mdi-text-search" :title="t('knowledge.empty')" data-testid="knowledge-empty" />
      <v-card v-else class="mb-6">
        <div class="card-head"><h2>{{ t('knowledge.searchResults') }} <span class="count-pill ml-1">{{ hits.length }}</span></h2></div>
        <ul class="knowledge-list" data-testid="knowledge-list">
          <li v-for="e in hits" :key="e.id" data-testid="knowledge-row">
            <button type="button" class="knowledge-row" @click="open(e.id)">
              <span class="knowledge-row__title">{{ e.title }}</span>
              <span class="knowledge-row__preview text-body-2 text-medium-emphasis">{{ preview(e) }}</span>
              <span class="knowledge-row__meta text-caption text-medium-emphasis">
                <v-chip size="x-small" variant="outlined">{{ t(`knowledge.types.${e.type}`) }}</v-chip>
                <StatusChip kind="knowledge" :value="e.status" :label="t(`knowledge.statuses.${e.status}`)" size="x-small" data-testid="status-chip" />
                <v-chip v-if="e.noAi" size="x-small" color="warning" data-testid="no-ai-chip">{{ t('knowledge.noAi') }}</v-chip>
                <span>{{ source(e) }}<template v-if="e.createdByName"> · {{ e.createdByName }}</template> · {{ date(e.createdAt) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </v-card>
    </template>

    <!-- Grouped by type, each group paged. -->
    <template v-else>
      <v-card v-if="loadingAll && !shownGroups.length" class="mb-6"><SkeletonList :rows="4" /></v-card>
      <EmptyState v-else-if="groupsEmpty" icon="mdi-book-open-page-variant-outline" :title="t('knowledge.empty')" data-testid="knowledge-empty">
        <v-btn color="primary" prepend-icon="mdi-plus" @click="open(null)">{{ t('knowledge.add') }}</v-btn>
      </EmptyState>
      <div v-else data-testid="knowledge-list">
        <v-card v-for="g in shownGroups" :key="g.key" class="mb-4" :data-group="g.key" data-testid="knowledge-group">
          <div class="card-head">
            <h2 class="d-flex align-center ga-2">
              <v-icon v-if="g.key === 'progressDrafts'" icon="mdi-creation-outline" size="18" color="ai" aria-hidden="true" />
              {{ groupTitle(g) }} <span class="count-pill">{{ state[g.key]!.total }}</span>
            </h2>
            <v-btn
              v-if="g.collapsible"
              variant="text"
              color="primary"
              size="small"
              :append-icon="state[g.key]!.open ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              :aria-expanded="state[g.key]!.open"
              :data-testid="`knowledge-toggle-${g.key}`"
              @click="state[g.key]!.open = !state[g.key]!.open"
            >{{ state[g.key]!.open ? t('status.showLess') : t('status.showAll') }}</v-btn>
          </div>
          <p v-if="g.collapsible && !state[g.key]!.open" class="card-body text-caption text-medium-emphasis mb-0">{{ t('knowledge.groupDraftsHint') }}</p>
          <template v-else>
            <p v-if="state[g.key]!.error" class="card-body text-error mb-0">{{ state[g.key]!.error }}</p>
            <ul class="knowledge-list" :class="{ 'knowledge-list--loading': state[g.key]!.loading }">
              <li v-for="e in state[g.key]!.entries" :key="e.id" data-testid="knowledge-row">
                <button type="button" class="knowledge-row" @click="open(e.id)">
                  <span class="knowledge-row__title">{{ e.title }}</span>
                  <span v-if="e.body" class="knowledge-row__preview text-body-2 text-medium-emphasis">{{ preview(e) }}</span>
                  <span class="knowledge-row__meta text-caption text-medium-emphasis">
                    <StatusChip kind="knowledge" :value="e.status" :label="t(`knowledge.statuses.${e.status}`)" size="x-small" data-testid="status-chip" />
                    <v-chip v-if="e.noAi" size="x-small" color="warning" data-testid="no-ai-chip">{{ t('knowledge.noAi') }}</v-chip>
                    <span>{{ source(e) }}<template v-if="e.createdByName"> · {{ e.createdByName }}</template> · {{ date(e.createdAt) }}</span>
                  </span>
                </button>
              </li>
            </ul>
            <div v-if="state[g.key]!.total > PAGE" class="knowledge-pages">
              <v-pagination
                :model-value="state[g.key]!.page"
                :length="pageCount(state[g.key]!.total, PAGE)"
                :total-visible="width < 600 ? 3 : 7"
                density="compact"
                size="small"
                :aria-label="t('knowledge.pageLabel', { type: groupTitle(g) })"
                :data-testid="`knowledge-pages-${g.key}`"
                @update:model-value="(p: number) => setPage(g, p)"
              />
            </div>
          </template>
        </v-card>
      </div>
    </template>

    <v-card class="mt-2">
      <div class="card-head">
        <h2>{{ t('knowledge.attachments') }} <span class="count-pill ml-1">{{ attachments.length }}</span></h2>
      </div>
      <p v-if="!attachments.length" class="card-body text-medium-emphasis mb-0" data-testid="attachments-empty">{{ t('knowledge.noAttachments') }}</p>
      <ul v-else class="attachment-list" data-testid="attachments">
        <li v-for="a in attachments" :key="a.id" class="attachment-row" data-testid="attachment-row">
          <v-icon icon="mdi-file-document-outline" size="20" class="text-medium-emphasis" aria-hidden="true" />
          <div class="attachment-row__main">
            <div class="font-weight-medium">{{ a.fileName }}</div>
            <div class="text-caption text-medium-emphasis">
              {{ (a.sizeBytes / 1024).toFixed(1) }} KB · {{ a.uploadedByName }} · {{ date(a.createdAt) }}<template v-if="a.hasText"> · {{ t('knowledge.hasText') }}</template>
            </div>
          </div>
          <div class="attachment-row__actions">
            <v-checkbox :model-value="a.noAi" :label="t('knowledge.noAi')" density="compact" hide-details @update:model-value="(v) => toggleNoAi(a, v)" />
            <v-btn variant="text" color="primary" size="small" prepend-icon="mdi-download" data-testid="attachment-download" @click="save(a)">{{ t('knowledge.download') }}</v-btn>
          </div>
        </li>
      </ul>
    </v-card>

    <AppDialog v-model="uploadOpen" :title="t('knowledge.uploadTitle')" data-testid="upload-dialog">
      <AttachmentUpload :project-id="projectId" @uploaded="onUploaded" />
      <template #actions>
        <v-btn variant="text" @click="uploadOpen = false">{{ t('common.close') }}</v-btn>
      </template>
    </AppDialog>

    <ProjectKnowledgeEntryDialog v-model="dialogOpen" :project-id="projectId" :is-member="isMember ?? false" :entry-id="dialogEntryId" @saved="onSaved" />
  </div>
</template>

<style scoped>
.knowledge-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.knowledge-filters__search { flex: 1 1 240px; max-width: 360px; min-width: 200px; }
.knowledge-filters__select { flex: 0 1 180px; min-width: 140px; }
@media (max-width: 599px) {
  .knowledge-filters__search { max-width: none; flex-basis: 100%; }
  .knowledge-filters__select { flex: 1 1 calc(50% - 8px); }
}
.knowledge-list { list-style: none; margin: 0; padding: 0; }
.knowledge-list--loading { opacity: .6; }
.knowledge-list li + li { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.knowledge-row { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; padding: 10px 16px; background: none; border: 0; color: inherit; cursor: pointer; font: inherit; min-width: 0; }
.knowledge-row:hover { background: #F8FAFC; }
.knowledge-row__title { font-weight: 500; overflow-wrap: anywhere; }
.knowledge-row__preview { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; max-width: 880px; }
.knowledge-row__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 2px; }
.knowledge-pages { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); padding: 4px 8px; display: flex; justify-content: flex-end; }
.attachment-list { list-style: none; margin: 0; padding: 0; }
.attachment-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 16px; }
.attachment-row + .attachment-row { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.attachment-row__main { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.attachment-row__actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
</style>
