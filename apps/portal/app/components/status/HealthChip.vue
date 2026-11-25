<script setup lang="ts">
import type { Health } from '@yoda/shared'

defineProps<{ health: Health }>()
</script>

<template>
  <StatusChip kind="health" :value="health" :data-health="health" data-testid="health-chip" />
</template>
