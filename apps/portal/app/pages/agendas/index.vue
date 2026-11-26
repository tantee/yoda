<script setup lang="ts">
import type { Agenda } from '@yoda/shared'
import { meetingIso, splitAgendas } from '~/utils/agendas'

const { t } = useI18n()
const api = useApi()
const router = useRouter()
const canEdit = useCanEditAgendas()

const agendas = ref<Agenda[]>([])
const loaded = ref(false)
const loadError = ref('')
const loadFailure = ref<unknown>(null)
const error = ref('')
const createOpen = ref(false)
const title = ref('')
const day = ref<Date | null>(null)
const time = ref('09:00')
const dayOpen = ref(false)
const tried = ref(false)
const busy = ref(false)

const { dateTime: fmt, date } = useDateFormat()

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<Agenda[]>('/agendas')
    if (mine !== seq) return
    agendas.value = list
    loaded.value = true
    loadError.value = ''
  } catch (e) {
    if (mine !== seq) return
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

const groups = computed(() => splitAgendas(agendas.value, Date.now()))

const pad = (n: number) => String(n).padStart(2, '0')
const dayIso = computed(() => (day.value ? `${day.value.getFullYear()}-${pad(day.value.getMonth() + 1)}-${pad(day.value.getDate())}` : null))
const at = computed(() => meetingIso(dayIso.value, time.value))
const dirty = computed(() => !!title.value.trim() || !!day.value)

function openCreate() {
  title.value = ''
  day.value = null
  time.value = '09:00'
  error.value = ''
  tried.value = false
  createOpen.value = true
}
async function create() {
  tried.value = true
  if (!title.value.trim() || !at.value) return
  busy.value = true
  error.value = ''
  try {
    const a = await api<Agenda>('/agendas', { method: 'POST', body: { title: title.value.trim(), meetingAt: at.value } })
    createOpen.value = false
    await router.push(`/agendas/${a.id}`)
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('discussions.agenda.title')">
      <template v-if="canEdit" #actions>
        <v-btn color="primary" prepend-icon="mdi-plus" data-testid="agenda-new" @click="openCreate">{{ t('discussions.agenda.new') }}</v-btn>
      </template>
    </PageHeader>

    <ErrorState v-if="loadError && !loaded" :error="loadFailure" data-testid="load-error" @retry="load" />
    <v-card v-else-if="!loaded" data-testid="agendas-loading"><SkeletonList :rows="3" /></v-card>
    <EmptyState
      v-else-if="!agendas.length"
      wisdom="empty"
      icon="mdi-calendar-text-outline"
      :title="t('discussions.agenda.empty')"
      :text="t('discussions.agenda.emptyText')"
      data-testid="agendas-empty"
    >
      <v-btn v-if="canEdit" color="primary" prepend-icon="mdi-plus" @click="openCreate">{{ t('discussions.agenda.new') }}</v-btn>
    </EmptyState>
    <template v-else>
      <template v-for="group in [{ key: 'upcoming', rows: groups.upcoming }, { key: 'past', rows: groups.past }]" :key="group.key">
        <section v-if="group.rows.length" class="mb-6">
          <h2 class="agenda-group">{{ t(`discussions.agenda.${group.key}`) }}<span class="count-pill ml-2">{{ group.rows.length }}</span></h2>
          <v-card :data-testid="`agendas-${group.key}`">
            <ul class="agenda-list">
              <li v-for="a in group.rows" :key="a.id" data-testid="agenda-row" :class="{ 'agenda-row--past': group.key === 'past' }">
                <div class="agenda-row__date" aria-hidden="true">
                  <v-icon icon="mdi-calendar-text-outline" size="20" />
                </div>
                <div class="agenda-row__main">
                  <NuxtLink :to="`/agendas/${a.id}`" class="row-link">{{ a.title }}</NuxtLink>
                  <div class="text-caption text-medium-emphasis">{{ fmt(a.meetingAt) }}</div>
                </div>
                <span class="text-body-2 text-medium-emphasis text-no-wrap">{{ t('discussions.agenda.items', { n: a.items.length }) }}</span>
              </li>
            </ul>
          </v-card>
        </section>
      </template>
    </template>

    <AppDialog v-model="createOpen" :title="t('discussions.agenda.new')" :busy="busy" :dirty="dirty" data-testid="agenda-dialog">
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3" data-testid="agenda-error">{{ error }}</v-alert>
      <v-text-field
        v-model="title"
        :label="t('discussions.agenda.nameRequired')"
        maxlength="200"
        autofocus
        class="mb-3"
        :error-messages="tried && !title.trim() ? [t('discussions.agenda.nameMissing')] : []"
        data-testid="agenda-title"
      />
      <div class="agenda-when">
        <v-menu v-model="dayOpen" :close-on-content-click="false" location="bottom start">
          <template #activator="{ props: act }">
            <v-text-field
              v-bind="act"
              :model-value="dayIso ? date(dayIso) : ''"
              :label="t('discussions.agenda.day')"
              prepend-inner-icon="mdi-calendar-outline"
              readonly
              :error-messages="tried && !dayIso ? [t('discussions.agenda.dayMissing')] : []"
              data-testid="agenda-date"
            />
          </template>
          <v-card min-width="300">
            <v-date-picker
              v-model="day"
              :header="dayIso ? date(dayIso) : t('discussions.agenda.day')"
              :title="t('discussions.agenda.day')"
              show-adjacent-months
              data-testid="agenda-date-picker"
              @update:model-value="dayOpen = false"
            />
          </v-card>
        </v-menu>
        <v-text-field
          v-model="time"
          type="time"
          :label="t('discussions.agenda.time')"
          prepend-inner-icon="mdi-clock-outline"
          :error-messages="tried && dayIso && !at ? [t('discussions.agenda.timeMissing')] : []"
          data-testid="agenda-time"
        />
      </div>
      <p class="text-caption text-medium-emphasis mb-0">{{ t('discussions.agenda.timeHint') }}</p>
      <template #actions>
        <v-btn variant="text" :disabled="busy" @click="createOpen = false">{{ t('common.cancel') }}</v-btn>
        <v-btn color="primary" variant="flat" :loading="busy" data-testid="agenda-create" @click="create">{{ t('discussions.agenda.create') }}</v-btn>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.agenda-group { display: flex; align-items: center; margin: 0 0 8px; font-size: 1rem; font-weight: 600; }
.agenda-list { list-style: none; margin: 0; padding: 0; }
.agenda-list li { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.agenda-list li:first-child { border-top: 0; }
.agenda-row__date { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-primary)); }
.agenda-row--past .agenda-row__date { background: rgb(var(--v-theme-neutral-soft)); color: rgb(var(--v-theme-neutral)); }
.agenda-row__main { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.agenda-when { display: grid; grid-template-columns: minmax(0, 1fr) 160px; gap: 12px; }
@media (max-width: 599px) { .agenda-when { grid-template-columns: minmax(0, 1fr); } }
</style>
