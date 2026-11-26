<script setup lang="ts">
import type { AdminSettingsResponse, LocalSession, RecoveryKit, SettingCategory, SettingsCategoryView, SetupClaimResult, SetupProgress, SetupStatus, SetupStepId } from '@yoda/shared'
import StepAdmin from '~/components/setup/StepAdmin.vue'
import StepCheck from '~/components/setup/StepCheck.vue'
import StepClaim from '~/components/setup/StepClaim.vue'
import StepKit from '~/components/setup/StepKit.vue'
import StepOrganisation from '~/components/setup/StepOrganisation.vue'
import StepSettings from '~/components/setup/StepSettings.vue'
import StepSignin from '~/components/setup/StepSignin.vue'
import StepToken from '~/components/setup/StepToken.vue'
import { oidcCallback, oidcCallbackError } from '~/utils/recovery'
import {
  currentStep,
  nextStep,
  prevStep,
  setupClient,
  setupError,
  setupFinished,
  setupSessionLost,
  stepList,
  wizardProgress,
} from '~/utils/setup'

/**
 * /setup, the first-run wizard (installer proposal §4, mockups `installer-token.html`, `installer-organisation.html`,
 * `installer-oidc.html`). Outside the default layout and without Keycloak (the boot plugin never starts it here):
 * the page talks to core with the `yoda_setup` cookie and the CSRF header only. Progress lives in core, so a
 * reload (or a new token after a restart) resumes; the step shown is in the URL (`?step=`), never a secret.
 * Opens in Thai (D11) with a switch to English.
 */
definePageMeta({ layout: false })

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { dateTime } = useDateFormat()

const status = ref<SetupStatus | null>(null)
const session = ref<LocalSession | null>(null)
const progress = ref<SetupProgress | null>(null)
const settings = ref<AdminSettingsResponse | null>(null)
const loading = ref(true)
const error = ref('')
const welcome = ref(false)
const claimResult = ref<SetupClaimResult | null>(null)
const callbackBusy = ref(false)
/** The recovery kit, once downloaded: kept in memory only (never browser storage), so Back and Next keep it. */
const kit = ref<RecoveryKit | null>(null)
const api = setupClient((url, opts) => $fetch(url, opts), () => session.value?.csrf ?? null)

const origin = typeof window === 'undefined' ? '' : window.location.origin
const step = computed<SetupStepId>(() => (session.value ? currentStep(progress.value, route.query.step) : 'token'))
const steps = computed(() => stepList(progress.value, step.value))
const bar = computed(() => wizardProgress(step.value))
const viewOf = (c: SettingCategory): SettingsCategoryView | null => settings.value?.categories.find(x => x.category === c) ?? null
const views = computed(() => settings.value?.categories ?? [])
const publicUrl = computed(() => {
  const v = viewOf('general')?.settings.find(s => s.key === 'org.publicUrl')
  return v && v.source !== 'default' && typeof v.value === 'string' ? v.value : (status.value?.detectedUrl ?? origin)
})
const installId = computed(() => progress.value?.installId ?? '')
const shortId = computed(() => (installId.value ? `${installId.value.slice(0, 4)}…${installId.value.slice(-4)}` : ''))
const OPTIONAL: Partial<Record<SetupStepId, SettingCategory[]>> = { email: ['email'], line: ['line'], telegram: ['telegram'], more: ['gitlab', 'ai', 'backups'] }

function fail(e: unknown) {
  if (setupFinished(e)) {
    window.location.assign('/')
    return
  }
  if (setupSessionLost(e)) {
    session.value = null
    progress.value = null
  }
  const m = setupError(e)
  error.value = t(m.key, m.named ?? {})
}

async function loadProgress() {
  progress.value = await api<SetupProgress>('/progress')
}

async function loadSettings() {
  settings.value = await api<AdminSettingsResponse>('/settings')
}

async function load() {
  try {
    await Promise.all([loadProgress(), loadSettings()])
  } catch (e) {
    fail(e)
  }
}

function go(s: SetupStepId | null) {
  if (!s) return
  error.value = ''
  void router.replace({ path: '/setup', query: { step: s } })
  if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
}

async function onSession(s: LocalSession) {
  session.value = s
  welcome.value = true
  await load()
  go(currentStep(progress.value, null))
}

/** The admin step rotates the session (8.3): use the new CSRF token from now on. */
async function onRotated(s: LocalSession) {
  session.value = s
}

