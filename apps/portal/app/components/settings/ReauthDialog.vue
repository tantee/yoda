<script setup lang="ts">
import { ref, useI18n } from '#imports'
import { loginLocale } from '~/utils/loginLocale'
import { REAUTH_STASH_KEY, type ReauthStash } from '~/utils/settings'
import ConfirmDialog from '../ConfirmDialog.vue'

/**
 * Secrets, sign-in settings and the public URL need a recent sign-in (8.6, `auth_time` within 10 minutes). This
 * explains why, keeps the form's plain values (never a secret) in sessionStorage, and sends the admin to Keycloak
 * with `prompt=login`, back to the same page, where the form picks the stash up again.
 */
const props = defineProps<{ modelValue: boolean; stash: ReauthStash | null }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const { t } = useI18n()
const busy = ref(false)

async function go() {
  busy.value = true
  try {
    if (props.stash) sessionStorage.setItem(REAUTH_STASH_KEY, JSON.stringify(props.stash))
  } catch {
    // private mode: the admin types the change again after signing in
  }
  const { $keycloak } = useNuxtApp()
  await $keycloak.login({ prompt: 'login', maxAge: 0, locale: loginLocale(document.cookie), redirectUri: window.location.href })
}
</script>

<template>
  <ConfirmDialog
    :model-value="modelValue"
    :title="t('settings.reauth.title')"
    :text="t('settings.reauth.text')"
    :confirm-label="t('settings.reauth.confirm')"
    :busy="busy"
    confirm-testid="reauth-confirm"
    cancel-testid="reauth-cancel"
    data-testid="reauth-dialog"
    @update:model-value="v => emit('update:modelValue', v)"
    @confirm="go"
  >
    <p v-if="stash?.secretsToRetype.length" class="text-body-2 mt-2 mb-0" data-testid="reauth-retype">{{ t('settings.reauth.retype') }}</p>
  </ConfirmDialog>
</template>
