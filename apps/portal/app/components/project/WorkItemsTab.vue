<script setup lang="ts">
import { Priority, WorkItemState, type WorkflowTemplateSummary, type WorkItem } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { localized } from '~/utils/localized'
import { filterWorkItems, itemOverdue, itemSteps, workItemFilterOptions } from '~/utils/projects'
import { bangkokToday } from '~/utils/status'

/**
 * The project work items table (proposal §8.2): search and state / step / priority / owner / overdue filters,
 * client-side (a project holds few items); active items by default. Stacked rows below 1,024 px.
 */
const props = defineProps<{
  items: WorkItem[] | null
  templates: WorkflowTemplateSummary[]
  error: string
  canCreate: boolean
  initialOverdue?: boolean
  /** Each change turns the overdue filter on (the status tab's overdue link). */
  overdueRequest?: number
}>()
const emit = defineEmits<{ create: []; retry: [] }>()
const { t, locale } = useI18n()
const { date, dateShort } = useDateFormat()
const { width } = useDisplay()
const stacked = computed(() => width.value < 1024)

const q = ref('')
const state = ref<WorkItemState | 'all'>('active')
const step = ref<string | null>(null)
const priority = ref<Priority | null>(null)
const ownerId = ref<string | null>(null)
const overdue = ref(!!props.initialOverdue || !!props.overdueRequest)
watch(() => props.overdueRequest, () => {
  clear()
  overdue.value = true
})

const today = bangkokToday()
const options = computed(() => workItemFilterOptions(props.items ?? [], props.templates))
const rows = computed(() =>
  filterWorkItems(props.items ?? [], { q: q.value, state: state.value, step: step.value, priority: priority.value, ownerId: ownerId.value, overdue: overdue.value }, today),
)
const filtered = computed(() => !!q.value || state.value !== 'active' || !!step.value || !!priority.value || !!ownerId.value || overdue.value)
function clear() {
  q.value = ''
  state.value = 'active'
  step.value = priority.value = ownerId.value = null
  overdue.value = false
}

const stateItems = computed(() => [
  { title: t('projects.items.stateAll'), value: 'all' },
  ...WorkItemState.options.map(s => ({ title: t(`chip.workItem.${s}`), value: s })),
])
const priorityItems = computed(() => [...Priority.options].reverse().map(p => ({ title: t(`priority.${p}`), value: p })))
const stepItems = computed(() => options.value.steps.map(s => ({ title: localized(s.name, locale.value), value: s.key })))
const templateName = (w: WorkItem) => {
  const tpl = props.templates.find(x => x.key === w.templateKey)
  return tpl ? localized(tpl.name, locale.value) : w.templateKey
}
const steps = (w: WorkItem) => itemSteps(props.templates, w)
</script>

