<script setup lang="ts">
/**
 * An empty list or section (proposal §7.1): icon, one-line title, what to do, and the action in the slot.
 * `secondary` is an optional extra line (the fun-mode copy from Task 9 goes here).
 */
withDefaults(defineProps<{ title: string; text?: string; secondary?: string; icon?: string }>(), { icon: 'mdi-inbox-outline' })
</script>

<template>
  <div class="empty-state" data-testid="empty-state">
    <v-icon :icon="icon" :size="48" color="neutral-dot" aria-hidden="true" />
    <div class="text-h6 mt-2">{{ title }}</div>
    <div v-if="text" class="text-body-2 text-medium-emphasis">{{ text }}</div>
    <div v-if="secondary" class="empty-state__secondary text-caption text-medium-emphasis font-italic mt-1">{{ secondary }}</div>
    <div v-if="$slots.default" class="mt-4 d-flex flex-wrap justify-center ga-2"><slot /></div>
  </div>
</template>

<style scoped>
.empty-state { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 16px; }
</style>
