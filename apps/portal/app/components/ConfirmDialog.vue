<script setup lang="ts">
import { useI18n } from '#imports'
import type { DialogSize } from '~/utils/dialogs'
import AppDialog from './AppDialog.vue'

/**
 * A confirm dialog (proposal §6.6): the title names the object, the text says the consequence, and the safe
 * button has focus. `destructive` makes the primary `flat error` (it carries the trigger's verb). Errors show in
 * the dialog. Extra fields (a required reason) go in the default slot.
 */
withDefaults(defineProps<{
  modelValue: boolean
  title: string
  text?: string
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  busy?: boolean
  dirty?: boolean
  disabled?: boolean
  error?: string
  size?: DialogSize
  confirmTestid?: string
  cancelTestid?: string
}>(), { size: 'confirm', confirmTestid: 'confirm-ok', cancelTestid: 'confirm-keep' })
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [] }>()
const { t } = useI18n()
</script>

<template>
  <AppDialog
    :model-value="modelValue"
    :title="title"
    :size="size"
    :busy="busy"
    :dirty="dirty"
    @update:model-value="v => emit('update:modelValue', v)"
  >
    <template v-if="$slots.title" #title><slot name="title" /></template>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="confirm-error">{{ error }}</v-alert>
    <p v-if="text" class="text-body-2 mb-0">{{ text }}</p>
    <slot />
    <template #actions>
      <v-btn variant="text" :disabled="busy" autofocus :data-testid="cancelTestid" @click="emit('update:modelValue', false)">{{ cancelLabel ?? t('common.cancel') }}</v-btn>
      <v-btn
        :color="destructive ? 'error' : 'primary'"
        variant="flat"
        :loading="busy"
        :disabled="disabled"
        :data-testid="confirmTestid"
        @click="emit('confirm')"
      >{{ confirmLabel }}</v-btn>
    </template>
  </AppDialog>
</template>
