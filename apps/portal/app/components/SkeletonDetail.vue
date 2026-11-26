<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import { useFunMode } from '~/composables/useFunMode'
import { wiseLine } from '~/utils/funMode'

/** Loading placeholder for a detail page: header, main column and side panel (proposal §7.1). */
const { t } = useI18n()
const route = useRoute()
const { enabled } = useFunMode()
const caption = computed(() => wiseLine(enabled.value, 'loading', route.path, t))
</script>

<template>
  <div data-testid="skeleton-detail" :aria-label="t('stateView.loading')" aria-busy="true">
    <v-skeleton-loader type="heading, text" class="mb-4 bg-transparent" />
    <div class="skeleton-detail">
      <v-card><v-skeleton-loader type="paragraph, paragraph" /></v-card>
      <v-card><v-skeleton-loader type="list-item-two-line@3" /></v-card>
    </div>
    <p v-if="caption" class="skeleton-caption" aria-hidden="true" data-testid="skeleton-caption">{{ caption }}</p>
  </div>
</template>

<style scoped>
.skeleton-detail { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; }
@media (max-width: 1279px) { .skeleton-detail { grid-template-columns: minmax(0, 1fr); } }
</style>
