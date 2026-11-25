<script setup lang="ts">
import type { ChannelName, ChannelSettingsPatch, ChannelStatus } from '@yoda/shared'
import { channelKey } from '~/utils/notificationSettings'

const { t } = useI18n()
const api = useApi()
const channels = ref<ChannelStatus[]>([])
const error = ref('')
const saving = ref(false)

async function load() {
  try {
    channels.value = await api<ChannelStatus[]>('/admin/notification-channels')
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
  }
}

async function setEnabled(name: ChannelName, on: boolean | null) {
  error.value = ''
  saving.value = true
  try {
    const body: ChannelSettingsPatch = { [name]: on === true }
    channels.value = await api<ChannelStatus[]>('/admin/notification-channels', { method: 'PATCH', body })
  } catch (e) {
    error.value = t(errorKey(e))
    await load()
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div data-testid="admin-notifications">
    <h1 class="text-h5 mb-2">{{ t('notifications.admin.title') }}</h1>
    <p class="text-medium-emphasis mb-4">{{ t('notifications.admin.hint') }}</p>
    <v-alert v-if="error" type="error" class="mb-4" data-testid="channels-error">{{ error }}</v-alert>
    <v-table v-if="channels.length" style="max-width: 640px" data-testid="channels-table">
      <thead>
        <tr>
          <th>{{ t('notifications.admin.channel') }}</th>
          <th>{{ t('notifications.admin.configured') }}</th>
          <th>{{ t('notifications.admin.enabled') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in channels" :key="c.name" :data-testid="`channel-${c.name}`">
          <td>{{ t(channelKey(c.name)) }}</td>
          <td>
            <StatusChip
              kind="yesNo"
              :value="c.configured ? 'yes' : 'no'"
              :label="t(c.configured ? 'notifications.admin.yes' : 'notifications.admin.no')"
              :data-testid="`channel-${c.name}-configured`"
            />
          </td>
          <td>
            <v-switch
              :model-value="c.enabled"
              :disabled="saving || (!c.configured && !c.enabled)"
              :hint="c.configured ? '' : t('notifications.admin.notConfiguredHint')"
              :persistent-hint="!c.configured"
              color="primary"
              density="compact"
              :data-testid="`channel-${c.name}-enabled`"
              @update:model-value="(v: boolean | null) => setEnabled(c.name, v)"
            />
          </td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
