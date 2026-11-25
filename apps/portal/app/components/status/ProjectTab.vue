<script setup lang="ts">
import type { LiveEvent, ProjectStatus } from '@yoda/shared'

const props = defineProps<{ projectId: string; noAi: boolean; canManage: boolean }>()
const { t, locale } = useI18n()
const api = useApi()
const status = ref<ProjectStatus | null>(null)
const error = ref('')
const weekly = ref<{ onLive: (type: string) => void } | null>(null)

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const s = await api<ProjectStatus>(`/projects/${props.projectId}/status`)
    if (mine !== seq) return
    status.value = s
    error.value = ''
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function loadSoon() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 400)
}
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
onMounted(load)

/** The project page forwards its live events (one stream per page). */
function onLive(e: LiveEvent) {
  if (e.projectId !== props.projectId) return
  weekly.value?.onLive(e.type)
  if (e.type !== 'run.heartbeat' && e.type !== 'message.created' && e.type !== 'notification.created') loadSoon()
}
defineExpose({ onLive, reload: loadSoon })

const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')
</script>

<template>
  <div data-testid="status-tab">
    <v-alert v-if="error" type="error" class="mb-4" data-testid="status-error">{{ error }}</v-alert>
    <v-progress-linear v-if="!status && !error" indeterminate class="mb-4" data-testid="status-loading" />
    <template v-if="status">
      <div class="d-flex align-center flex-wrap ga-2 mb-2">
        <StatusHealthChip :health="status.health" size="default" />
        <span class="text-body-2 text-medium-emphasis">
          {{ t('status.card.active') }} {{ status.activeItems }} · {{ t('status.card.overdue') }} {{ status.overdueItems }} · {{ t('status.card.discussions') }} {{ status.openDiscussions }}
        </span>
      </div>
      <StatusReasons :reasons="status.reasons" class="mb-4" />

      <h2 class="text-h6 mb-2">{{ t('status.board') }}</h2>
      <p v-if="!status.board.some(c => c.items.length)" class="text-medium-emphasis mb-2" data-testid="board-empty">{{ t('status.boardEmpty') }}</p>
      <StatusBoard v-if="status.board.length" :columns="status.board" class="mb-6" />

      <v-row>
        <v-col cols="12" md="7">
          <StatusWeeklySummary
            ref="weekly"
            :project-id="projectId"
            :summary="status.weeklySummary"
            :no-ai="noAi"
            :can-manage="canManage"
            class="mb-6"
            @refresh="loadSoon"
          />
          <h2 class="text-h6 mb-2">{{ t('status.people') }}</h2>
          <StatusPeopleLoad :people="status.people" class="mb-6" />
          <h2 class="text-h6 mb-2">{{ t('status.recentEvents') }}</h2>
          <p v-if="!status.recentEvents.length" class="text-medium-emphasis">{{ t('status.eventsEmpty') }}</p>
          <EventTimeline v-else :events="status.recentEvents" />
        </v-col>
        <v-col cols="12" md="5">
          <h2 class="text-h6 mb-2">{{ t('status.discussions') }}</h2>
          <p v-if="!status.discussions.length" class="text-medium-emphasis mb-6">{{ t('status.discussionsEmpty') }}</p>
          <v-list v-else density="compact" class="mb-6" data-testid="status-discussions">
            <v-list-item v-for="d in status.discussions" :key="d.id" :to="`/discussions/${d.id}`" data-testid="status-discussion">
              <v-list-item-title class="text-wrap">{{ d.question }}</v-list-item-title>
              <v-list-item-subtitle>
                {{ t(`priority.${d.priority}`) }}<template v-if="d.workItemTitle"> · {{ d.workItemTitle }}</template> · {{ fmt(d.createdAt) }}
              </v-list-item-subtitle>
            </v-list-item>
          </v-list>
          <h2 class="text-h6 mb-2">{{ t('status.repos') }}</h2>
          <p v-if="!status.repos.length" class="text-medium-emphasis">{{ t('status.reposEmpty') }}</p>
          <v-list v-else density="compact" data-testid="status-repos">
            <v-list-item v-for="r in status.repos" :key="r.id" :href="r.webUrl" target="_blank" rel="noopener noreferrer" prepend-icon="mdi-gitlab" append-icon="mdi-open-in-new">
              <v-list-item-title>{{ r.pathWithNamespace }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </v-col>
      </v-row>
    </template>
  </div>
</template>
