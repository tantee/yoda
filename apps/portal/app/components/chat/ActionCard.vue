<script setup lang="ts">
import type { ActionCard, Proposal } from '@yoda/shared'
import { proposalFallbackKey } from '~/utils/requests'

const props = defineProps<{ card: ActionCard; proposal?: Proposal; canDecide?: boolean }>()
const emit = defineEmits<{ decided: [] }>()
const { t } = useI18n()
const { me } = useMe()

/** Only same-site paths: a card's `to` is data, never a way off the portal. */
function internal(to: string): string | null {
  return to.startsWith('/') && !to.startsWith('//') ? to : null
}
const workItemLink = computed(() => {
  if (props.card.type !== 'work_item_created') return null
  return me.value?.isStaff ? `/work-items/${props.card.workItemId}` : '/requests'
})
</script>

<template>
  <v-card variant="outlined" class="mt-2" data-testid="action-card">
    <v-card-text class="py-2">
      <template v-if="card.type === 'work_item_created'">
        <v-icon icon="mdi-clipboard-plus-outline" size="small" class="mr-1" />
        {{ t('chat.card.workItemCreated') }}:
        <NuxtLink :to="workItemLink!">{{ card.title }}</NuxtLink>
      </template>
      <template v-else-if="card.type === 'knowledge_saved'">
        <v-icon icon="mdi-lightbulb-outline" size="small" class="mr-1" />
        {{ t('chat.card.knowledgeSaved') }}: {{ card.title }}
      </template>
      <template v-else-if="card.type === 'link'">
        <v-icon icon="mdi-link-variant" size="small" class="mr-1" />
        <NuxtLink v-if="internal(card.to)" :to="internal(card.to)!">{{ card.label }}</NuxtLink>
        <span v-else>{{ card.label }}</span>
      </template>
      <template v-else>
        <div>
          <v-icon icon="mdi-file-document-check-outline" size="small" class="mr-1" />
          <strong>{{ t('chat.card.proposal') }}</strong>
        </div>
        <template v-if="proposal">
          <div data-testid="proposal-summary">{{ proposal.summary || (proposalFallbackKey(proposal) ? t(proposalFallbackKey(proposal)!) : '') }}</div>
          <div v-if="proposal.reason" class="text-caption text-medium-emphasis">{{ proposal.reason }}</div>
          <div v-if="proposal.state !== 'pending' || !canDecide" class="mt-1">
            <v-chip size="small" :color="proposal.state === 'accepted' ? 'success' : undefined" data-testid="proposal-state">
              {{ t(`chat.card.state.${proposal.state}`) }}
            </v-chip>
          </div>
          <ProposalDecide v-if="proposal.state === 'pending' && canDecide" :proposal="proposal" @decided="emit('decided')" />
        </template>
      </template>
    </v-card-text>
  </v-card>
</template>
