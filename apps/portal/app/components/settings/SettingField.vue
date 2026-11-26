<script setup lang="ts">
import type { SettingView } from '@yoda/shared'
import { computed, useI18n, useId } from '#imports'
import { formatDateTime } from '~/utils/dates'
import { SHOW_HOW, lockNamed, enumOptions, fieldHelpKey, fieldKind, fieldLabelKey, fieldRules, sourceKind, type FormValue } from '~/utils/settings'
import EnvLockChip from './EnvLockChip.vue'

/**
 * One non-secret setting, drawn by its registry type (switch, number, choice, list, URL, text). A locked setting
 * (env, bootstrap, read-only, recovery-only) is disabled and carries the lock chip; otherwise the line under the
 * field says where the value came from ("บันทึกโดย <name> · <time>", or the default).
 */
const props = defineProps<{ view: SettingView; modelValue: FormValue; error?: string | null; note?: string | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: FormValue] }>()
const { t, te, locale } = useI18n()
const id = `setting-${useId()}`
const kind = computed(() => fieldKind(props.view.key))
const rules = computed(() => fieldRules(props.view))
const label = computed(() => t(fieldLabelKey(props.view.key)))
const help = computed(() => (te(fieldHelpKey(props.view.key)) ? t(fieldHelpKey(props.view.key)) : ''))
const options = computed(() => enumOptions(props.view.key).map(v => ({ value: v, title: t(`settings.option.${v}`) })))
const errors = computed(() => (props.error ? [props.error] : []))
const source = computed(() => {
  const v = props.view
  const kind = sourceKind(v)
  const at = v.updatedAt ? formatDateTime(v.updatedAt, locale.value) : ''
  // Imported from env on boot (D4): it stays in effect after the variable is removed from the host's .env.
  if (kind === 'imported') return t('settings.source.imported', { at })
  if (kind === 'saved') return v.updatedBy?.label ? t('settings.source.savedBy', { name: v.updatedBy.label, at }) : t('settings.source.savedAt', { at })
  if (kind === 'default') return t('settings.source.default')
  return ''
})
const inputType = computed(() => (kind.value === 'number' ? 'number' : kind.value === 'url' ? 'url' : 'text'))
const textValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''))
</script>

<template>
  <div class="setting-field" :data-key="view.key" :data-kind="kind" data-testid="setting-field">
    <template v-if="kind === 'bool'">
      <v-switch
        :id="id"
        :model-value="modelValue === true"
        :label="label"
        :disabled="!rules.editable"
        color="primary"
        inset
        hide-details
        density="compact"
        :data-testid="`setting-input-${view.key}`"
        @update:model-value="(v: boolean | null) => emit('update:modelValue', !!v)"
      />
    </template>
    <template v-else>
      <label :for="id" class="setting-label">{{ label }}</label>
      <v-select
        v-if="kind === 'enum'"
        :id="id"
        :model-value="textValue || null"
        :items="options"
        :disabled="!rules.editable"
        :error-messages="errors"
        hide-details="auto"
        :data-testid="`setting-input-${view.key}`"
        @update:model-value="(v: string | null) => emit('update:modelValue', v ?? '')"
      />
      <v-text-field
        v-else
        :id="id"
        :model-value="textValue"
        :type="inputType"
        :inputmode="kind === 'number' ? 'numeric' : undefined"
        :disabled="!rules.editable"
        :append-inner-icon="rules.editable ? undefined : 'mdi-lock-outline'"
        :error-messages="errors"
        :class="{ 'setting-mono': kind === 'url' || kind === 'list' }"
        spellcheck="false"
        hide-details="auto"
        :data-testid="`setting-input-${view.key}`"
        @update:model-value="(v: string) => emit('update:modelValue', v ?? '')"
      />
    </template>

    <div v-if="rules.lock" class="mt-1"><EnvLockChip :reason="rules.lock.reason" :env-name="rules.lock.envName" :container="rules.lock.container" :how-key="rules.lock.howKey" /></div>
    <p v-if="rules.lock && SHOW_HOW.includes(rules.lock.reason)" class="setting-meta" data-testid="setting-lock-how">{{ t(rules.lock.howKey, lockNamed(rules.lock)) }}</p>
    <p v-if="note" class="setting-meta text-warning" role="note" data-testid="setting-note">{{ note }}</p>
    <p v-if="view.restartRequired" class="setting-meta text-warning" data-testid="setting-restart">{{ t('settings.restart.field') }}</p>
    <p v-if="source" class="setting-meta" :data-source="sourceKind(view)" data-testid="setting-source">{{ source }}</p>
    <p v-if="kind === 'list' && rules.editable" class="setting-meta">{{ t('settings.listHint') }}</p>
    <p v-if="help" class="setting-meta">{{ help }}</p>
  </div>
</template>

<style scoped>
.setting-mono :deep(input) { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
</style>
