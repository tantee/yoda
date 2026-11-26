<script setup lang="ts">
import { homeFor } from '~/utils/nav'

// Reached from the route guard; the blocked URL is never shown (it may carry tokens or ids).
definePageMeta({ crumbs: [{ key: 'shell.forbidden.crumb' }] })
const { t } = useI18n()
const { me } = useMe()
const route = useRoute()
const title = computed(() => {
  const need = route.query.need
  return need === 'admin' ? t('shell.forbidden.admin') : need === 'staff' ? t('shell.forbidden.staff') : t('shell.forbidden.generic')
})
</script>

<template>
  <EmptyState :title="title" :text="t('shell.forbidden.text')" icon="mdi-lock-outline" :wisdom="false" data-testid="forbidden">
    <v-btn color="primary" :to="me ? homeFor(me) : '/'" data-testid="go-home">{{ t('shell.home') }}</v-btn>
  </EmptyState>
</template>
