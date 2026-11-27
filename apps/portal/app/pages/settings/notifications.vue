<script setup lang="ts">
import type { ChannelLinkCode, ChannelName, LinkableChannel, MyNotificationPrefs, NotificationKind, NotificationPrefs } from '@yoda/shared'
import { cellKey, channelColumns, channelKey, codeLeftPercent, columnNoteKey, countdown, isChecked, kindKey, msLeft, serialQueue, toggleChannel, withPendingPrefs } from '~/utils/notificationSettings'

const POLL_MS = 3000

definePageMeta({ crumbs: [{ key: 'notifications.settings.title' }] })

const { t } = useI18n()
const api = useApi()
const lineAddFriendUrl = usePublicConfig().values().lineAddFriendUrl
const my = ref<MyNotificationPrefs | null>(null)
const error = ref('')
const saved = ref(false)
/** Cells being saved: only these are disabled; other cells stay clickable and queue behind them. */
const savingCells = ref<string[]>([])
const saving = computed(() => savingCells.value.length > 0)
const saves = serialQueue()
// "Saved" never shows next to an error.
watch(error, (e) => { if (e) saved.value = false })
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
    my.value = withPendingPrefs(await api<MyNotificationPrefs>('/me/notification-prefs'), my.value, saves.pending)
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function toggle(kind: NotificationKind, channel: ChannelName, on: boolean | null) {
  if (!my.value) return
  const key = cellKey(kind, channel)
  const body: NotificationPrefs = toggleChannel(my.value.prefs, kind, channel, on === true)
  // Shown at once, so a second click builds on this one; the saves then run in click order.
  my.value = { ...my.value, prefs: body }
  error.value = ''
  saved.value = false
  savingCells.value = [...savingCells.value, key]
  try {
    const fresh = await saves.run(() => api<MyNotificationPrefs>('/me/notification-prefs', { method: 'PUT', body }))
    if (saves.pending === 0) {
      my.value = fresh
      saved.value = true
    }
  } catch (e) {
    const message = t(errorKey(e))
    // Back to what the server has once nothing else is on its way.
    if (saves.pending === 0) await load()
    error.value = message
  } finally {
    savingCells.value = savingCells.value.filter(k => k !== key)
  }
}

/** Why a column cannot be used: not enabled by an admin, no email address, or not linked yet. */
function columnNote(c: { name: ChannelName; available: boolean; linked: boolean }): string {
  const key = columnNoteKey(c)
  return key ? t(key, { channel: t(channelKey(c.name)) }) : ''
}
const CHANNEL_ICONS: Record<ChannelName, string> = { email: 'mdi-email-outline', line: 'mdi-chat-outline', telegram: 'mdi-send-outline' }
const loaded = computed(() => !!my.value)
const codeCopied = ref(false)
async function copyCode() {
  if (!linking.value) return
  try {
    await navigator.clipboard.writeText(linking.value.code.code)
    codeCopied.value = true
  } catch {
    // the code stays visible to copy by hand
  }
}

