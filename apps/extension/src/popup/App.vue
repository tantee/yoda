<script setup lang="ts">
import { ExtensionSession } from '@yoda/shared'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onConnectClick } from '../connect/connect'
import { checkVersion } from '../sw/api'
import { profiles as loadProfiles, type Profile } from '../sw/store'
import { saveLocale, type Locale } from '../i18n'
import { onRecordClick } from './record'
import { resolveTargetTab } from './target'

/** The toolbar popup (mockup extension-popup.html): which Yoda and project, capture, and the report actions. */
const { t, locale } = useI18n()
const list = ref<Profile[]>([])
const profileId = ref<string | null>(null)
const session = ref<ExtensionSession | null>(null)
const projectId = ref<string | null>(null)
const tabId = ref<number | null>(null)
const tabUrl = ref('')
const capture = ref<{ state: string; stoppedReason?: string; stoppedAt?: number } | null>(null)
const counts = ref<{ console: number; errors: number; failedRequests: number } | null>(null)
const attach = ref({ console: true, network: true })
const busy = ref('')
const error = ref('')
const reachable = ref(true)
/** The mapping for this page (sw/rules.ts): the profile and project it picks, and whether it is production. */
const resolved = ref<{ production: boolean; profileId: string | null; projectId: string | null; via: 'rule' | 'repo' | null } | null>(null)
const production = computed(() => resolved.value?.production === true)
/** A clip in progress (the offscreen document records it; the worker keeps the job). */
const clip = ref<{ tabId: number; startedAt: number } | null>(null)
const now = ref(Date.now())
const maxSeconds = computed(() => session.value?.limits.maxVideoSeconds ?? 30)

const profile = computed(() => list.value.find((p) => p.id === profileId.value) ?? null)
const version = computed(() => (session.value ? checkVersion(session.value, chrome.runtime.getManifest().version_name ?? '0.0.0') : 'ok'))
const webPage = computed(() => /^https?:/i.test(tabUrl.value))

async function load() {
  list.value = await loadProfiles()
  const saved = (await chrome.storage.local.get(['popup.profile', 'popup.attach']))
  profileId.value = (list.value.find((p) => p.id === saved['popup.profile']) ?? list.value.find((p) => p.isDefault) ?? list.value[0])?.id ?? null
  if (saved['popup.attach']) attach.value = saved['popup.attach'] as typeof attach.value
  tabId.value = await resolveTargetTab(location.search, async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]!)
  try {
    tabUrl.value = (await chrome.tabs.get(tabId.value)).url ?? ''
  } catch {
    tabUrl.value = ''
  }
  if (webPage.value) {
    // Opening the popup refreshes the Yoda mappings (their ttl otherwise).
    const r = (await chrome.runtime.sendMessage({ type: 'mapping.resolve', tabId: tabId.value, refresh: true })) as { ok: boolean; resolved?: typeof resolved.value }
    resolved.value = r?.ok ? (r.resolved ?? null) : null
    const mapped = list.value.find((p) => p.id === resolved.value?.profileId)
    if (mapped) profileId.value = mapped.id
    // On production, logs go only when the tester turns them on for this report.
    if (production.value) attach.value = { console: false, network: false }
  }
  await Promise.all([loadSession(), refreshCapture(), refreshClip()])
}

async function refreshClip() {
  const r = (await chrome.runtime.sendMessage({ type: 'video.state' })) as { ok: boolean; clip?: typeof clip.value }
  clip.value = r?.clip ?? null
  if (clip.value) setInterval(() => (now.value = Date.now()), 500)
}

function record() {
  if (tabId.value === null || !profile.value) return
  const message = { type: 'video.start', tabId: tabId.value, profileId: profile.value.id, projectId: projectId.value ?? undefined, attach: attach.value, maxSeconds: maxSeconds.value }
  busy.value = 'record'
  error.value = ''
  // No await before this call: the tabCapture request needs the click.
  void onRecordClick(() => chrome.runtime.sendMessage(message) as Promise<{ ok: boolean; error?: string }>).then((r) => {
    busy.value = ''
    if (r?.ok) window.close()
    else error.value = t(`popup.error.${['permission_needed', 'production', 'busy'].includes(r?.error ?? '') ? r!.error : 'capture_failed'}`)
  })
}

async function stopRecording() {
  busy.value = 'stop'
  await chrome.runtime.sendMessage({ type: 'video.stop' })
  busy.value = ''
  window.close()
}

