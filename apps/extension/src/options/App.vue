<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { saveLocale, type Locale } from '../i18n'
import { profiles as loadProfiles, type Profile } from '../sw/store'
import ConnectDialog from './ConnectDialog.vue'
import Permissions from './Permissions.vue'
import Profiles from './Profiles.vue'
import Rules from './Rules.vue'

/** The options page (mockup extension-setup.html): profiles, URL mapping with the tester, granted sites. */
const { t, locale } = useI18n()
const list = ref<Profile[]>([])
/** The managed policy (sw/policy.ts): a notice when IT's policy is invalid, and the switches it locks. */
const policy = ref<{ notice: string | null; policy: { sessionOnly: boolean } } | null>(null)
const version = chrome.runtime.getManifest().version_name ?? chrome.runtime.getManifest().version

async function load() {
  list.value = await loadProfiles()
  policy.value = (await chrome.runtime.sendMessage({ type: 'policy.get' })) as typeof policy.value
}

async function switchLocale(value: string) {
  const l: Locale = value === 'en' ? 'en' : 'th'
  locale.value = l
  await saveLocale(l)
}

onMounted(load)
</script>

<template>
  <v-app>
    <v-main>
      <div class="options" data-testid="options">
        <nav class="options__nav">
          <div class="options__brand">
            <img src="/icons/32.png" width="28" height="28" alt="" />
            <span>{{ t('app.name') }}</span>
          </div>
          <a href="#profiles"><v-icon icon="mdi-account-multiple-outline" size="18" /> {{ t('options.nav.profiles') }}</a>
          <a href="#rules"><v-icon icon="mdi-link-variant" size="18" /> {{ t('options.nav.rules') }}</a>
          <a href="#privacy"><v-icon icon="mdi-shield-lock-outline" size="18" /> {{ t('options.nav.privacy') }}</a>
          <div class="options__version text-caption">{{ t('options.version', { v: version }) }}</div>
        </nav>
        <div class="options__main">
          <header class="options__top">
            <v-spacer />
            <v-btn-toggle :model-value="locale" density="compact" mandatory variant="outlined" @update:model-value="switchLocale">
              <v-btn value="th" size="small" data-testid="lang-th">ไทย</v-btn>
              <v-btn value="en" size="small" data-testid="lang-en">EN</v-btn>
            </v-btn-toggle>
          </header>
          <section id="profiles">
            <h1 class="text-h6 mb-1">{{ t('options.nav.profiles') }}</h1>
            <p class="text-body-2 text-medium-emphasis mb-4">{{ t('options.subtitle') }}</p>
            <v-alert v-if="policy?.notice === 'invalid_policy'" type="warning" variant="tonal" density="compact" class="mb-4" data-testid="policy-invalid">{{ t('options.policyInvalid') }}</v-alert>
            <div class="options__grid">
              <div>
                <h2 class="text-subtitle-1 font-weight-bold mb-2">{{ t('options.profiles') }}</h2>
                <Profiles :list="list" :forced-session-only="policy?.policy.sessionOnly" @changed="load" />
              </div>
              <ConnectDialog @connected="load" />
            </div>
          </section>
          <section id="rules"><Rules :profiles="list" /></section>
          <section id="privacy"><Permissions :profiles="list" /></section>
        </div>
      </div>
    </v-main>
  </v-app>
</template>

<style scoped>
.options { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
.options__nav { background: #0b2545; color: #fff; padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; position: sticky; top: 0; height: 100vh; }
.options__brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 16px; }
.options__nav a { color: #dfe7f2; text-decoration: none; padding: 8px 10px; border-radius: 8px; display: flex; gap: 8px; align-items: center; }
.options__nav a:hover, .options__nav a:focus-visible { background: rgba(255, 255, 255, 0.1); }
.options__version { margin-top: auto; color: #9fb0c8; }
.options__main { padding: 16px 24px 48px; max-width: 1200px; }
.options__top { display: flex; margin-bottom: 8px; }
.options__main section { margin-bottom: 24px; scroll-margin-top: 16px; }
.options__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 900px) {
  .options { grid-template-columns: 1fr; }
  .options__nav { position: static; height: auto; flex-direction: row; flex-wrap: wrap; }
  .options__version { display: none; }
  .options__grid { grid-template-columns: 1fr; }
}
</style>
