<script setup lang="ts">
import type { Project, Proposal } from '@yoda/shared'

/**
 * Accept / reject controls for one pending proposal (shared by chat action cards and the to-do list):
 * right-aligned `[dismiss] [confirm]`, an optional hint on the left, and the reason when confirm is disabled.
 */
const props = defineProps<{ proposal: Proposal; confirmLabel?: string; dismissLabel?: string }>()
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
    <div class="proposal-decide">
      <div v-if="$slots.hint" class="proposal-decide__hint text-caption text-medium-emphasis"><slot name="hint" /></div>
      <v-select
        v-if="needsProject"
        v-model="chosenProject"
        :items="projects"
        item-title="name"
        item-value="id"
        :label="t('chat.card.chooseProject')"
        prepend-inner-icon="mdi-folder-outline"
        density="compact"
        hide-details
        class="proposal-decide__project"
        data-testid="proposal-project"
      />
      <div class="proposal-decide__actions">
        <v-btn size="small" variant="outlined" :disabled="busy" data-testid="proposal-dismiss" @click="dismissOpen = true">
          {{ dismissLabel ?? t('chat.card.dismiss') }}
        </v-btn>
        <v-btn
          size="small"
          color="primary"
          :loading="busy"
          :disabled="needsProject && !chosenProject"
          data-testid="proposal-confirm"
          @click="decide('accept')"
        >{{ confirmLabel ?? t('chat.card.confirm') }}</v-btn>
      </div>
    </div>
    <div v-if="needsProject && !chosenProject" class="text-caption text-medium-emphasis mt-1" data-testid="proposal-project-hint">
      {{ t('todo.chooseProjectFirst') }}
    </div>
    <v-alert v-if="error" type="error" density="compact" class="mt-2" data-testid="proposal-error">{{ error }}</v-alert>
    <AppDialog v-model="dismissOpen" :title="dismissLabel ?? t('chat.card.dismiss')" :busy="busy" :dirty="!!note.trim()" data-testid="dismiss-dialog">
      <v-textarea v-model="note" :label="noteRequired ? t('todo.dismissNoteRequired') : t('chat.card.dismissNote')" rows="2" auto-grow autofocus data-testid="dismiss-note" />
      <template #actions>
        <v-btn variant="text" :disabled="busy" @click="dismissOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="busy"
          :disabled="noteRequired && !note.trim()"
          data-testid="dismiss-submit"
          @click="decide('reject')"
        >{{ dismissLabel ?? t('chat.card.dismiss') }}</v-btn>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.proposal-decide { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.proposal-decide__hint { flex: 1 1 auto; min-width: 0; }
.proposal-decide__project { flex: 1 1 200px; max-width: 280px; }
.proposal-decide__actions { display: flex; gap: 8px; margin-left: auto; }
</style>
