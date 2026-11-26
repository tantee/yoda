<script setup lang="ts">
import { useI18n } from '#imports'

/**
 * The inside of every dialog (proposal §6.6): a title naming the object (`h2`, the dialog's label), the body,
 * and the actions row — extra or destructive actions on the left (`start`), then `[ยกเลิก] [Primary]` on the right.
 * `closable` adds a close button (full-screen dialogs on phones have no backdrop to tap).
 */
defineProps<{ title?: string; titleId: string; closable?: boolean; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
</script>

<template>
  <v-card class="dialog-card">
    <header class="dialog-card__head">
      <h2 :id="titleId" class="dialog-card__title"><slot name="title">{{ title }}</slot></h2>
      <v-btn
        v-if="closable"
        icon="mdi-close"
        variant="text"
        size="small"
        :disabled="busy"
        :aria-label="t('common.close')"
        data-testid="dialog-close"
        @click="emit('close')"
      />
    </header>
    <v-card-text class="dialog-card__body"><slot /></v-card-text>
    <v-card-actions v-if="$slots.actions || $slots.start" class="dialog-card__actions">
      <slot name="start" />
      <v-spacer />
      <slot name="actions" />
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.dialog-card { display: flex; flex-direction: column; }
.dialog-card__head {
  display: flex; align-items: center; gap: 8px; min-height: 56px; padding: 12px 16px 12px 24px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.dialog-card__title { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 1.125rem; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.dialog-card__title :deep(em) { font-style: normal; color: rgb(var(--v-theme-primary)); }
.dialog-card__body { padding: 16px 24px !important; overflow-wrap: anywhere; }
.dialog-card__actions { flex-wrap: wrap; gap: 8px; padding: 12px 16px 16px 24px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.dialog-card__actions :deep(.v-btn ~ .v-btn) { margin-inline-start: 0; }
</style>
