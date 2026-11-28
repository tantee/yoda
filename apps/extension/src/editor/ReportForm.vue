<script setup lang="ts">
import { DefectSeverity, ExtensionSession, severityPriority, type DefectReportCreated } from '@yoda/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { detectBuild } from '../capture/build'
import type { Draft } from '../drafts/db'
import { buildReport, type ReportForm } from '../report/build-report'
import { defaultDeps, sendReport } from '../report/send'
import { onConnectClick } from '../connect/connect'
import { getProfile, type Profile } from '../sw/store'
import ReviewPanel, { type ReviewFile } from './ReviewPanel.vue'

/** The report beside the screenshot: what happened, where, the build, the check before sending, and Send. */
const props = defineProps<{ draft: Draft; flatten: () => Promise<Blob | null>; save?: () => Promise<void> }>()
const emit = defineEmits<{ sent: [DefectReportCreated] }>()
const { t } = useI18n()

const profile = ref<Profile | null>(null)
const session = ref<ExtensionSession | null>(null)
const loadError = ref('')
const sending = ref(false)
const error = ref('')
const reconnect = ref(false)
const created = ref<DefectReportCreated | null>(null)

const detected = computed(() => (props.draft.metadata ? detectBuild({ ...props.draft.metadata.buildSources, gitlab: null }) : null))
const saved = (props.draft.form ?? {}) as Partial<ReportForm>
const form = ref<ReportForm>({
  projectId: saved.projectId ?? '',
  kind: saved.kind ?? 'defect',
  title: saved.title ?? '',
  severity: saved.severity ?? 'major',
  description: saved.description ?? '',
  steps: saved.steps?.length ? saved.steps : ['', '', ''],
  expected: saved.expected ?? '',
  actual: saved.actual ?? '',
  includeQuery: saved.includeQuery ?? true,
  attach: saved.attach ?? { screenshot: true, video: true, buffer: true, console: true, network: true },
  confirmedNoPatientData: false,
  textMayContainPatientData: saved.textMayContainPatientData ?? false,
  build: saved.build ?? null,
})
// The confirmation is never restored: it is ticked for this send, after looking at what goes.
watch(form, (f) => (props.draft.form = { ...f, confirmedNoPatientData: false }), { deep: true })

const project = computed(() => session.value?.projects.find((p) => p.id === form.value.projectId) ?? null)
// Set by the worker from the mapping rules when the report started (a production site: no video).
const production = computed(() => props.draft.production === true)
const severities = DefectSeverity.options
const buildText = ref(detected.value ? [detected.value.repo, detected.value.branch, detected.value.commit].filter(Boolean).join(' · ') : '')

const files = computed<ReviewFile[]>(() => {
  const out: ReviewFile[] = []
  const img = props.draft.images[0]
  if (img) out.push({ key: 'screenshot', label: t('review.screenshot'), bytes: img.blob.size })
  if (!production.value && props.draft.video) out.push({ key: 'video', label: t('review.video'), bytes: props.draft.video.size })
  if (props.draft.console.length) out.push({ key: 'console', label: t('review.console'), bytes: JSON.stringify(props.draft.console).length, detail: t('review.entries', { n: props.draft.console.length }) })
  if (props.draft.network.length) out.push({ key: 'network', label: t('review.network'), bytes: JSON.stringify(props.draft.network).length, detail: t('review.entries', { n: props.draft.network.length }) })
  return out
})

async function load() {
  profile.value = await getProfile(props.draft.profileId)
  if (!profile.value) {
    loadError.value = t('report.noProfile')
    return
  }
  if (profile.value.needsReconnect) reconnect.value = true
  const r = (await chrome.runtime.sendMessage({ type: 'session.get', profileId: props.draft.profileId })) as { ok: boolean; session?: unknown; error?: string }
  if (!r?.ok) {
    if (r?.error === 'reconnect') reconnect.value = true
    else loadError.value = t('report.sessionFailed')
    return
  }
  session.value = ExtensionSession.parse(r.session)
  if (!form.value.projectId || !project.value) form.value.projectId = session.value.projects[0]?.id ?? ''
}

function doReconnect() {
  if (!profile.value) return
  // From this click, before any await (permissions and the auth window need it).
  void onConnectClick(profile.value.url).then((r) => {
    if (r.ok) {
      reconnect.value = false
      error.value = ''
      void load()
    }
  })
}

/** Mosaic regions on the video that no apply has burned in yet: the video cannot go until they are (decision 1). */
const mosaicPending = computed(() => !production.value && form.value.attach.video && !!props.draft.video && !!props.draft.videoRegions?.length)
const canSend = computed(
  () => !!form.value.title.trim() && !!form.value.projectId && form.value.confirmedNoPatientData && !mosaicPending.value && !sending.value && !reconnect.value,
)

