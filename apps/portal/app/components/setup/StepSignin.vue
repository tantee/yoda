<script setup lang="ts">
import type { SettingsCategoryView, SettingsPutResponse } from '@yoda/shared'
import { computed, useI18n } from '#imports'
import CategorySection from '~/components/settings/CategorySection.vue'
import CopyField from '~/components/settings/CopyField.vue'
import { keycloakClientValues, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'

/**
 * Step 4 (proposal §4.2, mockup `installer-oidc.html`): the existing Keycloak (the bundled one is a later phase,
 * D2). Issuer, client id, staff group and an optional internal JWKS URL, the values to paste into the Keycloak
 * client, and the connection test (discovery, JWKS, client). Next opens once the saved values passed. The real
 * sign-in through them is the claim at the end (step 10), which also proves the groups claim and the staff group.
 */
const props = defineProps<{ api: SetupFetcher; view: SettingsCategoryView | null; publicUrl: string; done: boolean }>()
const emit = defineEmits<{ back: []; next: []; changed: [view?: SettingsCategoryView] }>()
const { t } = useI18n()
const kc = computed(() => keycloakClientValues(props.publicUrl))
const onSaved = (res: SettingsPutResponse | null) => emit('changed', res?.category)
</script>

<template>
  <StepFrame
    :kicker="t('setup.signin.kicker')"
    :title="t('setup.signin.title')"
    :lead="t('setup.signin.lead')"
    :hint="done ? t('setup.signin.passed') : t('setup.signin.hint')"
    :hint-icon="done ? 'mdi-check-circle-outline' : 'mdi-information-outline'"
    back
    :next-label="t('setup.nav.nextTo', { step: t('setup.step.email') })"
    :next-disabled="!done"
    @back="emit('back')"
    @next="emit('next')"
  >
    <div class="setup-choice mb-5" role="radiogroup" :aria-label="t('setup.signin.mode')">
      <div class="setup-choice__card setup-choice__card--on" role="radio" aria-checked="true">
        <v-icon icon="mdi-radiobox-marked" color="primary" size="20" aria-hidden="true" />
        <div><div class="font-weight-medium">{{ t('setup.signin.existing') }}</div><div class="setup-help mt-0">{{ t('setup.signin.existingHelp') }}</div></div>
      </div>
      <div class="setup-choice__card setup-choice__card--off" role="radio" aria-checked="false" aria-disabled="true">
        <v-icon icon="mdi-radiobox-blank" size="20" aria-hidden="true" />
        <div><div class="font-weight-medium">{{ t('setup.signin.bundled') }}</div><div class="setup-help mt-0">{{ t('setup.signin.bundledHelp') }}</div></div>
      </div>
    </div>

    <CategorySection
      v-if="view"
      category="signin"
      :view="view"
      :title="t('setup.signin.formTitle')"
      icon="mdi-shield-account-outline"
      :client="api"
      base-path="/settings"
      @saved="onSaved"
      @tested="emit('changed')"
      @reload="emit('changed')"
    >
      <template #after>
        <h2 class="setup-subhead mt-6">{{ t('setup.signin.keycloakValues') }}</h2>
        <div class="setup-copy-list">
          <CopyField :label="t('setup.signin.redirectUris')" :value="kc.redirect" testid="setup-kc-redirect" />
          <CopyField :label="t('setup.signin.postLogoutUris')" :value="kc.postLogout" testid="setup-kc-post-logout" />
          <CopyField :label="t('setup.signin.webOrigins')" :value="kc.webOrigin" testid="setup-kc-web-origin" />
        </div>
        <p class="setup-help">{{ t('setup.signin.saveThenTest') }}</p>
      </template>
    </CategorySection>
  </StepFrame>
</template>
