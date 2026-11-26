<script setup lang="ts">
import { computed, ref, useId } from '#imports'
import { useDisplay } from 'vuetify'
import { dialogPersistent, dialogWidth, type DialogSize } from '~/utils/dialogs'
import DialogCard from './DialogCard.vue'

/**
 * Every dialog (proposal §4.2, §6.6): one of three widths (confirm 480, form 560, editor 800), full screen below
 * 600 px, labelled by its title, and Escape / backdrop close only while nothing is saving or typed (`busy`,
 * `dirty`). Attributes such as `data-testid` land on the card. Slots: `title`, default body, `start`, `actions`.
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  modelValue: boolean
  title?: string
  size?: DialogSize
  busy?: boolean
  dirty?: boolean
  persistent?: boolean
  scrollable?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { xs } = useDisplay()
const titleId = `dialog-title-${useId()}`
const width = computed(() => dialogWidth(props.size))
const locked = computed(() => dialogPersistent(props))
const card = ref<{ $el?: HTMLElement } | null>(null)
// Focus rule (§6.6): the element marked `autofocus` (the safe button of a confirm, the first field of a form)
// gets focus once the dialog is in; Vuetify otherwise focuses the dialog box itself.
function focusMarked() {
  const el = card.value?.$el?.querySelector<HTMLElement>('[autofocus]')
  el?.focus()
}
const close = () => {
  if (!props.busy) emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    :max-width="width"
    :fullscreen="xs"
    :persistent="locked"
    :scrollable="scrollable"
    :aria-labelledby="titleId"
    @update:model-value="v => emit('update:modelValue', v)"
    @after-enter="focusMarked"
  >
    <DialogCard ref="card" v-bind="$attrs" :title="title" :title-id="titleId" :closable="xs" :busy="busy" @close="close">
      <template v-if="$slots.title" #title><slot name="title" /></template>
      <slot />
      <template v-if="$slots.start" #start><slot name="start" /></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    </DialogCard>
  </v-dialog>
</template>
