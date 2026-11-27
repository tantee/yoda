<script setup lang="ts">
import type { OidcCheckResult, OidcPending, OidcSignInStart, RecoveryAdmins, RecoveryCodesResult, RecoverySession, RecoveryStatus, TotpEnrolment } from '@yoda/shared'
import TestResult from '~/components/settings/TestResult.vue'
// Explicit: Nuxt would auto-register these as RecoveryCodesOnce / RecoveryTotpEnrol (directory prefix), so the bare
// names below resolved to nothing and /recovery showed no QR code, secret or new codes.
import CodesOnce from '~/components/recovery/CodesOnce.vue'
import TotpEnrol from '~/components/recovery/TotpEnrol.vue'
import { formatCode, isLastAdmin, oidcCallback, oidcCallbackError, recoveryClient, recoveryError, sessionLost } from '~/utils/recovery'

/**
 * /recovery (installer proposal §7.4, §8.6): the break-glass sign-in and what it may do. Outside the default
 * layout and without Keycloak (the boot plugin never starts it here): the page talks to core with the `yoda_bg`
 * cookie and the CSRF header only. Every action here is audited and every portal admin is told.
 */
definePageMeta({ layout: false })

const { t, locale, setLocale } = useI18n()
const route = useRoute()
const router = useRouter()
const { dateTime } = useDateFormat()

const session = ref<RecoverySession | null>(null)
const status = ref<RecoveryStatus | null>(null)
const loading = ref(true)
const busy = ref('')
const error = ref('')
const notice = ref('')
const api = recoveryClient((url, opts) => $fetch(url, opts), () => session.value?.csrf ?? null)

function fail(e: unknown) {
  if (sessionLost(e)) {
    session.value = null
    status.value = null
  }
  const m = recoveryError(e)
  error.value = t(m.key, m.named ?? {})
}

async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = name
  error.value = ''
  notice.value = ''
  try {
    return await fn()
  } catch (e) {
    fail(e)
    return undefined
  } finally {
    busy.value = ''
  }
}

/** A restricted session gets no status, except a status-only one (the master key is not usable). */
async function loadStatus() {
  if (!session.value || (session.value.restricted && !session.value.statusOnly)) return
  status.value = await api<RecoveryStatus>('/status')
  if (!session.value.restricted) admins.value = await api<RecoveryAdmins>('/admins')
}

// ── Portal admins: grant and revoke (step-up with the current second factor) ──
const admins = ref<RecoveryAdmins | null>(null)
const adminForm = reactive({ username: '', totpCode: '' })

async function grantAdmin() {
  const username = adminForm.username.trim()
  await run('grant', async () => {
    admins.value = await api<RecoveryAdmins>('/admins', { method: 'POST', body: { username, ...(adminForm.totpCode ? { totpCode: adminForm.totpCode } : {}) } })
    adminForm.username = ''
    adminForm.totpCode = ''
    notice.value = t('recovery.admins.granted', { username })
  })
}

/** The last portal admin: asked again before revoking (core refuses with `last_admin` without the flag). */
const confirmLast = ref<string | null>(null)

async function revokeAdmin(username: string, confirmLastAdmin = false) {
  await run(`revoke:${username}`, async () => {
    try {
      admins.value = await api<RecoveryAdmins>('/admins/revoke', {
        method: 'POST',
        body: { username, ...(adminForm.totpCode ? { totpCode: adminForm.totpCode } : {}), ...(confirmLastAdmin ? { confirmLastAdmin } : {}) },
      })
    } catch (e) {
      if (isLastAdmin(e)) {
        confirmLast.value = username
        return
      }
      throw e
    }
    confirmLast.value = null
    adminForm.totpCode = ''
    notice.value = t('recovery.admins.revoked', { username })
  })
}

// ── Sign-in ──
const form = reactive({ username: '', password: '', totpCode: '', recoveryCode: '', useCode: false })

