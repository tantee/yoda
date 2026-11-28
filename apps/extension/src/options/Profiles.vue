<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Profile } from '../sw/store'

/** The connected Yodas (mockup extension-setup.html): default, colour, sign-out-on-close, remove. */
defineProps<{ list: Profile[]; forcedSessionOnly?: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const COLOURS = ['#1f5fbf', '#1d6b3a', '#b3261e', '#8a5a00', '#6b3fa0', '#00727a']

async function update(p: Profile, patch: { colour?: string; isDefault?: boolean; sessionOnly?: boolean }) {
  await chrome.runtime.sendMessage({ type: 'profile.update', profileId: p.id, ...patch })
  emit('changed')
}

async function remove(p: Profile) {
  await chrome.runtime.sendMessage({ type: 'profile.remove', profileId: p.id })
  emit('changed')
}
</script>

<template>
  <div class="profiles" data-testid="profiles">
    <v-card v-for="p in list" :key="p.id" variant="outlined" class="profile mb-3" data-testid="profile-row">
      <div class="profile__head">
        <span class="profile__dot" :style="{ background: p.colour }" />
        <strong>{{ p.name }}</strong>
        <v-chip v-if="p.isDefault" size="x-small" color="primary" variant="tonal" data-testid="profile-default">{{ t('options.default') }}</v-chip>
        <v-chip v-if="p.managed" size="x-small" prepend-icon="mdi-lock-outline" variant="outlined">{{ t('options.managed') }}</v-chip>
        <v-spacer />
        <v-chip v-if="p.needsReconnect" color="warning" size="small">{{ t('options.needsReconnect') }}</v-chip>
        <v-chip v-else color="success" size="small" variant="tonal">{{ t('options.connected') }}</v-chip>
      </div>
      <div class="profile__url">{{ p.url }}</div>
      <div v-if="p.person" class="text-body-2 mt-1">{{ t('options.user') }}: {{ p.person.displayName }}</div>
      <div class="profile__controls">
        <div class="profile__colours" role="radiogroup" :aria-label="t('options.colour')">
          <button
            v-for="c in COLOURS"
            :key="c"
            type="button"
            role="radio"
            :aria-checked="p.colour === c"
            :aria-label="c"
            class="profile__swatch"
            :class="{ 'profile__swatch--on': p.colour === c }"
            :style="{ background: c }"
            :data-testid="`profile-colour-${c.slice(1)}`"
            @click="update(p, { colour: c })"
          />
        </div>
        <v-switch
          :model-value="p.sessionOnly"
          :disabled="p.managed || forcedSessionOnly"
          :label="t('options.sessionOnly')"
          density="compact"
          hide-details
          color="primary"
          data-testid="profile-session-only"
          @update:model-value="(v) => update(p, { sessionOnly: !!v })"
        />
        <v-spacer />
        <v-btn v-if="!p.isDefault" variant="text" size="small" data-testid="profile-make-default" @click="update(p, { isDefault: true })">{{ t('options.makeDefault') }}</v-btn>
        <v-btn v-if="!p.managed" variant="text" color="error" size="small" data-testid="profile-remove" @click="remove(p)">{{ t('common.remove') }}</v-btn>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.profile { padding: 12px 14px; }
.profile__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.profile__dot { width: 10px; height: 10px; border-radius: 50%; }
.profile__url { font-family: ui-monospace, monospace; font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.7); margin-top: 2px; }
.profile__controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
.profile__colours { display: flex; gap: 6px; }
.profile__swatch { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
.profile__swatch--on { border-color: rgb(var(--v-theme-on-surface)); }
.profile__swatch:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
</style>
