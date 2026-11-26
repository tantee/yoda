<script setup lang="ts">
import { computed, ref, useId, watch } from '#imports'
import { useDisplay } from 'vuetify'
import { dialogLayout, dialogPersistent, dialogWidth, type DialogSize } from '~/utils/dialogs'
import DialogCard from './DialogCard.vue'

/**
 * Every dialog (proposal §4.2, §6.6): one of three widths (confirm 480, form 560, editor 800); below 600 px a
 * confirm is a bottom sheet and a form or editor is full screen (`dialogLayout`); labelled by its title, and Escape / backdrop close only while nothing is saving or typed (`busy`,
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
const layout = computed(() => dialogLayout(props.size, xs.value))
const locked = computed(() => dialogPersistent(props))
const card = ref<{ $el?: HTMLElement } | null>(null)
// Focus rule (§6.6): the element marked `autofocus` (the safe button of a confirm, the first field of a form)
// gets focus once the dialog is in; Vuetify otherwise focuses the dialog box itself.
function focusMarked() {
  const el = card.value?.$el?.querySelector<HTMLElement>('[autofocus]')
  el?.focus()
}
// Keyboard users land back where they were: the element that opened the dialog gets focus again after it closes
// (Vuetify only does this for an activator slot; these dialogs open from v-model).
let opener: HTMLElement | null = null
watch(() => props.modelValue, (open) => {
  if (open && typeof document !== 'undefined') opener = document.activeElement as HTMLElement | null
}, { immediate: true })
function restoreFocus() {
  const active = document.activeElement
  const lost = !active || active === document.body || !!card.value?.$el?.contains(active)
  if (opener?.isConnected && lost) opener.focus()
  opener = null
}
const close = () => {
  if (!props.busy) emit('update:modelValue', false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    :max-width="layout === 'sheet' ? undefined : width"
    :fullscreen="layout === 'fullscreen'"
    :class="{ 'app-dialog--sheet': layout === 'sheet' }"
    :transition="layout === 'sheet' ? 'dialog-bottom-transition' : undefined"
    :persistent="locked"
    :scrollable="scrollable"
    :aria-labelledby="titleId"
    @update:model-value="v => emit('update:modelValue', v)"
    @after-enter="focusMarked"
    @after-leave="restoreFocus"
  >
    <DialogCard ref="card" v-bind="$attrs" :title="title" :title-id="titleId" :closable="layout === 'fullscreen'" :busy="busy" @close="close">
      <template v-if="$slots.title" #title><slot name="title" /></template>
      <slot />
      <template v-if="$slots.start" #start><slot name="start" /></template>
      <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    </DialogCard>
  </v-dialog>
</template>

<style>
/* Phone confirm (dialogLayout 'sheet'): pinned to the bottom edge, full width, buttons share the row. */
.v-dialog.app-dialog--sheet { align-items: flex-end; }
.v-dialog.app-dialog--sheet > .v-overlay__content { width: 100%; max-width: 100%; margin: 0; max-height: 90%; }
.v-dialog.app-dialog--sheet > .v-overlay__content > .v-card { border-radius: 12px 12px 0 0; padding-bottom: env(safe-area-inset-bottom); }
.v-dialog.app-dialog--sheet .dialog-card__actions > .v-btn { flex: 1 1 0; min-height: 44px; }
</style>
