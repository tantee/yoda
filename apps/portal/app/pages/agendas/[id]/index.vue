<script setup lang="ts">
import type { Agenda, Discussion } from '@yoda/shared'
import { briefFailKey } from '~/utils/discussions'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const api = useApi()
const id = route.params.id as string
const canEdit = useCanEditAgendas()

const agenda = ref<Agenda | null>(null)
useBreadcrumb(() => (agenda.value ? [{ label: agenda.value.title }] : []))
const full = ref<Record<string, Discussion>>({})
const candidates = ref<Discussion[]>([])
const loadError = ref('')
const error = ref('')
const busy = ref(false)
const deleteOpen = ref(false)
const addId = ref<string | null>(null)

const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'full', timeStyle: 'short' })
const ids = computed(() => agenda.value?.items.map(i => i.discussionId) ?? [])
const addItems = computed(() => candidates.value.filter(c => !ids.value.includes(c.id)).map(c => ({ value: c.id, title: c.question })))

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const a = await api<Agenda>(`/agendas/${id}`)
    if (mine !== seq) return
    agenda.value = a
    loadError.value = ''
    const details = await Promise.all(a.items.map(i => api<Discussion>(`/discussions/${i.discussionId}`).catch(() => null)))
    if (mine !== seq) return
    full.value = Object.fromEntries(details.filter((x): x is Discussion => !!x).map(x => [x.id, x]))
    if (canEdit.value) candidates.value = await api<Discussion[]>('/discussions', { query: { state: 'open' } })
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
watch(canEdit, (v) => {
  if (v) loadSoon()
})
useLiveEvents((e) => {
  if (e.type.startsWith('discussion.')) loadSoon()
}, loadSoon)

