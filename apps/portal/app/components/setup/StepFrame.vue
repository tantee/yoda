<script setup lang="ts">
import { useI18n } from '#imports'

/**
 * One wizard step as a card (proposal §4.3, mockups `installer-*.html`): kicker, title (the page's one h1) and
 * lead, the body, and the footer `[ย้อนกลับ] … [ข้าม] [ถัดไป]` with a hint on the left.
 */
defineProps<{
  kicker: string
  title: string
  lead?: string
  hint?: string
  hintIcon?: string
  back?: boolean
  skippable?: boolean
  nextLabel?: string
  nextDisabled?: boolean
  busy?: boolean
  /** No footer buttons (the token step has its own submit). */
  bare?: boolean
}>()
const emit = defineEmits<{ back: []; skip: []; next: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="wz-card" aria-labelledby="wz-step-title" data-testid="setup-step">
    <div class="wz-card__head">
      <div class="wz-card__kicker">{{ kicker }}</div>
      <h1 id="wz-step-title" class="wz-card__title">{{ title }}</h1>
      <p v-if="lead" class="wz-card__lead">{{ lead }}</p>
    </div>
    <div class="wz-card__body">
      <slot />
    </div>
    <div v-if="!bare" class="wz-card__foot">
      <span v-if="hint" class="wz-card__hint"><v-icon :icon="hintIcon ?? 'mdi-information-outline'" size="15" aria-hidden="true" />{{ hint }}</span>
      <span v-else class="wz-card__hint" />
      <v-btn v-if="back" variant="outlined" prepend-icon="mdi-arrow-left" data-testid="setup-back" @click="emit('back')">{{ t('setup.nav.back') }}</v-btn>
      <v-btn v-if="skippable" variant="text" :disabled="busy" data-testid="setup-skip" @click="emit('skip')">{{ t('setup.nav.skip') }}</v-btn>
      <v-btn color="primary" variant="flat" append-icon="mdi-arrow-right" :disabled="nextDisabled" :loading="busy" data-testid="setup-next" @click="emit('next')">{{ nextLabel ?? t('setup.nav.next') }}</v-btn>
    </div>
  </section>
</template>

<style scoped>
.wz-card { background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 12px; }
.wz-card__head { padding: 20px 24px 16px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.wz-card__kicker { font-size: .75rem; font-weight: 500; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); margin-bottom: 4px; }
.wz-card__title { font-size: 1.25rem; line-height: 1.4; font-weight: 600; margin: 0; }
.wz-card__lead { margin: 6px 0 0; font-size: .875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.wz-card__body { padding: 20px 24px 24px; }
.wz-card__foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 16px 24px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgba(var(--v-theme-on-surface), .02); border-radius: 0 0 12px 12px; }
.wz-card__hint { margin-right: auto; font-size: .75rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); display: inline-flex; align-items: center; gap: 4px; }
@media (max-width: 599px) {
  .wz-card__head, .wz-card__body, .wz-card__foot { padding-left: 16px; padding-right: 16px; }
  .wz-card__hint { flex-basis: 100%; }
}
</style>
