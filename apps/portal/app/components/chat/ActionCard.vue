<script setup lang="ts">
import type { ActionCard, Project, Proposal } from '@yoda/shared'

const props = defineProps<{ card: ActionCard; proposal?: Proposal; canDecide?: boolean }>()
const emit = defineEmits<{ decided: [] }>()
const { t } = useI18n()
const { me } = useMe()
const api = useApi()

const busy = ref(false)
const error = ref('')
const dismissOpen = ref(false)
const note = ref('')
const projects = ref<Project[]>([])
const chosenProject = ref<string | null>(null)

/** Only same-site paths: a card's `to` is data, never a way off the portal. */
function internal(to: string): string | null {
  return to.startsWith('/') && !to.startsWith('//') ? to : null
}
const workItemLink = computed(() => {
  if (props.card.type !== 'work_item_created') return null
  return me.value?.isStaff ? `/work-items/${props.card.workItemId}` : '/requests'
})
const needsProject = computed(
  () => props.proposal?.kind === 'create_work_item' && !props.proposal.projectId,
)

watch(
  () => [props.canDecide, needsProject.value],
  async () => {
    if (props.canDecide && needsProject.value && !projects.value.length) {
      try {
        projects.value = await api<Project[]>('/projects')
      } catch {
        projects.value = []
      }
    }
  },
  { immediate: true },
)

async function decide(decision: 'accept' | 'reject') {
  if (!props.proposal) return
  error.value = ''
  busy.value = true
  try {
    await api(`/proposals/${props.proposal.id}/decide`, {
      method: 'POST',
      body: {
        decision,
        ...(decision === 'reject' && note.value.trim() ? { note: note.value.trim() } : {}),
        ...(decision === 'accept' && needsProject.value && chosenProject.value ? { projectId: chosenProject.value } : {}),
      },
    })
    dismissOpen.value = false
    note.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
    emit('decided')
  }
}

const noteRequired = computed(() => props.proposal?.kind === 'step_advance')
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
          <div data-testid="proposal-summary">{{ proposal.summary }}</div>
          <div v-if="proposal.reason" class="text-caption text-medium-emphasis">{{ proposal.reason }}</div>
          <div v-if="proposal.state !== 'pending' || !canDecide" class="mt-1">
            <v-chip size="small" :color="proposal.state === 'accepted' ? 'success' : undefined" data-testid="proposal-state">
              {{ t(`chat.card.state.${proposal.state}`) }}
            </v-chip>
          </div>
          <template v-if="proposal.state === 'pending' && canDecide">
            <v-select
              v-if="needsProject"
              v-model="chosenProject"
              :items="projects"
              item-title="name"
              item-value="id"
              :label="t('chat.card.chooseProject')"
              density="compact"
              hide-details
              class="mt-2"
              data-testid="proposal-project"
            />
            <div class="mt-2 d-flex ga-2">
              <v-btn
                size="small"
                color="primary"
                :loading="busy"
                :disabled="needsProject && !chosenProject"
                data-testid="proposal-confirm"
                @click="decide('accept')"
              >{{ t('chat.card.confirm') }}</v-btn>
              <v-btn size="small" variant="outlined" :disabled="busy" data-testid="proposal-dismiss" @click="dismissOpen = true">
                {{ t('chat.card.dismiss') }}
              </v-btn>
            </div>
          </template>
        </template>
        <v-alert v-if="error" type="error" density="compact" class="mt-2" data-testid="proposal-error">{{ error }}</v-alert>
        <v-dialog v-model="dismissOpen" max-width="420">
          <v-card>
            <v-card-title>{{ t('chat.card.dismiss') }}</v-card-title>
            <v-card-text>
              <v-textarea v-model="note" :label="t('chat.card.dismissNote')" rows="2" auto-grow data-testid="dismiss-note" />
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn @click="dismissOpen = false">{{ t('common.cancel') }}</v-btn>
              <v-btn
                color="primary"
                :loading="busy"
                :disabled="noteRequired && !note.trim()"
                data-testid="dismiss-submit"
                @click="decide('reject')"
              >{{ t('chat.card.dismiss') }}</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>
      </template>
    </v-card-text>
  </v-card>
</template>
