<script setup lang="ts">
import type { KnowledgeCreate, KnowledgeEntry, KnowledgeType } from '@yoda/shared'

const TYPES: KnowledgeType[] = ['fact', 'decision', 'document', 'progress', 'memory']

const props = defineProps<{ modelValue: boolean; projectId: string; entryId: string | null; isMember: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; saved: [] }>()

const { t } = useI18n()
const { dateTime } = useDateFormat()
const api = useApi()
const { me } = useMe()
const entry = ref<KnowledgeEntry | null>(null)
const versions = ref<KnowledgeEntry[]>([])
const type = ref<KnowledgeType>('fact')
const title = ref('')
const body = ref('')
const noAi = ref(false)
const error = ref('')
const busy = ref(false)
const bodyTab = ref<'edit' | 'preview'>('edit')
const dirty = computed(() => (entry.value ? title.value !== entry.value.title || body.value !== entry.value.body || noAi.value !== entry.value.noAi : !!title.value.trim() || !!body.value.trim()))

const isNew = computed(() => !props.entryId)
// Mirrors core: department entries are admin-only to change; project entries need membership (or admin).
const canEdit = computed(() => {
  if (isNew.value || !entry.value) return true
  if (me.value?.isAdmin) return true
  return entry.value.scope !== 'department' && props.isMember
})
const canSubmit = computed(() => !!title.value.trim() && !busy.value)

function fill(e: KnowledgeEntry) {
  entry.value = e
  type.value = e.type
  title.value = e.title
  body.value = e.body
  noAi.value = e.noAi
}

let loadSeq = 0
async function loadEntry(id: string) {
  const mine = ++loadSeq
  try {
    const [e, v] = await Promise.all([
      api<KnowledgeEntry>(`/knowledge/${id}`),
      api<KnowledgeEntry[]>(`/knowledge/${id}/versions`),
    ])
    if (mine !== loadSeq) return
    fill(e)
    versions.value = [...v].sort((a, b) => b.version - a.version)
  } catch (e) {
    if (mine === loadSeq) error.value = t(errorKey(e))
  }
}

watch(() => props.modelValue, (open) => {
  if (!open) return
  loadSeq++
  error.value = ''
  entry.value = null
  versions.value = []
  type.value = 'fact'
  title.value = ''
  body.value = ''
  noAi.value = false
  bodyTab.value = 'edit'
  if (props.entryId) loadEntry(props.entryId)
})

async function submit() {
  if (!canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    if (isNew.value) {
      const payload: KnowledgeCreate = {
        scope: 'project',
        projectId: props.projectId,
        type: type.value,
        title: title.value.trim(),
        body: body.value,
        noAi: noAi.value,
      }
      await api('/knowledge', { method: 'POST', body: payload })
      emit('saved')
      emit('update:modelValue', false)
    } else if (entry.value) {
      const updated = await api<KnowledgeEntry>(`/knowledge/${entry.value.id}`, {
        method: 'PATCH',
        body: { title: title.value.trim(), body: body.value, noAi: noAi.value },
      })
      emit('saved')
      await loadEntry(updated.id)
    }
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

async function confirmEntry() {
  if (!entry.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const confirmed = await api<KnowledgeEntry>(`/knowledge/${entry.value.id}/confirm`, { method: 'POST' })
    emit('saved')
    await loadEntry(confirmed.id)
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppDialog
    :model-value="modelValue"
    :title="isNew ? t('knowledge.newEntry') : entry?.title || t('knowledge.edit')"
    size="editor"
    :busy="busy"
    :dirty="canEdit && dirty"
    scrollable
    data-testid="entry-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="entry-error">{{ error }}</v-alert>
    <div v-if="entry" class="entry-meta mb-4">
      <v-chip size="small" variant="outlined">{{ t(`knowledge.types.${entry.type}`) }}</v-chip>
      <StatusChip kind="knowledge" :value="entry.status" :label="t(`knowledge.statuses.${entry.status}`)" data-testid="entry-status" />
      <span class="text-caption text-medium-emphasis">
        {{ t('knowledge.version') }} {{ entry.version }} &middot; {{ t(`knowledge.sources.${entry.sourceKind}`) }}<template v-if="entry.createdByName"> {{ t('knowledge.by') }} {{ entry.createdByName }}</template> &middot; {{ dateTime(entry.createdAt) }}
      </span>
    </div>
    <div class="entry-form">
      <v-select v-if="isNew" v-model="type" :label="t('knowledge.type')" :items="TYPES.map(x => ({ title: t(`knowledge.types.${x}`), value: x }))" data-testid="entry-type" />
      <v-text-field v-model="title" :autofocus="canEdit" :readonly="!canEdit" :label="t('knowledge.entryTitle')" maxlength="300" data-testid="entry-title" />
      <div>
        <v-tabs v-model="bodyTab" density="compact" color="primary" class="mb-2">
          <v-tab value="edit">{{ t('knowledge.bodyEdit') }}</v-tab>
          <v-tab value="preview" data-testid="entry-preview-tab">{{ t('knowledge.bodyPreview') }}</v-tab>
        </v-tabs>
        <v-textarea v-show="bodyTab === 'edit'" v-model="body" :readonly="!canEdit" :label="t('knowledge.body')" :hint="t('knowledge.markdownHint')" persistent-hint rows="10" auto-grow data-testid="entry-body" />
        <div v-if="bodyTab === 'preview'" class="entry-preview" data-testid="entry-preview">
          <MarkdownView v-if="body.trim()" :source="body" />
          <p v-else class="text-body-2 text-medium-emphasis mb-0">{{ t('knowledge.previewEmpty') }}</p>
        </div>
      </div>
      <v-checkbox v-model="noAi" :disabled="!canEdit" :label="t('knowledge.noAi')" density="compact" hide-details data-testid="entry-no-ai" />
    </div>

    <template v-if="versions.length">
      <h3 class="text-body-2 font-weight-medium mt-4 mb-2">{{ t('knowledge.versions') }}</h3>
      <v-expansion-panels variant="accordion" data-testid="versions">
        <v-expansion-panel v-for="v in versions" :key="v.id" data-testid="version-row">
          <v-expansion-panel-title>
            {{ t('knowledge.version') }} {{ v.version }}<span v-if="!v.supersededAt" class="ml-2 text-medium-emphasis">({{ t('knowledge.current') }})</span>
            <span class="ml-auto mr-4 text-caption text-medium-emphasis">{{ dateTime(v.createdAt) }}</span>
          </v-expansion-panel-title>
          <v-expansion-panel-text><div style="white-space: pre-wrap">{{ v.body }}</div></v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>
    </template>
    <template #start>
      <v-btn v-if="canEdit && entry?.status === 'draft'" color="success" variant="tonal" prepend-icon="mdi-check-decagram-outline" :disabled="busy" data-testid="entry-confirm" @click="confirmEntry">{{ t('knowledge.confirm') }}</v-btn>
    </template>
    <template #actions>
      <v-btn variant="text" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('knowledge.close') }}</v-btn>
      <v-btn v-if="canEdit" color="primary" variant="flat" :loading="busy" :disabled="!canSubmit" data-testid="entry-save" @click="submit">{{ isNew ? t('common.save') : t('knowledge.save') }}</v-btn>
    </template>
  </AppDialog>
</template>

<style scoped>
.entry-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.entry-form { display: flex; flex-direction: column; gap: 12px; }
.entry-preview { min-height: 160px; padding: 12px 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 6px; }
</style>
