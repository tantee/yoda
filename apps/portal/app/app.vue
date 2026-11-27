<script setup lang="ts">
const { locale, t } = useI18n()
useHead({ htmlAttrs: { lang: locale } })
// The boot plugin could not start the app (core's /public-config unreadable, or nothing to sign in with): a
// retry screen instead of a blank page or a sign-in loop (spike §2.3). Retry reloads, so the plugin runs again.
const { bootError } = usePublicConfig()
const BOOT_TEXT = {
  config_unavailable: { title: 'boot.configUnavailableTitle', body: 'boot.configUnavailable' },
  not_configured: { title: 'boot.notConfiguredTitle', body: 'boot.notConfigured' },
  insecure_origin: { title: 'boot.insecureTitle', body: 'boot.insecure' },
} as const
function retry() {
  window.location.reload()
}
</script>

<template>
  <v-app>
    <v-main v-if="bootError" class="boot-error">
      <v-card class="boot-error__card pa-6" role="alert" :data-testid="`boot-error-${bootError}`">
        <v-icon icon="mdi-alert-circle-outline" color="error" :size="32" aria-hidden="true" />
        <div class="text-subtitle-1 mt-2">{{ t(BOOT_TEXT[bootError].title) }}</div>
        <div class="text-body-2 text-medium-emphasis mt-1">{{ t(BOOT_TEXT[bootError].body) }}</div>
        <v-btn class="mt-4" variant="outlined" prepend-icon="mdi-refresh" data-testid="boot-retry" @click="retry">{{ t('boot.retry') }}</v-btn>
      </v-card>
    </v-main>
    <NuxtLayout v-else>
      <NuxtPage />
    </NuxtLayout>
  </v-app>
</template>

<style scoped>
.boot-error { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
.boot-error__card { display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 440px; }
</style>
