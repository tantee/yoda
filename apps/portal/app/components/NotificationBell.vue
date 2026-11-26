<script setup lang="ts">
import type { Notification } from '@yoda/shared'
import { capCount } from '~/utils/nav'
import { isLocalRoute, NOTIFICATION_ICONS } from '~/utils/search'

const { t } = useI18n()
const { relative, dateTime } = useDateFormat()
const api = useApi()
const { me } = useMe()
const items = ref<Notification[]>([])
const open = ref(false)

const unread = computed(() => items.value.filter(n => !n.readAt).length)
// The bell caps at 9+ (proposal §5.3).
const badge = computed(() => capCount(unread.value, 9))

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
  if (isLocalRoute(n.link)) await navigateTo(n.link)
}
</script>

<template>
  <v-menu v-model="open" :close-on-content-click="false" location="bottom end">
    <template #activator="{ props: activator }">
      <v-btn
        v-bind="activator"
        icon
        variant="text"
        :title="t('notifications.title')"
        :aria-label="unread ? t('shell.notificationsCount', { n: badge }) : t('notifications.title')"
        data-testid="bell"
      >
        <v-badge :model-value="unread > 0" :content="badge ?? ''" color="error" data-testid="bell-count">
          <v-icon icon="mdi-bell-outline" />
        </v-badge>
      </v-btn>
    </template>
    <v-card min-width="320" max-width="400" width="min(400px, calc(100vw - 24px))">
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
          :class="{ 'notification--unread': !n.readAt }"
          data-testid="notification-item"
          @click="openItem(n)"
        >
          <template #prepend>
            <v-icon :icon="NOTIFICATION_ICONS[n.kind] ?? 'mdi-bell-outline'" size="20" color="primary" class="mr-n2" aria-hidden="true" />
          </template>
          <v-list-item-title class="notification__title">{{ n.title }}</v-list-item-title>
          <v-list-item-subtitle>{{ n.body }}</v-list-item-subtitle>
          <div class="text-caption text-medium-emphasis mt-1" :title="dateTime(n.createdAt)">{{ relative(n.createdAt) }}</div>
          <template #append>
            <span v-if="!n.readAt" class="notification__dot" :aria-label="t('shell.unread')" role="img" />
          </template>
        </v-list-item>
      </v-list>
      <p v-else class="pa-4 text-medium-emphasis" data-testid="notification-empty">{{ t('notifications.empty') }}</p>
    </v-card>
  </v-menu>
</template>

<style scoped>
.notification__title { white-space: normal; }
.notification--unread .notification__title { font-weight: 600; }
.notification__dot { width: 8px; height: 8px; border-radius: 50%; background: rgb(var(--v-theme-primary)); margin-left: 8px; }
</style>
