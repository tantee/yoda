<script setup lang="ts">
import type { Me } from '@yoda/shared'
import { initials, roleLineKeys } from '~/utils/nav'

/** Avatar + name + role line; the menu holds language, my notifications and logout (proposal §5.3). */
const props = defineProps<{ me: Me; compact?: boolean }>()
const { t, locale, locales, setLocale } = useI18n()
const { $keycloak } = useNuxtApp()

const roleLine = computed(() => roleLineKeys(props.me).map(k => t(k)).join(' · '))
const languages = computed(() => locales.value.map(l => (typeof l === 'string' ? { code: l, name: l } : { code: l.code, name: l.name ?? l.code })))

function logout() {
  $keycloak.logout({ redirectUri: window.location.origin })
}
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props: activator }">
      <button v-bind="activator" type="button" class="user-chip" :aria-label="t('shell.userMenu')" data-testid="user-menu">
        <span class="user-chip__avatar" aria-hidden="true">{{ initials(me.displayName) }}</span>
        <span v-if="!compact" class="user-chip__text">
          <span class="user-chip__name" data-testid="display-name">{{ me.displayName }}</span>
          <span class="user-chip__role" data-testid="role-line">{{ roleLine }}</span>
        </span>
        <v-icon v-if="!compact" icon="mdi-chevron-down" size="18" class="text-medium-emphasis" />
      </button>
    </template>
    <v-list min-width="240">
      <v-list-item v-if="compact" :title="me.displayName" :subtitle="roleLine" />
      <v-divider v-if="compact" />
      <v-list-subheader>{{ t('shell.language') }}</v-list-subheader>
      <v-list-item
        v-for="l in languages"
        :key="l.code"
        :active="locale === l.code"
        role="menuitemradio"
        :aria-checked="locale === l.code"
        :data-testid="`menu-lang-${l.code}`"
        @click="setLocale(l.code as 'th' | 'en')"
      >
        <template #prepend><v-icon :icon="locale === l.code ? 'mdi-radiobox-marked' : 'mdi-radiobox-blank'" :color="locale === l.code ? 'primary' : undefined" /></template>
        <v-list-item-title>{{ l.name }}</v-list-item-title>
      </v-list-item>
      <v-divider class="my-1" />
      <v-list-item to="/settings/notifications" prepend-icon="mdi-bell-cog-outline" :title="t('shell.myNotifications')" data-testid="menu-notification-settings" />
      <v-divider class="my-1" />
      <v-list-item prepend-icon="mdi-logout" :title="t('app.logout')" data-testid="menu-logout" @click="logout" />
    </v-list>
  </v-menu>
</template>

<style scoped>
.user-chip {
  display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 6px 0 4px; border: 0; border-radius: 20px;
  background: transparent; cursor: pointer; color: inherit; text-align: left; min-width: 0;
}
.user-chip:hover { background: rgb(var(--v-theme-surface-light)); }
.user-chip__avatar {
  width: 32px; height: 32px; border-radius: 50%; flex: none; display: grid; place-items: center;
  background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-on-primary-soft)); font-size: 13px; font-weight: 600;
}
.user-chip__text { display: flex; flex-direction: column; min-width: 0; max-width: 180px; }
.user-chip__name, .user-chip__role { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.user-chip__name { font-size: 13px; line-height: 1.3; }
.user-chip__role { font-size: 12px; line-height: 1.3; color: rgba(var(--v-theme-on-surface), .72); }
</style>
