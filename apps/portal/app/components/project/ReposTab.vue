<script setup lang="ts">
import type { Repo, WorkItemDetail } from '@yoda/shared'

const props = defineProps<{ projectId: string; canManage: boolean; canImport: boolean }>()

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
    <h2 class="text-h6 mb-2">{{ t('gitlab.repos.title') }}</h2>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="repos-error">{{ error }}</v-alert>
    <p v-if="!repos.length" class="text-medium-emphasis mb-4" data-testid="repos-empty">{{ t('gitlab.repos.empty') }}</p>
    <v-table v-else class="mb-4" data-testid="repos">
      <tbody>
        <tr v-for="r in repos" :key="r.id" data-testid="repo-row">
          <td><a :href="r.webUrl" target="_blank" rel="noopener noreferrer" :title="t('gitlab.repos.open')">{{ r.pathWithNamespace }}</a></td>
          <td class="text-medium-emphasis">{{ t('gitlab.repos.defaultBranch') }}: {{ r.defaultBranch }}</td>
          <td v-if="canManage" class="text-right">
            <v-btn icon="mdi-link-off" variant="text" :title="t('gitlab.repos.unlink')" data-testid="repo-unlink" @click="unlink(r)" />
          </td>
        </tr>
      </tbody>
    </v-table>
    <v-card v-if="canManage" variant="outlined" class="mb-6">
      <v-card-text class="d-flex ga-4 align-start">
        <v-text-field
          v-model="path"
          :label="t('gitlab.repos.path')"
          :hint="t('gitlab.repos.pathHint')"
          persistent-hint
          data-testid="repo-path"
          @keyup.enter="link"
        />
        <v-btn color="primary" :disabled="!path.trim()" :loading="busy" data-testid="repo-link" @click="link">{{ t('gitlab.repos.link') }}</v-btn>
      </v-card-text>
    </v-card>

    <template v-if="canImport && repos.length">
      <h2 class="text-h6 mb-2">{{ t('gitlab.import.title') }}</h2>
      <v-alert v-if="importError" type="error" class="mb-4" data-testid="import-error">{{ importError }}</v-alert>
      <v-card variant="outlined">
        <v-card-text class="d-flex ga-4 align-start">
          <v-select
            v-model="importRepo"
            :items="repos"
            item-title="pathWithNamespace"
            item-value="id"
            :label="t('gitlab.import.repo')"
            hide-details
            data-testid="import-repo"
          />
          <v-text-field v-model="importIid" :label="t('gitlab.import.issueIid')" prefix="#" inputmode="numeric" hide-details style="max-width: 180px" data-testid="import-iid" />
          <v-btn color="primary" :disabled="!importRepo || !iid" :loading="busy" data-testid="import-submit" @click="importIssue">{{ t('gitlab.import.submit') }}</v-btn>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>
