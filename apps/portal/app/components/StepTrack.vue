<script setup lang="ts">
import type { LocalizedText } from '@yoda/shared'
import { computed, useI18n } from '#imports'
import { localized } from '~/utils/localized'
import { stepProgress, type StepStatus } from '~/utils/steps'

/**
 * The workflow step track (proposal §6.8): one segment per step, done filled, current hollow, always with a
 * text label. `compact` is the 96 px table-row form; `plain` uses the requester wording ("ขั้นที่ 4 จาก 6").
 */
const props = defineProps<{
  steps: { key: string; name: LocalizedText | string; status: StepStatus }[]
  compact?: boolean
  plain?: boolean
  showNames?: boolean
}>()
const { t, locale } = useI18n()
const nameOf = (n: LocalizedText | string) => (typeof n === 'string' ? n : localized(n, locale.value))
const progress = computed(() => stepProgress(props.steps))
const label = computed(() => {
  const { n, total, index } = progress.value
  if (!total) return ''
  if (index < 0 && n === total) return t('stepTrack.allDone', { total })
  const name = nameOf(props.steps[Math.max(index, 0)]!.name)
  return t(props.plain ? 'stepTrack.long' : 'stepTrack.short', { n: Math.max(n, 1), total, name })
})
</script>

<template>
  <div class="step-track" :class="{ 'step-track--compact': compact }" data-testid="step-track">
    <ol class="step-track__bar" :aria-label="label">
      <li
        v-for="s in steps"
        :key="s.key"
        :class="['step-track__seg', `step-track__seg--${s.status}`]"
        :aria-current="s.status === 'current' ? 'step' : undefined"
        :title="nameOf(s.name)"
        :data-status="s.status"
        data-testid="step"
      >
        <span v-if="showNames && !compact" class="step-track__name text-caption">{{ nameOf(s.name) }}</span>
      </li>
    </ol>
    <span class="step-track__label text-caption" aria-hidden="true">{{ label }}</span>
  </div>
</template>

<style scoped>
.step-track { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.step-track--compact { flex-direction: row; align-items: center; gap: 8px; }
.step-track__bar { display: flex; gap: 3px; list-style: none; margin: 0; padding: 0; width: 100%; }
.step-track--compact .step-track__bar { width: 96px; flex: none; }
.step-track__seg { flex: 1 1 0; min-width: 0; position: relative; }
.step-track__seg::before { content: ''; display: block; height: 8px; border-radius: 2px; background: #C4CCD8; }
.step-track--compact .step-track__seg::before { height: 6px; }
.step-track__seg--done::before { background: rgb(var(--v-theme-primary)); }
.step-track__seg--current::before { background: rgb(var(--v-theme-surface)); box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary)); }
.step-track__name { display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.step-track__seg--current .step-track__name { color: rgb(var(--v-theme-primary)); font-weight: 600; }
.step-track__label { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
