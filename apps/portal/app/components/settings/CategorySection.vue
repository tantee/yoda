<script setup lang="ts">
import type { GeneratedSecret, MasterKeyView, SettingCategory, SettingsCategoryView, SettingsPutResponse, SettingsTestResult, SettingWarning } from '@yoda/shared'
import {
  REAUTH_STASH_KEY,
  applyModes,
  applyReauthStash,
  boundSecretNotes,
  boundSecretsInEnv,
  changedFieldErrors,
  draftChanges,
  fieldLabelKey,
  initialDraft,
  parseReauthStash,
  rebaseDraft,
  reauthStash,
  replayChanges,
  secretBlocked,
  saveError,
  testValues,
  visibleSettings,
  type ReauthStash,
  type SectionDraft,
} from '~/utils/settings'
import type { SetupFetcher } from '~/utils/setup'
import ApplyHint from './ApplyHint.vue'
import CopyField from './CopyField.vue'
import ReauthDialog from './ReauthDialog.vue'
import SecretField from './SecretField.vue'
import SettingField from './SettingField.vue'
import TestResult from './TestResult.vue'

/**
 * One settings category as a card (proposal §5.2): its fields drawn from the registry, the apply hints, a test
 * button that runs on the unsaved form, and a partial save with the loaded versions. A save that needs a recent
 * sign-in explains why and goes through Keycloak (ReauthDialog), then saves again on return; a stale version asks
 * for a reload. Slots: `head` (beside the hints), `before` (above the form), `after` (under the fields).
 */
const props = defineProps<{
  category: SettingCategory
  view: SettingsCategoryView
  title: string
  icon: string
  /** Webhook secrets core can generate (shown once). */
  generate?: string[]
  /** Email: also send a test message to the admin's own address. */
  sendTest?: boolean
  /** Secrets cannot be saved while the master key is not usable. */
  keyStatus?: MasterKeyView['status'] | null
  /**
   * The setup wizard's cookie-session client (`/api/setup`) and its settings path; the admin pages use the
   * Keycloak-backed `useApi` and `/admin/settings`. The setup session stands in for a recent sign-in.
   */
  client?: SetupFetcher
  basePath?: string
}>()
const emit = defineEmits<{ saved: [res: SettingsPutResponse | null]; generated: []; dirty: [dirty: boolean]; reload: []; tested: [result: SettingsTestResult] }>()
const { t } = useI18n()
const api = (props.client ?? useApi()) as SetupFetcher
const base = props.basePath ?? '/admin/settings'
const route = useRoute()

const views = computed(() => visibleSettings(props.category, props.view.settings))
const draft = ref<SectionDraft>(initialDraft(views.value))
const serverErrors = ref<Record<string, string>>({})
// After a save or a reload the form starts again from the server; after a partial reload (a generated secret)
// the admin's other unsaved edits are kept.
let resetOnNextView = false
watch(() => props.view, (next, prev) => {
  const nextViews = visibleSettings(props.category, next.settings)
  if (resetOnNextView || !prev) draft.value = initialDraft(nextViews)
  else draft.value = rebaseDraft(visibleSettings(props.category, prev.settings), draft.value, nextViews)
  resetOnNextView = false
  serverErrors.value = {}
  replay.value = null
})
onBeforeUnmount(() => emit('dirty', false))

const changes = computed(() => draftChanges(views.value, draft.value))
const dirty = computed(() => Object.keys(changes.value.changes).length)
watch(dirty, n => emit('dirty', n > 0), { immediate: true })
const modes = computed(() => applyModes(views.value))
const editable = computed(() => views.value.some(v => !v.locked))
const label = (key: string) => t(fieldLabelKey(key))
const notes = computed(() => {
  const out: Record<string, string> = {}
  for (const [k, secrets] of Object.entries(boundSecretNotes(views.value, draft.value))) out[k] = t('settings.boundNote', { secrets: secrets.map(label).join(', ') })
  for (const [k, b] of Object.entries(boundSecretsInEnv(views.value, draft.value))) out[k] = t('settings.save.boundInEnv', { name: label(k), env: b.envName ?? '' })
  return out
})
const clientErrors = computed(() =>
  Object.fromEntries(Object.entries(changedFieldErrors(views.value, draft.value)).map(([k, m]) => [k, t('settings.save.invalidField', { message: m })])),
)
const hasClientErrors = computed(() => Object.keys(clientErrors.value).length > 0)
const errorOf = (key: string) => serverErrors.value[key] ?? clientErrors.value[key] ?? null

type Notice = { type: 'success' | 'error' | 'info' | 'warning'; text: string; conflict?: boolean }
const notice = ref<Notice | null>(null)
const warnings = ref<string[]>([])
const saving = ref(false)
const reauthOpen = ref(false)
const stash = ref<ReauthStash | null>(null)
/** Back from re-authentication: the versions the form had before the redirect (sent with the replayed save). */
const replay = ref<ReauthStash | null>(null)

