<script setup lang="ts">
import type { ActionCard, Proposal } from '@yoda/shared'
import { proposalFallbackKey } from '~/utils/requests'
import { guardOf } from '~/utils/guards'
import { DECISION_KINDS } from '~/utils/todo'

/**
 * One action card in a chat message (proposal §8.2 chat): kind icon + kind label, a title naming the object,
 * a state chip and a real button. Proposal cards carry the same content as To-do decision cards.
 */
const props = defineProps<{ card: ActionCard; proposal?: Proposal; canDecide?: boolean }>()
const emit = defineEmits<{ decided: [] }>()
const { t } = useI18n()
const { me } = useMe()

/** Only same-site paths: a card's `to` is data, never a way off the portal. */
function internal(to: string): string | null {
  return to.startsWith('/') && !to.startsWith('//') ? to : null
}
const staff = computed(() => !!me.value?.isStaff)
const workItemLink = computed(() => {
  if (props.card.type !== 'work_item_created') return null
  return staff.value ? `/work-items/${props.card.workItemId}` : '/requests'
})
const kind = computed(() => (props.proposal ? DECISION_KINDS[props.proposal.kind] : null))
const proposalTitle = computed(() => {
  const p = props.proposal
  if (!p) return ''
  if (p.kind === 'create_work_item' && typeof p.payload.title === 'string' && p.payload.title.trim()) return p.payload.title
  if (p.summary.trim()) return p.summary
  const key = proposalFallbackKey(p)
  return key ? t(key) : ''
})
/** The summary when the title is the request title (so nothing is lost). */
const proposalSummary = computed(() => (props.proposal && props.proposal.summary.trim() && props.proposal.summary !== proposalTitle.value ? props.proposal.summary : ''))
const guard = computed(() => (props.proposal ? guardOf(props.proposal.payload) : null))
/** A requester's own pending request reads "sent to the team" rather than "awaiting a decision". */
const stateLabel = computed(() => {
  const p = props.proposal
  if (!p) return ''
  return p.state === 'pending' && !staff.value ? t('chat.card.state.sentToTeam') : t(`chat.card.state.${p.state}`)
})
</script>

<template>
  <div class="action-card" :class="`action-card--${card.type}`" data-testid="action-card">
    <template v-if="card.type === 'work_item_created'">
      <div class="action-card__row">
        <span class="action-card__icon action-card__icon--success"><v-icon icon="mdi-clipboard-check-outline" size="18" aria-hidden="true" /></span>
        <div class="action-card__main">
          <div class="action-card__kind">{{ t('chat.card.workItemCreated') }}</div>
          <div class="action-card__title">{{ card.title }}</div>
        </div>
        <v-btn :to="workItemLink!" size="small" variant="tonal" color="primary" data-testid="action-card-open">
          {{ staff ? t('chat.card.openWorkItem') : t('chat.card.openRequest') }}
        </v-btn>
      </div>
    </template>
    <template v-else-if="card.type === 'knowledge_saved'">
      <div class="action-card__row">
        <span class="action-card__icon action-card__icon--info"><v-icon icon="mdi-lightbulb-outline" size="18" aria-hidden="true" /></span>
        <div class="action-card__main">
          <div class="action-card__kind">{{ t('chat.card.knowledgeSaved') }}</div>
          <div class="action-card__title">{{ card.title }}</div>
        </div>
      </div>
    </template>
    <template v-else-if="card.type === 'link'">
      <div class="action-card__row">
        <span class="action-card__icon action-card__icon--info"><v-icon icon="mdi-link-variant" size="18" aria-hidden="true" /></span>
        <div class="action-card__main">
          <div class="action-card__title">{{ card.label }}</div>
        </div>
        <v-btn v-if="internal(card.to)" :to="internal(card.to)!" size="small" variant="tonal" color="primary" data-testid="action-card-open">{{ t('chat.card.open') }}</v-btn>
      </div>
    </template>
    <template v-else>
      <div class="action-card__row">
        <span class="action-card__icon action-card__icon--warning"><v-icon :icon="kind?.icon ?? 'mdi-file-document-check-outline'" size="18" aria-hidden="true" /></span>
        <div class="action-card__main">
          <div class="action-card__kind">
            {{ kind ? t(kind.label) : t('chat.card.proposal') }}
            <span v-if="proposal?.createdByKind === 'ai' && staff" class="action-card__ai">
              <v-icon icon="mdi-creation-outline" size="14" aria-hidden="true" />{{ t('todo.aiProposed') }}
            </span>
          </div>
          <div v-if="proposal" class="action-card__title" data-testid="proposal-summary">{{ proposalTitle }}</div>
          <div v-else-if="!staff" class="action-card__title" data-testid="proposal-summary">{{ t('chat.card.requestSent') }}</div>
        </div>
        <v-btn v-if="!proposal && !staff" to="/requests" size="small" variant="tonal" color="primary" data-testid="action-card-open">{{ t('chat.card.myRequests') }}</v-btn>
        <StatusChip
          v-if="proposal && (proposal.state !== 'pending' || !canDecide)"
          kind="proposal"
          :value="proposal.state"
          :label="stateLabel"
          size="x-small"
          data-testid="proposal-state"
        />
      </div>
      <div v-if="proposal" class="action-card__body">
        <div v-if="proposalSummary" class="text-body-2">{{ proposalSummary }}</div>
        <ProposalPreview :proposal="proposal" />
        <div v-if="proposal.requesterName && staff" class="text-body-2 text-medium-emphasis" data-testid="proposal-requester">
          {{ t('todo.requester', { name: proposal.requesterName }) }}
        </div>
        <GuardNote v-if="guard" :guard="guard" />
        <div v-else-if="proposal.reason" class="action-card__reason text-body-2">{{ proposal.reason }}</div>
        <ProposalDecide
          v-if="proposal.state === 'pending' && canDecide"
          :proposal="proposal"
          :confirm-label="kind ? t(kind.confirm) : undefined"
          :dismiss-label="kind ? t(kind.dismiss) : undefined"
          @decided="emit('decided')"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.action-card {
  margin-top: 8px; padding: 12px; border-radius: 8px; color: rgb(var(--v-theme-on-surface));
  background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.action-card__row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.action-card__icon { flex: none; width: 32px; height: 32px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; }
.action-card__icon--success { background: rgb(var(--v-theme-success-soft)); color: rgb(var(--v-theme-success)); }
.action-card__icon--info { background: rgb(var(--v-theme-info-soft)); color: rgb(var(--v-theme-info)); }
.action-card__icon--warning { background: rgb(var(--v-theme-warning-soft)); color: rgb(var(--v-theme-warning)); }
.action-card__main { flex: 1 1 160px; min-width: 0; }
.action-card__kind { display: flex; align-items: center; gap: 8px; font-size: .75rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.action-card__ai { display: inline-flex; align-items: center; gap: 2px; color: rgb(var(--v-theme-ai)); font-weight: 500; }
.action-card__title { font-weight: 600; overflow-wrap: anywhere; }
.action-card__body { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.action-card__reason { padding: 8px 12px; border-radius: 6px; background: rgb(var(--v-theme-background)); }
</style>