async function afterChange(view?: SettingsCategoryView) {
  if (view && settings.value) settings.value = { ...settings.value, categories: settings.value.categories.map(c => (c.category === view.category ? view : c)) }
  try {
    await (view ? loadProgress() : load())
  } catch (e) {
    fail(e)
  }
}

async function mark(s: SetupStepId, state: 'done' | 'skipped') {
  error.value = ''
  try {
    progress.value = await api<SetupProgress>('/progress/step', { method: 'POST', body: { step: s, state } })
    go(nextStep(s))
  } catch (e) {
    fail(e)
  }
}

async function advance(after: () => Promise<void> = loadProgress) {
  try {
    await after()
    go(nextStep(step.value))
  } catch (e) {
    fail(e)
  }
}

/** Back from Keycloak at the claim step: hand the code to core, then drop it from the address bar. */
async function finishCallback() {
  const cb = oidcCallback(route.query)
  const providerError = oidcCallbackError(route.query)
  if (!cb && !providerError) return
  await router.replace({ path: '/setup', query: { step: 'claim' } })
  if (providerError) {
    error.value = t('setup.claim.providerError')
    return
  }
  if (!session.value) return
  callbackBusy.value = true
  try {
    claimResult.value = await api<SetupClaimResult>('/claim/callback', { method: 'POST', body: cb })
    await loadProgress()
  } catch (e) {
    fail(e)
  } finally {
    callbackBusy.value = false
  }
}

function finished() {
  // A full load: the boot plugin reads /public-config again (setup is done) and starts Keycloak.
  window.location.assign('/')
}

onMounted(async () => {
  try {
    status.value = await api<SetupStatus>('/status')
  } catch (e) {
    if (setupFinished(e)) {
      window.location.assign('/')
      return
    }
    fail(e)
  }
  if (status.value?.session) {
    try {
      session.value = await api<LocalSession>('/session')
      await load()
    } catch (e) {
      fail(e)
    }
  }
  loading.value = false
  await finishCallback()
})

function switchLocale(l: 'th' | 'en') {
  locale.value = l
}
</script>

