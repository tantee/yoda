<script setup lang="ts">
import type { Repo, WorkItemCode } from '@yoda/shared'
import { closesHint, syncStatusKey } from '~/utils/gitlab'

/** Staff only: the work item page is a staff path; requesters never load /work-items/:id/code. */
const props = defineProps<{ workItemId: string; projectId: string; canManage: boolean; active: boolean }>()

const { t, te } = useI18n()
const api = useApi()
const code = ref<WorkItemCode | null>(null)
const projectRepos = ref<Repo[]>([])
const picked = ref<string[]>([])
const error = ref('')
const busy = ref(false)
/** The repo picker opens from "จัดการ" (or straight away while no repo is picked). */
const managing = ref(false)

/** Repos can be added at any time; a repo whose issue exists can't be removed (the server answers 409). */
const canPick = computed(() => props.canManage && props.active)
const withIssue = computed(() => new Set(code.value?.issues.filter(i => i.issueIid !== null).map(i => i.repoId) ?? []))
const repoItemProps = (r: Repo) => (withIssue.value.has(r.id) ? { disabled: true, subtitle: t('gitlab.code.hasIssue') } : {})
const repoPath = (repoId: string) => code.value?.repos.find(r => r.id === repoId)?.pathWithNamespace ?? ''
const hints = computed(() => (code.value?.issues ?? []).map(i => closesHint(i.issueIid)).filter((h): h is string => !!h))
const reasonText = (r: string | null) => (r && te(`events.reason.${r}`) ? t(`events.reason.${r}`) : (r ?? ''))

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
    const repoIds = [...new Set([...picked.value, ...withIssue.value])]
    code.value = await api<WorkItemCode>(`/work-items/${props.workItemId}/repos`, { method: 'PUT', body: { repoIds } })
    picked.value = code.value.repos.map(r => r.id)
    managing.value = false
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
  <v-card class="mb-4" data-testid="code-panel">
    <div class="code-head">
      <h2 class="text-subtitle-2 d-flex align-center ga-2"><v-icon icon="mdi-source-branch" size="18" aria-hidden="true" />{{ t('gitlab.code.title') }}</h2>
      <v-btn
        v-if="canPick && code && code.repos.length"
        size="small"
        variant="text"
        color="primary"
        :aria-expanded="managing"
        data-testid="code-manage"
        @click="managing = !managing"
      >{{ managing ? t('common.close') : t('gitlab.code.manage') }}</v-btn>
    </div>
    <div class="code-body">
      <v-alert v-if="code && !code.connected" type="info" variant="tonal" density="compact" class="mb-3" data-testid="code-not-connected">{{ t('gitlab.notConnected') }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="code-error">{{ error }}</v-alert>
      <template v-if="code">
        <div v-if="canPick && (managing || !code.repos.length)" class="d-flex flex-column ga-2 mb-3">
          <v-select
            v-model="picked"
            :items="projectRepos"
            item-title="pathWithNamespace"
            item-value="id"
            :item-props="repoItemProps"
            multiple
            chips
            closable-chips
            density="compact"
            :label="t('gitlab.code.repos')"
            :hint="t('gitlab.code.pickHint')"
            persistent-hint
            data-testid="code-repo-picker"
          />
          <div class="d-flex justify-end">
            <v-btn color="primary" variant="flat" size="small" :disabled="!dirty" :loading="busy" data-testid="code-repo-save" @click="save">{{ t('gitlab.code.save') }}</v-btn>
          </div>
        </div>
        <p v-else-if="!code.repos.length" class="text-body-2 text-medium-emphasis mb-2" data-testid="code-no-repos">{{ t('gitlab.code.noRepos') }}</p>

        <template v-if="code.issues.length">
          <h3 class="code-label">Repository</h3>
          <div v-for="i in code.issues" :key="i.repoId" class="code-row" data-testid="code-issue">
            <span class="code-repo">{{ i.pathWithNamespace }}</span>
            <span class="code-row__end">
              <a v-if="i.issueIid !== null && i.issueUrl" :href="i.issueUrl" target="_blank" rel="noopener noreferrer" class="text-body-2" data-testid="code-issue-link">#{{ i.issueIid }}</a>
              <span v-else class="text-medium-emphasis text-caption">{{ t('gitlab.code.noIssue') }}</span>
              <StatusChip kind="sync" :value="i.status" size="x-small" :label="t(syncStatusKey(i.status), { reason: reasonText(i.error) })" data-testid="code-sync" :data-status="i.status" />
            </span>
          </div>
          <div v-if="hints.length" class="text-caption text-medium-emphasis mt-1" data-testid="code-closes-hint">
            <i18n-t keypath="gitlab.code.closesHint" tag="span">
              <template #hint><template v-for="(h, n) in hints" :key="h"><template v-if="n"> / </template><code>{{ h }}</code></template></template>
            </i18n-t>
          </div>
        </template>

        <h3 class="code-label mt-3">{{ t('gitlab.code.mergeRequests') }}</h3>
        <p v-if="!code.mergeRequests.length" class="text-medium-emphasis text-caption mb-0" data-testid="code-no-mrs">{{ t('gitlab.code.noMrs') }}</p>
        <div v-for="mr in code.mergeRequests" :key="mr.id" class="code-mr" data-testid="code-mr">
          <div class="code-row">
            <a :href="mr.url" target="_blank" rel="noopener noreferrer" class="code-mr__title">!{{ mr.mrIid }} {{ mr.title }}</a>
            <span class="code-row__end">
              <StatusChip v-if="mr.pipeline !== 'none'" kind="pipeline" :value="mr.pipeline" size="x-small" :label="t(`gitlab.pipeline.${mr.pipeline}`)" data-testid="code-mr-pipeline" />
            </span>
          </div>
          <div class="text-caption text-medium-emphasis d-flex align-center flex-wrap ga-2">
            {{ repoPath(mr.repoId) }}
            <StatusChip kind="mr" :value="mr.state" size="x-small" data-testid="code-mr-state" :data-state="mr.state" />
          </div>
        </div>
      </template>
    </div>
  </v-card>
</template>

<style scoped>
.code-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 8px 16px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.code-head h2 { margin: 0; font-weight: 600; }
.code-body { padding: 16px; min-width: 0; }
.code-label { font-size: .75rem; font-weight: 500; margin: 0 0 4px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.code-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; padding: 4px 0; }
.code-row__end { display: inline-flex; align-items: center; gap: 6px; }
.code-repo { font-size: .875rem; min-width: 0; overflow-wrap: anywhere; }
.code-mr { padding: 6px 0; }
.code-mr + .code-mr { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.code-mr__title { font-size: .875rem; min-width: 0; overflow-wrap: anywhere; }
</style>
