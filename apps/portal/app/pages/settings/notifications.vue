<script setup lang="ts">
import type { ChannelName, MyNotificationPrefs, NotificationKind, NotificationPrefs } from '@yoda/shared'
import { channelColumns, channelKey, isChecked, kindKey, toggleChannel } from '~/utils/notificationSettings'

const { t } = useI18n()
const api = useApi()
const my = ref<MyNotificationPrefs | null>(null)
const error = ref('')
const saved = ref(false)
const saving = ref(false)

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

onMounted(load)
</script>

<template>
  <div data-testid="notification-settings">
    <h1 class="text-h5 mb-2">{{ t('notifications.settings.title') }}</h1>
    <p class="text-medium-emphasis mb-4">{{ t('notifications.settings.hint') }}</p>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="prefs-error">{{ error }}</v-alert>
    <v-alert v-if="saved" type="success" variant="tonal" density="compact" class="mb-4" data-testid="prefs-saved">{{ t('notifications.settings.saved') }}</v-alert>
    <v-alert v-if="my && !anyAvailable" type="info" variant="tonal" class="mb-4" data-testid="prefs-no-channels">{{ t('notifications.settings.noChannels') }}</v-alert>

    <v-table v-if="my" style="max-width: 760px" data-testid="prefs-grid">
      <thead>
        <tr>
          <th>{{ t('notifications.settings.kind') }}</th>
          <th v-for="c in columns" :key="c.name" class="text-center" :data-testid="`prefs-col-${c.name}`">
            <div>{{ t(channelKey(c.name)) }}</div>
            <div v-if="columnNote(c)" class="text-caption text-medium-emphasis">{{ columnNote(c) }}</div>
            <!-- Linking LINE / Telegram arrives with those channels; until then the button stays disabled. -->
            <v-btn
              v-if="c.name !== 'email' && !c.linked"
              size="x-small"
              variant="tonal"
              class="mt-1"
              :disabled="!c.available"
              :data-testid="`prefs-link-${c.name}`"
            >
              {{ t('notifications.settings.link') }}
            </v-btn>
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
  </div>
</template>
