<script setup lang="ts">
import type { Agenda } from '@yoda/shared'

const { t, locale } = useI18n()
const api = useApi()
const router = useRouter()
const canEdit = useCanEditAgendas()

const agendas = ref<Agenda[]>([])
const loadError = ref('')
const error = ref('')
const createOpen = ref(false)
const title = ref('')
const meetingAt = ref('')
const busy = ref(false)

const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH', { dateStyle: 'medium', timeStyle: 'short' })

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<Agenda[]>('/agendas')
    if (mine !== seq) return
    agendas.value = list
    loadError.value = ''
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

const now = Date.now()
const upcoming = computed(() => agendas.value.filter(a => new Date(a.meetingAt).getTime() >= now).sort((a, b) => a.meetingAt.localeCompare(b.meetingAt)))
const past = computed(() => agendas.value.filter(a => new Date(a.meetingAt).getTime() < now).sort((a, b) => b.meetingAt.localeCompare(a.meetingAt)))

function openCreate() {
  title.value = ''
  meetingAt.value = ''
  error.value = ''
  createOpen.value = true
}
async function create() {
  busy.value = true
  error.value = ''
  try {
    const a = await api<Agenda>('/agendas', {
      method: 'POST',
      body: { title: title.value.trim(), meetingAt: new Date(meetingAt.value).toISOString() },
    })
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
    <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/discussions" class="mb-2">{{ t('discussions.back') }}</v-btn>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ t('discussions.agenda.title') }}</h1>
      <v-spacer />
      <v-btn v-if="canEdit" color="primary" prepend-icon="mdi-plus" data-testid="agenda-new" @click="openCreate">{{ t('discussions.agenda.new') }}</v-btn>
    </div>
    <v-alert v-if="loadError" type="error" class="mb-4" data-testid="load-error">{{ loadError }}</v-alert>
    <p v-if="!agendas.length" class="text-medium-emphasis" data-testid="agendas-empty">{{ t('discussions.agenda.empty') }}</p>
    <template v-for="group in [{ key: 'upcoming', rows: upcoming }, { key: 'past', rows: past }]" :key="group.key">
      <template v-if="group.rows.length">
        <h2 class="text-h6 mb-2">{{ t(`discussions.agenda.${group.key}`) }}</h2>
        <v-list border lines="two" class="mb-6" :data-testid="`agendas-${group.key}`">
          <v-list-item v-for="a in group.rows" :key="a.id" :to="`/agendas/${a.id}`" data-testid="agenda-row">
            <v-list-item-title>{{ a.title }}</v-list-item-title>
            <v-list-item-subtitle>{{ fmt(a.meetingAt) }} · {{ t('discussions.agenda.items', { n: a.items.length }) }}</v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </template>
    </template>

    <v-dialog v-model="createOpen" max-width="440">
      <v-card :title="t('discussions.agenda.new')" data-testid="agenda-dialog">
        <v-card-text>
          <v-text-field v-model="title" :label="t('discussions.agenda.name')" maxlength="200" data-testid="agenda-title" />
          <v-text-field v-model="meetingAt" type="datetime-local" :label="t('discussions.agenda.meetingAt')" data-testid="agenda-date" />
          <v-alert v-if="error" type="error" density="compact" data-testid="agenda-error">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="createOpen = false">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="busy" :disabled="!title.trim() || !meetingAt" data-testid="agenda-create" @click="create">{{ t('discussions.agenda.create') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