async function signIn() {
  await run('signin', async () => {
    session.value = await api<RecoverySession>('/session', {
      method: 'POST',
      body: {
        username: form.username,
        password: form.password,
        ...(form.useCode ? { recoveryCode: form.recoveryCode } : form.totpCode ? { totpCode: form.totpCode } : {}),
      },
    })
    form.password = ''
    form.totpCode = ''
    form.recoveryCode = ''
    await loadStatus()
  })
}

async function signOut() {
  await run('signout', async () => {
    await api('/session', { method: 'DELETE' })
    session.value = null
    status.value = null
    admins.value = null
  })
}

// ── Finishing a reset, and the account itself ──
const pw = reactive({ newPassword: '', confirm: '', totpCode: '' })
const pwMismatch = computed(() => pw.confirm !== '' && pw.confirm !== pw.newPassword)

async function changePassword() {
  await run('password', async () => {
    session.value = await api<RecoverySession>('/password', {
      method: 'POST',
      body: { newPassword: pw.newPassword, ...(pw.totpCode ? { totpCode: pw.totpCode } : {}) },
    })
    if (session.value?.recoveryCodes) newCodes.value = session.value.recoveryCodes
    pw.newPassword = ''
    pw.confirm = ''
    pw.totpCode = ''
    notice.value = t('recovery.account.passwordChanged')
    await loadStatus()
  })
}

const enrolment = ref<TotpEnrolment | null>(null)
const totp = reactive({ code: '', currentTotpCode: '' })

async function startTotp() {
  await run('totp', async () => {
    enrolment.value = await api<TotpEnrolment>('/totp/start', { method: 'POST' })
  })
}

async function confirmTotp() {
  await run('totp', async () => {
    session.value = await api<RecoverySession>('/totp/confirm', {
      method: 'POST',
      body: { code: totp.code, ...(totp.currentTotpCode ? { currentTotpCode: totp.currentTotpCode } : {}) },
    })
    if (session.value?.recoveryCodes) newCodes.value = session.value.recoveryCodes
    enrolment.value = null
    totp.code = ''
    totp.currentTotpCode = ''
    notice.value = t('recovery.totp.enrolled')
    await loadStatus()
  })
}

const newCodes = ref<string[] | null>(null)
const codesTotp = ref('')

async function regenerateCodes() {
  await run('codes', async () => {
    const r = await api<RecoveryCodesResult>('/recovery-codes', { method: 'POST', body: codesTotp.value ? { totpCode: codesTotp.value } : {} })
    newCodes.value = r.recoveryCodes
    codesTotp.value = ''
    await loadStatus()
  })
}

// ── Sign-in settings (OIDC): stage, check, test sign-in, apply, rollback ──
const oidcForm = reactive({ issuer: '', clientId: '', jwksUrl: '' })
const check = ref<OidcCheckResult | null>(null)
const signinResult = ref<OidcCheckResult | null>(null)
const pending = computed<OidcPending | null>(() => status.value?.oidc.pending ?? null)
const oidcLocked = computed(() => (status.value?.oidc.envLocked.length ?? 0) > 0)

function fillOidcForm() {
  const src = pending.value?.values ?? status.value?.oidc.current
  oidcForm.issuer = src?.issuer ?? ''
  oidcForm.clientId = src?.clientId ?? 'yoda-portal'
  oidcForm.jwksUrl = src?.jwksUrl ?? ''
}

async function stage() {
  await run('stage', async () => {
    status.value = await api<RecoveryStatus>('/oidc/pending', {
      method: 'PUT',
      body: { issuer: oidcForm.issuer.trim(), clientId: oidcForm.clientId.trim(), jwksUrl: oidcForm.jwksUrl.trim() || null },
    })
    check.value = null
    signinResult.value = null
  })
}

async function discard() {
  await run('discard', async () => {
    status.value = await api<RecoveryStatus>('/oidc/pending', { method: 'DELETE' })
    check.value = null
    signinResult.value = null
    fillOidcForm()
  })
}

