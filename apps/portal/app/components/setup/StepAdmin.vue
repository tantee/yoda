<script setup lang="ts">
import type { LocalSession, SetupAdminResult, SetupProgress, SetupTotpConfirmResult, TotpEnrolment } from '@yoda/shared'
import { computed, onMounted, reactive, ref, shallowRef, useI18n } from '#imports'
import TotpEnrol from '~/components/recovery/TotpEnrol.vue'
import { passwordAcceptable, setupError, type SetupFetcher } from '~/utils/setup'
import { loadZxcvbn, type Scorer } from '~/utils/zxcvbn'
import PasswordMeter from './PasswordMeter.vue'
import StepFrame from './StepFrame.vue'

/**
 * Step 2 (proposal §4.2, §7.2): the break-glass admin, a local account for /recovery when Keycloak sign-in does
 * not work. Password with a strength meter (score 3 or more; core keeps its own minimum), and TOTP: required
 * unless the public URL is this machine (D3), recommended always. The seed stays sealed in the setup session; the
 * session is rotated after this step (8.3), so the new CSRF token goes up to the page. The recovery codes made
 * here are replaced by the set in the recovery kit (step 9), which is where they are shown. An admin made without
 * TOTP while the address was localhost gets it here once the address needs it (`adminNeedsTotp`): its password,
 * the QR code and a code (POST /setup/totp/confirm); setup cannot complete before that.
 */
const props = defineProps<{ api: SetupFetcher; progress: SetupProgress }>()
const emit = defineEmits<{ session: [session: LocalSession]; done: []; back: []; next: [] }>()
const { t } = useI18n()

const form = reactive({ username: 'admin', password: '', confirm: '', code: '' })
const useTotp = ref(true)
const enrolment = ref<TotpEnrolment | null>(null)
const busy = ref('')
const error = ref('')
const replacing = ref(false)

const existing = computed(() => props.progress.admin)
const needsTotp = computed(() => !!existing.value && props.progress.adminNeedsTotp)
const addForm = reactive({ password: '', code: '' })
const addReady = computed(() => addForm.password.length > 0 && !!enrolment.value && /^\d{6}$/.test(addForm.code))
const locked = computed(() => !!props.progress.kitDownloadedAt)
const showForm = computed(() => !existing.value || (replacing.value && !locked.value))
const totpOn = computed(() => props.progress.totpRequired || useTotp.value)
const mismatch = computed(() => form.confirm !== '' && form.confirm !== form.password)
// zxcvbn is loaded here only (its own chunks); until then, or if it fails, the estimator scores.
const scorer = shallowRef<Scorer | null>(null)
onMounted(() => {
  loadZxcvbn().then((f) => (scorer.value = f), () => {})
})
const user = computed(() => form.username.trim().toLowerCase())
const score = computed(() => (scorer.value && form.password ? scorer.value(form.password, [user.value, 'yoda', 'admin']) : null))
const strongEnough = computed(() => passwordAcceptable(user.value, form.password, score.value ?? undefined))
const ready = computed(() => form.username.trim().length >= 3 && strongEnough.value && form.password === form.confirm && (!totpOn.value || (!!enrolment.value && /^\d{6}$/.test(form.code))))

function fail(e: unknown) {
  const m = setupError(e)
  error.value = t(m.key, m.named ?? {})
}

