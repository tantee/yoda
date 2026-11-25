<script setup lang="ts">
import type { Proposal } from '@yoda/shared'
import { raisePayload } from '~/utils/discussions'

/** What a raise_discussion proposal would raise: shown before the person accepts. Plain text only. */
const props = defineProps<{ proposal: Proposal }>()
const { t } = useI18n()
const p = computed(() => raisePayload(props.proposal.payload))
</script>

<template>
  <div v-if="proposal.kind === 'raise_discussion'" class="mt-1" data-testid="raise-preview">
    <div class="font-weight-medium" data-testid="raise-preview-question">{{ p.question }}</div>
    <div v-if="p.details" class="text-body-2" style="white-space: pre-wrap" data-testid="raise-preview-details">{{ p.details }}</div>
    <div v-if="p.options.length" class="text-body-2 mt-1">
      <span class="text-caption text-medium-emphasis">{{ t('discussions.proposal.options') }}</span>
      <ul class="pl-5" data-testid="raise-preview-options">
        <li v-for="o in p.options" :key="o.key">{{ o.title }}</li>
      </ul>
    </div>
  </div>
</template>
