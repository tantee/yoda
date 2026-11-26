<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import { useFunMode } from '~/composables/useFunMode'
import { wiseLine, type WiseKind } from '~/utils/funMode'

/**
 * An empty list or section (proposal §7.1): icon, one-line title, what to do, and the action in the slot.
 * `secondary` is an optional extra line. Without it, fun mode adds a wise-master line of the `wisdom` kind
 * (rotating by page); `wisdom: false` keeps the state plain.
 */
const props = withDefaults(defineProps<{ title: string; text?: string; secondary?: string; icon?: string; wisdom?: WiseKind | false }>(), {
  icon: 'mdi-inbox-outline',
  wisdom: 'empty',
})
const { t, locale } = useI18n()
const route = useRoute()
const { enabled } = useFunMode()
const line = computed(() => props.secondary || (props.wisdom ? wiseLine(enabled.value, props.wisdom, route.path, t) : undefined))
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <v-icon :icon="icon" :size="48" color="neutral-dot" aria-hidden="true" />
    <div class="text-h6 mt-2">{{ title }}</div>
    <div v-if="text" class="text-body-2 text-medium-emphasis">{{ text }}</div>
    <div v-if="line" class="empty-state__secondary text-caption text-medium-emphasis mt-1" :class="{ 'font-italic': locale !== 'th' }" data-testid="empty-secondary">{{ line }}</div>
    <div v-if="$slots.default" class="mt-4 d-flex flex-wrap justify-center ga-2"><slot /></div>
  </div>
</template>

<!-- The extra line is italic in English only: Thai has no true italic and a slanted fallback reads poorly. -->
<style scoped>
.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 16px; }
</style>