async function startTotp() {
  busy.value = 'totp'
  error.value = ''
  try {
    enrolment.value = await props.api<TotpEnrolment>('/totp', { method: 'POST' })
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function create() {
  if (!ready.value || busy.value) return
  busy.value = 'create'
  error.value = ''
  try {
    const r = await props.api<SetupAdminResult>('/admin', {
      method: 'POST',
      body: { username: form.username.trim(), password: form.password, ...(totpOn.value ? { totpCode: form.code } : {}) },
    })
    // Rotated after the TOTP step: the page must use the new CSRF token from here on.
    emit('session', r.session)
    form.password = ''
    form.confirm = ''
    form.code = ''
    enrolment.value = null
    replacing.value = false
    emit('done')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function addTotp() {
  if (!addReady.value || busy.value) return
  busy.value = 'add'
  error.value = ''
  try {
    const r = await props.api<SetupTotpConfirmResult>('/totp/confirm', { method: 'POST', body: { password: addForm.password, totpCode: addForm.code } })
    emit('session', r.session)
    addForm.password = ''
    addForm.code = ''
    enrolment.value = null
    emit('done')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

function next() {
  if (showForm.value) void create()
  else if (needsTotp.value) void addTotp()
  else emit('next')
}
</script>

<template>
  <StepFrame
    :kicker="t('setup.admin.kicker')"
    :title="t('setup.admin.title')"
    :lead="t('setup.admin.lead')"
    :hint="showForm ? t('setup.admin.hint') : ''"
    hint-icon="mdi-shield-key-outline"
    back
    :next-label="showForm ? t('setup.admin.create') : needsTotp ? t('setup.admin.addTotpSave') : t('setup.nav.nextTo', { step: t('setup.step.check') })"
    :next-disabled="(showForm && !ready) || (!showForm && needsTotp && !addReady)"
    :busy="busy === 'create' || busy === 'add'"
    @back="emit('back')"
    @next="next"
  >
    <div v-if="existing && !showForm" data-testid="setup-admin-done">
      <v-alert type="success" variant="tonal" density="compact" class="mb-3">
        {{ t('setup.admin.created', { username: existing.username }) }}
        · {{ existing.totpEnabled ? t('setup.admin.totpOn') : t('setup.admin.totpOff') }}
      </v-alert>
      <p class="setup-help">{{ t('setup.admin.codesInKit') }}</p>
      <p v-if="locked" class="setup-help" data-testid="setup-admin-locked">{{ t('setup.admin.lockedByKit') }}</p>
      <v-btn v-else variant="text" size="small" class="px-0" data-testid="setup-admin-replace" @click="replacing = true">{{ t('setup.admin.replace') }}</v-btn>

      <v-form v-if="needsTotp" class="mt-4" data-testid="setup-admin-add-totp" @submit.prevent="addTotp">
        <h2 class="setup-subhead">{{ t('setup.admin.addTotpTitle') }}</h2>
        <p class="setup-help mb-3">{{ t('setup.admin.addTotpLead') }}</p>
        <v-text-field v-model="addForm.password" :label="t('setup.admin.password')" type="password" autocomplete="current-password" class="setup-code" data-testid="setup-admin-add-password" />
        <v-btn v-if="!enrolment" variant="tonal" color="primary" prepend-icon="mdi-qrcode" :loading="busy === 'totp'" data-testid="setup-admin-add-totp-start" @click="startTotp">{{ t('setup.admin.totpStart') }}</v-btn>
        <template v-else>
          <TotpEnrol :enrolment="enrolment" class="mb-4" />
          <v-text-field v-model="addForm.code" :label="t('setup.admin.totpCode')" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="setup-code" data-testid="setup-admin-add-totp-code" />
        </template>
      </v-form>
    </div>

    <v-form v-else @submit.prevent="create">
      <div class="setup-grid">
        <v-text-field v-model="form.username" :label="t('setup.admin.username')" :hint="t('setup.admin.usernameHelp')" persistent-hint autocomplete="username" autocapitalize="none" spellcheck="false" data-testid="setup-admin-username" />
        <div class="d-none d-sm-block" />
        <div>
          <v-text-field v-model="form.password" :label="t('setup.admin.password')" type="password" autocomplete="new-password" :hint="t('setup.admin.passwordHelp')" persistent-hint data-testid="setup-admin-password" />
          <PasswordMeter :password="form.password" :username="user" :score="score" class="mt-4" />
        </div>
        <v-text-field v-model="form.confirm" :label="t('setup.admin.confirm')" type="password" autocomplete="new-password" :error-messages="mismatch ? t('setup.admin.mismatch') : ''" data-testid="setup-admin-confirm" />
      </div>

      <h2 class="setup-subhead mt-4">{{ t('setup.admin.totpTitle') }}</h2>
      <p class="setup-help mb-3">{{ progress.totpRequired ? t('setup.admin.totpRequired') : t('setup.admin.totpRecommended') }}</p>
      <v-checkbox v-if="!progress.totpRequired" v-model="useTotp" :label="t('setup.admin.useTotp')" density="compact" hide-details class="mb-2" data-testid="setup-admin-use-totp" />
      <template v-if="totpOn">
        <v-btn v-if="!enrolment" variant="tonal" color="primary" prepend-icon="mdi-qrcode" :loading="busy === 'totp'" data-testid="setup-admin-totp-start" @click="startTotp">{{ t('setup.admin.totpStart') }}</v-btn>
        <template v-else>
          <TotpEnrol :enrolment="enrolment" class="mb-4" />
          <v-text-field v-model="form.code" :label="t('setup.admin.totpCode')" inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="setup-code" data-testid="setup-admin-totp-code" />
        </template>
      </template>
    </v-form>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert" data-testid="setup-admin-error">{{ error }}</v-alert>
  </StepFrame>
</template>
