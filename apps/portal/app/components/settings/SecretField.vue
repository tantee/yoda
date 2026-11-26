<script setup lang="ts">
import type { SettingView } from '@yoda/shared'
import { computed, useI18n, useId } from '#imports'
import { formatDateTime } from '~/utils/dates'
import { fieldHelpKey, fieldLabelKey, fieldRules, type SecretDraft } from '~/utils/settings'
import EnvLockChip from './EnvLockChip.vue'

/**
 * A write-only secret (proposal §5.2, 8.6). The value never comes back from the API and is never put into a field:
 * once saved it shows "ตั้งค่าแล้ว ✓ ···a1b2" (last 4 only for long values), who set it and when, and
 * เปลี่ยน (an empty field) / ลบ. `generatable` adds สร้างใหม่ (webhook secrets, generated and shown once by core).
 */
const props = defineProps<{ view: SettingView; modelValue: SecretDraft; error?: string | null; generatable?: boolean; busy?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: SecretDraft]; generate: [] }>()
const { t, te, locale } = useI18n()
const dateTime = (v: string) => formatDateTime(v, locale.value)
const id = `secret-${useId()}`
const rules = computed(() => fieldRules(props.view))
const state = computed(() => props.view.secretState ?? { set: false, hint: null, unavailable: false, updatedAt: null, updatedBy: null })
const help = computed(() => (te(fieldHelpKey(props.view.key)) ? t(fieldHelpKey(props.view.key)) : ''))
// Not set yet: the field is open straight away (typing makes it a replacement).
const editing = computed(() => rules.value.editable && (props.modelValue.mode === 'replace' || (!state.value.set && props.modelValue.mode !== 'clear')))
const savedLine = computed(() => {
  const by = state.value.updatedBy?.label
  if (!state.value.set || !state.value.updatedAt) return ''
  return by ? t('settings.source.savedBy', { name: by, at: dateTime(state.value.updatedAt) }) : t('settings.source.savedAt', { at: dateTime(state.value.updatedAt) })
})
const set = (mode: SecretDraft['mode'], value = '') => emit('update:modelValue', { mode, value })
</script>

<template>
  <div class="secret-field" :data-key="view.key" data-testid="secret-field">
    <label :for="id" class="setting-label">{{ t(fieldLabelKey(view.key)) }}</label>

    <div v-if="editing" class="d-flex align-start ga-2">
      <v-text-field
        :id="id"
        :model-value="modelValue.value"
        type="password"
        autocomplete="new-password"
        spellcheck="false"
        :placeholder="t('settings.secret.placeholder')"
        :error-messages="error ? [error] : []"
        hide-details="auto"
        :data-testid="`secret-input-${view.key}`"
        @update:model-value="(v: string) => set('replace', v ?? '')"
      />
      <v-btn v-if="state.set" variant="text" class="mt-2" :data-testid="`secret-cancel-${view.key}`" @click="set('keep')">{{ t('common.cancel') }}</v-btn>
    </div>

    <div v-else class="secret-box" :class="{ 'secret-box--locked': !rules.editable }">
      <template v-if="modelValue.mode === 'clear'">
        <v-icon icon="mdi-delete-outline" color="error" size="18" aria-hidden="true" />
        <span class="text-error text-body-2" data-testid="secret-will-clear">{{ t('settings.secret.willClear') }}</span>
        <v-spacer />
        <v-btn size="small" variant="text" :data-testid="`secret-undo-${view.key}`" @click="set('keep')">{{ t('settings.secret.undo') }}</v-btn>
      </template>
      <template v-else>
        <template v-if="state.unavailable">
          <v-icon icon="mdi-alert-outline" color="warning" size="18" aria-hidden="true" />
          <span class="text-body-2" data-testid="secret-unavailable">{{ t('settings.secret.unavailable') }}</span>
        </template>
        <template v-else-if="state.set">
          <v-icon icon="mdi-check-circle" color="success" size="18" aria-hidden="true" />
          <span class="text-body-2 text-success font-weight-medium" data-testid="secret-set">{{ t('settings.secret.set') }}</span>
          <span class="secret-hint" data-testid="secret-hint" aria-hidden="true">{{ state.hint ? `···${state.hint}` : '····' }}</span>
        </template>
        <span v-else class="text-body-2 text-medium-emphasis" data-testid="secret-unset">{{ t('settings.secret.unset') }}</span>
        <v-spacer />
        <template v-if="rules.editable">
          <v-btn v-if="generatable" size="small" variant="text" color="primary" :loading="busy" :data-testid="`secret-generate-${view.key}`" @click="emit('generate')">{{ t('settings.secret.generate') }}</v-btn>
          <v-btn size="small" variant="text" color="primary" :disabled="busy" :data-testid="`secret-replace-${view.key}`" @click="set('replace')">{{ t('settings.secret.replace') }}</v-btn>
          <v-btn v-if="state.set" size="small" variant="text" color="error" :disabled="busy" :data-testid="`secret-clear-${view.key}`" @click="set('clear')">{{ t('settings.secret.clear') }}</v-btn>
        </template>
        <v-icon v-else icon="mdi-lock-outline" size="18" class="text-medium-emphasis" aria-hidden="true" />
      </template>
    </div>

    <div v-if="rules.lock" class="mt-1"><EnvLockChip :reason="rules.lock.reason" :env-name="rules.lock.envName" /></div>
    <p v-if="rules.lock?.reason === 'env'" class="setting-meta">{{ t('settings.lock.how.env', { name: rules.lock.envName ?? '' }) }}</p>
    <p v-if="savedLine" class="setting-meta" data-testid="secret-saved-line">{{ savedLine }} · {{ t('settings.secret.noReadBack') }}</p>
    <p v-else-if="editing" class="setting-meta">{{ t('settings.secret.writeOnly') }}</p>
    <p v-if="help" class="setting-meta">{{ help }}</p>
  </div>
</template>

<style scoped>
.secret-box {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-height: 40px; padding: 4px 8px 4px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 4px;
}
.secret-box--locked { background: rgb(var(--v-theme-neutral-soft)); }
.secret-hint { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; letter-spacing: .1em; }
</style>
