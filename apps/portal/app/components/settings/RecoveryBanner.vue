<script setup lang="ts">
import type { RecoveryActivity } from '@yoda/shared'

/**
 * On admin pages while a break-glass session is open at /recovery (installer proposal §7.4, §12 T4): everyone
 * administering the portal sees it, not only the one who got the notification. Read on each admin page visit and
 * every 30 s while one stays open.
 */
const props = defineProps<{ path: string }>()
const { t } = useI18n()
const { dateTime } = useDateFormat()
const api = useApi()
const activity = ref<RecoveryActivity | null>(null)

async function load() {
  try {
    activity.value = await api<RecoveryActivity>('/admin/recovery-activity')
  } catch {
    activity.value = null
  }
}

watch(() => props.path, (path) => {
  if (path.startsWith('/admin')) void load()
}, { immediate: true })

// While an admin page stays open: every 30 s, only when the tab is visible.
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    if (props.path.startsWith('/admin') && document.visibilityState === 'visible') void load()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
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