<template>
  <v-main class="wz">
    <header class="wz-band">
      <AppMark :size="32" :fun="false" />
      <div class="wz-band__brand">
        <div class="wz-band__name">{{ t('setup.title') }}</div>
        <div class="wz-band__sub">{{ t('setup.subtitle') }}</div>
      </div>
      <v-spacer />
      <span v-if="shortId" class="wz-band__id d-none d-sm-inline" :title="installId" data-testid="setup-install-id">{{ t('setup.installId', { id: shortId }) }}</span>
      <div class="wz-lang" role="group" :aria-label="t('setup.language')">
        <button type="button" :class="{ on: locale === 'th' }" :aria-pressed="locale === 'th'" data-testid="setup-lang-th" @click="switchLocale('th')">ไทย</button>
        <button type="button" :class="{ on: locale === 'en' }" :aria-pressed="locale === 'en'" data-testid="setup-lang-en" @click="switchLocale('en')">English</button>
      </div>
    </header>

    <v-progress-linear v-if="loading" indeterminate color="primary" />

    <!-- Step 0: the token, in a narrow column of its own. -->
    <div v-else-if="!session" class="wz-body wz-body--narrow">
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" role="alert" data-testid="setup-error">{{ error }}</v-alert>
      <StepToken :api="api" :https="status?.https ?? true" @session="onSession" />
      <p class="wz-aside"><v-icon icon="mdi-information-outline" size="16" aria-hidden="true" /> {{ t('setup.aside') }}</p>
    </div>

    <div v-else class="wz-body">
      <nav class="wz-steps" :aria-label="t('setup.stepsLabel')">
        <div class="wz-steps__title">{{ t('setup.stepsLabel') }}</div>
        <ol class="wz-steps__list">
          <li v-for="s in steps" :key="s.id" :class="['wz-step', `wz-step--${s.mark}`]" :aria-current="s.mark === 'now' ? 'step' : undefined" :data-testid="`setup-nav-${s.id}`" :data-mark="s.mark">
            <span class="wz-step__dot" aria-hidden="true">
              <v-icon v-if="s.mark === 'done'" icon="mdi-check" size="16" />
              <v-icon v-else-if="s.mark === 'skipped'" icon="mdi-debug-step-over" size="16" />
              <template v-else>{{ s.number }}</template>
            </span>
            <span class="wz-step__name">
              <a v-if="s.open" href="#" class="wz-step__link" @click.prevent="go(s.id)">{{ t(`setup.step.${s.id}`) }}</a>
              <template v-else>{{ t(`setup.step.${s.id}`) }}</template>
              <span v-if="s.optional" class="wz-step__opt">{{ t('setup.optionalTag') }}</span>
            </span>
          </li>
        </ol>
      </nav>

      <div class="wz-main">
        <div class="wz-mprogress" data-testid="setup-mobile-progress">
          <div class="wz-mprogress__row">
            <span>{{ t('setup.stepOf', { n: bar.number, of: bar.of }) }}</span>
            <span class="wz-mprogress__name">{{ t(`setup.step.${step}`) }}</span>
          </div>
          <v-progress-linear :model-value="bar.percent" color="primary" rounded height="6" :aria-label="t('setup.stepOf', { n: bar.number, of: bar.of })" />
        </div>

        <v-alert v-if="welcome && step === 'organisation'" type="success" variant="tonal" density="compact" class="mb-4" data-testid="setup-welcome">
          <div class="font-weight-medium">{{ t('setup.welcome.title') }}</div>
          <div>{{ t('setup.welcome.body', { at: dateTime(session.expiresAt) }) }}</div>
        </v-alert>
        <v-alert v-if="session.insecure" type="warning" variant="tonal" density="compact" icon="mdi-lock-open-alert-outline" class="mb-4" data-testid="setup-session-insecure">{{ t('setup.insecure.session') }}</v-alert>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" role="alert" data-testid="setup-error">{{ error }}</v-alert>

        <template v-if="progress">
          <StepOrganisation
            v-if="step === 'organisation'"
            :api="api"
            :view="viewOf('general')"
            :detected-url="status?.detectedUrl ?? origin"
            :origin="origin"
            @saved="advance(load)"
          />
          <StepAdmin v-else-if="step === 'admin'" :api="api" :progress="progress" @session="onRotated" @done="loadProgress" @back="go(prevStep(step))" @next="go(nextStep(step))" />
          <StepCheck v-else-if="step === 'check'" :api="api" :storage="viewOf('storage')" @back="go(prevStep(step))" @next="mark('check', 'done')" />
          <StepSignin
            v-else-if="step === 'signin'"
            :api="api"
            :view="viewOf('signin')"
            :public-url="publicUrl"
            :done="progress.steps.signin === 'done'"
            @changed="afterChange"
            @back="go(prevStep(step))"
            @next="go(nextStep(step))"
          />
          <StepSettings
            v-else-if="OPTIONAL[step]"
            :key="step"
            :api="api"
            :step="step"
            :categories="OPTIONAL[step]!"
            :views="views"
            :public-url="publicUrl"
            :origin="origin"
            :key-status="settings?.masterKey.status ?? null"
            @changed="afterChange"
            @back="go(prevStep(step))"
            @skip="mark(step, 'skipped')"
            @next="mark(step, 'done')"
          />
          <StepKit v-else-if="step === 'kit'" :api="api" :progress="progress" :kit="kit" @kit="(k) => (kit = k)" @downloaded="loadProgress" @back="go(prevStep(step))" @next="go(nextStep(step))" />
          <StepClaim v-else-if="step === 'claim'" :api="api" :progress="progress" :result="claimResult" :callback-busy="callbackBusy" @back="go(prevStep(step))" @finished="finished" />
        </template>
      </div>
    </div>
  </v-main>
</template>