<template>
  <div data-testid="items-tab">
    <ErrorState v-if="error && !items" class="mb-4" data-testid="items-error" @retry="emit('retry')" />
    <v-alert v-else-if="error" type="error" variant="tonal" class="mb-4" data-testid="items-error">{{ error }}</v-alert>
    <v-card v-if="!items && !error"><SkeletonList :rows="5" /></v-card>
    <EmptyState
      v-else-if="items && !items.length"
      icon="mdi-clipboard-text-outline"
      :title="t('projects.items.empty')"
      :text="t('projects.items.emptyText')"
      data-testid="items-empty"
    >
      <v-btn v-if="canCreate" color="primary" prepend-icon="mdi-plus" @click="emit('create')">{{ t('workItems.new') }}</v-btn>
    </EmptyState>
    <template v-else-if="items">
      <div class="items-filters mb-3" data-testid="items-filters">
        <v-text-field
          v-model="q"
          :placeholder="t('projects.items.search')"
          :aria-label="t('projects.items.search')"
          prepend-inner-icon="mdi-magnify"
          clearable
          hide-details
          density="compact"
          class="items-filters__search"
          data-testid="items-search"
        />
        <v-select v-model="state" :items="stateItems" :label="t('projects.items.state')" hide-details density="compact" class="items-filters__select" data-testid="items-filter-state" />
        <v-select v-model="step" :items="stepItems" :label="t('projects.items.step')" clearable hide-details density="compact" class="items-filters__select" data-testid="items-filter-step" />
        <v-select v-model="priority" :items="priorityItems" :label="t('projects.items.priority')" clearable hide-details density="compact" class="items-filters__select" data-testid="items-filter-priority" />
        <v-select
          v-model="ownerId"
          :items="options.owners"
          item-title="name"
          item-value="id"
          :label="t('workItems.owner')"
          clearable
          hide-details
          density="compact"
          class="items-filters__select"
          data-testid="items-filter-owner"
        />
        <v-chip
          :variant="overdue ? 'flat' : 'outlined'"
          :color="overdue ? 'error' : undefined"
          prepend-icon="mdi-calendar-alert"
          size="default"
          :aria-pressed="overdue"
          data-testid="items-filter-overdue"
          @click="overdue = !overdue"
        >{{ t('projects.items.overdue') }}</v-chip>
        <v-btn v-if="filtered" variant="text" color="primary" size="small" data-testid="items-clear" @click="clear">{{ t('projects.items.clear') }}</v-btn>
        <v-spacer />
        <span class="text-caption text-medium-emphasis tabular-nums" data-testid="items-count">{{ t('projects.items.count', { n: rows.length }) }}</span>
      </div>

      <EmptyState
        v-if="!rows.length"
        icon="mdi-filter-off-outline"
        :title="t('projects.items.filterEmpty')"
        :text="t('projects.items.filterEmptyText')"
        data-testid="items-filter-empty"
      >
        <v-btn variant="outlined" @click="clear">{{ t('projects.items.clear') }}</v-btn>
      </EmptyState>
      <v-card v-else data-testid="work-items">
        <v-table v-if="!stacked" class="items-table">
          <thead>
            <tr>
              <th class="items-table__prio">{{ t('workItems.priority') }}</th>
              <th>{{ t('workItems.title') }}</th>
              <th class="items-table__step">{{ t('workItems.currentStep') }}</th>
              <th>{{ t('workItems.state') }}</th>
              <th>{{ t('workItems.owner') }}</th>
              <th class="text-right">{{ t('projects.items.due') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in rows" :key="w.id" :data-item="w.id" data-testid="work-item-row">
              <td class="items-table__prio"><PriorityMark :priority="w.priority" /></td>
              <td class="items-table__title">
                <NuxtLink :to="`/work-items/${w.id}`" class="row-link">{{ w.title }}</NuxtLink>
                <div class="text-caption text-medium-emphasis">{{ templateName(w) }}</div>
              </td>
              <td class="items-table__step"><StepTrack v-if="steps(w).length" :steps="steps(w)" compact /></td>
              <td><StatusChip kind="workItem" :value="w.state" /></td>
              <td class="text-body-2">{{ w.ownerName }}</td>
              <td class="text-right text-body-2 tabular-nums items-table__due">
                <span v-if="itemOverdue(w, today)" class="text-error font-weight-medium d-inline-flex align-center ga-1" :title="date(w.targetDate)">
                  <v-icon icon="mdi-calendar-alert" size="14" aria-hidden="true" />{{ t('projects.items.overdueOn', { date: dateShort(w.targetDate) }) }}
                </span>
                <span v-else-if="w.targetDate" class="text-medium-emphasis" :title="date(w.targetDate)">{{ dateShort(w.targetDate) }}</span>
                <span v-else class="text-placeholder">–</span>
              </td>
            </tr>
          </tbody>
        </v-table>
        <ul v-else class="items-stack">
          <li v-for="w in rows" :key="w.id" :data-item="w.id" data-testid="work-item-row">
            <NuxtLink :to="`/work-items/${w.id}`" class="row-link">{{ w.title }}</NuxtLink>
            <div class="items-stack__meta text-caption text-medium-emphasis">
              <PriorityMark :priority="w.priority" />
              <StatusChip kind="workItem" :value="w.state" size="x-small" />
              <StepTrack v-if="steps(w).length" :steps="steps(w)" compact />
            </div>
            <div class="items-stack__meta text-caption text-medium-emphasis">
              <span>{{ w.ownerName }}</span>
              <span v-if="itemOverdue(w, today)" class="text-error">{{ t('projects.items.overdueOn', { date: dateShort(w.targetDate) }) }}</span>
              <span v-else-if="w.targetDate">{{ dateShort(w.targetDate) }}</span>
            </div>
          </li>
        </ul>
      </v-card>
    </template>
  </div>
</template>

<style scoped>
.items-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.items-filters__search { flex: 1 1 220px; max-width: 320px; min-width: 180px; }
.items-filters__select { flex: 0 1 160px; min-width: 140px; }
@media (max-width: 599px) {
  .items-filters__search { max-width: none; flex-basis: 100%; }
  .items-filters__select { flex: 1 1 calc(50% - 8px); }
}
.items-table :deep(th) { white-space: nowrap; }
.items-table__prio { width: 104px; }
.items-table__step { width: 220px; }
.items-table__title { min-width: 240px; padding-top: 6px !important; padding-bottom: 6px !important; }
.items-table__due { white-space: nowrap; }
.items-stack { list-style: none; margin: 0; padding: 0; }
.items-stack li { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); min-width: 0; }
.items-stack li:first-child { border-top: 0; }
.items-stack__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 6px; }
</style>