async function putItems(next: string[]) {
  busy.value = true
  error.value = ''
  try {
    agenda.value = await api<Agenda>(`/agendas/${id}/items`, { method: 'PUT', body: { discussionIds: next } })
    seq++
    await load()
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
function move(i: number, by: -1 | 1) {
  const next = [...ids.value]
  const j = i + by
  if (j < 0 || j >= next.length) return
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  return putItems(next)
}
const remove = (i: number) => putItems(ids.value.filter((_, k) => k !== i))
async function add() {
  if (!addId.value) return
  const next = [...ids.value, addId.value]
  addId.value = null
  await putItems(next)
}
const printPage = () => window.print()
async function deleteAgenda() {
  busy.value = true
  try {
    await api(`/agendas/${id}`, { method: 'DELETE' })
    await router.push('/agendas')
  } catch (e) {
    error.value = t(errorKey(e))
    deleteOpen.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="no-print">
      <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/agendas" class="mb-2">{{ t('discussions.agenda.back') }}</v-btn>
      <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    </div>
    <template v-if="agenda">
      <div class="no-print">
        <div class="d-flex flex-wrap align-center ga-2 mb-1">
          <h1 class="text-h5" data-testid="agenda-title">{{ agenda.title }}</h1>
          <v-spacer />
          <v-btn color="primary" prepend-icon="mdi-presentation" :to="`/agendas/${id}/present`" :disabled="!agenda.items.length" data-testid="present-btn">{{ t('discussions.agenda.present') }}</v-btn>
          <v-btn variant="outlined" prepend-icon="mdi-printer-outline" data-testid="print-btn" @click="printPage">{{ t('discussions.agenda.print') }}</v-btn>
          <v-btn v-if="canEdit" variant="outlined" color="error" icon="mdi-delete-outline" :title="t('discussions.agenda.delete')" data-testid="agenda-delete" @click="deleteOpen = true" />
        </div>
        <p class="text-medium-emphasis mb-4">{{ fmt(agenda.meetingAt) }}</p>
        <v-alert v-if="error" type="error" class="mb-4" data-testid="action-error">{{ error }}</v-alert>
        <p v-if="!canEdit" class="text-caption text-medium-emphasis mb-2">{{ t('discussions.agenda.readOnly') }}</p>

        <p v-if="!agenda.items.length" class="text-medium-emphasis" data-testid="agenda-empty">{{ t('discussions.agenda.noItems') }}</p>
        <v-list v-else border lines="two" class="mb-4" data-testid="agenda-items">
          <v-list-item v-for="(it, i) in agenda.items" :key="it.discussionId" data-testid="agenda-item">
            <template #prepend><span class="mr-3 text-h6">{{ i + 1 }}</span></template>
            <v-list-item-title>
              <NuxtLink :to="`/discussions/${it.discussionId}`">{{ it.question }}</NuxtLink>
            </v-list-item-title>
            <v-list-item-subtitle>{{ it.projectName ?? t('discussions.department') }} · {{ t(`priority.${it.priority}`) }} · {{ t(`discussions.state.${it.state}`) }}</v-list-item-subtitle>
            <template v-if="canEdit" #append>
              <v-btn icon="mdi-arrow-up" size="small" variant="text" :disabled="i === 0 || busy" :title="t('discussions.agenda.moveUp')" data-testid="move-up" @click="move(i, -1)" />
              <v-btn icon="mdi-arrow-down" size="small" variant="text" :disabled="i === agenda.items.length - 1 || busy" :title="t('discussions.agenda.moveDown')" data-testid="move-down" @click="move(i, 1)" />
              <v-btn icon="mdi-close" size="small" variant="text" :disabled="busy" :title="t('discussions.agenda.remove')" data-testid="remove-item" @click="remove(i)" />
            </template>
          </v-list-item>
        </v-list>

        <div v-if="canEdit" class="d-flex ga-2 align-center">
          <v-select v-model="addId" :items="addItems" :label="t('discussions.agenda.add')" :no-data-text="t('discussions.agenda.addNone')" density="compact" hide-details data-testid="add-select" />
          <v-btn color="primary" :disabled="!addId" :loading="busy" data-testid="add-btn" @click="add">{{ t('discussions.agenda.addAction') }}</v-btn>
        </div>
      </div>

      <!-- Printable layout: shown only when printing. -->
      <div class="print-only agenda-print" data-testid="print-layout">
        <h1>{{ agenda.title }}</h1>
        <p>{{ fmt(agenda.meetingAt) }}</p>
        <section v-for="(it, i) in agenda.items" :key="it.discussionId" class="print-item">
          <h2>{{ i + 1 }}. {{ it.question }}</h2>
          <p class="meta">{{ it.projectName ?? t('discussions.department') }} · {{ t(`priority.${it.priority}`) }}</p>
          <template v-if="full[it.discussionId]">
            <p v-if="full[it.discussionId]!.details" class="pre">{{ full[it.discussionId]!.details }}</p>
            <p v-if="full[it.discussionId]!.brief?.status === 'failed'" class="meta">
              {{ t('discussions.brief.failed', { reason: t(briefFailKey(full[it.discussionId]!.brief!.failReason)) }) }}
            </p>
            <template v-if="full[it.discussionId]!.brief && full[it.discussionId]!.brief!.status !== 'pending'">
              <p v-if="full[it.discussionId]!.brief!.context" class="pre">{{ full[it.discussionId]!.brief!.context }}</p>
              <ul>
                <li v-for="o in full[it.discussionId]!.brief!.options" :key="o.key">
                  <strong>{{ o.title }}</strong>
                  <template v-if="o.key === full[it.discussionId]!.brief!.recommendedKey"> ({{ t('discussions.brief.recommended') }})</template>
                  · {{ t('discussions.votes', { n: full[it.discussionId]!.voteCounts[o.key] ?? 0 }) }}
                  <div v-if="o.pros" class="pre">{{ t('discussions.brief.pros') }}: {{ o.pros }}</div>
                  <div v-if="o.cons" class="pre">{{ t('discussions.brief.cons') }}: {{ o.cons }}</div>
                </li>
              </ul>
              <p v-if="full[it.discussionId]!.brief!.recommendation" class="pre">{{ t('discussions.brief.recommendation') }}: {{ full[it.discussionId]!.brief!.recommendation }}</p>
            </template>
          </template>
          <div class="notes">{{ t('discussions.agenda.notes') }}:</div>
        </section>
      </div>

      <v-dialog v-model="deleteOpen" max-width="420">
        <v-card :title="t('discussions.agenda.delete')" :text="t('discussions.agenda.deleteConfirm')">
          <v-card-actions>
            <v-spacer />
            <v-btn @click="deleteOpen = false">{{ t('common.cancel') }}</v-btn>
            <v-btn color="error" :loading="busy" data-testid="agenda-delete-confirm" @click="deleteAgenda">{{ t('discussions.agenda.delete') }}</v-btn>
          </v-card-actions>
        </v-card>
      </v-dialog>
    </template>
  </div>
</template>

<style>
.print-only { display: none; }
.agenda-print .pre { white-space: pre-wrap; }
@media print {
  .no-print, .v-app-bar, .v-navigation-drawer { display: none !important; }
  .print-only { display: block; }
  .v-main { padding: 0 !important; }
  .v-application, body { background: #fff !important; color: #000 !important; font-family: 'Noto Sans Thai', 'Sarabun', 'Thonburi', sans-serif; }
  .agenda-print h1 { font-size: 20pt; margin-bottom: 4pt; }
  .agenda-print h2 { font-size: 14pt; margin: 12pt 0 4pt; }
  .agenda-print .meta { font-size: 10pt; color: #444; }
  .print-item { break-inside: avoid; margin-bottom: 18pt; }
  .agenda-print .notes { border-bottom: 1px solid #000; min-height: 90pt; margin-top: 8pt; font-size: 10pt; }
}
</style>