async function loadSession() {
  session.value = null
  error.value = ''
  if (!profile.value || profile.value.needsReconnect) return
  const r = (await chrome.runtime.sendMessage({ type: 'session.get', profileId: profile.value.id })) as { ok: boolean; session?: unknown; error?: string }
  reachable.value = !!r?.ok
  if (!r?.ok) {
    if (r?.error === 'reconnect') list.value = await loadProfiles()
    return
  }
  session.value = ExtensionSession.parse(r.session)
  const last = (await chrome.storage.local.get(`popup.project.${profile.value.id}`))[`popup.project.${profile.value.id}`] as string | undefined
  const mappedProject = resolved.value?.profileId === profile.value.id ? resolved.value.projectId : null
  projectId.value = session.value.projects.find((p) => p.id === mappedProject)?.id ?? session.value.projects.find((p) => p.id === last)?.id ?? session.value.projects[0]?.id ?? null
}

async function refreshCapture() {
  if (tabId.value === null) return
  const r = (await chrome.runtime.sendMessage({ type: 'capture.state', tabId: tabId.value })) as { ok: boolean; state?: typeof capture.value; counts?: typeof counts.value }
  capture.value = r?.state ?? null
  counts.value = r?.counts ?? null
}

watch(profileId, (id) => {
  if (id) void chrome.storage.local.set({ 'popup.profile': id })
})
watch(projectId, (id) => {
  if (id && profile.value) void chrome.storage.local.set({ [`popup.project.${profile.value.id}`]: id })
})
// The production default (logs off) is not remembered as the tester's choice.
watch(attach, (a) => !production.value && void chrome.storage.local.set({ 'popup.attach': a }), { deep: true })

async function arm() {
  if (tabId.value === null) return
  busy.value = 'arm'
  error.value = ''
  const r = (await chrome.runtime.sendMessage({ type: 'capture.arm', tabId: tabId.value })) as { ok: boolean; error?: string }
  busy.value = ''
  if (!r?.ok) error.value = t('popup.error.arm')
  await refreshCapture()
}

async function start(type: 'capture.screenshot' | 'capture.fullPage' | 'capture.textOnly') {
  if (tabId.value === null || !profile.value) return
  busy.value = type
  error.value = ''
  const r = (await chrome.runtime.sendMessage({ type, tabId: tabId.value, profileId: profile.value.id, projectId: projectId.value ?? undefined, attach: attach.value })) as { ok: boolean; error?: string }
  busy.value = ''
  if (r?.ok) window.close()
  else error.value = t(r?.error === 'tab_changed' ? 'popup.error.tabChanged' : 'popup.error.capture')
}

function reconnect() {
  if (!profile.value) return
  // This click carries the user activation the permission and auth window need: nothing is awaited before it.
  void onConnectClick(profile.value.url).then(async (r) => {
    list.value = await loadProfiles()
    if (r.ok) await loadSession()
  })
}

function openOptions() {
  void chrome.runtime.openOptionsPage()
}

async function switchLocale(value: string) {
  const l: Locale = value === 'en' ? 'en' : 'th'
  locale.value = l
  await saveLocale(l)
}

onMounted(load)
</script>

