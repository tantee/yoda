<script setup lang="ts">
import type { Priority } from '@yoda/shared'
import { computed, useI18n } from '#imports'
import { priorityStyle } from '~/utils/statusStyle'

/** Priority is a glyph and a word in text colour, not a chip (proposal §6.5). */
const props = defineProps<{ priority: Priority }>()
const { t } = useI18n()
const style = computed(() => priorityStyle(props.priority))
</script>

<template>
  <span class="priority-mark text-body-2" :class="[style.color ? `text-${style.color}` : '', style.class]" :data-priority="priority">
    <v-icon :icon="style.icon" :size="16" aria-hidden="true" />
    {{ t(style.labelKey) }}
  </span>
</template>

<style scoped>
.priority-mark { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; vertical-align: middle; }
</style>
