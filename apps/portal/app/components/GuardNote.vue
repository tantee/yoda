<script setup lang="ts">
import type { GuardInfo } from '~/utils/guards'

/** Why an automatic decision was handed to the PM (an auto-assign guard rail), in plain language. */
const props = defineProps<{ guard: GuardInfo }>()
const { t, te } = useI18n()
const detail = computed(() =>
  props.guard.detail && te(`guards.detail.${props.guard.reason}`)
    ? t(`guards.detail.${props.guard.reason}`, { detail: props.guard.detail })
    : null,
)
</script>

<template>
  <div class="text-caption d-flex align-start ga-1" data-testid="guard-note">
    <v-icon icon="mdi-shield-alert-outline" size="small" color="warning" class="mt-0" />
    <span>
      <span data-testid="guard-reason">{{ t(`guards.${guard.reason}`) }}</span>
      <template v-if="detail"> · <span data-testid="guard-detail">{{ detail }}</span></template>
    </span>
  </div>
</template>
