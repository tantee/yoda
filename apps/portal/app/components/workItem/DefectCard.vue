<script setup lang="ts">
import type { Attachment, ConsoleEntry, DefectReportView, NetworkEntry, Repo } from '@yoda/shared'
import { buildLine, commitUrl, orderAttachments, parseLog, safeHttpUrl } from '~/utils/defectView'

/**
 * A Yoda Reporter report on its work item (plan A12): the tester's text (the real text, also for a sensitive
 * report), page, build, browser, and the files: images, video and logs, fetched with the bearer token into blob
 * URLs. Everything from the page is untrusted and rendered as text only.
 */
const props = defineProps<{ workItemId: string; projectId: string; defect: DefectReportView; meId: string; canManage: boolean }>()
const { t, locale } = useI18n()
const api = useApi()
const { fetchBlob, download } = useUpload()

const files = ref<Attachment[]>([])
const repos = ref<Repo[]>([])
const urls = reactive<Record<string, string>>({})
const logs = reactive<Record<string, { entries: (ConsoleEntry | NetworkEntry)[]; dropped: number }>>({})
const error = ref('')
/** Files whose bytes could not be fetched (a row placeholder each). */
const failed = reactive<Record<string, boolean>>({})
let unmounted = false
const removing = ref<Attachment | null>(null)
const removingName = ref('')
const reason = ref('')
const busy = ref(false)
const removeError = ref('')

const ordered = computed(() => orderAttachments(files.value))
const pageUrl = computed(() => safeHttpUrl(props.defect.page.url))
const build = computed(() => buildLine(props.defect.build))
const commit = computed(() => commitUrl(props.defect.build, repos.value))
const client = computed(() => {
  const c = props.defect.client
  return `${c.browser} ${c.browserVersion} · ${c.os} ${c.osVersion} · ${c.viewport.w}×${c.viewport.h} @${c.viewport.dpr}x`
})
const isImage = (a: Attachment) => a.role === 'screenshot' || a.role === 'screenshot_full'
const isVideo = (a: Attachment) => a.role === 'video' || a.role === 'buffer'
const isLog = (a: Attachment) => a.role === 'console' || a.role === 'network'
const mayRemove = (a: Attachment) => !a.purgedAt && (a.uploadedById === props.meId || props.canManage)

/** Fetches one file's bytes (once): images and logs on open, a video only when asked (it can be 25 MiB). */
async function loadFile(a: Attachment) {
  if (a.purgedAt || urls[a.id] || logs[a.id]) return
  delete failed[a.id]
  try {
    const blob = await fetchBlob(a.id)
    if (unmounted) return
    if (isLog(a)) logs[a.id] = parseLog(await blob.text(), a.role as 'console')
    else urls[a.id] = URL.createObjectURL(blob)
  } catch {
    if (!unmounted) failed[a.id] = true
  }
}

