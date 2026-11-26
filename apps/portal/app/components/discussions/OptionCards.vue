<script setup lang="ts">
import type { Discussion } from '@yoda/shared'
import { voteShares } from '~/utils/discussions'

/**
 * The brief's options as cards (proposal §8.2 discussions): title, pros / cons, a vote bar with count and share,
 * the recommended one marked ("AI แนะนำ", primary border), the decided one marked, and your vote. `canVote` adds a
 * vote button per card; `large` is the projector scale of present mode. Option text is plain (AI text is untrusted).
 */
const props = defineProps<{ discussion: Discussion; voters?: Record<string, string[]>; canVote?: boolean; busy?: boolean; large?: boolean }>()
const emit = defineEmits<{ vote: [key: string] }>()
const { t } = useI18n()
const shares = computed(() => voteShares(props.discussion))
const aiBrief = computed(() => props.discussion.brief?.source === 'ai')
</script>

<template>
  <div class="options" :class="{ 'options--large': large }" data-testid="vote-summary">
    <article
      v-for="o in shares.options"
      :key="o.key"
      class="option"
      :class="{ 'option--recommended': o.recommended, 'option--decided': o.decided }"
      :data-key="o.key"
      data-testid="brief-option"
    >
      <div class="option__head">
        <h3 class="option__title">{{ o.title }}</h3>
        <span v-if="o.recommended" class="option__label option__label--ai" data-testid="option-recommended">
          <v-icon :icon="aiBrief ? 'mdi-creation-outline' : 'mdi-star-outline'" size="14" aria-hidden="true" />{{ aiBrief ? t('discussions.brief.aiRecommended') : t('discussions.brief.recommended') }}
        </span>
        <StatusChip v-if="o.decided" kind="discussion" value="decided" :label="t('discussions.decision.chosen')" size="x-small" />
      </div>
      <dl v-if="o.pros || o.cons" class="option__pc">
        <template v-if="o.pros">
          <dt><v-icon icon="mdi-plus-circle-outline" size="16" color="success" aria-hidden="true" />{{ t('discussions.brief.pros') }}</dt>
          <dd>{{ o.pros }}</dd>
        </template>
        <template v-if="o.cons">
          <dt><v-icon icon="mdi-minus-circle-outline" size="16" color="error" aria-hidden="true" />{{ t('discussions.brief.cons') }}</dt>
          <dd>{{ o.cons }}</dd>
        </template>
      </dl>
      <div class="option__votes">
        <v-progress-linear
          :model-value="o.percent"
          :color="o.recommended || o.mine ? 'primary' : 'neutral-dot'"
          bg-color="neutral-soft"
          bg-opacity="1"
          :height="large ? 12 : 8"
          rounded
          :aria-label="t('discussions.voteShare', { title: o.title, n: o.votes, percent: o.percent })"
          data-testid="vote-bar"
        />
        <span class="option__count tabular-nums" data-testid="vote-count">{{ t('discussions.votes', { n: o.votes }) }} · {{ o.percent }}%</span>
      </div>
      <div v-if="voters?.[o.key]?.length || o.mine || canVote" class="option__foot">
        <span v-if="voters?.[o.key]?.length" class="text-caption text-medium-emphasis option__voters">{{ voters[o.key]!.join(', ') }}</span>
        <v-spacer />
        <span v-if="o.mine && !canVote" class="text-caption text-primary font-weight-medium" data-testid="my-vote">{{ t('discussions.thread.myVote') }}</span>
        <v-btn
          v-if="canVote"
          size="small"
          :variant="o.mine ? 'flat' : 'outlined'"
          :color="o.mine ? 'primary' : undefined"
          :prepend-icon="o.mine ? 'mdi-check' : undefined"
          :disabled="busy"
          :aria-pressed="o.mine"
          data-testid="vote-btn"
          :data-mine="o.mine"
          @click="emit('vote', o.key)"
        >{{ o.mine ? t('discussions.thread.myVote') : t('discussions.thread.vote') }}</v-btn>
      </div>
    </article>
    <p class="text-caption text-medium-emphasis mb-0" data-testid="vote-total">{{ t('discussions.voteTotal', { n: shares.total }) }}</p>
  </div>
</template>

<style scoped>
.options { display: grid; gap: 12px; }
.option {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; padding: 12px 16px;
  background: rgb(var(--v-theme-surface)); min-width: 0; overflow-wrap: anywhere;
}
.option--recommended { border: 2px solid rgb(var(--v-theme-primary)); padding: 11px 15px; }
.option--decided { background: rgb(var(--v-theme-success-soft)); }
.option__head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.option__title { margin: 0; font-size: 1rem; font-weight: 600; flex: 1 1 auto; min-width: 0; }
.option__label { display: inline-flex; align-items: center; gap: 4px; font-size: .75rem; font-weight: 600; padding: 0 8px; border-radius: 12px; }
.option__label--ai { color: rgb(var(--v-theme-ai)); background: rgb(var(--v-theme-ai-soft)); }
.option__pc { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 8px 0 0; font-size: .875rem; }
.option__pc dt { display: inline-flex; align-items: center; gap: 4px; font-weight: 500; white-space: nowrap; }
.option__pc dd { margin: 0; white-space: pre-wrap; }
.option__votes { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
.option__votes .v-progress-linear { flex: 1 1 auto; }
.option__count { flex: none; font-size: .8125rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); min-width: 96px; text-align: right; }
.option__foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.option__voters { min-width: 0; }

.options--large { gap: 16px; }
.options--large .option { padding: 20px 24px; }
.options--large .option--recommended { padding: 19px 23px; }
.options--large .option__title { font-size: 1.25rem; line-height: 1.5; }
.options--large .option__pc { font-size: 1.125rem; gap: 6px 16px; }
.options--large .option__count { font-size: 1.125rem; min-width: 140px; }
.options--large .option__label { font-size: .875rem; }
@media (max-width: 599px) { .option__pc { grid-template-columns: minmax(0, 1fr); } }
</style>
