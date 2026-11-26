<script setup lang="ts">
import { computed, useI18n } from '#imports'
import { passwordStrength } from '~/utils/setup'

/** How guessable the break-glass password is (§4.2 step 2: score 3 or more), with what to change. */
const props = defineProps<{ password: string; username: string }>()
const { t } = useI18n()
const s = computed(() => passwordStrength(props.password, props.username))
const color = computed(() => (s.value.score >= 4 ? 'success' : s.value.score === 3 ? 'primary' : s.value.score === 2 ? 'warning' : 'error'))
</script>

<template>
  <div v-if="password" class="password-meter" role="status" aria-live="polite" data-testid="setup-password-meter" :data-score="s.score">
    <div class="password-meter__bars" aria-hidden="true">
      <span v-for="n in 4" :key="n" :class="['password-meter__bar', n <= s.score ? `bg-${color}` : '']" />
    </div>
    <div class="text-caption">
      <span class="font-weight-medium">{{ t(`setup.admin.score.${s.score}`) }}</span>
      <span v-for="w in s.warnings" :key="w" class="text-medium-emphasis"> · {{ t(`setup.admin.warning.${w}`) }}</span>
    </div>
  </div>
</template>

<style scoped>
.password-meter { margin: -8px 0 16px; }
.password-meter__bars { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 4px; }
.password-meter__bar { height: 4px; border-radius: 2px; background: rgba(var(--v-theme-on-surface), .12); }
</style>
