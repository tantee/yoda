<script setup lang="ts">
import { navItemsFor } from '~/utils/nav'

const { me } = useMe()
const { $keycloak } = useNuxtApp()
const { t, locale, locales, setLocale } = useI18n()
// null lets Vuetify open it on desktop and keep it closed on narrow screens
const drawer = ref<boolean | null>(null)
const meError = useState<string>('meError', () => '')
const items = computed(() => (me.value ? navItemsFor(me.value) : []))

function logout() {
  $keycloak.logout({ redirectUri: window.location.origin })
}
</script>

<template>
  <v-app-bar flat border>
    <v-app-bar-nav-icon @click="drawer = !drawer" />
    <v-app-bar-title>{{ t('app.title') }}</v-app-bar-title>
    <v-btn-toggle
      :model-value="locale"
      mandatory
      density="compact"
      variant="outlined"
      divided
      class="mr-4"
      @update:model-value="(v: string) => setLocale(v as 'th' | 'en')"
    >
      <v-btn v-for="l in locales" :key="typeof l === 'string' ? l : l.code" :value="typeof l === 'string' ? l : l.code" size="small">
        {{ typeof l === 'string' ? l : l.code.toUpperCase() }}
      </v-btn>
    </v-btn-toggle>
    <span v-if="me" class="mr-2" data-testid="display-name">{{ me.displayName }}</span>
    <v-btn icon="mdi-logout" :title="t('app.logout')" @click="logout" />
  </v-app-bar>
  <v-navigation-drawer v-model="drawer">
    <v-list nav>
      <v-list-item
        v-for="item in items"
        :key="item.key"
        :to="item.to"
        :prepend-icon="item.icon"
        :title="t(item.key)"
      />
    </v-list>
  </v-navigation-drawer>
  <v-main>
    <v-container>
      <v-alert v-if="meError" type="error" data-testid="me-error">{{ t(meError) }}</v-alert>
      <slot v-else />
    </v-container>
  </v-main>
</template>
