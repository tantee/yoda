<script setup lang="ts">
import type { ChannelLinkCode, ChannelName, LinkableChannel, MyNotificationPrefs, NotificationKind, NotificationPrefs } from '@yoda/shared'
import { channelColumns, channelKey, countdown, isChecked, kindKey, msLeft, toggleChannel } from '~/utils/notificationSettings'

const POLL_MS = 3000

const { t } = useI18n()
const api = useApi()
const lineAddFriendUrl = useRuntimeConfig().public.lineAddFriendUrl as string
const my = ref<MyNotificationPrefs | null>(null)
const error = ref('')
const saved = ref(false)
const saving = ref(false)
/** A success message after linking or unlinking. */
const notice = ref('')

// Linking dialog: the code, a ticking clock for its countdown, and a poll until the account shows as linked.
const linking = ref<{ channel: LinkableChannel; code: ChannelLinkCode } | null>(null)
const linkError = ref('')
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let lastPoll = 0
const expired = computed(() => !!linking.value && msLeft(linking.value.code.expiresAt, now.value) === 0)

const columns = computed(() => (my.value ? channelColumns(my.value) : []))
const anyAvailable = computed(() => columns.value.some(c => c.available))

async function load() {
  try {
    my.value = await api<MyNotificationPrefs>('/me/notification-prefs')
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function toggle(kind: NotificationKind, channel: ChannelName, on: boolean | null) {
  if (!my.value) return
  const body: NotificationPrefs = toggleChannel(my.value.prefs, kind, channel, on === true)
  error.value = ''
  saved.value = false
  saving.value = true
  try {
    my.value = await api<MyNotificationPrefs>('/me/notification-prefs', { method: 'PUT', body })
    saved.value = true
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    saving.value = false
  }
}

/** Why a column cannot be used: not enabled by an admin, or (email) no address on the account. */
function columnNote(c: { name: ChannelName; available: boolean; linked: boolean }): string {
  if (!c.available) return t('notifications.settings.notAvailable')
  if (c.name === 'email' && !c.linked) return t('notifications.settings.noEmail')
  return ''
}

async function requestCode(channel: LinkableChannel) {
  linkError.value = ''
  notice.value = ''
  try {
    const code = await api<ChannelLinkCode>(`/me/channel-links/${channel}/code`, { method: 'POST' })
    linking.value = { channel, code }
    startTimer()
  } catch (e) {
    if (linking.value) linkError.value = t(errorKey(e))
    else error.value = t(errorKey(e))
  }
}

function startTimer() {
  stopTimer()
  now.value = Date.now()
  lastPoll = now.value
  timer = setInterval(() => void tick(), 1000)
}

function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}

async function tick() {
  now.value = Date.now()
  const l = linking.value
  if (!l || expired.value || now.value - lastPoll < POLL_MS) return
  lastPoll = now.value
  try {
    const fresh = await api<MyNotificationPrefs>('/me/notification-prefs')
    if (linking.value !== l) return
    my.value = fresh
    if (fresh.channels.linked[l.channel]) {
      closeLinking()
      notice.value = t('notifications.settings.linking.linked', { channel: t(channelKey(l.channel)) })
    }
  } catch {
    // A missed poll is retried on the next tick.
  }
}

function closeLinking() {
  stopTimer()
  linking.value = null
  linkError.value = ''
}

async function unlink(channel: LinkableChannel) {
  error.value = ''
  notice.value = ''
  try {
    await api(`/me/channel-links/${channel}`, { method: 'DELETE' })
    await load()
    notice.value = t('notifications.settings.linking.unlinked', { channel: t(channelKey(channel)) })
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

onMounted(load)
onBeforeUnmount(stopTimer)
</script>

<template>
  <div data-testid="notification-settings">
    <h1 class="text-h5 mb-2">{{ t('notifications.settings.title') }}</h1>
    <p class="text-medium-emphasis mb-4">{{ t('notifications.settings.hint') }}</p>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="prefs-error">{{ error }}</v-alert>
    <v-alert v-if="saved" type="success" variant="tonal" density="compact" class="mb-4" data-testid="prefs-saved">{{ t('notifications.settings.saved') }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-4" data-testid="prefs-notice">{{ notice }}</v-alert>
    <v-alert v-if="my && !anyAvailable" type="info" variant="tonal" class="mb-4" data-testid="prefs-no-channels">{{ t('notifications.settings.noChannels') }}</v-alert>

    <v-table v-if="my" style="max-width: 760px" data-testid="prefs-grid">
      <thead>
        <tr>
          <th>{{ t('notifications.settings.kind') }}</th>
          <th v-for="c in columns" :key="c.name" class="text-center" :data-testid="`prefs-col-${c.name}`">
            <div>{{ t(channelKey(c.name)) }}</div>
            <div v-if="columnNote(c)" class="text-caption text-medium-emphasis">{{ columnNote(c) }}</div>
            <template v-if="c.name !== 'email'">
              <div v-if="c.linked" class="text-caption text-success" :data-testid="`prefs-linked-${c.name}`">
                {{ t('notifications.settings.linking.linkedNote') }}
              </div>
              <v-btn
                v-if="c.linked"
                size="x-small"
                variant="text"
                :data-testid="`prefs-unlink-${c.name}`"
                @click="unlink(c.name as LinkableChannel)"
              >
                {{ t('notifications.settings.linking.unlink') }}
              </v-btn>
              <v-btn
                v-else
                size="x-small"
                variant="tonal"
                class="mt-1"
                :disabled="!c.available"
                :data-testid="`prefs-link-${c.name}`"
                @click="requestCode(c.name as LinkableChannel)"
              >
                {{ t('notifications.settings.link') }}
              </v-btn>
            </template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="kind in my.kinds" :key="kind" :data-testid="`prefs-row-${kind}`">
          <td>{{ t(kindKey(kind)) }}</td>
          <td v-for="c in columns" :key="c.name" class="text-center">
            <v-checkbox-btn
              class="d-inline-flex"
              :model-value="c.usable && isChecked(my.prefs, kind, c.name)"
              :disabled="!c.usable || saving"
              :aria-label="`${t(kindKey(kind))} – ${t(channelKey(c.name))}`"
              :data-testid="`prefs-${kind}-${c.name}`"
              @update:model-value="(v: boolean | null) => toggle(kind, c.name, v)"
            />
          </td>
        </tr>
      </tbody>
    </v-table>

    <v-dialog :model-value="!!linking" max-width="480" persistent>
      <v-card v-if="linking" data-testid="link-dialog">
        <v-card-title>{{ t('notifications.settings.linking.linkTitle', { channel: t(channelKey(linking.channel)) }) }}</v-card-title>
        <v-card-text>
          <v-alert v-if="linkError" type="error" density="compact" class="mb-3" data-testid="link-error">{{ linkError }}</v-alert>
          <template v-if="linking.channel === 'line'">
            <p class="mb-2">1. {{ t('notifications.settings.linking.lineStepAdd') }}</p>
            <v-btn
              v-if="linking.code.instructions.addFriendUrl || lineAddFriendUrl"
              :href="linking.code.instructions.addFriendUrl || lineAddFriendUrl"
              target="_blank"
              rel="noopener"
              color="success"
              variant="tonal"
              size="small"
              class="mb-3"
              data-testid="link-add-friend"
            >
              {{ t('notifications.settings.linking.lineAddFriend') }}
            </v-btn>
            <p class="mb-2">2. {{ t('notifications.settings.linking.lineStepSend') }}</p>
          </template>
          <template v-else>
            <p class="mb-2">{{ t('notifications.settings.linking.telegramStep') }}</p>
            <v-btn
              v-if="linking.code.instructions.deepLink"
              :href="linking.code.instructions.deepLink"
              target="_blank"
              rel="noopener"
              color="primary"
              variant="tonal"
              size="small"
              class="mb-3"
              :disabled="expired"
              data-testid="link-deep-link"
            >
              {{ t('notifications.settings.linking.telegramOpen') }}
            </v-btn>
            <p class="mb-2">{{ t('notifications.settings.linking.telegramOr', { bot: `@${linking.code.instructions.botUsername ?? ''}` }) }}</p>
          </template>
          <div class="text-caption text-medium-emphasis">{{ t('notifications.settings.linking.code') }}</div>
          <div class="text-h5 font-weight-bold mb-2" style="font-family: monospace; letter-spacing: 0.1em" data-testid="link-code">
            {{ linking.code.code }}
          </div>
          <div v-if="!expired" class="text-body-2" data-testid="link-countdown">
            {{ t('notifications.settings.linking.expiresIn', { time: countdown(linking.code.expiresAt, now) }) }}
            <span class="text-medium-emphasis"> · {{ t('notifications.settings.linking.waiting') }}</span>
          </div>
          <div v-else class="text-body-2 text-warning" data-testid="link-expired">{{ t('notifications.settings.linking.expired') }}</div>
        </v-card-text>
        <v-card-actions>
          <v-btn v-if="expired" variant="tonal" data-testid="link-new-code" @click="requestCode(linking.channel)">
            {{ t('notifications.settings.linking.newCode') }}
          </v-btn>
          <v-spacer />
          <v-btn data-testid="link-close" @click="closeLinking">{{ t('notifications.settings.linking.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