async function loadList() {
  try {
    files.value = (await api<Attachment[]>(`/projects/${props.projectId}/attachments`, { query: { workItemId: props.workItemId } })).filter((a) => a.role)
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function load() {
  await loadList()
  void Promise.all(files.value.filter((a) => !isVideo(a)).map(loadFile))
  // The commit link is a nicety: no repos (or no access) just shows the commit as text.
  repos.value = await api<Repo[]>(`/projects/${props.projectId}/repos`).catch(() => [])
}

const sizeMb = (a: Attachment) => (a.sizeBytes / 1024 / 1024).toFixed(1)

async function save(a: Attachment) {
  try {
    if (urls[a.id]) {
      const link = document.createElement('a')
      link.href = urls[a.id]!
      link.download = a.fileName
      link.click()
    } else await download(a.id, a.fileName)
  } catch {
    failed[a.id] = true
  }
}

function askRemove(a: Attachment) {
  reason.value = ''
  removeError.value = ''
  removingName.value = a.fileName
  removing.value = a
}

async function remove() {
  const a = removing.value
  if (!a || busy.value || !reason.value.trim()) return
  busy.value = true
  try {
    await api(`/attachments/${a.id}`, { method: 'DELETE', body: { reason: reason.value.trim() } })
    removing.value = null
    if (urls[a.id]) URL.revokeObjectURL(urls[a.id]!)
    delete urls[a.id]
    delete logs[a.id]
    await loadList()
  } catch (e) {
    removeError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

onMounted(load)
onBeforeUnmount(() => {
  unmounted = true
  for (const u of Object.values(urls)) URL.revokeObjectURL(u)
})
</script>

<template>
  <v-card class="defect mb-6" data-testid="defect-card">
    <div class="card-head">
      <h2 class="text-subtitle-1 ma-0">{{ t(defect.kind === 'bug_fix_request' ? 'defect.titleBugFix' : 'defect.title') }}</h2>
      <div class="d-flex flex-wrap ga-2 align-center">
        <StatusChip kind="severity" :value="defect.severity" size="x-small" data-testid="defect-severity" />
        <StatusChip v-if="defect.productionSite" kind="appUrl" value="production" size="x-small" data-testid="defect-production" />
        <span v-if="defect.sensitive" class="text-caption text-medium-emphasis d-inline-flex align-center ga-1" data-testid="defect-sensitive">
          <v-icon icon="mdi-shield-lock-outline" size="16" aria-hidden="true" />{{ t(defect.textMayContainPatientData ? 'defect.sensitive' : 'defect.projectNoAi') }}
        </span>
      </div>
    </div>
    <div class="card-body">
      <p v-if="defect.description" class="defect__text mb-4" data-testid="defect-description">{{ defect.description }}</p>
      <template v-if="defect.steps.length">
        <h3 class="text-subtitle-2 mb-1">{{ t('defect.steps') }}</h3>
        <ol class="defect__steps mb-4" data-testid="defect-steps">
          <li v-for="(s, i) in defect.steps" :key="i" class="defect__text">{{ s }}</li>
        </ol>
      </template>
      <div class="defect__pair mb-4">
        <div>
          <h3 class="text-subtitle-2 mb-1">{{ t('defect.expected') }}</h3>
          <p class="defect__text mb-0" data-testid="defect-expected">{{ defect.expected || '—' }}</p>
        </div>
        <div>
          <h3 class="text-subtitle-2 mb-1">{{ t('defect.actual') }}</h3>
          <p class="defect__text mb-0" data-testid="defect-actual">{{ defect.actual || '—' }}</p>
        </div>
      </div>

      <dl class="defect__facts mb-2">
        <dt>{{ t('defect.page') }}</dt>
        <dd data-testid="defect-page">
          <a v-if="pageUrl" :href="pageUrl" target="_blank" rel="noopener noreferrer" class="defect__mono">{{ defect.page.url }}</a>
          <span v-else class="defect__mono">{{ defect.page.url }}</span>
          <span v-if="defect.page.title" class="text-medium-emphasis"> · {{ defect.page.title }}</span>
        </dd>
        <dt>{{ t('defect.build') }}</dt>
        <dd data-testid="defect-build">
          <template v-if="build">
            <span class="defect__mono">{{ build }}</span>
            <a v-if="commit" :href="commit" target="_blank" rel="noopener noreferrer" class="ml-2" data-testid="defect-commit">{{ t('defect.openCommit') }}</a>
            <span class="text-caption text-medium-emphasis"> ({{ t(`defect.buildSource.${defect.build!.source}`) }})</span>
          </template>
          <span v-else class="text-medium-emphasis">{{ t('defect.noBuild') }}</span>
        </dd>
        <template v-if="defect.backendBuilds.length">
          <dt>{{ t('defect.backends') }}</dt>
          <dd>
            <div v-for="(b, i) in defect.backendBuilds" :key="i" class="defect__mono">{{ b.origin }} · {{ [b.repo, b.branch, b.commit].filter(Boolean).join(' · ') }}</div>
          </dd>
        </template>
        <dt>{{ t('defect.browser') }}</dt>
        <dd data-testid="defect-client">{{ client }}</dd>
        <dt>{{ t('defect.reported') }}</dt>
        <dd>{{ defect.reportedBy.displayName }} · {{ formatDateTime(defect.capturedAt, locale) }} · Yoda Reporter {{ defect.client.extensionVersion }}</dd>
      </dl>

      <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="my-3" data-testid="defect-error">{{ error }}</v-alert>
      <p v-if="!error && !files.length" class="text-body-2 text-medium-emphasis mt-3 mb-0" data-testid="defect-no-files">{{ t('defect.noFiles') }}</p>

      <div v-for="a in ordered" :key="a.id" class="defect__file" data-testid="defect-file" :data-role="a.role">
        <div class="defect__file-head">
          <span class="text-body-2 defect__file-name">{{ t(`defect.role.${a.role}`) }} · {{ a.fileName }}</span>
          <span class="d-flex ga-1">
            <v-btn v-if="!a.purgedAt" variant="text" size="small" icon="mdi-download" :aria-label="t('defect.download')" data-testid="defect-download" @click="save(a)" />
            <v-btn v-if="mayRemove(a)" variant="text" size="small" color="error" icon="mdi-delete-outline" :aria-label="t('defect.remove')" data-testid="defect-remove" @click="askRemove(a)" />
          </span>
        </div>
        <p v-if="a.purgedAt" class="defect__removed text-body-2 text-medium-emphasis" data-testid="defect-removed">{{ t('defect.removed', { when: formatDate(a.purgedAt, locale) }) }}</p>
        <img v-else-if="isImage(a) && urls[a.id]" :src="urls[a.id]" :alt="a.fileName" class="defect__image" />
        <p v-else-if="failed[a.id]" class="defect__removed text-body-2 text-medium-emphasis" data-testid="defect-file-failed">
          {{ t('defect.fileFailed') }} <v-btn variant="text" size="small" data-testid="defect-file-retry" @click="loadFile(a)">{{ t('defect.retry') }}</v-btn>
        </p>
        <video v-else-if="isVideo(a) && urls[a.id]" :src="urls[a.id]" controls class="defect__video" />
        <div v-else-if="isVideo(a)" class="defect__removed">
          <v-btn variant="tonal" prepend-icon="mdi-play-circle-outline" data-testid="defect-load-video" @click="loadFile(a)">{{ t('defect.loadVideo', { mb: sizeMb(a) }) }}</v-btn>
        </div>
        <div v-else-if="isLog(a) && logs[a.id]" class="defect__log" data-testid="defect-log">
          <table v-if="a.role === 'console'">
            <tbody>
              <tr v-for="(e, i) in (logs[a.id]!.entries as ConsoleEntry[])" :key="i" :class="`lvl-${e.level}`">
                <td class="defect__mono text-medium-emphasis">{{ e.level }}</td>
                <td class="defect__mono defect__msg">{{ e.message }}<span v-if="e.source" class="text-medium-emphasis"> ({{ e.source }})</span></td>
              </tr>
            </tbody>
          </table>
          <table v-else>
            <tbody>
              <tr v-for="(e, i) in (logs[a.id]!.entries as NetworkEntry[])" :key="i" :class="{ 'is-failed': e.failed }">
                <td class="defect__mono">{{ e.status ?? '—' }}</td>
                <td class="defect__mono">{{ e.method }}</td>
                <td class="defect__mono defect__msg">{{ e.url }}</td>
                <td class="defect__mono text-medium-emphasis">{{ Math.round(e.durationMs) }} ms</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!logs[a.id]!.entries.length" class="text-body-2 text-medium-emphasis ma-2">{{ t('defect.emptyLog') }}</p>
          <p v-if="logs[a.id]!.dropped" class="text-caption text-medium-emphasis ma-2">{{ t('defect.dropped', { n: logs[a.id]!.dropped }) }}</p>
        </div>
      </div>
      <p class="text-caption text-medium-emphasis mt-3 mb-0">{{ t('defect.filesNoAi') }}</p>
    </div>

    <ConfirmDialog
      :model-value="!!removing"
      :title="t('defect.removeTitle')"
      :text="t('defect.removeText', { name: removingName })"
      :confirm-label="t('defect.remove')"
      destructive
      :busy="busy"
      :disabled="!reason.trim()"
      :dirty="!!reason"
      :error="removeError"
      confirm-testid="defect-remove-ok"
      cancel-testid="defect-remove-keep"
      @update:model-value="(v) => { if (!v) removing = null }"
      @confirm="remove"
    >
      <v-text-field v-model="reason" class="mt-4" :label="t('defect.removeReason')" maxlength="500" data-testid="defect-remove-reason" />
    </ConfirmDialog>
  </v-card>
</template>

<style scoped>
.defect__text { white-space: pre-wrap; overflow-wrap: anywhere; }
.defect__steps { padding-left: 20px; margin: 0; }
.defect__pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.defect__facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: .875rem; }
.defect__facts dt { color: rgba(var(--v-theme-on-surface), .64); }
.defect__facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.defect__mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: .8125rem; overflow-wrap: anywhere; }
.defect__file { margin-top: 16px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; overflow: hidden; }
.defect__file-name { min-width: 0; overflow-wrap: anywhere; }
.defect__file-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 4px 4px 12px; background: rgb(var(--v-theme-surface-light)); }
.defect__image, .defect__video { display: block; max-width: 100%; max-height: 520px; margin: 0 auto; }
.defect__removed { padding: 12px; margin: 0; }
.defect__log { max-height: 320px; overflow: auto; }
.defect__log table { border-collapse: collapse; width: 100%; }
.defect__log td { padding: 2px 8px; vertical-align: top; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.defect__msg { white-space: pre-wrap; word-break: break-word; }
.lvl-error td, .lvl-exception td, .lvl-rejection td, .is-failed td { color: rgb(var(--v-theme-error)); }
.lvl-warn td { color: rgb(var(--v-theme-warning)); }
@media (max-width: 599px) {
  .defect__facts { grid-template-columns: 1fr; }
  .defect__facts dt { margin-top: 6px; }
}
</style>
