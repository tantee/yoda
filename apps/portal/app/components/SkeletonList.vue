<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import { useFunMode } from '~/composables/useFunMode'
import { wiseLine } from '~/utils/funMode'

/**
 * Loading placeholder shaped like a list or table (proposal §7.1). Fun mode adds a wise-master caption unless
 * `quiet` (small placeholders inside an already loaded page).
 */
const props = withDefaults(defineProps<{ rows?: number; twoLine?: boolean; quiet?: boolean }>(), { rows: 5, twoLine: true })
const { t } = useI18n()
const route = useRoute()
const { enabled } = useFunMode()
const caption = computed(() => (props.quiet ? undefined : wiseLine(enabled.value, 'loading', route.path, t)))
</script>

<template>
  <v-card data-testid="skeleton-list" :aria-label="t('stateView.loading')" aria-busy="true">
    <v-skeleton-loader v-for="i in rows" :key="i" :type="twoLine ? 'list-item-two-line' : 'list-item'" />
    <p v-if="caption" class="skeleton-caption" aria-hidden="true" data-testid="skeleton-caption">{{ caption }}</p>
  </v-card>
</template>
