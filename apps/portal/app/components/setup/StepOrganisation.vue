<script setup lang="ts">
import type { SettingsCategoryView, SettingsPutResponse, SettingView } from '@yoda/shared'
import { computed, reactive, ref, useI18n, watch } from '#imports'
import { checkPublicUrl, setupError, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'

/**
 * Step 1 (proposal §4.2, mockup `installer-organisation.html`): the organisation's names, the side-menu line, the
 * public URL (pre-filled with the address the browser came through, confirmed here; a warning on plain HTTP, D8,
 * and when it is not the address in the browser) and the default language. Saved on Next.
 */
const props = defineProps<{ api: SetupFetcher; view: SettingsCategoryView | null; detectedUrl: string; origin: string }>()
const emit = defineEmits<{ saved: [] }>()
const { t, locale } = useI18n()

const KEYS = ['org.name', 'org.nameEn', 'org.line', 'org.publicUrl', 'org.defaultLocale'] as const
type Key = (typeof KEYS)[number]
const views = computed(() => Object.fromEntries((props.view?.settings ?? []).map(v => [v.key, v])) as Record<string, SettingView | undefined>)
const locked = (k: Key) => !!views.value[k]?.locked
const lockHint = (k: Key) => (views.value[k]?.locked ? t('setup.org.lockedEnv', { name: views.value[k]?.envName ?? '' }) : '')

const form = reactive<Record<Key, string>>({ 'org.name': '', 'org.nameEn': '', 'org.line': '', 'org.publicUrl': '', 'org.defaultLocale': 'th' })
function fill() {
  const val = (k: Key) => (typeof views.value[k]?.value === 'string' ? (views.value[k]!.value as string) : '')
  form['org.name'] = val('org.name')
  form['org.nameEn'] = val('org.nameEn')
  form['org.line'] = val('org.line')
  // The default (localhost) is not a choice: the address the browser came through is the better guess.
  const url = views.value['org.publicUrl']
  form['org.publicUrl'] = url && url.source !== 'default' && typeof url.value === 'string' ? url.value : props.detectedUrl
  form['org.defaultLocale'] = val('org.defaultLocale') || (locale.value === 'en' ? 'en' : 'th')
}
watch(() => props.view, fill, { immediate: true })

const url = computed(() => checkPublicUrl(form['org.publicUrl'], props.origin))
const nameMissing = computed(() => !form['org.name'].trim())
const busy = ref(false)
const error = ref('')

function changes(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of KEYS) {
    if (locked(k)) continue
    const raw = k === 'org.publicUrl' ? url.value.normalised : form[k].trim()
    const cur = views.value[k]
    const saved = cur?.source === 'db' ? cur.value : undefined
    if (raw === '') {
      if (saved !== undefined) out[k] = null
      continue
    }
    if (raw !== saved) out[k] = raw
  }
  return out
}

async function save() {
  if (nameMissing.value || url.value.invalid || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const c = changes()
    if (Object.keys(c).length) await props.api<SettingsPutResponse>('/settings/general', { method: 'PUT', body: { changes: c } })
    emit('saved')
  } catch (e) {
    const m = setupError(e)
    error.value = t(m.key, m.named ?? {})
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <StepFrame
    :kicker="t('setup.org.kicker')"
    :title="t('setup.org.title')"
    :lead="t('setup.org.lead')"
    :hint="t('setup.nav.saveOnNext')"
    hint-icon="mdi-content-save-outline"
    :next-label="t('setup.nav.nextTo', { step: t('setup.step.admin') })"
    :next-disabled="nameMissing || url.invalid"
    :busy="busy"
    @next="save"
  >
    <div class="setup-grid">
      <v-text-field v-model="form['org.name']" :label="t('setup.org.name')" :disabled="locked('org.name')" :hint="lockHint('org.name')" :persistent-hint="locked('org.name')" :error-messages="nameMissing && form['org.name'] !== '' ? t('setup.org.nameRequired') : ''" data-testid="setup-org-name" />
      <v-text-field v-model="form['org.nameEn']" :label="t('setup.org.nameEn')" :disabled="locked('org.nameEn')" :hint="lockHint('org.nameEn')" :persistent-hint="locked('org.nameEn')" data-testid="setup-org-name-en" />
      <v-text-field v-model="form['org.line']" class="setup-grid__full" :label="t('setup.org.line')" :hint="locked('org.line') ? lockHint('org.line') : t('setup.org.lineHelp')" persistent-hint :disabled="locked('org.line')" data-testid="setup-org-line" />
      <div class="setup-grid__full">
        <v-text-field
          v-model="form['org.publicUrl']"
          :label="t('setup.org.publicUrl')"
          prepend-inner-icon="mdi-web"
          spellcheck="false"
          :disabled="locked('org.publicUrl')"
          :error-messages="url.invalid && form['org.publicUrl'] ? t('setup.org.urlInvalid') : ''"
          :hint="locked('org.publicUrl') ? lockHint('org.publicUrl') : t('setup.org.publicUrlHelp')"
          persistent-hint
          data-testid="setup-org-url"
        >
          <template #append-inner>
            <v-chip v-if="!url.invalid && !url.mismatch" size="small" color="success" variant="tonal" data-testid="setup-url-match">{{ t('setup.org.urlMatches') }}</v-chip>
          </template>
        </v-text-field>
        <v-alert v-if="!url.invalid && url.mismatch" type="warning" variant="tonal" density="compact" class="mt-3" data-testid="setup-url-mismatch">{{ t('setup.org.urlMismatch', { origin }) }}</v-alert>
        <v-alert v-if="!url.invalid && url.plainHttp" type="warning" variant="tonal" density="compact" icon="mdi-lock-open-alert-outline" class="mt-3" data-testid="setup-url-http">
          <div class="font-weight-medium">{{ t('setup.insecure.title') }}</div>
          <div>{{ t('setup.org.httpWarning') }}</div>
        </v-alert>
      </div>
      <div>
        <div class="setup-label">{{ t('setup.org.defaultLocale') }}</div>
        <v-btn-toggle v-model="form['org.defaultLocale']" mandatory density="compact" variant="outlined" color="primary" divided :disabled="locked('org.defaultLocale')" data-testid="setup-org-locale">
          <v-btn value="th" data-testid="setup-org-locale-th">ไทย</v-btn>
          <v-btn value="en" data-testid="setup-org-locale-en">English</v-btn>
        </v-btn-toggle>
        <p class="setup-help">{{ t('setup.org.defaultLocaleHelp') }}</p>
      </div>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert" data-testid="setup-org-error">{{ error }}</v-alert>
  </StepFrame>
</template>
