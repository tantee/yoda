<script setup lang="ts">
import type { Repo, WorkItemDetail } from '@yoda/shared'

const props = defineProps<{ projectId: string; canManage: boolean; canImport: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const { t } = useI18n()
const api = useApi()
const repos = ref<Repo[]>([])
const error = ref('')
const path = ref('')
const busy = ref(false)
const importRepo = ref<string | null>(null)
const importIid = ref('')
const importError = ref('')

const code = (e: unknown) => (e as { data?: { error?: string } })?.data?.error

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<Repo[]>(`/projects/${props.projectId}/repos`)
    if (mine !== seq) return
    repos.value = list
    if (!importRepo.value && list.length) importRepo.value = list[0]!.id
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}

async function link() {
  const p = path.value.trim()
  if (!p) return
  error.value = ''
  busy.value = true
  try {
    await api(`/projects/${props.projectId}/repos`, { method: 'POST', body: { path: p } })
    path.value = ''
    emit('changed')
  } catch (e) {
    error.value = code(e) === 'invalid_state' ? t('gitlab.repos.duplicate') : t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
}

async function unlink(r: Repo) {
  error.value = ''
  try {
    await api(`/projects/${props.projectId}/repos/${r.id}`, { method: 'DELETE' })
    emit('changed')
  } catch (e) {
    error.value = code(e) === 'invalid_state' ? t('gitlab.repos.hasIssues') : t(errorKey(e))
  }
  await load()
}

const iid = computed(() => (/^\d+$/.test(importIid.value.trim()) ? Number(importIid.value.trim()) : null))

async function importIssue() {
  if (!importRepo.value || !iid.value) return
  importError.value = ''
  busy.value = true
  try {
    const item = await api<WorkItemDetail>(`/projects/${props.projectId}/import-issue`, {
      method: 'POST',
      body: { repoId: importRepo.value, issueIid: iid.value },
    })
    await navigateTo(`/work-items/${item.id}`)
  } catch (e) {
    importError.value = code(e) === 'invalid_state' ? t('gitlab.import.duplicate') : t(errorKey(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="repos-tab">
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" data-testid="repos-error">{{ error }}</v-alert>
    <v-card class="mb-4">
      <div class="card-head">
        <h2>{{ t('gitlab.repos.title') }} <span class="count-pill ml-1">{{ repos.length }}</span></h2>
      </div>
      <p v-if="!repos.length" class="card-body text-medium-emphasis mb-0" data-testid="repos-empty">{{ t('gitlab.repos.empty') }}</p>
      <ul v-else class="repo-list" data-testid="repos">
        <li v-for="r in repos" :key="r.id" class="repo-row" data-testid="repo-row">
          <v-icon icon="mdi-gitlab" size="20" class="text-medium-emphasis" aria-hidden="true" />
          <div class="repo-row__main">
            <a :href="r.webUrl" target="_blank" rel="noopener noreferrer" class="row-link" :title="t('gitlab.repos.open')">
              {{ r.pathWithNamespace }} <v-icon icon="mdi-open-in-new" size="14" aria-hidden="true" />
            </a>
            <div class="text-caption text-medium-emphasis">
              <v-icon icon="mdi-source-branch" size="14" aria-hidden="true" /> {{ t('gitlab.repos.defaultBranch') }}: {{ r.defaultBranch ?? '—' }}
            </div>
          </div>
          <v-btn v-if="canManage" variant="text" color="error" size="small" prepend-icon="mdi-link-off" data-testid="repo-unlink" @click="unlink(r)">{{ t('gitlab.repos.unlink') }}</v-btn>
        </li>
      </ul>
      <div v-if="canManage" class="repo-form">
        <v-text-field
          v-model="path"
          :label="t('gitlab.repos.path')"
          :hint="t('gitlab.repos.pathHint')"
          persistent-hint
          prepend-inner-icon="mdi-gitlab"
          class="repo-form__field"
          data-testid="repo-path"
          @keyup.enter="link"
        />
        <v-btn color="primary" variant="tonal" :disabled="!path.trim()" :loading="busy" data-testid="repo-link" @click="link">{{ t('gitlab.repos.link') }}</v-btn>
      </div>
    </v-card>

    <v-card v-if="canImport && repos.length">
      <div class="card-head"><h2>{{ t('gitlab.import.title') }}</h2></div>
      <div class="card-body">
        <v-alert v-if="importError" type="error" variant="tonal" density="compact" class="mb-4" data-testid="import-error">{{ importError }}</v-alert>
        <div class="repo-form repo-form--plain">
          <v-select
            v-model="importRepo"
            :items="repos"
            item-title="pathWithNamespace"
            item-value="id"
            :label="t('gitlab.import.repo')"
            hide-details
            class="repo-form__field"
            data-testid="import-repo"
          />
          <v-text-field v-model="importIid" :label="t('gitlab.import.issueIid')" prefix="#" inputmode="numeric" hide-details class="repo-form__iid" data-testid="import-iid" />
          <v-btn color="primary" :disabled="!importRepo || !iid" :loading="busy" data-testid="import-submit" @click="importIssue">{{ t('gitlab.import.submit') }}</v-btn>
        </div>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.repo-list { list-style: none; margin: 0; padding: 0; }
.repo-row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; flex-wrap: wrap; }
.repo-row + .repo-row { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.repo-row__main { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.repo-form { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 12px; padding: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.repo-form--plain { padding: 0; border-top: 0; align-items: center; }
.repo-form__field { flex: 1 1 260px; max-width: 480px; }
.repo-form__iid { flex: 0 1 160px; min-width: 120px; }
.repo-form .v-btn { margin-top: 2px; }
</style>
