<script setup lang="ts">
import type { PersonLoad } from '@yoda/shared'
import { initials } from '~/utils/nav'
import { loadBars } from '~/utils/projects'

/** Member load (proposal §9.3): name with initials, roles, open / in progress, and a bar against the busiest member. */
const props = defineProps<{ people: PersonLoad[] }>()
const { t } = useI18n()
const bars = computed(() => loadBars(props.people))
</script>

<template>
  <p v-if="!people.length" class="card-body text-medium-emphasis mb-0">{{ t('status.peopleEmpty') }}</p>
  <v-table v-else density="compact" class="people-load" data-testid="people-load">
    <thead>
      <tr>
        <th>{{ t('status.peopleCols.name') }}</th>
        <th class="people-load__roles">{{ t('status.peopleCols.roles') }}</th>
        <th class="text-right">{{ t('status.peopleCols.openTasks') }}</th>
        <th class="text-right">{{ t('status.peopleCols.inProgress') }}</th>
        <th class="people-load__bar-col">{{ t('status.peopleCols.load') }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="b in bars" :key="b.person.personId" :title="t('status.peopleCols.todayAssigned') + ': ' + b.person.todayAssigned" data-testid="person-load">
        <td>
          <div class="d-flex align-center ga-2 min-w-0">
            <v-avatar size="24" color="primary-soft" class="people-load__avatar" aria-hidden="true">{{ initials(b.person.name) }}</v-avatar>
            <span class="people-load__name">{{ b.person.name }}</span>
          </div>
        </td>
        <td class="people-load__roles">
          <span class="d-inline-flex flex-wrap ga-1">
            <v-chip v-for="r in b.person.roles" :key="r" size="x-small" variant="outlined">{{ r }}</v-chip>
          </span>
        </td>
        <td class="text-right">{{ b.person.openTasks }}</td>
        <td class="text-right">{{ b.person.inProgressTasks }}</td>
        <td class="people-load__bar-col">
          <v-progress-linear
            :model-value="b.percent"
            :color="b.heavy ? 'warning-dot' : 'primary'"
            bg-color="neutral-soft"
            bg-opacity="1"
            height="6"
            rounded
            :aria-label="t('status.peopleCols.load')"
          />
        </td>
      </tr>
    </tbody>
  </v-table>
</template>

<style scoped>
.people-load :deep(th) { white-space: nowrap; }
.people-load__avatar { font-size: .75rem; font-weight: 600; color: rgb(var(--v-theme-on-primary-soft)); flex: none; }
.people-load__name { overflow-wrap: anywhere; min-width: 96px; }
.people-load__bar-col { width: 18%; min-width: 64px; }
.min-w-0 { min-width: 0; }
@media (max-width: 599px) { .people-load__roles { display: none; } }
</style>