async function send() {
  if (!canSend.value) return
  sending.value = true
  error.value = ''
  try {
    await props.save?.()
    const image = await props.flatten()
    const edited = buildText.value.trim() && detected.value && buildText.value !== [detected.value.repo, detected.value.branch, detected.value.commit].filter(Boolean).join(' · ')
    const f: ReportForm = { ...form.value, build: edited || (buildText.value.trim() && !detected.value) ? { commit: buildText.value.trim() } : null }
    const { report, files: parts } = buildReport(props.draft, f, {
      production: production.value,
      extensionVersion: chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version,
      images: image ? [{ role: props.draft.images[0]!.role, blob: image }] : [],
    })
    const r = await sendReport(props.draft.id, report, parts, defaultDeps(props.draft.profileId))
    if (r.ok) {
      created.value = r.created
      emit('sent', r.created)
    } else if (r.error === 'reconnect') reconnect.value = true
    else error.value = errorText(r)
  } catch (e) {
    error.value = e instanceof Error && e.message === 'mosaic_not_applied' ? t('report.error.mosaicNotApplied') : e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

function errorText(r: { error: string; reason?: string; retryAfter?: number }): string {
  if (r.error === 'too_large') return t('report.error.tooLarge')
  if (r.error === 'unsupported_type') return t('report.error.type')
  if (r.reason === 'video_on_production') return t('report.error.videoOnProduction')
  if (r.error === 'rate_limited') return t('report.error.rateLimited', { s: r.retryAfter ?? 60 })
  if (r.error === 'network') return t('report.error.network')
  if (r.error === 'mosaic_not_applied') return t('report.error.mosaicNotApplied')
  return t('report.error.other')
}

onMounted(load)
</script>

<template>
  <div class="report pa-4" data-testid="report-form">
    <v-alert v-if="created" type="success" variant="tonal" class="mb-3" data-testid="report-sent">
      {{ t('report.sent') }}
      <a :href="created.url" target="_blank" rel="noopener" data-testid="report-link">{{ created.title }}</a>
    </v-alert>
    <template v-else>
      <v-alert v-if="reconnect" type="info" variant="tonal" class="mb-3" data-testid="report-reconnect">
        {{ t('report.reconnectText') }}
        <template #append><v-btn size="small" color="primary" variant="flat" data-testid="reconnect" @click="doReconnect">{{ t('connect.reconnect') }}</v-btn></template>
      </v-alert>
      <v-alert v-if="loadError" type="warning" variant="tonal" class="mb-3">{{ loadError }}</v-alert>
      <v-select
        v-model="form.projectId"
        :items="session?.projects ?? []"
        item-title="name"
        item-value="id"
        :label="t('report.project')"
        class="mb-2"
        data-testid="report-project"
      />
      <v-btn-toggle v-model="form.kind" mandatory density="compact" color="primary" class="mb-3" data-testid="report-kind">
        <v-btn value="defect" size="small" data-testid="kind-defect">{{ t('report.kind.defect') }}</v-btn>
        <v-btn value="bug_fix_request" size="small" data-testid="kind-bug_fix_request">{{ t('report.kind.bug_fix_request') }}</v-btn>
      </v-btn-toggle>
      <v-text-field v-model="form.title" :label="`${t('report.title')} *`" maxlength="200" class="mb-2" data-testid="report-title" />
      <div class="text-caption mb-1">{{ t('report.severity') }}</div>
      <v-chip-group v-model="form.severity" mandatory selected-class="text-primary" class="mb-1" data-testid="report-severity">
        <v-chip v-for="s in severities" :key="s" :value="s" filter :data-testid="`severity-${s}`">{{ t(`report.sev.${s}`) }}</v-chip>
      </v-chip-group>
      <p class="text-caption text-medium-emphasis mb-3">{{ t('report.priorityHint', { p: t(`report.priority.${severityPriority(form.severity)}`) }) }}</p>
      <div class="text-caption mb-1">{{ t('report.steps') }}</div>
      <v-text-field v-for="(_, i) in form.steps" :key="i" v-model="form.steps[i]" :prefix="`${i + 1}.`" maxlength="500" class="mb-1" :data-testid="`report-step-${i}`" />
      <v-btn v-if="form.steps.length < 30" size="small" variant="text" prepend-icon="mdi-plus" class="mb-2" data-testid="report-step-add" @click="form.steps.push('')">{{ t('report.addStep') }}</v-btn>
      <v-textarea v-model="form.expected" :label="t('report.expected')" rows="2" maxlength="2000" class="mb-2" data-testid="report-expected" />
      <v-textarea v-model="form.actual" :label="t('report.actual')" rows="2" maxlength="2000" class="mb-2" data-testid="report-actual" />
      <v-textarea v-model="form.description" :label="t('report.description')" rows="2" maxlength="10000" class="mb-3" data-testid="report-description" />

      <h3 class="text-subtitle-2 mb-1">{{ t('report.environment') }}</h3>
      <v-text-field v-model="buildText" :label="t('report.build')" :hint="detected ? t('report.buildSource', { s: t(`report.source.${detected.source}`) }) : t('report.buildNone')" persistent-hint class="mb-2" data-testid="report-build" />
      <div class="text-caption text-medium-emphasis report__page" data-testid="report-page">{{ draft.metadata?.page.url ?? draft.tabUrl }}</div>
      <v-switch v-model="form.includeQuery" :label="t('report.includeQuery')" hide-details class="mb-3" data-testid="report-include-query" />

      <ReviewPanel
        v-model:attach="form.attach"
        v-model:confirmed="form.confirmedNoPatientData"
        v-model:sensitive="form.textMayContainPatientData"
        :files="files"
        :no-ai="!!project?.noAi"
        :production="production"
      />
      <v-alert v-if="mosaicPending" type="warning" variant="tonal" density="compact" class="mt-3" data-testid="report-mosaic-pending">{{ t('report.error.mosaicNotApplied') }}</v-alert>
      <v-alert v-if="error" type="error" variant="tonal" class="mt-3" data-testid="report-error">{{ error }}</v-alert>
      <v-btn block color="primary" size="large" class="mt-4" :disabled="!canSend" :loading="sending" data-testid="report-send" @click="send">{{ t('report.send') }}</v-btn>
    </template>
  </div>
</template>

<style scoped>
.report__page { overflow-wrap: anywhere; }
</style>
