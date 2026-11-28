<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

/** The check before sending (D4 kept): every file with its size and a tick, the privacy confirmation, the AI line. */
export type ReviewFile = { key: 'screenshot' | 'video' | 'buffer' | 'console' | 'network'; label: string; bytes: number; detail?: string }
const props = defineProps<{ files: ReviewFile[]; attach: Record<string, boolean>; confirmed: boolean; sensitive: boolean; noAi: boolean; production: boolean }>()
const emit = defineEmits<{ 'update:attach': [Record<string, boolean>]; 'update:confirmed': [boolean]; 'update:sensitive': [boolean] }>()
const { t } = useI18n()
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const aiLine = computed(() => (props.noAi || props.sensitive ? t('review.aiNone') : t('review.aiText')))
</script>

<template>
  <div class="review" data-testid="review">
    <h3 class="text-subtitle-2 mb-1">{{ t('review.title') }}</h3>
    <p class="text-caption text-medium-emphasis mb-2">{{ t('review.hint') }}</p>
    <v-alert v-if="production" type="error" variant="tonal" density="compact" class="mb-2" data-testid="review-production">{{ t('review.production') }}</v-alert>
    <div v-for="f in files" :key="f.key" class="review__file" :data-testid="`review-file-${f.key}`">
      <v-checkbox
        :model-value="attach[f.key]"
        :label="f.label"
        hide-details
        density="compact"
        :data-testid="`attach-${f.key}`"
        @update:model-value="(v: boolean | null) => emit('update:attach', { ...attach, [f.key]: !!v })"
      />
      <span class="text-caption text-medium-emphasis">{{ f.detail ? `${f.detail} · ` : '' }}{{ size(f.bytes) }}</span>
    </div>
    <v-checkbox
      :model-value="confirmed"
      :label="t('review.confirm')"
      color="primary"
      hide-details
      class="mt-2"
      data-testid="review-confirm"
      @update:model-value="(v: boolean | null) => emit('update:confirmed', !!v)"
    />
    <v-checkbox
      :model-value="sensitive"
      :label="t('review.sensitive')"
      hide-details
      data-testid="review-sensitive"
      @update:model-value="(v: boolean | null) => emit('update:sensitive', !!v)"
    />
    <div class="review__ai text-caption mt-2" data-testid="review-ai">
      <v-icon :icon="noAi || sensitive ? 'mdi-shield-lock-outline' : 'mdi-creation-outline'" size="16" class="mr-1" />{{ aiLine }}
    </div>
  </div>
</template>

<style scoped>
.review__file { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.review__ai { display: flex; align-items: center; color: rgba(var(--v-theme-on-surface), 0.72); }
</style>
