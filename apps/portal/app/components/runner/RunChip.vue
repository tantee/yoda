<script setup lang="ts">
import type { TaskRunSummary } from '@yoda/shared'
import { heartbeatAgeMinutes, runStateColor } from '~/utils/runners'

/** Staff only: the latest runner run of a task (state, runner, heartbeat age, branch). */
const props = defineProps<{ run: TaskRunSummary }>()
const { t } = useI18n()

const now = ref(new Date())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => { now.value = new Date() }, 30000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const label = computed(() =>
  props.run.state === 'running'
    ? t('runners.run.runningOn', { name: props.run.runnerName })
    : t('runners.run.chip', { state: t(`runners.state.${props.run.state}`), name: props.run.runnerName }),
)
const age = computed(() => heartbeatAgeMinutes(props.run.heartbeatAt, now.value))
</script>

<template>
  <span class="d-inline-flex align-center flex-wrap ga-1" data-testid="run-chip" :data-state="run.state">
    <v-chip size="x-small" :color="runStateColor(run.state)" prepend-icon="mdi-robot-industrial-outline">
      <v-progress-circular v-if="run.state === 'running'" indeterminate size="10" width="2" class="mr-1" />
      {{ label }}
    </v-chip>
    <span v-if="run.state === 'running'" class="text-caption text-medium-emphasis" data-testid="run-heartbeat">{{ t('runners.run.heartbeat', { n: age }) }}</span>
    <span v-if="run.branch" class="text-caption text-medium-emphasis" data-testid="run-branch">· <code>{{ run.branch }}</code></span>
  </span>
</template>