function warningText(w: SettingWarning): string {
  if (w.code === 'embedding_model_changed') return t('settings.warning.embedding_model_changed', { count: w.count ?? 0 })
  if (w.code === 'unpriced_model') return t('settings.warning.unpriced_model', { name: label(w.key) })
  return t('settings.warning.other', { code: w.code })
}

function handleError(e: unknown, action: ReauthStash['action']) {
  const err = saveError(e)
  switch (err.kind) {
    case 'reauth':
      stash.value = reauthStash(props.category, route.path, views.value, draft.value, action)
      reauthOpen.value = true
      return
    case 'conflict':
      notice.value = { type: 'warning', text: t('settings.save.conflict', { name: err.key ? label(err.key) : '' }), conflict: true }
      return
    case 'locked':
      notice.value = { type: 'error', text: t(err.reason === 'bound_secret_in_env' ? 'settings.save.boundInEnv' : 'settings.save.locked', { name: err.key ? label(err.key) : '', env: err.envName ?? '' }) }
      return
    case 'invalid':
      serverErrors.value = Object.fromEntries(err.issues.map(i => [i.key, t('settings.save.invalidField', { message: i.message })]))
      notice.value = { type: 'error', text: t('settings.save.invalid') }
      return
    case 'rateLimited':
      notice.value = { type: 'error', text: t('settings.save.rateLimited', { s: err.retryAfter ?? 60 }) }
      return
    case 'secretsUnavailable':
      notice.value = { type: 'error', text: t('settings.save.secretsUnavailable') }
      return
    default:
      notice.value = { type: 'error', text: t(errorKey(e)) }
  }
}

async function save() {
  if (!dirty.value || hasClientErrors.value || saving.value) return
  saving.value = true
  notice.value = null
  warnings.value = []
  serverErrors.value = {}
  try {
    const res = await api<SettingsPutResponse>(`${base}/${props.category}`, { method: 'PUT', body: replayChanges(changes.value, replay.value) })
    replay.value = null
    notice.value = { type: 'success', text: t('settings.save.saved') }
    resetOnNextView = true
    warnings.value = [
      ...(res.cleared.length ? [t('settings.save.cleared', { secrets: res.cleared.map(label).join(', ') })] : []),
      ...res.warnings.map(warningText),
    ]
    emit('saved', res)
  } catch (e) {
    handleError(e, 'save')
  } finally {
    saving.value = false
  }
}

function reset() {
  replay.value = null
  draft.value = initialDraft(views.value)
  serverErrors.value = {}
  notice.value = null
}

// Tests run against the unsaved form (§5.2).
const testing = ref<'' | 'run' | 'self'>('')
const result = ref<SettingsTestResult | null>(null)
const testedDraft = ref(false)
const testError = ref('')
async function runTest(sendTo?: 'self') {
  testing.value = sendTo ?? 'run'
  result.value = null
  testError.value = ''
  testedDraft.value = dirty.value > 0
  try {
    result.value = await api<SettingsTestResult>(`${base}/${props.category}/test`, {
      method: 'POST',
      body: { values: testValues(views.value, draft.value), ...(sendTo ? { sendTo } : {}) },
    })
    emit('tested', result.value)
  } catch (e) {
    const err = saveError(e)
    if (err.kind === 'invalid') {
      serverErrors.value = Object.fromEntries(err.issues.map(i => [i.key, t('settings.save.invalidField', { message: i.message })]))
      testError.value = t('settings.save.invalid')
    } else if (err.kind === 'rateLimited') testError.value = t('settings.save.rateLimited', { s: err.retryAfter ?? 60 })
    else testError.value = t(errorKey(e))
  } finally {
    testing.value = ''
  }
}

// Generated webhook secrets are shown once, then dropped from memory when the dialog closes.
const generating = ref('')
const generated = ref<GeneratedSecret | null>(null)
async function generateSecret(key: string) {
  const v = views.value.find(x => x.key === key)
  if (!v) return
  generating.value = key
  notice.value = null
  try {
    const r = await api<GeneratedSecret & { webhook?: SettingsTestResult }>(`${base}/${props.category}/generate/${key}`, { method: 'POST', body: { version: v.version } })
    generated.value = { key: r.key, value: r.value, version: r.version }
    if (r.webhook) result.value = r.webhook
    emit('generated')
  } catch (e) {
    handleError(e, 'generate')
  } finally {
    generating.value = ''
  }
}
const generatedOpen = computed({ get: () => !!generated.value, set: (v) => { if (!v) generated.value = null } })