async function runCheck() {
  await run('check', async () => {
    check.value = await api<OidcCheckResult>('/oidc/check', { method: 'POST' })
  })
}

async function testSignIn() {
  await run('signin-test', async () => {
    const r = await api<OidcSignInStart>('/oidc/signin', { method: 'POST' })
    window.location.assign(r.authorizeUrl)
  })
}

async function apply() {
  await run('apply', async () => {
    status.value = await api<RecoveryStatus>('/oidc/apply', { method: 'POST' })
    signinResult.value = null
    notice.value = t('recovery.oidc.applied')
    fillOidcForm()
  })
}

async function rollback() {
  await run('rollback', async () => {
    status.value = await api<RecoveryStatus>('/oidc/rollback', { method: 'POST' })
    notice.value = t('recovery.oidc.rolledBack')
    fillOidcForm()
  })
}

async function funOff() {
  await run('fun', async () => {
    status.value = await api<RecoveryStatus>('/fun-mode/off', { method: 'POST' })
  })
}

/** Back from the identity provider: hand the code to core, then drop it from the address bar. */
async function finishCallback() {
  const cb = oidcCallback(route.query)
  const providerError = oidcCallbackError(route.query)
  if (!cb && !providerError) return
  await router.replace({ path: '/recovery', query: {} })
  if (providerError) {
    error.value = t('recovery.oidc.providerError')
    return
  }
  if (!session.value) return
  await run('callback', async () => {
    const r = await api<OidcCheckResult & { pending: OidcPending | null }>('/oidc/callback', { method: 'POST', body: cb })
    signinResult.value = { ok: r.ok, checks: r.checks }
    await loadStatus()
  })
}

onMounted(async () => {
  try {
    session.value = await api<RecoverySession>('/session')
    await loadStatus()
  } catch {
    session.value = null
  }
  fillOidcForm()
  loading.value = false
  await finishCallback()
})

const masterKeyTone = computed(() => (status.value?.masterKey.status === 'ok' ? 'success' : 'error'))
const rollbackInfo = computed(() => status.value?.oidc.rollback ?? null)
const rollbackUntil = computed(() => (rollbackInfo.value ? dateTime(rollbackInfo.value.until) : ''))
const breakGlass = computed(() => status.value?.breakGlass ?? { totpEnabled: false, recoveryCodesLeft: 0 })
const asResult = (r: OidcCheckResult) => ({ action: 'oidc' as const, ...r })

// setLocale, not `locale.value =`: the locale files load lazily, so a plain assignment shows raw keys.
function switchLocale() {
  void setLocale(locale.value === 'th' ? 'en' : 'th')
}
</script>

