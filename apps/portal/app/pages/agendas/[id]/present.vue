<script setup lang="ts">
import type { Agenda, Discussion, ProjectDetail } from '@yoda/shared'
import { briefFailKey } from '~/utils/discussions'

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
  <v-main class="present-main">
    <div class="present" data-testid="present">
      <header class="present__bar">
        <v-btn variant="text" prepend-icon="mdi-close" :to="`/agendas/${id}`" data-testid="present-exit">{{ t('discussions.agenda.exit') }}</v-btn>
        <span class="present__agenda">{{ agenda?.title }}</span>
        <div v-if="items.length" class="present__progress">
          <ol class="present__dots" :aria-label="t('discussions.agenda.progress')">
            <li v-for="(d, i) in items" :key="d.id">
              <button
                type="button"
                class="present__dot"
                :class="{ 'present__dot--done': i < index, 'present__dot--current': i === index }"
                :aria-current="i === index ? 'step' : undefined"
                :aria-label="t('discussions.agenda.goTo', { n: i + 1, question: d.question })"
                @click="index = i"
              />
            </li>
          </ol>
          <span class="present__position tabular-nums" data-testid="present-position">{{ t('discussions.agenda.position', { n: index + 1, total: items.length }) }}</span>
        </div>
      </header>

      <main class="present__body">
        <v-alert v-if="loadError" type="error" variant="tonal" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
        <template v-if="current">
          <div class="present__context">
            <StatusChip kind="discussion" :value="current.state" />
            <PriorityMark :priority="current.priority" />
            <span>{{ current.projectName ?? t('discussions.department') }}</span>
            <span v-if="current.workItemTitle">· {{ current.workItemTitle }}</span>
          </div>
          <h1 class="present__question" data-testid="present-question">{{ current.question }}</h1>
          <p v-if="current.details" class="present__details">{{ current.details }}</p>
          <div v-if="current.state === 'decided'" class="present__decision">
            <v-icon icon="mdi-check-decagram-outline" color="success" size="28" aria-hidden="true" />
            <div>
              <div class="present__decision-title">{{ t('discussions.decision.title') }}</div>
              <div class="pre">{{ current.decision }}</div>
            </div>
          </div>
          <div v-if="current.brief?.status === 'pending'" class="present__note">
            <StatusChip kind="aiStatus" value="drafting" :label="t('discussions.brief.preparing')" />
          </div>
          <v-alert v-else-if="current.brief?.status === 'failed'" type="warning" variant="tonal" class="mb-6 present__text">
            {{ t('discussions.brief.failed', { reason: t(briefFailKey(current.brief.failReason)) }) }}
          </v-alert>
          <template v-else-if="current.brief">
            <AiDraft v-if="current.brief.context && current.brief.source === 'ai'" class="present__brief">
              <MarkdownView :source="current.brief.context" class="present__text" />
            </AiDraft>
            <div v-else-if="current.brief.context" class="present__brief present__text"><MarkdownView :source="current.brief.context" /></div>
            <DiscussionsOptionCards v-if="current.brief.options.length" :discussion="current" large class="present__options" data-testid="present-votes" />
            <p v-if="current.brief.recommendation" class="present__text present__rec">
              <strong>{{ current.brief.source === 'ai' ? t('discussions.brief.aiRecommended') : t('discussions.brief.recommendation') }}:</strong> {{ current.brief.recommendation }}
            </p>
          </template>
          <v-btn v-if="canDecide" color="primary" size="x-large" prepend-icon="mdi-gavel" class="mt-2" data-testid="present-decide" @click="decideOpen = true">{{ t('discussions.decide.button') }}</v-btn>
          <DiscussionsDecideDialog v-model="decideOpen" :discussion="current" @decided="load" />
        </template>
      </main>

      <footer class="present__nav">
        <v-btn size="x-large" variant="outlined" :disabled="index === 0" prepend-icon="mdi-arrow-left" data-testid="present-prev" @click="go(-1)">{{ t('discussions.agenda.prev') }}</v-btn>
        <span class="present__hint"><kbd>←</kbd> <kbd>→</kbd> {{ t('discussions.agenda.presentHint') }}</span>
        <v-btn size="x-large" color="primary" :disabled="index >= items.length - 1" append-icon="mdi-arrow-right" data-testid="present-next" @click="go(1)">{{ t('discussions.agenda.next') }}</v-btn>
      </footer>
    </div>
  </v-main>
</template>

<style scoped>
.present-main { background: rgb(var(--v-theme-background)); min-height: 100vh; }
.present { display: flex; flex-direction: column; min-height: 100vh; max-width: 1200px; margin: 0 auto; padding: 16px 32px 24px; }
.present__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding-bottom: 12px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.present__agenda { flex: 1 1 200px; min-width: 0; font-size: 1.125rem; font-weight: 500; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); overflow-wrap: anywhere; }
.present__progress { display: flex; align-items: center; gap: 12px; }
.present__dots { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
.present__dot { display: block; width: 28px; height: 8px; border-radius: 4px; border: 0; padding: 0; cursor: pointer; background: #C4CCD8; }
.present__dot--done { background: rgb(var(--v-theme-primary)); }
.present__dot--current { background: transparent; box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary)); }
.present__position { font-size: 1.25rem; font-weight: 600; }
.present__body { flex: 1 1 auto; padding: 32px 0 24px; min-width: 0; overflow-wrap: anywhere; }
.present__context { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; font-size: 1.125rem; margin-bottom: 12px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.present__question { font-size: 2rem; font-weight: 600; line-height: 1.4; margin: 0 0 16px; }
.present__details { font-size: 1.25rem; line-height: 1.7; white-space: pre-wrap; margin: 0 0 24px; max-width: 960px; }
.present__text, .present__text :deep(p), .present__text :deep(li) { font-size: 1.25rem !important; line-height: 1.7 !important; }
.present__brief { margin-bottom: 24px; }
.present__options { margin-bottom: 24px; }
.present__rec { margin: 0 0 24px; white-space: pre-wrap; }
.present__note { margin-bottom: 24px; }
.present__decision { display: flex; gap: 12px; align-items: flex-start; padding: 16px 20px; margin-bottom: 24px; border-radius: 8px; background: rgb(var(--v-theme-success-soft)); color: rgb(var(--v-theme-success)); font-size: 1.25rem; }
.present__decision-title { font-weight: 600; }
.present__nav { display: flex; align-items: center; gap: 16px; padding-top: 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); position: sticky; bottom: 0; background: rgb(var(--v-theme-background)); padding-bottom: 8px; }
.present__hint { flex: 1 1 auto; text-align: center; font-size: .875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.present__hint kbd { display: inline-block; padding: 0 6px; border: 1px solid rgb(var(--v-theme-border-strong)); border-radius: 4px; font-family: inherit; }
.pre { white-space: pre-wrap; }
@media (max-width: 599px) {
  .present { padding: 12px 16px 16px; }
  .present__question { font-size: 1.5rem; }
  .present__hint { display: none; }
  .present__nav { justify-content: space-between; }
}
</style>
