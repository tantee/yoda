<script setup lang="ts">
import type { Agenda, Discussion, ProjectDetail } from '@yoda/shared'
import { briefFailKey, voteSummary } from '~/utils/discussions'

definePageMeta({ layout: false })

const { t } = useI18n()
const { me } = useMe()
const route = useRoute()
const api = useApi()
const id = route.params.id as string

const agenda = ref<Agenda | null>(null)
const items = ref<Discussion[]>([])
const projects = ref<Record<string, ProjectDetail | null>>({})
const loadError = ref('')
const index = ref(0)
const decideOpen = ref(false)

const current = computed(() => items.value[index.value] ?? null)
const summary = computed(() => (current.value ? voteSummary(current.value) : []))
const isPmOf = (d: Discussion) => !!d.projectId && !!projects.value[d.projectId]?.members.some(m => m.personId === me.value?.id && m.roles.includes('PM'))
const canDecide = computed(() => !!current.value && (current.value.state === 'open' || current.value.state === 'scheduled') && (!!me.value?.isAdmin || isPmOf(current.value)))

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const a = await api<Agenda>(`/agendas/${id}`)
    const list = (await Promise.all(a.items.map(i => api<Discussion>(`/discussions/${i.discussionId}`).catch(() => null)))).filter((x): x is Discussion => !!x)
    if (mine !== seq) return
    agenda.value = a
    items.value = list
    index.value = Math.min(index.value, Math.max(list.length - 1, 0))
    loadError.value = ''
    for (const pid of new Set(list.map(d => d.projectId).filter((x): x is string => !!x))) {
      if (!(pid in projects.value)) projects.value[pid] = await api<ProjectDetail>(`/projects/${pid}`).catch(() => null)
    }
  } catch (e) {
    if (mine === seq) loadError.value = t(errorKey(e))
  }
}
let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 200)
}

function go(by: -1 | 1) {
  index.value = Math.min(Math.max(index.value + by, 0), Math.max(items.value.length - 1, 0))
}
function onKey(e: KeyboardEvent) {
  if (decideOpen.value || e.altKey || e.ctrlKey || e.metaKey) return
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.key === 'ArrowRight') go(1)
  else if (e.key === 'ArrowLeft') go(-1)
}
onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (timer) clearTimeout(timer)
})
useLiveEvents((e) => {
  if (e.type.startsWith('discussion.')) loadSoon()
}, loadSoon)
</script>

<template>
  <v-main>
      <v-container class="present" data-testid="present">
        <div class="d-flex align-center mb-4">
          <v-btn variant="text" prepend-icon="mdi-close" :to="`/agendas/${id}`" data-testid="present-exit">{{ t('discussions.agenda.exit') }}</v-btn>
          <v-spacer />
          <span class="text-medium-emphasis mr-4">{{ agenda?.title }}</span>
          <span v-if="current" data-testid="present-position">{{ t('discussions.agenda.position', { n: index + 1, total: items.length }) }}</span>
        </div>
        <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
        <template v-if="current">
          <div class="d-flex flex-wrap ga-2 mb-2">
            <StatusChip kind="discussion" :value="current.state" />
            <PriorityMark :priority="current.priority" />
            <v-chip size="small" variant="outlined">{{ current.projectName ?? t('discussions.department') }}</v-chip>
          </div>
          <h1 class="text-h4 mb-3" data-testid="present-question">{{ current.question }}</h1>
          <p v-if="current.details" class="mb-4" style="white-space: pre-wrap">{{ current.details }}</p>
          <v-alert v-if="current.state === 'decided'" type="success" variant="tonal" class="mb-4" :title="t('discussions.decision.title')">
            <div style="white-space: pre-wrap">{{ current.decision }}</div>
          </v-alert>
          <v-alert v-if="current.brief?.status === 'pending'" type="info" variant="tonal" density="compact" class="mb-4">{{ t('discussions.brief.preparing') }}</v-alert>
          <v-alert v-else-if="current.brief?.status === 'failed'" type="warning" variant="tonal" density="compact" class="mb-4">
            {{ t('discussions.brief.failed', { reason: t(briefFailKey(current.brief.failReason)) }) }}
          </v-alert>
          <DiscussionsBriefView v-else :discussion="current" class="mb-4" />
          <div v-if="summary.length" class="mb-4" data-testid="present-votes">
            <div v-for="s in summary" :key="s.key" class="d-flex ga-2 text-h6">
              <span>{{ s.title }}</span><v-spacer /><strong>{{ s.votes }}</strong>
            </div>
          </div>
          <v-btn v-if="canDecide" color="primary" size="large" data-testid="present-decide" @click="decideOpen = true">{{ t('discussions.decide.button') }}</v-btn>
          <DiscussionsDecideDialog v-model="decideOpen" :discussion="current" @decided="load" />
        </template>
        <div class="d-flex mt-8">
          <v-btn :disabled="index === 0" prepend-icon="mdi-arrow-left" data-testid="present-prev" @click="go(-1)">{{ t('discussions.agenda.prev') }}</v-btn>
          <v-spacer />
          <span class="text-caption text-medium-emphasis align-self-center">{{ t('discussions.agenda.presentHint') }}</span>
          <v-spacer />
          <v-btn :disabled="index >= items.length - 1" append-icon="mdi-arrow-right" data-testid="present-next" @click="go(1)">{{ t('discussions.agenda.next') }}</v-btn>
        </div>
      </v-container>
  </v-main>
</template>
