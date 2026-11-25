<script setup lang="ts">
import type { TodoWorkItem } from '@yoda/shared'
import { localized } from '~/utils/localized'
import { guardOf } from '~/utils/guards'
import { proposalFallbackKey } from '~/utils/requests'
import { priorityChange, stepChange, type Decision } from '~/utils/todo'

/**
 * One "waiting for your decision" card (proposal §8.2 To-do): what kind of decision, the work item, the
 * project, the change and its reason, and bottom-right `[dismiss] [specific verb]`.
 */
const props = defineProps<{
  decision: Decision
  item?: TodoWorkItem
  projectName?: string
  advancing?: boolean
}>()
const emit = defineEmits<{ advance: [string]; decided: [] }>()
const { t, locale } = useI18n()
const { dateTime } = useDateFormat()

const KINDS = {
  advance: { icon: 'mdi-debug-step-over', label: 'todo.kind.advance', confirm: 'todo.verb.advance', dismiss: 'todo.verb.notYet' },
  step_advance: { icon: 'mdi-debug-step-over', label: 'todo.kind.advance', confirm: 'todo.verb.advance', dismiss: 'todo.verb.notYet' },
  priority_change: { icon: 'mdi-flag-outline', label: 'todo.kind.priority', confirm: 'todo.verb.confirm', dismiss: 'todo.verb.reject' },
  create_work_item: { icon: 'mdi-inbox-arrow-down-outline', label: 'todo.kind.intake', confirm: 'todo.verb.accept', dismiss: 'todo.verb.reject' },
  raise_discussion: { icon: 'mdi-forum-outline', label: 'todo.kind.discussion', confirm: 'todo.verb.raise', dismiss: 'todo.verb.reject' },
} as const

const p = computed(() => (props.decision.type === 'proposal' ? props.decision.proposal : null))
const kind = computed(() => KINDS[p.value ? p.value.kind : 'advance'])
const workItemId = computed(() => (props.decision.type === 'advance' ? props.decision.item.id : p.value?.workItemId ?? null))

const title = computed(() => {
  if (props.decision.type === 'advance') return props.decision.item.title
  const prop = props.decision.proposal
  if (prop.kind === 'create_work_item' && typeof prop.payload.title === 'string') return prop.payload.title
  if (props.item) return props.item.title
  if (prop.summary.trim()) return prop.summary
  const key = proposalFallbackKey(prop)
  return key ? t(key) : ''
})
const steps = computed(() => (p.value?.kind === 'step_advance' ? stepChange(p.value, props.item) : null))
const prio = computed(() => (p.value?.kind === 'priority_change' ? priorityChange(p.value, props.item) : null))
const guard = computed(() => (p.value ? guardOf(p.value.payload) : null))
const openDiscussions = computed(() => (props.decision.type === 'advance' ? props.decision.item.openDiscussions : 0))
</script>

<template>
  <v-card class="decision" :data-testid="decision.type === 'advance' ? 'awaiting-advance-item' : 'proposal-item'">
    <div class="decision__kind text-caption">
      <v-icon :icon="kind.icon" size="16" aria-hidden="true" />
      {{ t(kind.label) }}
      <span v-if="p?.createdByKind === 'ai'" class="decision__ai" data-testid="ai-proposed">
        <v-icon icon="mdi-creation-outline" size="14" aria-hidden="true" />{{ t('todo.aiProposed') }}
      </span>
    </div>
    <h3 class="decision__title text-subtitle-2" data-testid="proposal-summary">
      <NuxtLink v-if="workItemId" :to="`/work-items/${workItemId}`" class="decision__link">{{ title }}</NuxtLink>
      <template v-else>{{ title }}</template>
    </h3>
    <div class="decision__ctx text-body-2 text-medium-emphasis">
      <span v-if="item?.projectName || projectName"><v-icon icon="mdi-folder-outline" size="16" aria-hidden="true" />{{ item?.projectName ?? projectName }}</span>
      <span v-if="steps" class="decision__change" data-testid="step-change">
        <StatusChip kind="step" value="done" :label="t('todo.stepDone', { name: localized(steps.from, locale) })" />
        <v-icon icon="mdi-arrow-right" size="16" :aria-label="t('todo.changeTo')" />
        <StatusChip kind="step" value="current" :label="localized(steps.to, locale)" />
      </span>
      <span v-if="prio" class="decision__change" data-testid="priority-change">
        <PriorityMark v-if="prio.from" :priority="prio.from" />
        <v-icon icon="mdi-arrow-right" size="16" :aria-label="t('todo.changeTo')" />
        <PriorityMark :priority="prio.to" />
      </span>
      <span v-if="p?.requesterName" data-testid="proposal-requester">
        <v-icon icon="mdi-account-outline" size="16" aria-hidden="true" />{{ t('todo.requester', { name: p.requesterName }) }}
      </span>
      <span v-if="p?.kind === 'create_work_item'"><v-icon icon="mdi-clock-outline" size="16" aria-hidden="true" />{{ dateTime(p.createdAt) }}</span>
    </div>
    <ProposalPreview v-if="p" :proposal="p" />
    <GuardNote v-if="guard" :guard="guard" class="mt-2" />
    <div v-else-if="p?.reason" class="decision__reason text-body-2">{{ p.reason }}</div>

    <div class="decision__foot">
      <template v-if="decision.type === 'advance'">
        <div class="decision__actions">
          <span class="text-caption text-medium-emphasis">
            {{ openDiscussions ? t('todo.heldByDiscussions', { n: openDiscussions }) : t('todo.allTasksDone') }}
          </span>
          <v-btn
            v-if="!openDiscussions"
            color="primary"
            size="small"
            :loading="advancing"
            data-testid="todo-advance-btn"
            @click="emit('advance', decision.item.id)"
          >{{ t('todo.verb.advance') }}</v-btn>
        </div>
      </template>
      <ProposalDecide
        v-else
        :proposal="decision.proposal"
        :confirm-label="t(kind.confirm)"
        :dismiss-label="t(kind.dismiss)"
        @decided="emit('decided')"
      >
        <template v-if="p?.kind === 'step_advance' && !guard" #hint>{{ t('todo.allTasksDone') }}</template>
        <template v-else-if="p?.kind === 'create_work_item' && p.projectId && p.createdByKind === 'ai'" #hint>{{ t('todo.aiRouted') }}</template>
      </ProposalDecide>
    </div>
  </v-card>
</template>

<style scoped>
.decision { display: flex; flex-direction: column; gap: 8px; padding: 16px; min-width: 0; }
.decision__kind { display: flex; align-items: center; gap: 6px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.decision__ai { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; color: rgb(var(--v-theme-ai)); font-weight: 500; }
.decision__title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.decision__link { color: inherit; text-decoration: none; }
.decision__link:hover { text-decoration: underline; }
.decision__ctx { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; }
.decision__ctx > span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.decision__change { flex-wrap: wrap; }
.decision__reason { padding: 8px 12px; border-radius: 6px; background: rgb(var(--v-theme-background)); }
.decision__foot { margin-top: auto; }
.decision__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.decision__actions > span { margin-right: auto; }
</style>
