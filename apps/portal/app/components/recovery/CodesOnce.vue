<script setup lang="ts">
import { ref, useI18n } from '#imports'

/** New recovery codes, shown once (proposal §7.2): copy or print them now; core keeps only their HMACs. */
const props = defineProps<{ codes: string[] }>()
const { t } = useI18n()
const copied = ref(false)

async function copy() {
  try {
    await navigator.clipboard.writeText(props.codes.join('\n'))
    copied.value = true
  } catch {
    // the codes stay visible to copy by hand
  }
}
</script>

<template>
  <div data-testid="codes-once">
    <v-alert type="warning" variant="tonal" density="compact" icon="mdi-key-alert-outline" class="mb-3">{{ t('recovery.codes.once') }}</v-alert>
    <ol class="codes-once__list" data-testid="codes-list">
      <li v-for="c in codes" :key="c"><code>{{ c }}</code></li>
    </ol>
    <v-btn class="mt-3" :variant="copied ? 'tonal' : 'outlined'" :color="copied ? 'success' : undefined" :prepend-icon="copied ? 'mdi-check' : 'mdi-content-copy'" data-testid="codes-copy" @click="copy">
      {{ copied ? t('recovery.codes.copied') : t('recovery.codes.copy') }}
    </v-btn>
  </div>
</template>

<style scoped>
.codes-once__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 4px 16px; padding-left: 1.5em; margin: 0; }
.codes-once__list code { font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9375rem; }
</style>
