<script setup lang="ts">
/**
 * Inline target date editor (proposal §6.4): a pencil opens a small menu with the date picker (Thai calendar in
 * Thai), save and clear. Emits `YYYY-MM-DD`, or null to clear.
 */
const props = defineProps<{ value: string | null; busy?: boolean }>()
const emit = defineEmits<{ save: [value: string | null] }>()
const { t } = useI18n()
const { date } = useDateFormat()
const open = ref(false)
const picked = ref<Date | null>(null)

const toDate = (v: string | null) => (v ? new Date(`${v}T12:00:00`) : null)
const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date | null) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null)
watch(open, (v) => {
  if (v) picked.value = toDate(props.value)
})
const pickedIso = computed(() => toIso(picked.value))

function save(v: string | null) {
  emit('save', v)
  open.value = false
}
</script>

<template>
  <v-menu v-model="open" :close-on-content-click="false" location="bottom end">
    <template #activator="{ props: act }">
      <v-btn
        v-bind="act"
        icon="mdi-pencil-outline"
        size="small"
        variant="text"
        color="primary"
        density="comfortable"
        :aria-label="t('workItems.editTargetDate')"
        :title="t('workItems.editTargetDate')"
        data-testid="target-date-edit"
      />
    </template>
    <v-card min-width="300" data-testid="target-date-menu">
      <v-date-picker
        v-model="picked"
        :header="pickedIso ? date(pickedIso) : t('workItems.noTargetDate')"
        :title="t('workItems.targetDate')"
        show-adjacent-months
        data-testid="target-date-input"
      />
      <div class="text-caption text-medium-emphasis px-4">{{ t('workItems.targetDateHint') }}</div>
      <v-card-actions>
        <v-btn v-if="value" variant="text" color="error" :disabled="busy" data-testid="target-date-clear" @click="save(null)">{{ t('workItems.clearTargetDate') }}</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="open = false">{{ t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="busy"
          :disabled="!pickedIso || pickedIso === value"
          data-testid="target-date-save"
          @click="save(pickedIso)"
        >{{ t('workItems.saveTargetDate') }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-menu>
</template>
