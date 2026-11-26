<script setup lang="ts">
/**
 * The standard page header (proposal §5.4): optional context line, the one page title (h1, 20/600), actions on
 * the right (wrapping under the title on narrow screens), a meta line, and tabs.
 */
defineProps<{ title: string }>()
</script>

<template>
  <header class="page-header mb-4" data-testid="page-header">
    <div v-if="$slots.context" class="page-header__context text-body-2 text-medium-emphasis mb-1"><slot name="context" /></div>
    <div class="page-header__row">
      <h1 class="page-header__title text-h5" data-testid="page-title">{{ title }}</h1>
      <div v-if="$slots.actions" class="page-header__actions"><slot name="actions" /></div>
    </div>
    <div v-if="$slots.meta" class="page-header__meta text-body-2 text-medium-emphasis mt-1"><slot name="meta" /></div>
    <div v-if="$slots.tabs" class="page-header__tabs mt-3"><slot name="tabs" /></div>
  </header>
</template>

<style scoped>
.page-header__row { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; }
.page-header__title { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.page-header__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.page-header__context, .page-header__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.page-header__tabs { border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); overflow-x: auto; }
</style>
