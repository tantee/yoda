<script setup lang="ts">
/** The runner token, shown once right after creation. It lives only in this component's props. */
const props = defineProps<{ token: string }>()
const { t } = useI18n()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.token)
    copied.value = true
  } catch {
    // the token stays visible to copy by hand
  }
}
</script>

<template>
  <div data-testid="token-once">
    <v-alert type="warning" variant="tonal" class="mb-3" data-testid="token-once-warning">{{ t('runners.tokenOnce') }}</v-alert>
    <div class="d-flex ga-2 align-center">
      <v-text-field
        :model-value="token"
        :label="t('runners.tokenTitle')"
        readonly
        hide-details
        density="compact"
        class="font-monospace"
        autocomplete="off"
        data-testid="token-value"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <v-btn variant="outlined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" data-testid="token-copy" @click="copy">
        {{ copied ? t('runners.copied') : t('runners.copy') }}
      </v-btn>
    </div>
  </div>
</template>
