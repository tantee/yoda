<script setup lang="ts">
import type { RecoveryKit, SetupProgress } from '@yoda/shared'
import { computed, ref, useI18n } from '#imports'
import CodesOnce from '~/components/recovery/CodesOnce.vue'
import { setupError, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'

/**
 * Step 9 (proposal §4.2, D7): the recovery kit, one text file with the master key and the break-glass recovery
 * codes. Core hands it out once per install (the session that downloaded it may have it issued again for 10
 * minutes, with new codes), so the file is saved straight away and the codes are shown here. The kit lives only in
 * the page's memory (passed in as `kit`, so Back and Next keep it); never in browser storage. Next opens once it
 * was downloaded and "I have stored it" is ticked.
 */
const props = defineProps<{ api: SetupFetcher; progress: SetupProgress; kit: RecoveryKit | null }>()
const emit = defineEmits<{ back: []; next: []; downloaded: []; kit: [kit: RecoveryKit] }>()
const { t } = useI18n()
const { dateTime } = useDateFormat()
const stored = ref(false)
const busy = ref(false)
const error = ref('')
const downloadedAt = computed(() => props.kit?.downloadedAt ?? props.progress.kitDownloadedAt)
const reissueUntil = computed(() => props.progress.kitReissueUntil)

function save(k: RecoveryKit) {
  const url = URL.createObjectURL(new Blob([k.content], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = k.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function download() {
  busy.value = true
  error.value = ''
  try {
    const k = await props.api<RecoveryKit>('/recovery-kit', { method: 'POST' })
    emit('kit', k)
    save(k)
    emit('downloaded')
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
    :kicker="t('setup.kit.kicker')"
    :title="t('setup.kit.title')"
    :lead="t('setup.kit.lead')"
    :hint="downloadedAt ? '' : t('setup.kit.hint')"
    hint-icon="mdi-download-lock-outline"
    back
    :next-label="t('setup.nav.nextTo', { step: t('setup.step.claim') })"
    :next-disabled="!downloadedAt || !stored"
    @back="emit('back')"
    @next="emit('next')"
  >
    <ul class="setup-list mb-4">
      <li>{{ t('setup.kit.contains1') }}</li>
      <li>{{ t('setup.kit.contains2') }}</li>
      <li>{{ t('setup.kit.contains3') }}</li>
    </ul>
    <v-alert type="warning" variant="tonal" density="compact" icon="mdi-key-alert-outline" class="mb-4">{{ t('setup.kit.once') }}</v-alert>

    <template v-if="!downloadedAt">
      <v-btn color="primary" variant="flat" prepend-icon="mdi-download" :loading="busy" data-testid="setup-kit-download" @click="download">{{ t('setup.kit.download') }}</v-btn>
    </template>
    <template v-else>
      <v-alert type="success" variant="tonal" density="compact" class="mb-4" data-testid="setup-kit-downloaded">{{ t('setup.kit.downloaded', { at: dateTime(downloadedAt) }) }}</v-alert>
      <v-alert v-if="kit?.reissued" type="info" variant="tonal" density="compact" class="mb-4" data-testid="setup-kit-reissued">{{ t('setup.kit.reissued') }}</v-alert>
      <template v-if="kit">
        <v-btn variant="outlined" prepend-icon="mdi-download" class="mb-4" data-testid="setup-kit-save-again" @click="save(kit)">{{ t('setup.kit.saveAgain') }}</v-btn>
        <h2 class="setup-subhead">{{ t('setup.kit.codesTitle') }}</h2>
        <CodesOnce :codes="kit.recoveryCodes" class="mb-4" />
      </template>
      <template v-else-if="reissueUntil">
        <p class="setup-help" data-testid="setup-kit-reissue-help">{{ t('setup.kit.reissueHelp', { at: dateTime(reissueUntil) }) }}</p>
        <v-btn variant="outlined" prepend-icon="mdi-download" class="mb-4" :loading="busy" data-testid="setup-kit-reissue" @click="download">{{ t('setup.kit.reissue') }}</v-btn>
      </template>
      <p v-else class="setup-help" data-testid="setup-kit-gone">{{ t('setup.kit.lost') }}</p>
      <v-checkbox v-model="stored" :label="t('setup.kit.stored')" density="compact" hide-details data-testid="setup-kit-stored" />
    </template>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4" role="alert" data-testid="setup-kit-error">{{ error }}</v-alert>
  </StepFrame>
</template>