<style scoped>
.wz { min-height: 100vh; background: rgb(var(--v-theme-background)); }
.wz-band { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 8px 32px; background: rgb(var(--v-theme-secondary)); color: rgb(var(--v-theme-on-secondary)); }
.wz-band__name { font-weight: 600; line-height: 1.3; }
.wz-band__sub, .wz-band__id { font-size: .75rem; opacity: .75; }
.wz-lang { display: inline-flex; border: 1px solid rgba(255, 255, 255, .28); border-radius: 6px; overflow: hidden; }
.wz-lang button { height: 30px; padding: 0 10px; font-size: .8125rem; color: inherit; background: transparent; border: 0; cursor: pointer; }
.wz-lang button.on { background: rgba(255, 255, 255, .18); font-weight: 500; }
.wz-lang button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
.wz-body { width: 100%; max-width: 1120px; margin: 0 auto; padding: 32px 24px 48px; display: grid; grid-template-columns: 272px minmax(0, 1fr); gap: 32px; align-items: start; }
.wz-body--narrow { grid-template-columns: minmax(0, 1fr); max-width: 560px; }
.wz-main { min-width: 0; max-width: 760px; }
.wz-aside { margin-top: 16px; font-size: .8125rem; color: rgba(var(--v-theme-on-background), var(--v-medium-emphasis-opacity)); display: flex; gap: 6px; align-items: flex-start; }
.wz-steps { position: sticky; top: 24px; }
.wz-steps__title { font-size: .75rem; font-weight: 500; color: rgba(var(--v-theme-on-background), var(--v-medium-emphasis-opacity)); margin: 0 0 8px 4px; }
.wz-steps__list { list-style: none; margin: 0; padding: 0; }
.wz-step { display: grid; grid-template-columns: 28px 1fr; gap: 10px; align-items: start; padding: 8px 10px; border-radius: 8px; position: relative; }
.wz-step + .wz-step::before { content: ''; position: absolute; left: 23px; top: -8px; height: 16px; width: 2px; background: rgba(var(--v-border-color), var(--v-border-opacity)); }
.wz-step__dot { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: .8125rem; font-weight: 600; background: rgb(var(--v-theme-surface)); border: 1.5px solid rgba(var(--v-border-color), .38); color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); position: relative; z-index: 1; }
.wz-step__name { font-size: .875rem; line-height: 1.4; padding-top: 3px; color: rgba(var(--v-theme-on-background), var(--v-medium-emphasis-opacity)); }
.wz-step__opt { display: block; font-size: .75rem; opacity: .8; }
.wz-step__link { color: inherit; text-decoration: none; }
.wz-step__link:hover, .wz-step__link:focus-visible { text-decoration: underline; }
.wz-step--done .wz-step__dot { background: rgb(var(--v-theme-primary)); border-color: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary)); }
.wz-step--done .wz-step__name { color: rgb(var(--v-theme-on-background)); }
.wz-step--skipped .wz-step__dot { border-style: dashed; }
.wz-step--now { background: rgba(var(--v-theme-primary), .1); }
.wz-step--now .wz-step__dot { border: 2px solid rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-primary)); }
.wz-step--now .wz-step__name { color: rgb(var(--v-theme-on-background)); font-weight: 600; }
.wz-mprogress { display: none; }
@media (max-width: 959px) {
  .wz-band { padding: 8px 16px; }
  .wz-band__sub { display: none; }
  .wz-body { grid-template-columns: minmax(0, 1fr); padding: 16px 12px 32px; gap: 16px; }
  .wz-steps { display: none; }
  .wz-mprogress { display: block; margin-bottom: 16px; }
  .wz-mprogress__row { display: flex; gap: 8px; justify-content: space-between; font-size: .8125rem; margin-bottom: 6px; }
  .wz-mprogress__name { color: rgba(var(--v-theme-on-background), var(--v-medium-emphasis-opacity)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
}
</style>

<style>
/* Shared by the step components (they render inside .wz). */
.wz .setup-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 20px; align-items: start; }
.wz .setup-grid__full { grid-column: 1 / -1; }
.wz .setup-label { display: block; font-size: .8125rem; font-weight: 500; margin-bottom: 6px; }
.wz .setup-help { font-size: .75rem; line-height: 1.5; margin-top: 6px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.wz .setup-subhead { font-size: .875rem; font-weight: 600; margin-bottom: 8px; }
.wz .setup-how, .wz .setup-list { padding-left: 1.25em; font-size: .875rem; margin: 0; }
.wz .setup-term { margin: 10px 0 12px; padding: 12px 14px; border-radius: 8px; background: #0f1b2d; color: #e6edf7; font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.wz .setup-term__dim { opacity: .6; }
.wz .setup-code { max-width: 220px; }
.wz .setup-copy-list { display: grid; gap: 12px; }
.wz .setup-choice { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.wz .setup-choice__card { display: grid; grid-template-columns: 20px 1fr; gap: 10px; padding: 12px 14px; border-radius: 12px; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); font-size: .875rem; }
.wz .setup-choice__card--on { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .06); }
.wz .setup-choice__card--off { opacity: .6; }
.wz code { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; overflow-wrap: anywhere; }
@media (max-width: 599px) {
  .wz .setup-grid, .wz .setup-choice { grid-template-columns: minmax(0, 1fr); }
}
</style>
