<script setup lang="ts">
import {
  AccountType,
  RunnerCapability,
  RunnerKind,
  RunnerMode,
  WorkingHours,
  type Person,
  type RunnerCreate,
  type RunnerCreated,
} from '@yoda/shared'

/**
 * Create a runner. Staff register their own dev machine; admins also pick the kind and the staff owner.
 * After creation the dialog shows the token once; it is dropped when the dialog closes.
 */
const props = defineProps<{ modelValue: boolean; isAdmin: boolean; meId: string }>()
const emit = defineEmits<{ 'update:modelValue': [boolean]; created: [] }>()

const { t } = useI18n()
const api = useApi()

const name = ref('')
const kind = ref<RunnerCreate['kind']>('dev-machine')
const ownerId = ref<string | null>(null)
const accountType = ref<RunnerCreate['accountType']>('api-key')
const capabilities = ref<RunnerCreate['capabilities']>(['code-change'])
const mode = ref<RunnerCreate['mode']>('on-demand')
const maxConcurrent = ref(1)
const limitHours = ref(false)
const days = ref<number[]>([1, 2, 3, 4, 5])
const start = ref('09:00')
const end = ref('17:00')
const staff = ref<Person[]>([])
const error = ref('')
const busy = ref(false)
const token = ref<string | null>(null)

const opts = <T extends string>(values: readonly T[], prefix: string) => values.map(v => ({ value: v, title: t(`${prefix}.${v}`) }))
const kindItems = computed(() => opts(RunnerKind.options, 'runners.kind'))
const accountItems = computed(() => opts(AccountType.options, 'runners.accountType'))
const capabilityItems = computed(() => opts(RunnerCapability.options, 'runners.capability'))
const modeItems = computed(() => opts(RunnerMode.options, 'runners.mode'))
const ownerItems = computed(() => staff.value.filter(p => p.isStaff).map(p => ({ title: p.displayName, subtitle: p.username, value: p.id })))

const hours = computed(() => (limitHours.value ? WorkingHours.safeParse({ days: [...days.value].sort(), start: start.value, end: end.value }) : null))
const canSubmit = computed(() => !!name.value.trim() && capabilities.value.length > 0 && (!hours.value || hours.value.success))

watch(() => props.modelValue, (open) => {
  if (!open) {
    token.value = null // shown once: never kept after the dialog closes
    return
  }
  name.value = ''
  kind.value = 'dev-machine'
  ownerId.value = props.meId
  accountType.value = 'api-key'
  capabilities.value = ['code-change']
  mode.value = 'on-demand'
  maxConcurrent.value = 1
  limitHours.value = false
  days.value = [1, 2, 3, 4, 5]
  start.value = '09:00'
  end.value = '17:00'
  error.value = ''
  token.value = null
  if (props.isAdmin && !staff.value.length) {
    api<Person[]>('/people').then((list) => { staff.value = list }).catch(() => { staff.value = [] })
  }
})

async function submit() {
  if (!canSubmit.value) return
  error.value = ''
  busy.value = true
  try {
    const body: RunnerCreate = {
      name: name.value.trim(),
      kind: props.isAdmin ? kind.value : 'dev-machine',
      accountType: accountType.value,
      capabilities: capabilities.value,
      mode: mode.value,
      maxConcurrent: maxConcurrent.value,
      workingHours: hours.value?.success ? hours.value.data : null,
    }
    if (props.isAdmin && ownerId.value) body.ownerId = ownerId.value
    const created = await api<RunnerCreated>('/runners', { method: 'POST', body })
    token.value = created.token
    emit('created')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}

const close = () => emit('update:modelValue', false)
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="600" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card :title="token ? t('runners.tokenTitle') : t('runners.dialog.title')" data-testid="runner-dialog">
      <v-card-text v-if="token">
        <RunnerTokenOnce :token="token" />
      </v-card-text>
      <v-card-text v-else class="d-flex flex-column ga-2">
        <v-alert v-if="error" type="error" data-testid="runner-create-error">{{ error }}</v-alert>
        <v-text-field v-model="name" :label="t('runners.dialog.name')" :hint="t('runners.dialog.nameHint')" maxlength="80" data-testid="runner-name" />
        <template v-if="isAdmin">
          <v-select v-model="kind" :items="kindItems" :label="t('runners.col.kind')" data-testid="runner-kind" />
          <v-autocomplete v-model="ownerId" :items="ownerItems" :label="t('runners.dialog.owner')" data-testid="runner-owner" />
        </template>
        <v-select v-model="accountType" :items="accountItems" :label="t('runners.col.accountType')" data-testid="runner-account" />
        <v-alert v-if="accountType === 'personal-subscription'" type="info" variant="tonal" density="compact" data-testid="runner-personal-hint">
          {{ t('runners.dialog.personalHint') }}
        </v-alert>
        <v-select v-model="capabilities" :items="capabilityItems" :label="t('runners.col.capabilities')" multiple chips closable-chips data-testid="runner-capabilities" />
        <v-select v-model="mode" :items="modeItems" :label="t('runners.col.mode')" data-testid="runner-mode" />
        <v-select v-model="maxConcurrent" :items="[1, 2, 3, 4]" :label="t('runners.dialog.maxConcurrent')" data-testid="runner-max" />
        <v-switch v-model="limitHours" :label="t('runners.dialog.limitHours')" color="primary" hide-details data-testid="runner-limit-hours" />
        <template v-if="limitHours">
          <div class="text-caption">{{ t('runners.dialog.days') }}</div>
          <v-chip-group v-model="days" multiple column selected-class="text-primary" data-testid="runner-days">
            <v-chip v-for="d in [1, 2, 3, 4, 5, 6, 0]" :key="d" :value="d" filter size="small">{{ t(`runners.days.${d}`) }}</v-chip>
          </v-chip-group>
          <div class="d-flex ga-2">
            <v-text-field v-model="start" type="time" :label="t('runners.dialog.start')" data-testid="runner-start" />
            <v-text-field v-model="end" type="time" :label="t('runners.dialog.end')" data-testid="runner-end" />
          </div>
          <div class="text-caption text-medium-emphasis">{{ t('runners.dialog.hoursHint') }}</div>
          <div v-if="hours && !hours.success" class="text-caption text-error" data-testid="runner-hours-error">{{ t('runners.dialog.invalidHours') }}</div>
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <template v-if="token">
          <v-btn color="primary" data-testid="runner-token-done" @click="close">{{ t('runners.done') }}</v-btn>
        </template>
        <template v-else>
          <v-btn @click="close">{{ t('common.cancel') }}</v-btn>
          <v-btn color="primary" :disabled="!canSubmit" :loading="busy" data-testid="runner-create-submit" @click="submit">{{ t('runners.create') }}</v-btn>
        </template>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
