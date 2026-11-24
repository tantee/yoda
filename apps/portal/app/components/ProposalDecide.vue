<script setup lang="ts">
import type { Project, Proposal } from '@yoda/shared'

/** Accept / reject controls for one pending proposal (shared by chat action cards and the to-do list). */
const props = defineProps<{ proposal: Proposal }>()
const emit = defineEmits<{ decided: [] }>()
const { t } = useI18n()
const api = useApi()

const busy = ref(false)
const error = ref('')
const dismissOpen = ref(false)
const note = ref('')
const projects = ref<Project[]>([])
const chosenProject = ref<string | null>(null)

const needsProject = computed(() => props.proposal.kind === 'create_work_item' && !props.proposal.projectId)
const noteRequired = computed(() => props.proposal.kind === 'step_advance')

watch(
  needsProject,
  async (needs) => {
    if (needs && !projects.value.length) {
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
</script>

<template>
  <div>
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
  </div>
</template>
