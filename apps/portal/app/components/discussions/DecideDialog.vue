<script setup lang="ts">
import type { Discussion } from '@yoda/shared'
import { voteShares } from '~/utils/discussions'

/**
 * Record the decision (proposal §8.5): the options as cards with their pros / cons and votes to pick from (or
 * none), and the decision text (required, checked on submit).
 */
const props = defineProps<{ modelValue: boolean; discussion: Discussion }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; decided: [] }>()
const { t } = useI18n()
const api = useApi()

const optionKey = ref<string | null>(null)
const decision = ref('')
const busy = ref(false)
const error = ref('')
const tried = ref(false)
const shares = computed(() => voteShares(props.discussion))
const dirty = computed(() => !!decision.value.trim() || !!optionKey.value)

watch(() => props.modelValue, (open) => {
  if (!open) return
  optionKey.value = null
  decision.value = ''
  error.value = ''
  tried.value = false
})

async function submit() {
  tried.value = true
  if (!decision.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${props.discussion.id}/decide`, {
      method: 'POST',
      body: { decision: decision.value.trim(), ...(optionKey.value ? { optionKey: optionKey.value } : {}) },
    })
    emit('update:modelValue', false)
    emit('decided')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppDialog
    :model-value="modelValue"
    size="editor"
    :busy="busy"
    :dirty="dirty"
    scrollable
    data-testid="decide-dialog"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <template #title>{{ t('discussions.decide.titleNamed') }} <em>{{ discussion.question }}</em></template>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="decide-error">{{ error }}</v-alert>
    <fieldset v-if="shares.options.length" class="decide-options">
      <legend class="text-body-2 font-weight-medium mb-2">{{ t('discussions.decide.option') }}</legend>
      <v-radio-group v-model="optionKey" hide-details data-testid="decide-option">
        <label
          v-for="o in shares.options"
          :key="o.key"
          class="decide-card"
          :class="{ 'decide-card--on': optionKey === o.key }"
          :data-key="o.key"
          data-testid="decide-option-card"
        >
          <v-radio :value="o.key" density="compact" />
          <span class="decide-card__body">
            <span class="decide-card__title">
              {{ o.title }}
              <span v-if="o.recommended" class="decide-card__ai">{{ discussion.brief?.source === 'ai' ? t('discussions.brief.aiRecommended') : t('discussions.brief.recommended') }}</span>
            </span>
            <span v-if="o.pros" class="decide-card__pc"><strong>{{ t('discussions.brief.pros') }}:</strong> {{ o.pros }}</span>
            <span v-if="o.cons" class="decide-card__pc"><strong>{{ t('discussions.brief.cons') }}:</strong> {{ o.cons }}</span>
            <span class="decide-card__votes tabular-nums">{{ t('discussions.votes', { n: o.votes }) }} · {{ o.percent }}%</span>
          </span>
        </label>
        <label class="decide-card" :class="{ 'decide-card--on': optionKey === null }">
          <v-radio :value="null" density="compact" />
          <span class="decide-card__body"><span class="decide-card__title">{{ t('discussions.decide.none') }}</span></span>
        </label>
      </v-radio-group>
    </fieldset>
    <v-textarea
      v-model="decision"
      :label="t('discussions.decide.textRequired')"
      :hint="t('discussions.decide.textHint')"
      persistent-hint
      rows="3"
      auto-grow
      class="mt-4"
      :error-messages="tried && !decision.trim() ? [t('discussions.decide.textMissing')] : []"
      data-testid="decide-text"
    />
    <template #actions>
      <v-btn variant="text" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('common.cancel') }}</v-btn>
      <v-btn color="primary" variant="flat" :loading="busy" data-testid="decide-submit" @click="submit">{{ t('discussions.decide.submit') }}</v-btn>
    </template>
  </AppDialog>
</template>

<style scoped>
.decide-options { border: 0; padding: 0; margin: 0; }
.decide-options :deep(.v-selection-control-group) { display: grid; gap: 8px; }
.decide-card {
  display: flex; align-items: flex-start; gap: 4px; padding: 8px 12px 8px 4px; cursor: pointer;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px;
}
.decide-card--on { border-color: rgb(var(--v-theme-primary)); background: rgb(var(--v-theme-primary-soft)); }
.decide-card__body { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding-top: 6px; overflow-wrap: anywhere; }
.decide-card__title { font-weight: 600; }
.decide-card__ai { margin-left: 6px; font-size: .75rem; font-weight: 600; color: rgb(var(--v-theme-ai)); }
.decide-card__pc { font-size: .875rem; white-space: pre-wrap; }
.decide-card__votes { font-size: .8125rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.decide-card :deep(.v-radio) { flex: none; width: auto; }
</style>