<template>
  <v-main class="recovery">
    <header class="recovery__band">
      <AppMark :size="28" :fun="false" />
      <span class="recovery__brand">{{ t('recovery.title') }}</span>
      <v-spacer />
      <v-btn variant="text" size="small" class="recovery__lang" data-testid="recovery-locale" @click="switchLocale">{{ locale === 'th' ? 'English' : 'ไทย' }}</v-btn>
    </header>

    <div class="recovery__body">
      <v-alert type="warning" variant="tonal" density="compact" icon="mdi-shield-alert-outline" class="mb-4" data-testid="recovery-warning">
        {{ t('recovery.warning') }}
      </v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" role="alert" data-testid="recovery-error">{{ error }}</v-alert>
      <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-4" role="status" data-testid="recovery-notice">{{ notice }}</v-alert>

      <v-progress-linear v-if="loading" indeterminate color="primary" />

      <!-- Sign-in -->
      <v-card v-else-if="!session" class="pa-6 recovery__card" data-testid="recovery-signin">
        <h1 class="text-h6 mb-1">{{ t('recovery.signin.title') }}</h1>
        <p class="text-body-2 text-medium-emphasis mb-4">{{ t('recovery.signin.help') }}</p>
        <v-form @submit.prevent="signIn">
          <v-text-field v-model="form.username" :label="t('recovery.signin.username')" autocomplete="username" autocapitalize="none" spellcheck="false" data-testid="recovery-username" />
          <v-text-field v-model="form.password" :label="t('recovery.signin.password')" type="password" autocomplete="current-password" data-testid="recovery-password" />
          <v-text-field
            v-if="!form.useCode"
            v-model="form.totpCode"
            :label="t('recovery.signin.totp')"
            :hint="t('recovery.signin.totpHint')"
            persistent-hint
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            data-testid="recovery-totp"
          />
          <v-text-field
            v-else
            :model-value="form.recoveryCode"
            :label="t('recovery.signin.recoveryCode')"
            autocomplete="off"
            spellcheck="false"
            data-testid="recovery-code"
            @update:model-value="(v: string) => (form.recoveryCode = formatCode(v))"
          />
          <v-btn variant="text" size="small" class="mb-4 px-0" data-testid="recovery-use-code" @click="form.useCode = !form.useCode">
            {{ form.useCode ? t('recovery.signin.useTotp') : t('recovery.signin.useCode') }}
          </v-btn>
          <div>
            <v-btn type="submit" color="primary" :loading="busy === 'signin'" :disabled="!form.username || !form.password" data-testid="recovery-submit">{{ t('recovery.signin.submit') }}</v-btn>
          </div>
        </v-form>
      </v-card>

      <template v-else>
        <PageHeader :title="t('recovery.signedIn.title')">
          <template #meta>
            <span data-testid="recovery-user">{{ t('recovery.signedIn.as', { username: session.admin.username }) }}</span>
            <span>{{ t('recovery.signedIn.expires', { at: dateTime(session.idleExpiresAt) }) }}</span>
          </template>
          <template #actions>
            <v-btn variant="outlined" prepend-icon="mdi-logout" :loading="busy === 'signout'" data-testid="recovery-signout" @click="signOut">{{ t('recovery.signedIn.signOut') }}</v-btn>
          </template>
        </PageHeader>
        <v-alert v-if="session.insecure" type="warning" variant="tonal" density="compact" class="mb-4" data-testid="recovery-insecure">{{ t('recovery.insecure') }}</v-alert>

        <!-- A reset from the install host is not finished: password first, then TOTP. -->
        <v-card v-if="session.restricted" class="pa-6 recovery__card" data-testid="recovery-restricted">
          <template v-if="session.statusOnly">
            <h2 class="text-subtitle-1 font-weight-medium mb-1">{{ t('recovery.statusOnly.title') }}</h2>
            <p class="text-body-2 text-medium-emphasis mb-4" data-testid="recovery-status-only">{{ t('recovery.statusOnly.help') }}</p>
            <dl v-if="status" class="recovery__facts text-body-2 mb-4">
              <dt>{{ t('recovery.status.masterKey') }}</dt>
              <dd>
                <v-chip size="small" color="error" variant="tonal" data-testid="recovery-master-key">{{ t(`recovery.status.key.${status.masterKey.status}`) }}</v-chip>
              </dd>
              <dt>{{ t('recovery.status.setup') }}</dt>
              <dd>{{ t(`recovery.status.setupState.${status.setup}`) }}</dd>
            </dl>
          </template>
          <template v-else>
            <h2 class="text-subtitle-1 font-weight-medium mb-1">{{ t('recovery.reset.title') }}</h2>
            <p class="text-body-2 text-medium-emphasis mb-4">{{ t('recovery.reset.help') }}</p>
          </template>
          <v-form v-if="session.admin.mustChangePassword" @submit.prevent="changePassword">
            <v-text-field v-model="pw.newPassword" :label="t('recovery.account.newPassword')" :hint="t('recovery.account.passwordRule')" persistent-hint type="password" autocomplete="new-password" data-testid="recovery-new-password" />
            <v-text-field v-model="pw.confirm" :label="t('recovery.account.confirmPassword')" type="password" autocomplete="new-password" :error-messages="pwMismatch ? t('recovery.account.mismatch') : ''" data-testid="recovery-confirm-password" />
            <v-btn type="submit" color="primary" :loading="busy === 'password'" :disabled="pw.newPassword.length < 14 || pw.newPassword !== pw.confirm" data-testid="recovery-save-password">{{ t('recovery.account.savePassword') }}</v-btn>
          </v-form>
          <div v-else-if="session.admin.mustEnrolTotp && !session.statusOnly">
            <v-btn v-if="!enrolment" color="primary" :loading="busy === 'totp'" data-testid="recovery-totp-start" @click="startTotp">{{ t('recovery.totp.start') }}</v-btn>
            <template v-else>
              <TotpEnrol :enrolment="enrolment" class="mb-4" />
              <v-text-field v-model="totp.code" :label="t('recovery.totp.code')" inputmode="numeric" autocomplete="one-time-code" maxlength="6" data-testid="recovery-totp-code" />
              <v-btn color="primary" :loading="busy === 'totp'" :disabled="totp.code.length !== 6" data-testid="recovery-totp-confirm" @click="confirmTotp">{{ t('recovery.totp.confirm') }}</v-btn>
            </template>
          </div>
        </v-card>

        <template v-else-if="status">
          <!-- State -->
          <v-card class="pa-5 mb-4" data-testid="recovery-status">
            <h2 class="text-subtitle-1 font-weight-medium mb-3">{{ t('recovery.status.title') }}</h2>
            <dl class="recovery__facts text-body-2">
              <dt>{{ t('recovery.status.masterKey') }}</dt>
              <dd>
                <v-chip size="small" :color="masterKeyTone" variant="tonal" data-testid="recovery-master-key">{{ t(`recovery.status.key.${status.masterKey.status}`) }}</v-chip>
                <span v-if="status.masterKey.keyId" class="text-medium-emphasis ml-2">{{ status.masterKey.keyId }}</span>
              </dd>
              <dt>{{ t('recovery.status.setup') }}</dt>
              <dd>{{ t(`recovery.status.setupState.${status.setup}`) }}</dd>
              <dt>{{ t('recovery.status.funMode') }}</dt>
              <dd>
                {{ status.funMode ? t('recovery.status.on') : t('recovery.status.off') }}
                <v-btn v-if="status.funMode" variant="text" size="small" :loading="busy === 'fun'" data-testid="recovery-fun-off" @click="funOff">{{ t('recovery.status.funOff') }}</v-btn>
              </dd>
            </dl>
          </v-card>

          <!-- Sign-in settings -->
          <v-card class="pa-5 mb-4" data-testid="recovery-oidc">
            <h2 class="text-subtitle-1 font-weight-medium mb-1">{{ t('recovery.oidc.title') }}</h2>
            <p class="text-body-2 text-medium-emphasis mb-3">{{ t('recovery.oidc.help') }}</p>
            <dl class="recovery__facts text-body-2 mb-4">
              <dt>{{ t('recovery.oidc.issuer') }}</dt>
              <dd class="recovery__value" data-testid="recovery-oidc-issuer">{{ status.oidc.current.issuer ?? t('recovery.oidc.notSet') }}</dd>
              <dt>{{ t('recovery.oidc.clientId') }}</dt>
              <dd class="recovery__value">{{ status.oidc.current.clientId }}</dd>
              <dt>{{ t('recovery.oidc.jwksUrl') }}</dt>
              <dd class="recovery__value">{{ status.oidc.current.jwksUrl ?? t('recovery.oidc.fromIssuer') }}</dd>
            </dl>

            <v-alert v-if="oidcLocked" type="info" variant="tonal" density="compact" data-testid="recovery-oidc-locked">
              {{ t('recovery.oidc.envLocked', { names: status.oidc.envLocked.join(', ') }) }}
            </v-alert>
            <template v-else>
              <v-form class="recovery__grid" @submit.prevent="stage">
                <v-text-field v-model="oidcForm.issuer" :label="t('recovery.oidc.issuer')" placeholder="https://sso.example.org/realms/hospital" spellcheck="false" data-testid="recovery-oidc-issuer-input" />
                <v-text-field v-model="oidcForm.clientId" :label="t('recovery.oidc.clientId')" spellcheck="false" data-testid="recovery-oidc-client-input" />
                <v-text-field v-model="oidcForm.jwksUrl" :label="t('recovery.oidc.jwksUrlOptional')" spellcheck="false" data-testid="recovery-oidc-jwks-input" />
                <div>
                  <v-btn type="submit" variant="outlined" :loading="busy === 'stage'" :disabled="!oidcForm.issuer || !oidcForm.clientId" data-testid="recovery-oidc-stage">{{ t('recovery.oidc.stage') }}</v-btn>
                </div>
              </v-form>

              <div v-if="pending" class="recovery__pending mt-4" data-testid="recovery-oidc-pending">
                <div class="text-body-2 mb-2">
                  <strong>{{ t('recovery.oidc.pending') }}</strong>
                  <span class="recovery__value ml-1">{{ pending.values.issuer }} · {{ pending.values.clientId }}</span>
                </div>
                <div class="text-body-2 mb-3" data-testid="recovery-oidc-tested">
                  {{ pending.testedAt ? t('recovery.oidc.tested', { username: pending.testedUsername ?? '', at: dateTime(pending.testedAt) }) : t('recovery.oidc.notTested') }}
                </div>
                <div class="recovery__actions">
                  <v-btn variant="outlined" :loading="busy === 'check'" data-testid="recovery-oidc-check" @click="runCheck">{{ t('recovery.oidc.check') }}</v-btn>
                  <v-btn variant="outlined" prepend-icon="mdi-login" :loading="busy === 'signin-test'" data-testid="recovery-oidc-signin" @click="testSignIn">{{ t('recovery.oidc.testSignIn') }}</v-btn>
                  <v-btn color="primary" :disabled="!pending.testedAt" :loading="busy === 'apply'" data-testid="recovery-oidc-apply" @click="apply">{{ t('recovery.oidc.apply') }}</v-btn>
                  <v-btn variant="text" :loading="busy === 'discard'" data-testid="recovery-oidc-discard" @click="discard">{{ t('recovery.oidc.discard') }}</v-btn>
                </div>
                <TestResult v-if="check" :result="asResult(check)" class="mt-3" />
                <TestResult v-if="signinResult" :result="asResult(signinResult)" class="mt-3" />
              </div>
            </template>

            <div v-if="rollbackInfo" class="mt-4" data-testid="recovery-oidc-rollback">
              <div class="text-body-2 mb-2">{{ t('recovery.oidc.rollbackHelp', { issuer: rollbackInfo.values.issuer ?? t('recovery.oidc.notSet'), until: rollbackUntil }) }}</div>
              <v-btn variant="outlined" color="warning" :loading="busy === 'rollback'" :disabled="oidcLocked" data-testid="recovery-oidc-rollback-btn" @click="rollback">{{ t('recovery.oidc.rollback') }}</v-btn>
            </div>
          </v-card>

          <!-- Portal admins -->
          <v-card v-if="admins" class="pa-5 mb-4" data-testid="recovery-admins">
            <h2 class="text-subtitle-1 font-weight-medium mb-1">{{ t('recovery.admins.title') }}</h2>
            <p class="text-body-2 text-medium-emphasis mb-3">{{ t('recovery.admins.help') }}</p>
            <h3 class="text-body-1 font-weight-medium mb-2">{{ t('recovery.admins.list') }}</h3>
            <p v-if="!admins.admins.length && !admins.preGranted.length" class="text-body-2 text-medium-emphasis mb-3" data-testid="recovery-admins-none">{{ t('recovery.admins.none') }}</p>
            <ul class="recovery__list mb-4">
              <li v-for="a in admins.admins" :key="a.username" :data-testid="`recovery-admin-${a.username}`">
                <span class="recovery__value">{{ a.username }}</span>
                <span class="text-medium-emphasis">{{ a.displayName }} · {{ t('recovery.admins.lastSeen', { at: dateTime(a.lastSeenAt) }) }}</span>
                <v-btn variant="text" size="small" color="error" :loading="busy === `revoke:${a.username}`" :data-testid="`recovery-admin-revoke-${a.username}`" @click="revokeAdmin(a.username)">{{ t('recovery.admins.revoke') }}</v-btn>
              </li>
              <li v-for="u in admins.preGranted" :key="`pre:${u}`" :data-testid="`recovery-admin-pre-${u}`">
                <span class="recovery__value">{{ u }}</span>
                <v-chip size="x-small" variant="tonal">{{ t('recovery.admins.preGranted') }}</v-chip>
                <v-btn variant="text" size="small" color="error" :loading="busy === `revoke:${u}`" :disabled="admins.preGrantLocked" :data-testid="`recovery-admin-revoke-${u}`" @click="revokeAdmin(u)">{{ t('recovery.admins.revoke') }}</v-btn>
              </li>
            </ul>
            <v-alert v-if="confirmLast" type="warning" variant="tonal" density="compact" class="mb-3" data-testid="recovery-admin-last">
              <div class="mb-2">{{ t('recovery.admins.lastAdmin', { username: confirmLast }) }}</div>
              <v-btn size="small" color="error" variant="flat" :loading="busy === `revoke:${confirmLast}`" data-testid="recovery-admin-last-confirm" @click="revokeAdmin(confirmLast, true)">{{ t('recovery.admins.revokeAnyway') }}</v-btn>
              <v-btn size="small" variant="text" class="ml-2" data-testid="recovery-admin-last-cancel" @click="confirmLast = null">{{ t('recovery.admins.cancel') }}</v-btn>
            </v-alert>
            <v-alert v-if="admins.preGrantLocked" type="info" variant="tonal" density="compact" class="mb-3" data-testid="recovery-admins-locked">{{ t('recovery.admins.locked') }}</v-alert>
            <v-form class="recovery__grid" @submit.prevent="grantAdmin">
              <v-text-field v-model="adminForm.username" :label="t('recovery.admins.username')" autocapitalize="none" spellcheck="false" data-testid="recovery-admin-username" />
              <v-text-field v-if="breakGlass.totpEnabled" v-model="adminForm.totpCode" :label="t('recovery.account.currentTotp')" inputmode="numeric" maxlength="6" data-testid="recovery-admin-totp" />
              <div>
                <v-btn type="submit" variant="outlined" :loading="busy === 'grant'" :disabled="!adminForm.username.trim()" data-testid="recovery-admin-grant">{{ t('recovery.admins.grant') }}</v-btn>
              </div>
            </v-form>
          </v-card>

          <!-- The break-glass account -->
          <v-card class="pa-5 mb-4" data-testid="recovery-account">
            <h2 class="text-subtitle-1 font-weight-medium mb-3">{{ t('recovery.account.title') }}</h2>
            <dl class="recovery__facts text-body-2 mb-4">
              <dt>{{ t('recovery.account.totp') }}</dt>
              <dd>{{ breakGlass.totpEnabled ? t('recovery.status.on') : t('recovery.status.off') }}</dd>
              <dt>{{ t('recovery.account.codesLeft') }}</dt>
              <dd data-testid="recovery-codes-left">{{ breakGlass.recoveryCodesLeft }}</dd>
            </dl>

            <h3 class="text-body-1 font-weight-medium mb-2">{{ t('recovery.codes.title') }}</h3>
            <CodesOnce v-if="newCodes" :codes="newCodes" class="mb-4" />
            <div v-else class="recovery__inline mb-4">
              <v-text-field v-if="breakGlass.totpEnabled" v-model="codesTotp" :label="t('recovery.account.currentTotp')" inputmode="numeric" maxlength="6" hide-details density="compact" data-testid="recovery-codes-totp" />
              <v-btn variant="outlined" :loading="busy === 'codes'" data-testid="recovery-codes-new" @click="regenerateCodes">{{ t('recovery.codes.regenerate') }}</v-btn>
            </div>

            <h3 class="text-body-1 font-weight-medium mb-2">{{ t('recovery.account.password') }}</h3>
            <v-form class="recovery__grid mb-4" @submit.prevent="changePassword">
              <v-text-field v-model="pw.newPassword" :label="t('recovery.account.newPassword')" :hint="t('recovery.account.passwordRule')" persistent-hint type="password" autocomplete="new-password" data-testid="recovery-account-password" />
              <v-text-field v-model="pw.confirm" :label="t('recovery.account.confirmPassword')" type="password" autocomplete="new-password" :error-messages="pwMismatch ? t('recovery.account.mismatch') : ''" data-testid="recovery-account-confirm" />
              <v-text-field v-if="breakGlass.totpEnabled" v-model="pw.totpCode" :label="t('recovery.account.currentTotp')" inputmode="numeric" maxlength="6" data-testid="recovery-account-totp" />
              <div>
                <v-btn type="submit" variant="outlined" :loading="busy === 'password'" :disabled="pw.newPassword.length < 14 || pw.newPassword !== pw.confirm" data-testid="recovery-account-save">{{ t('recovery.account.savePassword') }}</v-btn>
              </div>
            </v-form>

            <h3 class="text-body-1 font-weight-medium mb-2">{{ t('recovery.totp.title') }}</h3>
            <v-btn v-if="!enrolment" variant="outlined" :loading="busy === 'totp'" data-testid="recovery-account-totp-start" @click="startTotp">{{ t('recovery.totp.start') }}</v-btn>
            <template v-else>
              <TotpEnrol :enrolment="enrolment" class="mb-4" />
              <div class="recovery__grid">
                <v-text-field v-model="totp.code" :label="t('recovery.totp.code')" inputmode="numeric" maxlength="6" data-testid="recovery-account-totp-code" />
                <v-text-field v-if="breakGlass.totpEnabled" v-model="totp.currentTotpCode" :label="t('recovery.totp.currentCode')" inputmode="numeric" maxlength="6" data-testid="recovery-account-totp-current" />
                <div>
                  <v-btn color="primary" :loading="busy === 'totp'" :disabled="totp.code.length !== 6" data-testid="recovery-account-totp-confirm" @click="confirmTotp">{{ t('recovery.totp.confirm') }}</v-btn>
                </div>
              </div>
            </template>
          </v-card>
        </template>
      </template>
    </div>
  </v-main>
</template>

<style scoped>
.recovery { min-height: 100vh; background: rgb(var(--v-theme-background)); }
.recovery__band { display: flex; align-items: center; gap: 12px; padding: 12px 24px; background: rgb(var(--v-theme-secondary)); color: rgb(var(--v-theme-on-secondary)); }
.recovery__brand { font-weight: 600; }
.recovery__lang { color: rgb(var(--v-theme-on-secondary)); }
.recovery__body { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
.recovery__card { max-width: 480px; margin: 0 auto; }
.recovery__facts { display: grid; grid-template-columns: minmax(120px, max-content) 1fr; gap: 6px 16px; margin: 0; }
.recovery__facts dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.recovery__facts dd { margin: 0; min-width: 0; }
.recovery__value { overflow-wrap: anywhere; font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; }
.recovery__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0 16px; align-items: start; }
.recovery__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.recovery__inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.recovery__inline .v-text-field { max-width: 220px; }
.recovery__list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
.recovery__list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.recovery__pending { border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); padding-top: 16px; }
</style>