async function requestCode(channel: LinkableChannel) {
  linkError.value = ''
  notice.value = ''
  try {
    const code = await api<ChannelLinkCode>(`/me/channel-links/${channel}/code`, { method: 'POST' })
    codeCopied.value = false
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
    my.value = withPendingPrefs(fresh, my.value, saves.pending)
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
    <PageHeader :title="t('notifications.settings.title')">
      <template #meta><span>{{ t('notifications.settings.hint') }}</span></template>
    </PageHeader>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="prefs-error">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-4" data-testid="prefs-notice">{{ notice }}</v-alert>
    <v-alert v-if="my && !anyAvailable" type="info" variant="tonal" density="compact" class="mb-4" data-testid="prefs-no-channels">{{ t('notifications.settings.noChannels') }}</v-alert>

    <SkeletonList v-if="!loaded && !error" :rows="4" />
    <template v-if="my">
      <h2 class="prefs-section">{{ t('notifications.settings.channelsTitle') }}</h2>
      <div class="prefs-channels mb-6" data-testid="prefs-channels">
        <v-card class="prefs-channel">
          <div class="prefs-channel__head">
            <v-icon icon="mdi-bell-outline" color="primary" aria-hidden="true" />
            <span class="prefs-channel__name">{{ t('notifications.settings.portal') }}</span>
            <StatusChip kind="yesNo" value="yes" :label="t('notifications.settings.alwaysOn')" size="x-small" />
          </div>
          <p class="text-caption text-medium-emphasis mb-0">{{ t('notifications.settings.portalHint') }}</p>
        </v-card>
        <v-card v-for="c in columns" :key="c.name" class="prefs-channel" :data-testid="`prefs-col-${c.name}`">
          <div class="prefs-channel__head">
            <v-icon :icon="CHANNEL_ICONS[c.name]" :color="c.usable ? 'primary' : 'neutral-dot'" aria-hidden="true" />
            <span class="prefs-channel__name">{{ t(channelKey(c.name)) }}</span>
            <StatusChip
              v-if="c.name !== 'email' && c.linked"
              kind="yesNo"
              value="yes"
              :label="t('notifications.settings.linking.linkedNote')"
              size="x-small"
              :data-testid="`prefs-linked-${c.name}`"
            />
            <StatusChip v-else-if="!c.available" kind="yesNo" value="no" :label="t('notifications.settings.notAvailable')" size="x-small" />
            <StatusChip v-else-if="c.name !== 'email'" kind="yesNo" value="no" :label="t('notifications.settings.notLinked')" size="x-small" />
            <StatusChip v-else :kind="'yesNo'" :value="c.linked ? 'yes' : 'no'" :label="c.linked ? t('notifications.settings.emailReady') : t('notifications.settings.noEmail')" size="x-small" />
          </div>
          <p class="text-caption text-medium-emphasis mb-0">{{ t(`notifications.settings.channelHint.${c.name}`) }}</p>
          <div v-if="c.name !== 'email'" class="mt-2">
            <v-btn
              v-if="c.linked"
              size="small"
              variant="text"
              color="error"
              :data-testid="`prefs-unlink-${c.name}`"
              @click="unlink(c.name as LinkableChannel)"
            >
              {{ t('notifications.settings.linking.unlink') }}
            </v-btn>
            <v-btn
              v-else
              size="small"
              variant="tonal"
              color="primary"
              prepend-icon="mdi-link-variant"
              :disabled="!c.available"
              :data-testid="`prefs-link-${c.name}`"
              @click="requestCode(c.name as LinkableChannel)"
            >
              {{ t('notifications.settings.link') }}
            </v-btn>
          </div>
        </v-card>
      </div>

      <v-card>
        <div class="card-head">
          <h2>{{ t('notifications.settings.gridTitle') }}</h2>
          <span class="text-caption text-medium-emphasis d-flex align-center ga-1" aria-live="polite">
            <template v-if="saving"><v-progress-circular indeterminate size="14" width="2" />{{ t('notifications.settings.saving') }}</template>
            <template v-else-if="saved"><v-icon icon="mdi-check" size="14" color="success" aria-hidden="true" /><span data-testid="prefs-saved">{{ t('notifications.settings.saved') }}</span></template>
          </span>
        </div>
        <div class="prefs-scroll">
          <v-table class="prefs-grid" data-testid="prefs-grid">
            <thead>
              <tr>
                <th>{{ t('notifications.settings.kind') }}</th>
                <th v-for="c in columns" :key="c.name" class="text-center">
                  <div>{{ t(channelKey(c.name)) }}</div>
                  <div v-if="columnNote(c)" class="prefs-note">{{ columnNote(c) }}</div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="kind in my.kinds" :key="kind" :data-testid="`prefs-row-${kind}`">
                <td>{{ t(kindKey(kind)) }}</td>
                <td v-for="c in columns" :key="c.name" class="text-center">
                  <v-checkbox-btn
                    class="d-inline-flex"
                    color="primary"
                    :model-value="c.usable && isChecked(my.prefs, kind, c.name)"
                    :disabled="!c.usable || savingCells.includes(cellKey(kind, c.name))"
                    :aria-label="`${t(kindKey(kind))} – ${t(channelKey(c.name))}`"
                    :data-testid="`prefs-${kind}-${c.name}`"
                    @update:model-value="(v: boolean | null) => toggle(kind, c.name, v)"
                  />
                </td>
              </tr>
            </tbody>
          </v-table>
        </div>
      </v-card>
    </template>

    <AppDialog
      :model-value="!!linking"
      :title="linking ? t('notifications.settings.linking.linkTitle', { channel: t(channelKey(linking.channel)) }) : ''"
      data-testid="link-dialog"
      @update:model-value="v => { if (!v) closeLinking() }"
    >
      <template v-if="linking">
        <v-alert v-if="linkError" type="error" variant="tonal" density="compact" class="mb-3" data-testid="link-error">{{ linkError }}</v-alert>
        <ol class="link-steps">
          <template v-if="linking.channel === 'line'">
            <li>
              {{ t('notifications.settings.linking.lineStepAdd') }}
              <div v-if="lineAddFriendUrl" class="mt-2">
                <v-btn :href="lineAddFriendUrl" target="_blank" rel="noopener" color="success" variant="tonal" size="small" append-icon="mdi-open-in-new" data-testid="link-add-friend">
                  {{ t('notifications.settings.linking.lineAddFriend') }}
                </v-btn>
              </div>
            </li>
            <li>{{ t('notifications.settings.linking.lineStepSend') }}</li>
          </template>
          <template v-else>
            <li>
              {{ t('notifications.settings.linking.telegramStep') }}
              <div v-if="linking.code.instructions.deepLink" class="mt-2">
                <v-btn
                  :href="linking.code.instructions.deepLink"
                  target="_blank"
                  rel="noopener"
                  color="primary"
                  variant="tonal"
                  size="small"
                  append-icon="mdi-open-in-new"
                  :disabled="expired"
                  data-testid="link-deep-link"
                >
                  {{ t('notifications.settings.linking.telegramOpen') }}
                </v-btn>
              </div>
            </li>
            <li>{{ t('notifications.settings.linking.telegramOr', { bot: `@${linking.code.instructions.botUsername ?? ''}` }) }}</li>
          </template>
        </ol>
        <div class="link-code-row">
          <v-text-field
            :model-value="linking.code.code"
            :label="t('notifications.settings.linking.code')"
            readonly
            hide-details
            class="link-code"
            :disabled="expired"
            data-testid="link-code"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <v-btn :variant="codeCopied ? 'tonal' : 'outlined'" :color="codeCopied ? 'success' : undefined" :prepend-icon="codeCopied ? 'mdi-check' : 'mdi-content-copy'" :disabled="expired" data-testid="link-copy" @click="copyCode">
            {{ codeCopied ? t('runners.copied') : t('runners.copy') }}
          </v-btn>
        </div>
        <div v-if="!expired" class="link-wait text-body-2" data-testid="link-countdown">
          <v-progress-circular :model-value="codeLeftPercent(linking.code.expiresAt, now)" size="20" width="3" color="primary" aria-hidden="true" />
          <span>{{ t('notifications.settings.linking.expiresIn', { time: countdown(linking.code.expiresAt, now) }) }}</span>
          <span class="text-medium-emphasis">· {{ t('notifications.settings.linking.waiting') }}</span>
        </div>
        <div v-else class="link-wait text-body-2 text-warning" data-testid="link-expired">
          <v-icon icon="mdi-timer-off-outline" size="20" aria-hidden="true" />{{ t('notifications.settings.linking.expired') }}
        </div>
      </template>
      <template #actions>
        <v-btn v-if="expired && linking" variant="tonal" color="primary" data-testid="link-new-code" @click="requestCode(linking.channel)">
          {{ t('notifications.settings.linking.newCode') }}
        </v-btn>
        <v-btn variant="text" data-testid="link-close" @click="closeLinking">{{ t('notifications.settings.linking.close') }}</v-btn>
      </template>
    </AppDialog>
  </div>
</template>

<style scoped>
.prefs-section { margin: 0 0 8px; font-size: 1rem; font-weight: 600; }
.prefs-channels { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.prefs-channel { padding: 12px 16px; min-width: 0; }
.prefs-channel__head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; }
.prefs-channel__name { font-weight: 600; flex: 1 1 auto; }
.prefs-scroll { overflow-x: auto; }
.prefs-grid :deep(th) { vertical-align: top; padding-top: 8px !important; padding-bottom: 8px !important; }
.prefs-grid :deep(th:not(:first-child)), .prefs-grid :deep(td:not(:first-child)) { width: 140px; }
.prefs-grid :deep(th:first-child), .prefs-grid :deep(td:first-child) { min-width: 150px; }
@media (max-width: 599px) {
  .prefs-grid :deep(th:not(:first-child)), .prefs-grid :deep(td:not(:first-child)) { width: 72px; padding: 0 4px !important; }
  .prefs-grid :deep(th:first-child), .prefs-grid :deep(td:first-child) { padding-right: 8px !important; min-width: 0; }
}
.prefs-note { font-size: .75rem; font-weight: 400; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); white-space: normal; }
.link-steps { padding-left: 20px; margin: 0 0 16px; display: grid; gap: 8px; }
.link-code-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.link-code { flex: 1 1 220px; min-width: 0; }
.link-code :deep(input) { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.125rem; font-weight: 600; }
.link-wait { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
</style>
