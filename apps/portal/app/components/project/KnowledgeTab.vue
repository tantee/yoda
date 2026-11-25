<script setup lang="ts">
import type { Attachment, KnowledgeEntry, KnowledgeSearchHit, KnowledgeStatus, KnowledgeType } from '@yoda/shared'

const TYPES: KnowledgeType[] = ['fact', 'decision', 'document', 'progress', 'memory']
const STATUSES: KnowledgeStatus[] = ['draft', 'confirmed']

const props = defineProps<{ projectId: string; isMember?: boolean }>()

const { t } = useI18n()
const api = useApi()
const { download } = useUpload()

const q = ref('')
const type = ref<KnowledgeType | null>(null)
const status = ref<KnowledgeStatus | null>(null)
const entries = ref<(KnowledgeEntry | KnowledgeSearchHit)[]>([])
const attachments = ref<Attachment[]>([])
const error = ref('')
const dialogOpen = ref(false)
const dialogEntryId = ref<string | null>(null)

let seq = 0
async function loadEntries() {
  const mine = ++seq
  try {
    const term = (q.value ?? '').trim()
    let list: (KnowledgeEntry | KnowledgeSearchHit)[]
    if (term) {
      list = await api<KnowledgeSearchHit[]>('/knowledge/search', { query: { q: term, projectId: props.projectId } })
      if (type.value) list = list.filter(e => e.type === type.value)
      if (status.value) list = list.filter(e => e.status === status.value)
    } else {
      list = await api<KnowledgeEntry[]>('/knowledge', {
        query: { projectId: props.projectId, type: type.value ?? undefined, status: status.value ?? undefined },
      })
    }
    if (mine !== seq) return
    entries.value = list
    error.value = ''
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
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
watch([type, status], loadEntries)
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

async function onUploaded() {
  await Promise.all([loadEntries(), loadAttachments()])
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
</script>

<template>
  <div data-testid="knowledge-tab">
    <v-alert v-if="error" type="error" class="mb-4" data-testid="knowledge-error">{{ error }}</v-alert>
    <div class="d-flex ga-3 align-center flex-wrap mb-2">
      <v-text-field v-model="q" :label="t('knowledge.search')" prepend-inner-icon="mdi-magnify" clearable hide-details density="compact" style="min-width: 240px" data-testid="knowledge-search" />
      <v-select v-model="type" :items="TYPES.map(x => ({ title: t(`knowledge.types.${x}`), value: x }))" :label="t('knowledge.type')" clearable hide-details density="compact" style="max-width: 180px" data-testid="knowledge-type" />
      <v-select v-model="status" :items="STATUSES.map(x => ({ title: t(`knowledge.statuses.${x}`), value: x }))" :label="t('knowledge.status')" clearable hide-details density="compact" style="max-width: 180px" data-testid="knowledge-status" />
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" data-testid="add-entry" @click="open(null)">{{ t('knowledge.add') }}</v-btn>
    </div>

    <p v-if="!entries.length && !error" class="text-medium-emphasis my-4" data-testid="knowledge-empty">{{ t('knowledge.empty') }}</p>
    <v-list v-else lines="two" class="mb-6" data-testid="knowledge-list">
      <v-list-item v-for="e in entries" :key="e.id" data-testid="knowledge-row" @click="open(e.id)">
        <v-list-item-title>{{ e.title }}</v-list-item-title>
        <v-list-item-subtitle>
          {{ 'snippet' in e && e.snippet ? e.snippet : e.body.slice(0, 120) }}
        </v-list-item-subtitle>
        <template #append>
          <div class="d-flex ga-1 align-center">
            <v-chip size="x-small">{{ t(`knowledge.types.${e.type}`) }}</v-chip>
            <StatusChip kind="knowledge" :value="e.status" :label="t(`knowledge.statuses.${e.status}`)" size="x-small" data-testid="status-chip" />
            <v-chip v-if="e.noAi" size="x-small" color="warning" data-testid="no-ai-chip">{{ t('knowledge.noAi') }}</v-chip>
            <span class="text-caption text-medium-emphasis ml-1">{{ t(`knowledge.sources.${e.sourceKind}`) }}<template v-if="e.createdByName"> &middot; {{ e.createdByName }}</template></span>
          </div>
        </template>
      </v-list-item>
    </v-list>

    <h2 class="text-h6 mb-2">{{ t('knowledge.uploadFile') }}</h2>
    <AttachmentUpload :project-id="projectId" class="mb-6" @uploaded="onUploaded" />

    <h2 class="text-h6 mb-2">{{ t('knowledge.attachments') }}</h2>
    <p v-if="!attachments.length" class="text-medium-emphasis" data-testid="attachments-empty">{{ t('knowledge.noAttachments') }}</p>
    <v-list v-else data-testid="attachments">
      <v-list-item v-for="a in attachments" :key="a.id" data-testid="attachment-row">
        <v-list-item-title>{{ a.fileName }}</v-list-item-title>
        <v-list-item-subtitle>{{ (a.sizeBytes / 1024).toFixed(1) }} KB &middot; {{ a.uploadedByName }}<template v-if="a.hasText"> &middot; {{ t('knowledge.hasText') }}</template></v-list-item-subtitle>
        <template #append>
          <v-checkbox :model-value="a.noAi" :label="t('knowledge.noAi')" density="compact" hide-details class="mr-2" @update:model-value="(v) => toggleNoAi(a, v)" />
          <v-btn variant="text" prepend-icon="mdi-download" data-testid="attachment-download" @click="save(a)">{{ t('knowledge.download') }}</v-btn>
        </template>
      </v-list-item>
    </v-list>

    <ProjectKnowledgeEntryDialog v-model="dialogOpen" :project-id="projectId" :is-member="isMember ?? false" :entry-id="dialogEntryId" @saved="loadEntries" />
  </div>
</template>
