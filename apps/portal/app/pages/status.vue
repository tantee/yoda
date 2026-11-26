<script setup lang="ts">
import type { DepartmentStatus, LiveEvent } from '@yoda/shared'
import { debounceMax, usd } from '~/utils/status'

const { t } = useI18n()
const api = useApi()
const status = ref<DepartmentStatus | null>(null)
const error = ref('')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const s = await api<DepartmentStatus>('/status')
    if (mine !== seq) return
    status.value = s
    error.value = ''
  } catch (e) {
    if (mine !== seq) return
    error.value = t(errorKey(e))
    loadFailure.value = e
  }
}

// Debounced, but a busy stream still refreshes at least every 5 s.
const loadSoon = debounceMax(load, 1000, 5000)
onBeforeUnmount(loadSoon.cancel)
onMounted(load)

const RELOAD_ON = ['work_item.', 'task.', 'discussion.', 'gitlab.issue_sync', 'ai.budget']
useLiveEvents((e: LiveEvent) => {
  if (RELOAD_ON.some(p => e.type.startsWith(p))) loadSoon()
}, loadSoon)

const loadFailure = ref<unknown>(null)
watch(error, (v) => { if (!v) loadFailure.value = null })
// Projects with active work first; the rest collapse into one group at the bottom (proposal §8.2 Status).
const busy = computed(() => status.value?.projects.filter(p => p.activeItems > 0) ?? [])
const idle = computed(() => status.value?.projects.filter(p => p.activeItems === 0) ?? [])
const showIdle = ref(false)
</script>

<template>
  <div>
    <PageHeader :title="t('nav.status')">
      <template #meta><span>{{ t('status.subtitle') }}</span></template>
    </PageHeader>
    <ErrorState v-if="error && !status" :error="loadFailure" class="mb-4" data-testid="status-error" @retry="load" />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-4" data-testid="status-error">{{ error }}</v-alert>
    <div v-if="!status && !error" data-testid="status-loading">
      <div class="dept-grid mb-4"><v-skeleton-loader v-for="i in 3" :key="i" type="article" class="dept-skeleton" /></div>
    </div>
    <template v-if="status">
      <StatusKpiTiles
        :active="status.totals.activeItems"
        :overdue="status.totals.overdueItems"
        :discussions="status.totals.openDiscussions"
        :spend="status.totals.aiSpendUsd"
        class="mb-2"
      />
      <p v-if="status.departmentAiSpendUsd > 0" class="text-caption text-medium-emphasis mb-4" data-testid="department-ai">
        {{ t('status.totals.departmentAiSpend', { amount: usd(status.departmentAiSpendUsd) }) }}
      </p>
      <div v-else class="mb-4" />
      <EmptyState v-if="!status.projects.length" icon="mdi-folder-outline" :title="t('status.empty')" data-testid="status-empty" />
      <template v-else>
        <div class="dept-grid">
          <StatusProjectCard v-for="p in busy" :key="p.projectId" :project="p" />
        </div>
        <section v-if="idle.length" class="mt-6" data-testid="status-idle">
          <v-btn
            variant="text"
            :append-icon="showIdle ? 'mdi-chevron-up' : 'mdi-chevron-down'"
            :aria-expanded="showIdle"
            class="mb-3 px-1"
            data-testid="status-idle-toggle"
            @click="showIdle = !showIdle"
          >{{ t('status.inactiveGroup', { n: idle.length }) }}</v-btn>
          <div v-if="showIdle || !busy.length" class="dept-grid">
            <StatusProjectCard v-for="p in idle" :key="p.projectId" :project="p" />
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.dept-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 1279px) { .dept-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 767px) { .dept-grid { grid-template-columns: minmax(0, 1fr); } }
.dept-skeleton { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; }
</style>
