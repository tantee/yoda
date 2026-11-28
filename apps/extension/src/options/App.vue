<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { profiles as loadProfiles, type Profile } from '../sw/store'
import ConnectDialog from './ConnectDialog.vue'

const { t } = useI18n()
const list = ref<Profile[]>([])

async function load() {
  list.value = await loadProfiles()
}

async function remove(p: Profile) {
  await chrome.runtime.sendMessage({ type: 'profile.remove', profileId: p.id })
  await load()
}

onMounted(load)
</script>

<template>
  <v-app>
    <v-main>
      <div class="options pa-4" data-testid="options">
        <h1 class="text-h6 mb-4">{{ t('app.name') }}</h1>
        <ConnectDialog class="mb-4" @connected="load" />
        <v-card v-if="list.length" data-testid="profiles">
          <v-card-title class="text-subtitle-1">{{ t('options.profiles') }}</v-card-title>
          <v-list>
            <v-list-item v-for="p in list" :key="p.id" :title="p.name" :subtitle="p.url" data-testid="profile-row">
              <template #append>
                <v-chip v-if="p.needsReconnect" color="warning" class="mr-2">{{ t('options.needsReconnect') }}</v-chip>
                <v-chip v-else-if="p.person" class="mr-2">{{ p.person.displayName }}</v-chip>
                <v-btn v-if="!p.managed" variant="text" color="error" size="small" data-testid="profile-remove" @click="remove(p)">{{ t('common.remove') }}</v-btn>
              </template>
            </v-list-item>
          </v-list>
        </v-card>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.options { max-width: 720px; margin: 0 auto; }
</style>
