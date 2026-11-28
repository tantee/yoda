<script setup lang="ts">
import { matchesPattern } from '@yoda/shared'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Profile } from '../sw/store'

/** The sites the extension may read (granted origins), each removable; a connected Yoda's own origin is not. */
const props = defineProps<{ profiles: Profile[] }>()
const { t } = useI18n()
const origins = ref<string[]>([])
/** An origin a connected Yoda needs (exactly, or through a wildcard): removing it would break the profile. */
const needed = (o: string) => props.profiles.some((p) => o === `${p.url}/*` || matchesPattern(o, `${p.url}/`))

async function load() {
  origins.value = ((await chrome.permissions.getAll()).origins ?? []).filter((o) => o !== '<all_urls>').sort()
}

async function remove(o: string) {
  await chrome.permissions.remove({ origins: [o] })
  await load()
}

onMounted(load)
</script>

<template>
  <v-card variant="outlined" data-testid="permissions">
    <v-card-title class="text-subtitle-1 font-weight-bold">{{ t('options.privacy') }}</v-card-title>
    <v-card-subtitle class="text-wrap">{{ t('options.privacyHint') }}</v-card-subtitle>
    <v-list density="compact">
      <v-list-item v-if="!origins.length" :title="t('options.noOrigins')" />
      <v-list-item v-for="o in origins" :key="o" :title="o" data-testid="origin-row">
        <template #append>
          <v-chip v-if="needed(o)" size="x-small" variant="tonal">Yoda</v-chip>
          <v-btn v-else variant="text" color="error" size="small" data-testid="origin-remove" @click="remove(o)">{{ t('common.remove') }}</v-btn>
        </template>
      </v-list-item>
    </v-list>
  </v-card>
</template>
