<script setup lang="ts">
import type { HealthReason } from '@yoda/shared'
import { reasonLink, reasonText } from '~/utils/status'

defineProps<{ reasons: HealthReason[] }>()
const { t } = useI18n()
</script>

<template>
  <ul v-if="reasons.length" class="pl-5 text-body-2" data-testid="health-reasons">
    <li v-for="r in reasons" :key="r.code" :data-code="r.code" data-testid="health-reason">
      {{ reasonText(t, r) }}<template v-for="(s, i) in r.sample" :key="s.id"><span class="text-medium-emphasis">{{ i === 0 ? ': ' : ', ' }}</span><NuxtLink :to="reasonLink(r.code, s.id)" data-testid="reason-sample">{{ s.title }}</NuxtLink></template>
    </li>
  </ul>
</template>
