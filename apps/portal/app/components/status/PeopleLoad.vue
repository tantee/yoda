<script setup lang="ts">
import type { PersonLoad } from '@yoda/shared'

defineProps<{ people: PersonLoad[] }>()
const { t } = useI18n()
</script>

<template>
  <p v-if="!people.length" class="text-medium-emphasis">{{ t('status.peopleEmpty') }}</p>
  <v-table v-else density="compact" data-testid="people-load">
    <thead>
      <tr>
        <th>{{ t('status.peopleCols.name') }}</th>
        <th>{{ t('status.peopleCols.roles') }}</th>
        <th class="text-right">{{ t('status.peopleCols.openTasks') }}</th>
        <th class="text-right">{{ t('status.peopleCols.inProgress') }}</th>
        <th class="text-right">{{ t('status.peopleCols.todayAssigned') }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="p in people" :key="p.personId" data-testid="person-load">
        <td>{{ p.name }}</td>
        <td>{{ p.roles.join(', ') }}</td>
        <td class="text-right">{{ p.openTasks }}</td>
        <td class="text-right">{{ p.inProgressTasks }}</td>
        <td class="text-right">{{ p.todayAssigned }}</td>
      </tr>
    </tbody>
  </v-table>
</template>
