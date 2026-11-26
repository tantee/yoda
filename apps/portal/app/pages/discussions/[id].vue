<script setup lang="ts">
import type { Discussion, DiscussionResponse, ProjectDetail } from '@yoda/shared'
import { votersByOption } from '~/utils/discussions'

const { t } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string

const d = ref<Discussion | null>(null)
useBreadcrumb(() => (d.value ? [{ label: d.value.question }] : []))
const project = ref<ProjectDetail | null>(null)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const notFound = ref(false)
const error = ref('')
const busy = ref(false)
const voting = ref(false)
const editing = ref(false)
const decideOpen = ref(false)
const withdrawOpen = ref(false)
const withdrawTried = ref(false)
const withdrawError = ref('')
const reason = ref('')
const responses = ref<{ load: () => Promise<void>; vote: (key: string) => Promise<boolean> } | null>(null)
const voters = ref<Record<string, string[]>>({})

const isPm = computed(() => !!project.value?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM')))
const isAdmin = computed(() => !!me.value?.isAdmin)
const undecided = computed(() => d.value?.state === 'open' || d.value?.state === 'scheduled')
const canDecide = computed(() => undecided.value && (isAdmin.value || (!!d.value?.projectId && isPm.value)))
const canEdit = computed(() => undecided.value && (isAdmin.value || isPm.value || d.value?.raisedById === me.value?.id))
const { dateTime: fmt, date } = useDateFormat()
const decidedTitle = computed(() => d.value?.brief?.options.find(o => o.key === d.value?.decidedOptionKey)?.title ?? '')
const hasOptions = computed(() => !!d.value?.brief?.options.length && d.value.brief.status !== 'pending')

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
    if (mine !== seq) return
    notFound.value = errorKey(e) === 'errors.notFound'
    loadError.value = t(errorKey(e))
    loadFailure.value = e
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
function openWithdraw() {
  reason.value = ''
  withdrawTried.value = false
  withdrawError.value = ''
  withdrawOpen.value = true
}
async function withdraw() {
  withdrawTried.value = true
  if (!reason.value.trim()) return
  busy.value = true
  withdrawError.value = ''
  try {
    await api(`/discussions/${id}/withdraw`, { method: 'POST', body: { reason: reason.value.trim() } })
    withdrawOpen.value = false
    reason.value = ''
  } catch (e) {
    withdrawError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
  await load()
}
async function vote(key: string) {
  voting.value = true
  try {
    await responses.value?.vote(key)
  } finally {
    voting.value = false
  }
}
const onResponses = (list: DiscussionResponse[]) => {
  voters.value = votersByOption(list)
}
async function saved() {
  editing.value = false
  await load()
}
</script>

<template>
  <div>
    <EmptyState
      v-if="!d && notFound"
      icon="mdi-forum-remove-outline"
      wisdom="notFound"
      :title="t('discussions.notFound')"
      :text="t('discussions.notFoundText')"
      data-testid="load-error"
    >
      <v-btn color="primary" variant="flat" to="/discussions">{{ t('discussions.backToList') }}</v-btn>
    </EmptyState>
    <ErrorState v-else-if="!d && loadError" :error="loadFailure" data-testid="load-error" @retry="load" />
    <SkeletonDetail v-else-if="!d" />
    <template v-if="d">
      <PageHeader :title="d.question">
        <template #context>
          <StatusChip kind="discussion" :value="d.state" data-testid="state-chip" />
          <PriorityMark :priority="d.priority" />
        </template>
        <template #actions>
          <v-btn v-if="canDecide" color="primary" prepend-icon="mdi-gavel" data-testid="decide-btn" @click="decideOpen = true">{{ t('discussions.decide.button') }}</v-btn>
          <v-menu v-if="canEdit" location="bottom end">
            <template #activator="{ props: act }">
              <v-btn v-bind="act" icon="mdi-dots-horizontal" variant="outlined" size="small" :aria-label="t('discussions.more')" :title="t('discussions.more')" data-testid="more-btn" />
            </template>
            <v-list density="compact" data-testid="more-menu">
              <v-list-item v-if="d.brief?.status !== 'pending'" prepend-icon="mdi-pencil-outline" :title="t('discussions.brief.edit')" @click="editing = true" />
              <v-divider v-if="d.brief?.status !== 'pending'" class="my-1" />
              <v-list-item base-color="error" prepend-icon="mdi-close-circle-outline" :title="t('discussions.withdraw.menu')" data-testid="withdraw-btn" @click="openWithdraw" />
            </v-list>
          </v-menu>
        </template>
        <template #meta>
          <span><v-icon icon="mdi-account-outline" size="16" aria-hidden="true" /> {{ t('discussions.raisedBy', { name: d.raisedByName }) }}</span>
          <span><v-icon icon="mdi-calendar-outline" size="16" aria-hidden="true" /> {{ date(d.createdAt) }}</span>
        </template>
      </PageHeader>

      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

      <div class="disc-layout">
        <div class="disc-main">
          <v-card v-if="d.state === 'decided'" class="disc-decision mb-4" data-testid="decision">
            <div class="card-head"><h2><v-icon icon="mdi-check-decagram-outline" color="success" size="20" class="mr-1" aria-hidden="true" />{{ t('discussions.decision.title') }}</h2></div>
            <div class="card-body">
              <div v-if="d.decidedOptionKey" class="font-weight-medium mb-1">{{ decidedTitle }}</div>
              <div class="pre">{{ d.decision }}</div>
              <div class="text-caption text-medium-emphasis mt-2">{{ t('discussions.decision.by', { name: d.decidedByName ?? '', date: d.decidedAt ? fmt(d.decidedAt) : '' }) }}</div>
            </div>
          </v-card>
          <v-alert v-else-if="d.state === 'withdrawn'" type="info" variant="tonal" density="compact" class="mb-4" data-testid="withdrawn">{{ t('discussions.decision.withdrawn') }}</v-alert>

          <v-card v-if="d.details" class="mb-4">
            <div class="card-head"><h2>{{ t('discussions.details') }}</h2></div>
            <div class="card-body pre disc-reading" data-testid="details">{{ d.details }}</div>
          </v-card>

          <DiscussionsBriefEditor v-if="editing" :discussion="d" class="mb-4" @saved="saved" @cancel="editing = false" />
          <template v-else>
            <DiscussionsBriefView :discussion="d" :can-edit="canEdit" :can-retry="canEdit" :busy="busy" class="mb-4" @edit="editing = true" @retry="retry" />
            <section v-if="hasOptions" class="mb-6">
              <h2 class="disc-section">{{ t('discussions.brief.options') }}</h2>
              <DiscussionsOptionCards :discussion="d" :voters="voters" :can-vote="undecided" :busy="voting" @vote="vote" />
            </section>
          </template>

          <DiscussionsResponses ref="responses" :discussion="d" :can-respond="undecided" @changed="load" @loaded="onResponses" />
        </div>

        <aside class="disc-side">
          <v-card data-testid="side-details">
            <div class="card-head"><h2>{{ t('discussions.side.title') }}</h2></div>
            <dl class="card-body side-list">
              <dt>{{ t('discussions.project') }}</dt>
              <dd>
                <NuxtLink v-if="d.projectId" :to="`/projects/${d.projectId}`">{{ d.projectName }}</NuxtLink>
                <span v-else>{{ t('discussions.department') }}</span>
              </dd>
              <template v-if="d.workItemId">
                <dt>{{ t('discussions.workItem') }}</dt>
                <dd><NuxtLink :to="`/work-items/${d.workItemId}`" data-testid="work-item-link">{{ d.workItemTitle }}</NuxtLink></dd>
              </template>
              <template v-if="d.agendaId">
                <dt>{{ t('discussions.side.agenda') }}</dt>
                <dd><NuxtLink :to="`/agendas/${d.agendaId}`">{{ t('discussions.onAgenda') }}</NuxtLink></dd>
              </template>
              <dt>{{ t('discussions.side.raisedBy') }}</dt>
              <dd>{{ d.raisedByName }}</dd>
              <dt>{{ t('discussions.side.created') }}</dt>
              <dd>{{ fmt(d.createdAt) }}</dd>
            </dl>
          </v-card>
        </aside>
      </div>

      <DiscussionsDecideDialog v-model="decideOpen" :discussion="d" @decided="load" />
      <ConfirmDialog
        v-model="withdrawOpen"
        :title="t('discussions.withdraw.titleNamed', { question: d.question })"
        :text="t('discussions.withdraw.text')"
        :confirm-label="t('discussions.withdraw.submit')"
        destructive
        :busy="busy"
        :dirty="!!reason.trim()"
        :error="withdrawError"
        confirm-testid="withdraw-submit"
        data-testid="withdraw-dialog"
        @confirm="withdraw"
      >
        <v-textarea
          v-model="reason"
          :label="t('discussions.withdraw.reasonRequired')"
          rows="2"
          auto-grow
          class="mt-4"
          :error-messages="withdrawTried && !reason.trim() ? [t('discussions.withdraw.reasonMissing')] : []"
          data-testid="withdraw-reason"
        />
      </ConfirmDialog>
    </template>
  </div>
</template>

<style scoped>
.disc-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
@media (min-width: 1280px) { .disc-layout { grid-template-columns: minmax(0, 880px) 340px; } }
.disc-main, .disc-side { min-width: 0; }
.disc-section { margin: 0 0 8px; font-size: 1rem; font-weight: 600; }
.disc-reading { max-width: 720px; font-size: .9375rem; line-height: 1.7; }
.disc-decision { border-color: rgba(var(--v-theme-success-dot), .45) !important; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.side-list { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: .875rem; }
.side-list dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.side-list dd { margin: 0; overflow-wrap: anywhere; }
</style>
