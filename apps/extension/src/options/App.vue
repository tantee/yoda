<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <v-app>
    <v-main class="pa-4" data-testid="app-root">
      <h1 class="text-h6">{{ t('app.name') }}</h1>
    </v-main>
  </v-app>
</template>
