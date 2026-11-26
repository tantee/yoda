<script setup lang="ts">
import type { NuxtError } from '#app'
import { homeFor } from '~/utils/nav'

/**
 * Unknown routes and uncaught errors, inside the portal shell. Never shows the error's message or URL: after a
 * login redirect the URL fragment holds OAuth parameters, and Nuxt's 404 message echoes the path.
 */
const props = defineProps<{ error: NuxtError }>()
const { t, locale } = useI18n()
const { me, refresh } = useMe()
const meError = useState<string>('meError', () => '')
const notFound = computed(() => props.error?.statusCode === 404)
const status = computed(() => (props.error?.statusCode && props.error.statusCode >= 500 ? props.error.statusCode : null))

// app.vue (which sets the page language) is not rendered for errors.
useHead({ htmlAttrs: { lang: locale } })
useHead({ title: () => (notFound.value ? t('shell.notFound.title') : t('shell.error.title')) })

onMounted(async () => {
  // The shell needs the signed-in user (an unknown route may be the first page loaded).
  if (me.value || meError.value) return
  try {
    await refresh()
  } catch (e) {
    meError.value = errorKey(e)
  }
})

function home() {
  void clearError({ redirect: me.value ? homeFor(me.value) : '/' })
}
function reload() {
  window.location.reload()
}
</script>

<template>
  <v-app>
    <NuxtLayout>
      <EmptyState
        v-if="notFound"
        :title="t('shell.notFound.title')"
        :text="t('shell.notFound.text')"
        icon="mdi-map-marker-question-outline"
        wisdom="notFound"
        data-testid="not-found"
      >
        <v-btn color="primary" data-testid="go-home" @click="home">{{ t('shell.home') }}</v-btn>
      </EmptyState>
      <EmptyState
        v-else
        :title="t('shell.error.title')"
        :text="status ? `${t('shell.error.text')} (${t('shell.error.status', { status })})` : t('shell.error.text')"
        icon="mdi-alert-circle-outline"
        wisdom="error"
        data-testid="error-page"
      >
        <v-btn variant="outlined" prepend-icon="mdi-refresh" @click="reload">{{ t('shell.error.reload') }}</v-btn>
        <v-btn color="primary" data-testid="go-home" @click="home">{{ t('shell.home') }}</v-btn>
      </EmptyState>
    </NuxtLayout>
  </v-app>
</template>