// Back from the re-authentication redirect: restore the form, then save again when no secret needs retyping.
// A stash that is too old, from another page or unreadable is dropped without saving.
const AGAIN: Record<ReauthStash['action'], string> = { save: 'settings.reauth.again', generate: 'settings.reauth.againGenerate', webhook: 'settings.reauth.againWebhook' }
onMounted(async () => {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(REAUTH_STASH_KEY)
  } catch {
    return
  }
  if (!raw) return
  const s = parseReauthStash(raw, route.path)
  // A valid stash for another card on this page is left to that card; an invalid one is dropped by any card.
  if (s && s.category !== props.category) return
  try {
    sessionStorage.removeItem(REAUTH_STASH_KEY)
  } catch {
    // nothing kept
  }
  if (!s) return
  draft.value = applyReauthStash(views.value, s)
  replay.value = s
  if (s.action === 'save' && !s.secretsToRetype.length && dirty.value > 0) {
    await save()
    return
  }
  notice.value = {
    type: 'info',
    text: s.secretsToRetype.length ? t('settings.reauth.retypeNow', { secrets: s.secretsToRetype.map(label).join(', ') }) : t(AGAIN[s.action] ?? AGAIN.save),
  }
})
</script>

<template>
  <v-card class="settings-section" :data-testid="`settings-section-${category}`">
    <div class="card-head">
      <h2 class="d-flex align-center ga-2"><v-icon :icon="icon" size="20" aria-hidden="true" />{{ title }}</h2>
      <div class="d-flex align-center flex-wrap ga-3">
        <ApplyHint v-for="m in modes" :key="m" :mode="m" />
        <slot name="head" />
      </div>
    </div>
    <slot name="before" />
    <div class="card-body">
      <div v-if="views.length" class="settings-grid">
        <template v-for="v in views" :key="v.key">
          <SecretField
            v-if="v.secret"
            v-model="draft.secrets[v.key]!"
            :view="v"
            :error="errorOf(v.key)"
            :generatable="props.generate?.includes(v.key)"
            :busy="generating === v.key"
            :key-blocked="secretBlocked(v, keyStatus)"
            @generate="generateSecret(v.key)"
          />
          <SettingField v-else v-model="draft.values[v.key]!" :view="v" :error="errorOf(v.key)" :note="notes[v.key]" />
        </template>
      </div>
      <slot name="after" />

      <div v-if="view.test" class="settings-test" data-testid="settings-test">
        <div class="d-flex flex-wrap align-center ga-2">
          <v-btn variant="tonal" color="primary" prepend-icon="mdi-connection" :loading="testing === 'run'" :disabled="!!testing" :data-testid="`test-${category}`" @click="runTest()">{{ t('settings.test.run') }}</v-btn>
          <v-btn v-if="sendTest" variant="tonal" color="primary" prepend-icon="mdi-send-outline" :loading="testing === 'self'" :disabled="!!testing" :data-testid="`test-${category}-self`" @click="runTest('self')">{{ t('settings.test.sendSelf') }}</v-btn>
          <span v-if="dirty" class="text-caption text-medium-emphasis">{{ t('settings.test.draftHint') }}</span>
        </div>
        <TestResult v-if="result" :result="result" :draft="testedDraft" class="mt-3" />
        <v-alert v-if="testError" type="error" variant="tonal" density="compact" class="mt-3" data-testid="test-error">{{ testError }}</v-alert>
      </div>

      <v-alert v-if="notice" :type="notice.type" variant="tonal" density="compact" class="mt-4" :role="notice.type === 'error' ? 'alert' : 'status'" data-testid="settings-notice">
        {{ notice.text }}
        <template v-if="notice.conflict" #append>
          <v-btn size="small" variant="outlined" data-testid="settings-reload" @click="resetOnNextView = true; emit('reload')">{{ t('settings.save.reload') }}</v-btn>
        </template>
      </v-alert>
      <v-alert v-for="w in warnings" :key="w" type="warning" variant="tonal" density="compact" class="mt-2" data-testid="settings-warning">{{ w }}</v-alert>

      <div v-if="editable" class="settings-save">
        <span class="text-caption text-medium-emphasis" data-testid="settings-dirty">{{ dirty ? t('settings.save.dirty', { n: dirty }) : '' }}</span>
        <v-spacer />
        <v-btn variant="outlined" :disabled="!dirty || saving" :data-testid="`cancel-${category}`" @click="reset">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="saving" :disabled="!dirty || hasClientErrors" :data-testid="`save-${category}`" @click="save">{{ t('common.save') }}</v-btn>
      </div>
    </div>

    <ReauthDialog v-model="reauthOpen" :stash="stash" />
    <AppDialog v-model="generatedOpen" :title="t('settings.secret.generatedTitle')" size="form" data-testid="generated-dialog">
      <template v-if="generated">
        <v-alert type="warning" variant="tonal" density="compact" class="mb-3">{{ t('settings.secret.generatedOnce') }}</v-alert>
        <CopyField :label="label(generated.key)" :value="generated.value" testid="generated-value" />
      </template>
      <template #actions>
        <v-btn color="primary" variant="flat" data-testid="generated-done" @click="generatedOpen = false">{{ t('settings.secret.generatedDone') }}</v-btn>
      </template>
    </AppDialog>
  </v-card>
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 20px 24px; align-items: start; }
.settings-test { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.settings-save { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 20px; }
</style>
