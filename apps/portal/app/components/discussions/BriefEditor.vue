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
  <section data-testid="brief-editor">
    <h2 class="text-h6 mb-2">{{ t('discussions.brief.edit') }}</h2>
    <v-textarea v-model="context" :label="t('discussions.brief.context')" rows="3" auto-grow data-testid="brief-context" />
    <v-card v-for="(o, i) in options" :key="o.key" variant="outlined" class="mb-2" data-testid="brief-option-edit">
      <v-card-text>
        <div class="d-flex ga-2">
          <v-text-field v-model="o.title" :label="t('discussions.optionTitle')" density="compact" maxlength="200" hide-details="auto" />
          <v-btn icon="mdi-close" variant="text" size="small" :title="t('discussions.removeOption')" @click="removeOption(i)" />
        </div>
        <v-textarea v-model="o.pros" :label="t('discussions.brief.pros')" rows="1" auto-grow density="compact" class="mt-2" hide-details />
        <v-textarea v-model="o.cons" :label="t('discussions.brief.cons')" rows="1" auto-grow density="compact" class="mt-2" hide-details />
      </v-card-text>
    </v-card>
    <v-btn size="small" variant="text" prepend-icon="mdi-plus" :disabled="options.length >= 8" data-testid="brief-add-option" @click="addOption">
      {{ t('discussions.addOption') }}
    </v-btn>
    <v-select v-model="recommendedKey" :items="recommendItems" :label="t('discussions.brief.recommended')" class="mt-2" />
    <v-textarea v-model="recommendation" :label="t('discussions.brief.recommendation')" rows="2" auto-grow />
    <v-alert v-if="!valid" type="warning" density="compact" class="mb-2">{{ t('discussions.brief.noOptionTitle') }}</v-alert>
    <v-alert v-if="error" type="error" density="compact" class="mb-2" data-testid="brief-error">{{ error }}</v-alert>
    <div class="d-flex ga-2">
      <v-btn color="primary" :loading="busy" :disabled="!valid" data-testid="brief-save" @click="save">{{ t('discussions.brief.save') }}</v-btn>
      <v-btn variant="text" @click="emit('cancel')">{{ t('common.cancel') }}</v-btn>
    </div>
  </section>
</template>
