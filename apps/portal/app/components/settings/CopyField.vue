<script setup lang="ts">
import { ref, useI18n, useId } from '#imports'

/** A read-only value to paste elsewhere (a webhook URL, a generated secret) with a copy button. */
defineProps<{ label: string; value: string; testid?: string }>()
const { t } = useI18n()
const id = `copy-${useId()}`
const copied = ref(false)
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = true
  } catch {
    // the value stays visible to copy by hand
  }
}
</script>

<template>
  <div>
    <label :for="id" class="setting-label">{{ label }}</label>
    <div class="copy-row">
      <v-text-field :id="id" :model-value="value" readonly hide-details class="copy-field" :data-testid="testid" @focus="($event.target as HTMLInputElement).select()" />
      <v-btn :variant="copied ? 'tonal' : 'outlined'" :color="copied ? 'success' : undefined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" :data-testid="testid ? `${testid}-copy` : undefined" @click="copy(value)">
        {{ copied ? t('runners.copied') : t('gitlab.admin.copy') }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.copy-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.copy-field { flex: 1 1 260px; min-width: 0; }
.copy-field :deep(input) { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
</style>
