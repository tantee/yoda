<script setup lang="ts">
import type { IssueSync, Repo, WorkItemCode } from '@yoda/shared'
import { closesHint, mrStateColor, pipelineColor, syncStatusKey } from '~/utils/gitlab'

/** Staff only: the work item page is a staff path; requesters never load /work-items/:id/code. */
const props = defineProps<{ workItemId: string; projectId: string; canManage: boolean; active: boolean }>()

const { t, te } = useI18n()
const api = useApi()
const code = ref<WorkItemCode | null>(null)
const projectRepos = ref<Repo[]>([])
const picked = ref<string[]>([])
const error = ref('')
const busy = ref(false)

/** Once an issue or MR exists development has started; the server refuses changes then (409). */
const started = computed(() => !!code.value && (code.value.issues.some(i => i.issueIid !== null) || code.value.mergeRequests.length > 0))
const canPick = computed(() => props.canManage && props.active && !started.value)
const repoPath = (repoId: string) => code.value?.repos.find(r => r.id === repoId)?.pathWithNamespace ?? ''
const reasonText = (r: string | null) => (r && te(`events.reason.${r}`) ? t(`events.reason.${r}`) : (r ?? ''))
const syncColor = (s: IssueSync['status']) => (s === 'synced' ? 'success' : s === 'failed' ? 'error' : 'warning')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const c = await api<WorkItemCode>(`/work-items/${props.workItemId}/code`)
    if (mine !== seq) return
    code.value = c
    picked.value = c.repos.map(r => r.id)
    error.value = ''
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}

// The project (and so PM rights) loads after the item: fetch the choices once picking becomes possible.
watch(canPick, async (v) => {
  if (!v || projectRepos.value.length) return
  try {
    projectRepos.value = await api<Repo[]>(`/projects/${props.projectId}/repos`)
  } catch (e) {
    error.value = t(errorKey(e))
  }
}, { immediate: true })

const dirty = computed(() => {
  const now = new Set(code.value?.repos.map(r => r.id) ?? [])
  return picked.value.length !== now.size || picked.value.some(id => !now.has(id))
})

async function save() {
  error.value = ''
  busy.value = true
  try {
    seq++
    code.value = await api<WorkItemCode>(`/work-items/${props.workItemId}/repos`, { method: 'PUT', body: { repoIds: picked.value } })
    picked.value = code.value.repos.map(r => r.id)
  } catch (e) {
    const c = (e as { data?: { error?: string } })?.data?.error
    error.value = c === 'invalid_state' ? t('gitlab.code.locked') : t(errorKey(e))
    await load()
  } finally {
    busy.value = false
  }
}

defineExpose({ reload: load })
onMounted(load)
</script>

<template>
  <v-card variant="outlined" class="mb-4" data-testid="code-panel">
    <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
      <v-icon icon="mdi-gitlab" size="small" />{{ t('gitlab.code.title') }}
    </v-card-title>
    <v-card-text>
      <v-alert v-if="code && !code.connected" type="info" variant="tonal" density="compact" class="mb-3" data-testid="code-not-connected">{{ t('gitlab.notConnected') }}</v-alert>
      <v-alert v-if="error" type="error" density="compact" class="mb-3" data-testid="code-error">{{ error }}</v-alert>
      <template v-if="code">
        <div v-if="canPick" class="d-flex ga-4 align-start mb-3">
          <v-select
            v-model="picked"
            :items="projectRepos"
            item-title="pathWithNamespace"
            item-value="id"
            multiple
            chips
            density="compact"
            :label="t('gitlab.code.repos')"
            :hint="t('gitlab.code.pickHint')"
            persistent-hint
            data-testid="code-repo-picker"
          />
          <v-btn color="primary" :disabled="!dirty" :loading="busy" data-testid="code-repo-save" @click="save">{{ t('gitlab.code.save') }}</v-btn>
        </div>
        <p v-else-if="!code.repos.length" class="text-medium-emphasis mb-2" data-testid="code-no-repos">{{ t('gitlab.code.noRepos') }}</p>

        <div v-for="i in code.issues" :key="i.repoId" class="mb-2" data-testid="code-issue">
          <div class="d-flex flex-wrap align-center ga-2">
            <span class="font-weight-medium">{{ i.pathWithNamespace }}</span>
            <a v-if="i.issueIid !== null && i.issueUrl" :href="i.issueUrl" target="_blank" rel="noopener noreferrer" data-testid="code-issue-link">#{{ i.issueIid }}</a>
            <span v-else class="text-medium-emphasis text-caption">{{ t('gitlab.code.noIssue') }}</span>
            <v-chip size="x-small" :color="syncColor(i.status)" data-testid="code-sync" :data-status="i.status">
              {{ t(syncStatusKey(i.status), { reason: reasonText(i.error) }) }}
            </v-chip>
          </div>
          <div v-if="closesHint(i.issueIid)" class="text-caption text-medium-emphasis" data-testid="code-closes-hint">
            <i18n-t keypath="gitlab.code.closesHint" tag="span">
              <template #hint><code>{{ closesHint(i.issueIid) }}</code></template>
            </i18n-t>
          </div>
        </div>

        <h3 class="text-subtitle-2 mt-3 mb-1">{{ t('gitlab.code.mergeRequests') }}</h3>
        <p v-if="!code.mergeRequests.length" class="text-medium-emphasis text-caption" data-testid="code-no-mrs">{{ t('gitlab.code.noMrs') }}</p>
        <div v-for="mr in code.mergeRequests" :key="mr.id" class="d-flex flex-wrap align-center ga-2 mb-1" data-testid="code-mr">
          <a :href="mr.url" target="_blank" rel="noopener noreferrer">{{ repoPath(mr.repoId) }}!{{ mr.mrIid }}</a>
          <span>{{ mr.title }}</span>
          <v-chip size="x-small" :color="mrStateColor(mr.state)" data-testid="code-mr-state" :data-state="mr.state">{{ t(`gitlab.mrState.${mr.state}`) }}</v-chip>
          <v-chip v-if="mr.pipeline !== 'none'" size="x-small" variant="outlined" :color="pipelineColor(mr.pipeline)" data-testid="code-mr-pipeline">{{ t(`gitlab.pipeline.${mr.pipeline}`) }}</v-chip>
        </div>
      </template>
    </v-card-text>
  </v-card>
</template>
