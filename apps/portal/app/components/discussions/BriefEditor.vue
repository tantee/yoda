<script setup lang="ts">
import type { Discussion } from '@yoda/shared'

const props = defineProps<{ discussion: Discussion }>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const { t } = useI18n()
const api = useApi()
const b = props.discussion.brief

const context = ref(b?.context ?? '')
const recommendation = ref(b?.recommendation ?? '')
const recommendedKey = ref<string | null>(b?.recommendedKey ?? null)
const options = ref((b?.options ?? []).map(o => ({ ...o })))
const busy = ref(false)
const error = ref('')
let counter = 0

const addOption = () => options.value.push({ key: `opt-${++counter}-${Date.now().toString(36)}`, title: '', pros: '', cons: '' })
function removeOption(i: number) {
  const [gone] = options.value.splice(i, 1)
  if (gone && recommendedKey.value === gone.key) recommendedKey.value = null
}
const valid = computed(() => options.value.every(o => o.title.trim()))
const recommendItems = computed(() => [
  { value: null, title: t('discussions.brief.noRecommended') },
  ...options.value.filter(o => o.title.trim()).map(o => ({ value: o.key, title: o.title })),
])

async function save() {
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${props.discussion.id}/brief`, {
      method: 'PUT',
      body: {
        context: context.value,
        recommendation: recommendation.value,
        recommendedKey: recommendedKey.value,
        options: options.value.map(o => ({ ...o, title: o.title.trim() })),
      },
    })
    emit('saved')
  } catch (e) {
    error.value = t(errorKey(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <v-card data-testid="brief-editor">
    <div class="card-head"><h2>{{ t('discussions.brief.edit') }}</h2></div>
    <div class="card-body">
      <v-textarea v-model="context" :label="t('discussions.brief.context')" rows="3" auto-grow class="mb-4" data-testid="brief-context" />
      <h3 class="text-body-2 font-weight-medium mb-2">{{ t('discussions.brief.options') }}</h3>
      <div v-for="(o, i) in options" :key="o.key" class="brief-opt" data-testid="brief-option-edit">
        <div class="d-flex ga-2 align-start">
          <v-text-field v-model="o.title" :label="t('discussions.optionTitleN', { n: i + 1 })" maxlength="200" />
          <v-btn icon="mdi-close" variant="text" size="small" class="mt-1" :aria-label="t('discussions.removeOption')" :title="t('discussions.removeOption')" @click="removeOption(i)" />
        </div>
        <div class="brief-opt__pc">
          <v-textarea v-model="o.pros" :label="t('discussions.brief.pros')" rows="1" auto-grow hide-details />
          <v-textarea v-model="o.cons" :label="t('discussions.brief.cons')" rows="1" auto-grow hide-details />
        </div>
      </div>
      <v-btn size="small" variant="text" color="primary" prepend-icon="mdi-plus" :disabled="options.length >= 8" data-testid="brief-add-option" @click="addOption">
        {{ t('discussions.addOption') }}
      </v-btn>
      <v-select v-model="recommendedKey" :items="recommendItems" :label="t('discussions.brief.recommended')" class="mt-4 mb-3" />
      <v-textarea v-model="recommendation" :label="t('discussions.brief.recommendation')" rows="2" auto-grow />
      <p v-if="!valid" class="text-caption text-error d-flex align-center ga-1 mt-2 mb-0">
        <v-icon icon="mdi-alert-circle-outline" size="14" aria-hidden="true" />{{ t('discussions.brief.noOptionTitle') }}
      </p>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-2" data-testid="brief-error">{{ error }}</v-alert>
    </div>
    <v-card-actions class="brief-actions">
      <v-spacer />
      <v-btn variant="text" @click="emit('cancel')">{{ t('common.cancel') }}</v-btn>
      <v-btn color="primary" variant="flat" :loading="busy" :disabled="!valid" data-testid="brief-save" @click="save">{{ t('discussions.brief.save') }}</v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.brief-opt { border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
.brief-opt__pc { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
@media (max-width: 599px) { .brief-opt__pc { grid-template-columns: minmax(0, 1fr); } }
.brief-actions { padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
