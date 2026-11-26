<script setup lang="ts">
import type { RecoveryActivity } from '@yoda/shared'

/**
 * On admin pages while a break-glass session is open at /recovery (installer proposal §7.4, §12 T4): everyone
 * administering the portal sees it, not only the one who got the notification. Read on each admin page visit.
 */
const props = defineProps<{ path: string }>()
const { t } = useI18n()
const { dateTime } = useDateFormat()
const api = useApi()
const activity = ref<RecoveryActivity | null>(null)

watch(() => props.path, async (path) => {
  if (!path.startsWith('/admin')) return
  try {
    activity.value = await api<RecoveryActivity>('/admin/recovery-activity')
  } catch {
    activity.value = null
  }
}, { immediate: true })
</script>

<template>
  <v-alert
    v-if="path.startsWith('/admin') && activity?.active"
    type="warning"
    variant="tonal"
    density="compact"
    class="mb-4"
    icon="mdi-shield-alert-outline"
    role="status"
    data-testid="recovery-banner"
  >
    <div class="font-weight-medium">{{ t('recoveryBanner.title') }}</div>
    <div class="text-body-2">{{ t('recoveryBanner.text', { username: activity.username ?? '', at: activity.since ? dateTime(activity.since) : '' }) }}</div>
  </v-alert>
</template>
