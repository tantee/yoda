<script setup lang="ts">
const { locale } = useI18n()
useHead({ htmlAttrs: { lang: locale } })
</script>

<template>
  <v-app>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </v-app>
</template>
