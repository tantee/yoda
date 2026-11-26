<script setup lang="ts">
import type { ChannelName, ChannelSettingsPatch, ChannelStatus } from '@yoda/shared'
import { channelKey } from '~/utils/notificationSettings'

const { t } = useI18n()
const api = useApi()
const channels = ref<ChannelStatus[]>([])
const loaded = ref(false)
const loadFailure = ref<unknown>(null)
const error = ref('')
const ICONS: Record<ChannelName, string> = { email: 'mdi-email-outline', line: 'mdi-chat-outline', telegram: 'mdi-send-outline' }
const saving = ref(false)

async function load() {
  try {
    channels.value = await api<ChannelStatus[]>('/admin/notification-channels')
    loaded.value = true
    error.value = ''
  } catch (e) {
    error.value = t(errorKey(e))
    loadFailure.value = e
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
    <PageHeader :title="t('notifications.admin.title')">
      <template #meta><span>{{ t('notifications.admin.hint') }}</span></template>
    </PageHeader>
    <ErrorState v-if="error && !loaded" :error="loadFailure" data-testid="channels-error" @retry="load" />
    <SkeletonList v-else-if="!loaded" :rows="3" />
    <template v-else>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4" data-testid="channels-error">{{ error }}</v-alert>
      <v-card>
        <div class="card-head"><h2>{{ t('notifications.admin.channelsTitle') }}</h2></div>
        <ul class="channels" data-testid="channels-table">
          <li v-for="c in channels" :key="c.name" class="channel" :data-testid="`channel-${c.name}`">
            <v-icon :icon="ICONS[c.name]" :color="c.enabled ? 'primary' : 'neutral-dot'" class="channel__icon" aria-hidden="true" />
            <div class="channel__main">
              <div class="d-flex flex-wrap align-center ga-2">
                <span :id="`channel-label-${c.name}`" class="font-weight-medium">{{ t(channelKey(c.name)) }}</span>
                <StatusChip
                  kind="yesNo"
                  :value="c.configured ? 'yes' : 'no'"
                  :label="t(c.configured ? 'notifications.admin.configuredYes' : 'notifications.admin.configuredNo')"
                  size="x-small"
                  :data-testid="`channel-${c.name}-configured`"
                />
              </div>
              <div class="text-caption text-medium-emphasis">
                {{ c.configured ? t(`notifications.admin.channelHint.${c.name}`) : t('notifications.admin.notConfiguredHint') }}
              </div>
            </div>
            <v-switch
              :model-value="c.enabled"
              :disabled="saving || (!c.configured && !c.enabled)"
              :aria-labelledby="`channel-label-${c.name}`"
              color="primary"
              density="compact"
              hide-details
              inset
              class="channel__switch"
              :data-testid="`channel-${c.name}-enabled`"
              @update:model-value="(v: boolean | null) => setEnabled(c.name, v)"
            />
          </li>
        </ul>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.channels { list-style: none; margin: 0; padding: 0; }
.channel { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.channel:first-child { border-top: 0; }
.channel__icon { flex: none; }
.channel__main { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.channel__switch { flex: none; }
</style>
