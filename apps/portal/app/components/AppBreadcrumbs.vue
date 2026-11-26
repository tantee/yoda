<script setup lang="ts">
import { computed, useI18n } from '#imports'
import { mobileCrumbs, type Crumb } from '~/utils/breadcrumbs'

/** The top bar's trail (proposal §5.3): 13 px, last item 500 weight with ellipsis; parent + current on mobile. */
const props = defineProps<{ items: Crumb[]; compact?: boolean }>()
const { t } = useI18n()
const shown = computed(() => (props.compact ? mobileCrumbs(props.items) : props.items))
</script>

<template>
  <nav class="crumbs" :aria-label="t('shell.breadcrumb')" data-testid="breadcrumbs">
    <ol>
      <li v-for="(c, i) in shown" :key="i" :class="{ 'crumbs__here': i === shown.length - 1 }">
        <v-icon v-if="i > 0" icon="mdi-chevron-right" size="16" class="crumbs__sep" aria-hidden="true" />
        <NuxtLink v-if="c.to" :to="c.to" class="crumbs__link" :title="c.label">{{ c.label }}</NuxtLink>
        <span v-else :aria-current="i === shown.length - 1 ? 'page' : undefined" :title="c.label">{{ c.label }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.crumbs { flex: 1; min-width: 0; font-size: 13px; color: rgba(var(--v-theme-on-surface), .72); }
.crumbs ol { display: flex; align-items: center; list-style: none; margin: 0; padding: 0; min-width: 0; white-space: nowrap; }
.crumbs li { display: flex; align-items: center; gap: 4px; margin-right: 4px; min-width: 0; flex: 0 1 auto; overflow: hidden; }
.crumbs li > span, .crumbs__link { overflow: hidden; text-overflow: ellipsis; }
.crumbs li:not(.crumbs__here) { flex-shrink: 2; max-width: 240px; }
.crumbs__here { color: rgb(var(--v-theme-on-surface)); font-weight: 500; flex-shrink: 1; }
.crumbs__link { color: inherit; text-decoration: none; }
.crumbs__link:hover { text-decoration: underline; }
.crumbs__sep { color: rgb(var(--v-theme-border-strong)); flex: none; }
</style>
