<script setup lang="ts">
import { useI18n } from '#imports'

/** Loading placeholder for a detail page: header, main column and side panel (proposal §7.1). */
const { t } = useI18n()
</script>

<template>
  <div data-testid="skeleton-detail" :aria-label="t('stateView.loading')" aria-busy="true">
    <v-skeleton-loader type="heading, text" class="mb-4 bg-transparent" />
    <div class="skeleton-detail">
      <v-card><v-skeleton-loader type="paragraph, paragraph" /></v-card>
      <v-card><v-skeleton-loader type="list-item-two-line@3" /></v-card>
    </div>
  </div>
</template>

<style scoped>
.skeleton-detail { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; }
@media (max-width: 1279px) { .skeleton-detail { grid-template-columns: minmax(0, 1fr); } }
</style>
