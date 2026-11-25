<script setup lang="ts">
import { useI18n } from '#imports'

/** Loading placeholder shaped like a list or table (proposal §7.1). */
withDefaults(defineProps<{ rows?: number; twoLine?: boolean }>(), { rows: 5, twoLine: true })
const { t } = useI18n()
</script>

<template>
  <v-card data-testid="skeleton-list" :aria-label="t('stateView.loading')" aria-busy="true">
    <v-skeleton-loader v-for="i in rows" :key="i" :type="twoLine ? 'list-item-two-line' : 'list-item'" />
  </v-card>
</template>
