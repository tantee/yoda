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
    <v-alert type="warning" variant="tonal" density="compact" icon="mdi-key-alert-outline" class="mb-4" data-testid="token-once-warning">{{ t('runners.tokenOnce') }}</v-alert>
    <div class="token-row">
      <v-text-field
        :model-value="token"
        :label="t('runners.tokenTitle')"
        readonly
        hide-details
        class="token-field"
        autocomplete="off"
        spellcheck="false"
        data-testid="token-value"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <v-btn :variant="copied ? 'tonal' : 'outlined'" :color="copied ? 'success' : undefined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" data-testid="token-copy" @click="copy">
        {{ copied ? t('runners.copied') : t('runners.copy') }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.token-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.token-field { flex: 1 1 260px; min-width: 0; }
.token-field :deep(input) { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
</style>
