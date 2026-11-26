<script setup lang="ts">
import type { Agenda, Discussion } from '@yoda/shared'
import { moveItem } from '~/utils/agendas'
import { briefFailKey } from '~/utils/discussions'

const { t } = useI18n()
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
const loadFailure = ref<unknown>(null)
const notFound = ref(false)
const error = ref('')
const deleteError = ref('')
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)
const busy = ref(false)
const deleteOpen = ref(false)
const addId = ref<string | null>(null)

const { dateTimeLong: fmt } = useDateFormat()
const ids = computed(() => agenda.value?.items.map(i => i.discussionId) ?? [])
const addItems = computed(() => candidates.value.filter(c => !ids.value.includes(c.id)).map(c => ({ value: c.id, title: c.question, subtitle: c.projectName ?? t('discussions.department') })))

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
    if (mine !== seq) return
    notFound.value = !agenda.value && errorKey(e) === 'errors.notFound'
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
function move(i: number, to: number) {
  if (to < 0 || to >= ids.value.length || to === i) return
  return putItems(moveItem(ids.value, i, to))
}
// Drag starts only from the handle (text and links in the row stay selectable); the whole row is the drag image.
function onDragStart(i: number, e: DragEvent) {
  dragFrom.value = i
  e.dataTransfer?.setData('text/plain', String(i))
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    const row = (e.currentTarget as HTMLElement | null)?.closest('li')
    if (row) e.dataTransfer.setDragImage(row, 16, 16)
  }
}
function onDrop(i: number) {
  const from = dragFrom.value
  dragFrom.value = null
  dragOver.value = null
  if (from !== null) void move(from, i)
}
function onDragEnd() {
  dragFrom.value = null
  dragOver.value = null
}
const remove = (i: number) => putItems(ids.value.filter((_, k) => k !== i))
async function add() {
  if (!addId.value) return
  const next = [...ids.value, addId.value]
  addId.value = null
  await putItems(next)
}
const printPage = () => window.print()
function openDelete() {
  deleteError.value = ''
  deleteOpen.value = true
}
async function deleteAgenda() {
  busy.value = true
  deleteError.value = ''
  try {
    await api(`/agendas/${id}`, { method: 'DELETE' })
    deleteOpen.value = false
    await router.push('/agendas')
  } catch (e) {
    deleteError.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <div class="no-print">
      <EmptyState v-if="!agenda && notFound" icon="mdi-calendar-remove-outline" wisdom="notFound" :title="t('discussions.agenda.notFound')" data-testid="load-error">
        <v-btn color="primary" variant="flat" to="/agendas">{{ t('discussions.agenda.backToList') }}</v-btn>
      </EmptyState>
      <ErrorState v-else-if="!agenda && loadError" :error="loadFailure" data-testid="load-error" @retry="load" />
      <SkeletonDetail v-else-if="!agenda" />
    </div>
    <template v-if="agenda">
      <div class="no-print">
        <PageHeader :title="agenda.title">
          <template #actions>
            <v-btn variant="outlined" prepend-icon="mdi-printer-outline" data-testid="print-btn" @click="printPage">{{ t('discussions.agenda.print') }}</v-btn>
            <v-btn color="primary" prepend-icon="mdi-presentation" :to="`/agendas/${id}/present`" :disabled="!agenda.items.length" data-testid="present-btn">{{ t('discussions.agenda.present') }}</v-btn>
            <v-menu v-if="canEdit" location="bottom end">
              <template #activator="{ props: act }">
                <v-btn v-bind="act" icon="mdi-dots-horizontal" variant="outlined" size="small" :aria-label="t('discussions.more')" :title="t('discussions.more')" data-testid="agenda-more" />
              </template>
              <v-list density="compact">
                <v-list-item base-color="error" prepend-icon="mdi-delete-outline" :title="t('discussions.agenda.deleteMenu')" data-testid="agenda-delete" @click="openDelete" />
              </v-list>
            </v-menu>
          </template>
          <template #meta>
            <span data-testid="agenda-when"><v-icon icon="mdi-calendar-clock-outline" size="16" aria-hidden="true" /> {{ fmt(agenda.meetingAt) }}</span>
            <span>{{ t('discussions.agenda.items', { n: agenda.items.length }) }}</span>
          </template>
        </PageHeader>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="action-error">{{ error }}</v-alert>

        <v-card class="agenda-card">
          <div class="card-head">
            <h2>{{ t('discussions.agenda.itemsTitle') }}</h2>
            <span v-if="!canEdit" class="text-caption text-medium-emphasis">{{ t('discussions.agenda.readOnly') }}</span>
            <span v-else-if="agenda.items.length > 1" class="text-caption text-medium-emphasis">{{ t('discussions.agenda.dragHint') }}</span>
          </div>
          <EmptyState v-if="!agenda.items.length" icon="mdi-format-list-numbered" :title="t('discussions.agenda.noItems')" :text="canEdit ? t('discussions.agenda.noItemsText') : undefined" data-testid="agenda-empty" />
          <ol v-else class="agenda-items" data-testid="agenda-items">
            <li
              v-for="(it, i) in agenda.items"
              :key="it.discussionId"
              class="agenda-item"
              :class="{ 'agenda-item--over': dragOver === i && dragFrom !== i, 'agenda-item--dragging': dragFrom === i }"
              data-testid="agenda-item"
              @dragover.prevent="dragOver = i"
              @dragleave="dragOver = dragOver === i ? null : dragOver"
              @drop.prevent="onDrop(i)"
            >
              <span
                v-if="canEdit"
                class="agenda-item__handle"
                :draggable="!busy"
                aria-hidden="true"
                data-testid="agenda-drag-handle"
                @dragstart="onDragStart(i, $event)"
                @dragend="onDragEnd"
              ><v-icon icon="mdi-drag-vertical" /></span>
              <span class="agenda-item__n tabular-nums">{{ i + 1 }}</span>
              <div class="agenda-item__main">
                <NuxtLink :to="`/discussions/${it.discussionId}`" class="row-link">{{ it.question }}</NuxtLink>
                <div class="agenda-item__meta">
                  <span class="text-caption text-medium-emphasis">{{ it.projectName ?? t('discussions.department') }}</span>
                  <PriorityMark :priority="it.priority" />
                  <StatusChip kind="discussion" :value="it.state" size="x-small" />
                </div>
              </div>
              <v-menu v-if="canEdit" location="bottom end">
                <template #activator="{ props: act }">
                  <v-btn v-bind="act" icon="mdi-dots-horizontal" variant="text" size="small" :disabled="busy" :aria-label="t('discussions.agenda.itemMenu', { n: i + 1 })" data-testid="item-menu" />
                </template>
                <v-list density="compact">
                  <v-list-item v-if="i > 0" prepend-icon="mdi-arrow-up" :title="t('discussions.agenda.moveUp')" data-testid="move-up" @click="move(i, i - 1)" />
                  <v-list-item v-if="i < agenda.items.length - 1" prepend-icon="mdi-arrow-down" :title="t('discussions.agenda.moveDown')" data-testid="move-down" @click="move(i, i + 1)" />
                  <v-divider class="my-1" />
                  <v-list-item base-color="error" prepend-icon="mdi-close" :title="t('discussions.agenda.remove')" data-testid="remove-item" @click="remove(i)" />
                </v-list>
              </v-menu>
            </li>
          </ol>
          <div v-if="canEdit" class="agenda-add">
            <v-autocomplete
              v-model="addId"
              :items="addItems"
              :label="t('discussions.agenda.add')"
              :no-data-text="t('discussions.agenda.addNone')"
              prepend-inner-icon="mdi-magnify"
              clearable
              data-testid="add-select"
            />
            <v-btn color="primary" variant="tonal" prepend-icon="mdi-plus" :disabled="!addId" :loading="busy" data-testid="add-btn" @click="add">{{ t('discussions.agenda.addAction') }}</v-btn>
          </div>
        </v-card>
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

      <ConfirmDialog
        v-model="deleteOpen"
        :title="t('discussions.agenda.deleteTitle', { title: agenda.title })"
        :text="t('discussions.agenda.deleteConfirm')"
        :confirm-label="t('discussions.agenda.delete')"
        destructive
        :busy="busy"
        :error="deleteError"
        confirm-testid="agenda-delete-confirm"
        data-testid="agenda-delete-dialog"
        @confirm="deleteAgenda"
      />
    </template>
  </div>
</template>

<style scoped>
.agenda-items { list-style: none; margin: 0; padding: 0; }
.agenda-item { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 12px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); background: rgb(var(--v-theme-surface)); }
.agenda-item:first-child { border-top: 0; }
.agenda-item__handle[draggable='true'] { cursor: grab; }
.agenda-item--dragging { opacity: .5; }
.agenda-item--over { box-shadow: inset 0 2px 0 rgb(var(--v-theme-primary)); }
.agenda-item__handle { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 36px; color: rgb(var(--v-theme-neutral-dot)); }
.agenda-item__n { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-on-primary-soft)); font-weight: 600; font-size: .875rem; }
.agenda-item__main { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.agenda-item__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 2px; }
.agenda-add { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.agenda-add > .v-input { flex: 1 1 280px; }
.agenda-add > .v-btn { margin-top: 2px; }
</style>

<style>
.print-only { display: none; }
.agenda-print .pre { white-space: pre-wrap; }
@media print {
  .no-print, .v-app-bar, .v-navigation-drawer, .v-bottom-navigation, .skip-link { display: none !important; }
  .print-only { display: block; }
  .v-main { padding: 0 !important; --v-layout-left: 0px !important; --v-layout-top: 0px !important; --v-layout-bottom: 0px !important; }
  .app-content { padding: 0 !important; }
  .v-application, body { background: #fff !important; color: #000 !important; font-family: 'IBM Plex Sans Thai', 'IBM Plex Sans', 'Thonburi', sans-serif; }
  .agenda-print h1 { font-size: 20pt; margin-bottom: 4pt; }
  .agenda-print h2 { font-size: 14pt; margin: 12pt 0 4pt; }
  .agenda-print .meta { font-size: 10pt; color: #444; }
  .print-item { break-inside: avoid; margin-bottom: 18pt; }
  .agenda-print .notes { border-bottom: 1px solid #000; min-height: 90pt; margin-top: 8pt; font-size: 10pt; }
}
</style>