<template>
  <v-app>
    <v-main>
      <div class="popup" data-testid="popup">
        <header class="popup__head">
          <img src="/icons/32.png" width="24" height="24" alt="" />
          <span class="popup__name">{{ t('app.name') }}</span>
          <v-spacer />
          <v-btn-toggle :model-value="locale" density="compact" mandatory variant="text" @update:model-value="switchLocale">
            <v-btn value="th" size="x-small" data-testid="lang-th">ไทย</v-btn>
            <v-btn value="en" size="x-small" data-testid="lang-en">EN</v-btn>
          </v-btn-toggle>
        </header>

        <div v-if="!list.length" class="pa-4" data-testid="popup-empty">
          <p class="text-body-2 mb-3">{{ t('popup.notConnected') }}</p>
          <v-btn color="primary" block data-testid="popup-connect" @click="openOptions">{{ t('connect.submit') }}</v-btn>
        </div>

        <template v-else-if="profile">
          <div class="popup__section">
            <v-select v-if="list.length > 1" v-model="profileId" :items="list" item-title="name" item-value="id" :label="t('popup.yoda')" hide-details data-testid="popup-profile" @update:model-value="loadSession" />
            <div v-else class="popup__profile" data-testid="popup-profile">
              <span class="popup__dot" :style="{ background: profile.colour }" />
              <span class="text-body-2">{{ profile.name }}</span>
              <span v-if="profile.person" class="text-caption text-medium-emphasis">· {{ profile.person.displayName }}</span>
            </div>
          </div>

          <v-alert v-if="profile.needsReconnect" type="info" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-reconnect-needed">
            {{ t('popup.reconnectText') }}
            <template #append><v-btn size="small" color="primary" variant="flat" data-testid="reconnect" @click="reconnect">{{ t('connect.reconnect') }}</v-btn></template>
          </v-alert>
          <v-alert v-else-if="!reachable" type="warning" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-unreachable">{{ t('popup.unreachable') }}</v-alert>
          <v-alert v-if="version === 'update_available'" type="info" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-update">{{ t('popup.update', { v: session?.latestExtension?.version ?? '' }) }}</v-alert>
          <v-alert v-if="version === 'api_too_new'" type="error" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-too-old">{{ t('popup.tooOld') }}</v-alert>

          <v-alert v-if="production" type="error" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-production">{{ t('review.production') }}</v-alert>

          <div class="popup__section">
            <v-select v-model="projectId" :items="session?.projects ?? []" item-title="name" item-value="id" :label="t('report.project')" hide-details :disabled="!session" data-testid="popup-project" />
          </div>

          <div v-if="clip" class="popup__section text-caption" data-testid="popup-recording">
            <v-icon icon="mdi-record" color="error" size="14" /> {{ t('popup.recording', { s: Math.min(maxSeconds, Math.floor((now - clip.startedAt) / 1000)) }) }}
          </div>
          <div class="popup__section text-caption" data-testid="popup-capture">
            <template v-if="!webPage">{{ t('popup.notWebPage') }}</template>
            <template v-else-if="capture?.state === 'armed'">
              <v-icon icon="mdi-record-circle" color="error" size="14" /> {{ t('popup.armed') }}
              <span v-if="counts" data-testid="popup-counts">· {{ t('popup.counts', { e: counts.errors, n: counts.failedRequests }) }}</span>
            </template>
            <template v-else-if="capture?.state === 'stopped'">{{ t('popup.stopped', { reason: t(`popup.stoppedReason.${capture.stoppedReason}`) }) }}</template>
            <template v-else>{{ t('popup.notArmed') }}</template>
          </div>

          <div class="popup__actions">
            <v-btn color="primary" prepend-icon="mdi-camera-outline" :disabled="!webPage || !session" :loading="busy === 'capture.screenshot'" data-testid="action-screenshot" @click="start('capture.screenshot')">{{ t('popup.screenshot') }}</v-btn>
            <v-btn variant="tonal" prepend-icon="mdi-arrow-expand-vertical" :disabled="!webPage || !session" :loading="busy === 'capture.fullPage'" data-testid="action-fullpage" @click="start('capture.fullPage')">{{ t('popup.fullPage') }}</v-btn>
            <v-btn variant="tonal" prepend-icon="mdi-record-rec" :disabled="!webPage || capture?.state === 'armed'" :loading="busy === 'arm'" data-testid="action-arm" @click="arm">{{ t('popup.arm') }}</v-btn>
            <v-btn v-if="clip" color="error" prepend-icon="mdi-stop" :loading="busy === 'stop'" data-testid="action-stop" @click="stopRecording">{{ t('popup.stopRecording') }}</v-btn>
            <v-btn v-else-if="!production" variant="tonal" prepend-icon="mdi-video-outline" :disabled="!webPage || !session" :loading="busy === 'record'" data-testid="action-record" @click="record">{{ t('popup.record', { s: maxSeconds }) }}</v-btn>
            <v-btn variant="text" prepend-icon="mdi-text" :disabled="!session" :loading="busy === 'capture.textOnly'" data-testid="action-text" @click="start('capture.textOnly')">{{ t('popup.textOnly') }}</v-btn>
          </div>

          <div class="popup__section">
            <v-switch v-model="attach.console" :label="t('popup.attachConsole')" hide-details density="compact" data-testid="popup-attach-console" />
            <v-switch v-model="attach.network" :label="t('popup.attachNetwork')" hide-details density="compact" data-testid="popup-attach-network" />
          </div>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mx-3 mb-2" data-testid="popup-error">{{ error }}</v-alert>
          <div class="popup__foot">
            <v-btn variant="text" size="small" prepend-icon="mdi-cog-outline" data-testid="popup-options" @click="openOptions">{{ t('popup.settings') }}</v-btn>
          </div>
        </template>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.popup { width: 360px; }
.popup__head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.popup__name { font-weight: 600; }
.popup__section { padding: 8px 12px; }
.popup__profile { display: flex; align-items: center; gap: 6px; }
.popup__dot { width: 10px; height: 10px; border-radius: 50%; }
.popup__actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 12px; }
.popup__foot { display: flex; justify-content: flex-end; padding: 4px 8px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
