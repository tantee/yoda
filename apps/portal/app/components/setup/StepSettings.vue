<script setup lang="ts">
import type { MasterKeyView, SettingCategory, SettingsCategoryView, SettingsPutResponse, SetupStepId } from '@yoda/shared'
import { computed, useI18n } from '#imports'
import CategorySection from '~/components/settings/CategorySection.vue'
import CopyField from '~/components/settings/CopyField.vue'
import TelegramWebhook from '~/components/settings/TelegramWebhook.vue'
import { CATEGORY_ICONS, webhookUrl } from '~/utils/settings'
import { nextStep, type SetupFetcher } from '~/utils/setup'
import StepFrame from './StepFrame.vue'

/**
 * Steps 5–8 (proposal §4.2): email, LINE, Telegram (with webhook registration), and GitLab, AI and backups. The
 * same forms, tests and rules as System settings, saved through the setup session; each step can be skipped and
 * says where to find it later.
 */
const props = defineProps<{
  api: SetupFetcher
  step: SetupStepId
  categories: SettingCategory[]
  views: SettingsCategoryView[]
  publicUrl: string
  origin: string
  keyStatus: MasterKeyView['status'] | null
}>()
const emit = defineEmits<{ back: []; skip: []; next: []; changed: [view?: SettingsCategoryView] }>()
const { t } = useI18n()
const viewOf = (c: SettingCategory) => props.views.find(v => v.category === c) ?? null
const hook = (path: string) => webhookUrl(props.publicUrl, props.origin, path)
const following = computed(() => nextStep(props.step))
const onSaved = (res: SettingsPutResponse | null) => emit('changed', res?.category)
</script>

<template>
  <StepFrame
    :kicker="t(`setup.optional.${step}.kicker`)"
    :title="t(`setup.optional.${step}.title`)"
    :lead="t(`setup.optional.${step}.lead`)"
    :hint="t('setup.optional.later')"
    hint-icon="mdi-cog-outline"
    back
    skippable
    :next-label="following ? t('setup.nav.nextTo', { step: t(`setup.step.${following}`) }) : t('setup.nav.next')"
    @back="emit('back')"
    @skip="emit('skip')"
    @next="emit('next')"
  >
    <div class="setup-sections">
      <template v-for="c in categories" :key="c">
        <CategorySection
          v-if="viewOf(c)"
          :category="c"
          :view="viewOf(c)!"
          :title="t(`settings.category.${c}`)"
          :icon="CATEGORY_ICONS[c]"
          :generate="c === 'gitlab' ? ['gitlab.webhookSecret'] : c === 'telegram' ? ['telegram.webhookSecret'] : []"
          :key-status="keyStatus"
          :client="api"
          base-path="/settings"
          @saved="onSaved"
          @generated="emit('changed')"
          @reload="emit('changed')"
        >
          <template v-if="c === 'gitlab'" #after>
            <div class="mt-4"><CopyField :label="t('gitlab.admin.webhookUrl')" :value="hook('/api/gitlab/webhook')" testid="setup-gitlab-webhook-url" /></div>
          </template>
          <template v-else-if="c === 'line'" #after>
            <div class="mt-4"><CopyField :label="t('settings.channels.lineWebhookUrl')" :value="hook('/api/webhooks/line')" testid="setup-line-webhook-url" /></div>
            <p class="setup-help">{{ t('setup.optional.lineVerify') }}</p>
          </template>
          <template v-else-if="c === 'telegram'" #after>
            <TelegramWebhook :url="hook('/api/webhooks/telegram')" :client="api" base-path="/settings" />
          </template>
          <template v-else-if="c === 'backups'" #after>
            <p class="setup-help mt-3">{{ t('setup.optional.backupsHost') }}</p>
          </template>
        </CategorySection>
      </template>
    </div>
  </StepFrame>
</template>

<style scoped>
.setup-sections { display: grid; gap: 16px; }
</style>
