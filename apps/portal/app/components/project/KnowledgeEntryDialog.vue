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
  <v-dialog :model-value="modelValue" max-width="720" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="isNew ? t('knowledge.newEntry') : entry?.title || t('knowledge.edit')" data-testid="entry-dialog">
      <v-card-text>
        <v-alert v-if="error" type="error" class="mb-4" data-testid="entry-error">{{ error }}</v-alert>
        <div v-if="entry" class="mb-3 d-flex ga-2 align-center flex-wrap">
          <v-chip size="small">{{ t(`knowledge.types.${entry.type}`) }}</v-chip>
          <StatusChip kind="knowledge" :value="entry.status" :label="t(`knowledge.statuses.${entry.status}`)" data-testid="entry-status" />
          <span class="text-caption text-medium-emphasis">
            {{ t('knowledge.version') }} {{ entry.version }} &middot; {{ t(`knowledge.sources.${entry.sourceKind}`) }}<template v-if="entry.createdByName"> {{ t('knowledge.by') }} {{ entry.createdByName }}</template>
          </span>
        </div>
        <v-select v-if="isNew" v-model="type" :label="t('knowledge.type')" :items="TYPES.map(x => ({ title: t(`knowledge.types.${x}`), value: x }))" data-testid="entry-type" />
        <v-text-field v-model="title" :readonly="!canEdit" :label="t('knowledge.entryTitle')" maxlength="300" data-testid="entry-title" />
        <v-textarea v-model="body" :readonly="!canEdit" :label="t('knowledge.body')" rows="8" auto-grow data-testid="entry-body" />
        <v-checkbox v-model="noAi" :disabled="!canEdit" :label="t('knowledge.noAi')" density="compact" hide-details data-testid="entry-no-ai" />

        <template v-if="versions.length">
          <h3 class="text-subtitle-1 mt-4 mb-1">{{ t('knowledge.versions') }}</h3>
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
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="canEdit && entry?.status === 'draft'" color="success" :disabled="busy" data-testid="entry-confirm" @click="confirmEntry">{{ t('knowledge.confirm') }}</v-btn>
        <v-spacer />
        <v-btn @click="emit('update:modelValue', false)">{{ t('knowledge.close') }}</v-btn>
        <v-btn v-if="canEdit" color="primary" variant="flat" :disabled="!canSubmit" data-testid="entry-save" @click="submit">{{ isNew ? t('common.save') : t('knowledge.save') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
