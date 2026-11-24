<script setup lang="ts">
import type { Notification } from '@yoda/shared'

const { t } = useI18n()
const api = useApi()
const { me } = useMe()
const items = ref<Notification[]>([])
const open = ref(false)

const unread = computed(() => items.value.filter(n => !n.readAt).length)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<Notification[]>('/me/notifications')
    if (mine === seq) items.value = list
  } catch {
    // the bell stays as it was
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
  if (e.type === 'notification.created' && (!e.personId || e.personId === me.value?.id)) loadSoon()
}, loadSoon)

async function markAll() {
  try {
    await api('/me/notifications/read', { method: 'POST', body: { all: true } })
  } catch {
    // reloaded below
  }
  await load()
}

async function openItem(n: Notification) {
  open.value = false
  if (!n.readAt) {
    try {
      await api('/me/notifications/read', { method: 'POST', body: { ids: [n.id] } })
    } catch {
      // not worth blocking navigation
    }
    void load()
  }
  // Same-site paths only.
  if (n.link && n.link.startsWith('/') && !n.link.startsWith('//')) await navigateTo(n.link)
}
</script>

<template>
  <v-menu v-model="open" :close-on-content-click="false" location="bottom end">
    <template #activator="{ props: activator }">
      <v-btn v-bind="activator" icon variant="text" :title="t('notifications.title')" data-testid="bell">
        <v-badge :model-value="unread > 0" :content="unread" color="error" data-testid="bell-count">
          <v-icon icon="mdi-bell-outline" />
        </v-badge>
      </v-btn>
    </template>
    <v-card min-width="320" max-width="400">
      <v-card-title class="d-flex align-center text-subtitle-1">
        {{ t('notifications.title') }}
        <v-spacer />
        <v-btn size="small" variant="text" :disabled="!unread" data-testid="mark-all-read" @click="markAll">
          {{ t('notifications.markAllRead') }}
        </v-btn>
      </v-card-title>
      <v-divider />
      <v-list v-if="items.length" lines="two" style="max-height: 420px; overflow-y: auto" data-testid="notification-list">
        <v-list-item
          v-for="n in items"
          :key="n.id"
          :title="n.title"
          :subtitle="n.body"
          :class="{ 'font-weight-bold': !n.readAt }"
          data-testid="notification-item"
          @click="openItem(n)"
        />
      </v-list>
      <p v-else class="pa-4 text-medium-emphasis" data-testid="notification-empty">{{ t('notifications.empty') }}</p>
    </v-card>
  </v-menu>
</template>
