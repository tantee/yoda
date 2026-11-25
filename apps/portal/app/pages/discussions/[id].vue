<script setup lang="ts">
import type { Discussion, ProjectDetail } from '@yoda/shared'
import { voteSummary } from '~/utils/discussions'

const { t } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string

const d = ref<Discussion | null>(null)
const project = ref<ProjectDetail | null>(null)
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const editing = ref(false)
const decideOpen = ref(false)
const withdrawOpen = ref(false)
const reason = ref('')
const responses = ref<{ load: () => Promise<void> } | null>(null)

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const isAdmin = computed(() => !!me.value?.isAdmin)
const undecided = computed(() => d.value?.state === 'open' || d.value?.state === 'scheduled')
const canDecide = computed(() => undecided.value && (isAdmin.value || (!!d.value?.projectId && isPm.value)))
const canEdit = computed(() => undecided.value && (isAdmin.value || isPm.value || d.value?.raisedById === me.value?.id))
const { dateTime: fmt } = useDateFormat()
const decidedTitle = computed(() => d.value?.brief?.options.find(o => o.key === d.value?.decidedOptionKey)?.title ?? '')
const summary = computed(() => (d.value ? voteSummary(d.value) : []))

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const loaded = await api<Discussion>(`/discussions/${id}`)
    if (mine !== seq) return
    d.value = loaded
    loadError.value = ''
    if (loaded.projectId && !project.value) {
      try {
        project.value = await api<ProjectDetail>(`/projects/${loaded.projectId}`)
      } catch {
        project.value = null
      }
    }
    void responses.value?.load()
  } catch (e) {
    if (mine === seq) loadError.value = t(errorKey(e))
  }
}
let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 200)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
onMounted(load)
useLiveEvents((e) => {
  if (e.type.startsWith('discussion.')) loadSoon()
}, loadSoon)

async function retry() {
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${id}/brief/retry`, { method: 'POST' })
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
}
async function withdraw() {
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${id}/withdraw`, { method: 'POST', body: { reason: reason.value.trim() } })
    withdrawOpen.value = false
    reason.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
}
async function saved() {
  editing.value = false
  await load()
}
</script>

<template>
  <div>
    <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/discussions" class="mb-2">{{ t('discussions.back') }}</v-btn>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <template v-if="d">
      <div class="d-flex align-center ga-2 mb-2">
        <h1 class="text-h5" data-testid="question">{{ d.question }}</h1>
        <v-spacer />
        <v-btn v-if="canDecide" color="primary" data-testid="decide-btn" @click="decideOpen = true">{{ t('discussions.decide.button') }}</v-btn>
        <v-btn v-if="canEdit" variant="outlined" color="error" data-testid="withdraw-btn" @click="withdrawOpen = true">{{ t('discussions.withdraw.button') }}</v-btn>
      </div>
      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <StatusChip kind="discussion" :value="d.state" data-testid="state-chip" />
        <PriorityMark :priority="d.priority" />
        <v-chip size="small" variant="outlined" prepend-icon="mdi-account-outline">{{ t('discussions.raisedBy', { name: d.raisedByName }) }}</v-chip>
      </div>
      <p class="text-medium-emphasis mb-4">
        {{ t('discussions.project') }}:
        <NuxtLink v-if="d.projectId" :to="`/projects/${d.projectId}`">{{ d.projectName }}</NuxtLink>
        <span v-else>{{ t('discussions.department') }}</span>
        <template v-if="d.workItemId">
          · {{ t('discussions.workItem') }}: <NuxtLink :to="`/work-items/${d.workItemId}`" data-testid="work-item-link">{{ d.workItemTitle }}</NuxtLink>
        </template>
        <template v-if="d.agendaId"> · <NuxtLink :to="`/agendas/${d.agendaId}`">{{ t('discussions.onAgenda') }}</NuxtLink></template>
      </p>
      <p v-if="d.details" class="mb-4" style="white-space: pre-wrap" data-testid="details">{{ d.details }}</p>
      <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

      <v-alert v-if="d.state === 'decided'" type="success" variant="tonal" class="mb-4" :title="t('discussions.decision.title')" data-testid="decision">
        <div style="white-space: pre-wrap">{{ d.decision }}</div>
        <div v-if="d.decidedOptionKey" class="font-weight-medium">{{ decidedTitle }}</div>
        <div class="text-caption">{{ t('discussions.decision.by', { name: d.decidedByName ?? '', date: d.decidedAt ? fmt(d.decidedAt) : '' }) }}</div>
      </v-alert>
      <v-alert v-else-if="d.state === 'withdrawn'" type="info" variant="tonal" class="mb-4" data-testid="withdrawn">{{ t('discussions.decision.withdrawn') }}</v-alert>

      <DiscussionsBriefEditor v-if="editing" :discussion="d" class="mb-6" @saved="saved" @cancel="editing = false" />
      <DiscussionsBriefView v-else :discussion="d" :can-edit="canEdit" :can-retry="canEdit" :busy="busy" class="mb-6" @edit="editing = true" @retry="retry" />

      <div v-if="summary.length" class="mb-6" data-testid="vote-summary">
        <div v-for="s in summary" :key="s.key" class="d-flex ga-2">
          <span>{{ s.title }}</span><v-spacer /><strong>{{ s.votes }}</strong>
        </div>
      </div>

      <DiscussionsResponses ref="responses" :discussion="d" :can-respond="undecided" @changed="load" />

      <DiscussionsDecideDialog v-model="decideOpen" :discussion="d" @decided="load" />
      <v-dialog v-model="withdrawOpen" max-width="420">
        <v-card :title="t('discussions.withdraw.title')" data-testid="withdraw-dialog">
          <v-card-text>
            <v-textarea v-model="reason" :label="t('discussions.withdraw.reason')" rows="2" auto-grow data-testid="withdraw-reason" />
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn @click="withdrawOpen = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="error" :loading="busy" :disabled="!reason.trim()" data-testid="withdraw-submit" @click="withdraw">{{ t('discussions.withdraw.submit') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>
