<script setup lang="ts">
import type { Discussion } from '@yoda/shared'
import { briefFailKey } from '~/utils/discussions'

/** The brief of a discussion. AI text is untrusted: plain text for options, sanitized markdown for the context. */
const props = defineProps<{ discussion: Discussion; canEdit?: boolean; canRetry?: boolean; busy?: boolean }>()
const emit = defineEmits<{ edit: []; retry: [] }>()
const { t } = useI18n()
const brief = computed(() => props.discussion.brief)
const undecided = computed(() => props.discussion.state === 'open' || props.discussion.state === 'scheduled')
</script>

<template>
  <section data-testid="brief">
    <div class="d-flex align-center ga-2 mb-2">
      <h2 class="text-h6">{{ t('discussions.brief.title') }}</h2>
      <StatusChip v-if="brief?.status === 'ready' && brief.source === 'ai'" kind="aiDraft" value="normal" :label="t('discussions.brief.aiPrepared')" size="x-small" data-testid="ai-prepared" />
      <v-chip v-else-if="brief?.status === 'ready'" size="x-small" variant="outlined">{{ t('discussions.brief.personWritten') }}</v-chip>
      <v-spacer />
      <v-btn v-if="canEdit && undecided && brief?.status !== 'pending'" size="small" variant="outlined" prepend-icon="mdi-pencil" data-testid="brief-edit" @click="emit('edit')">
        {{ t('discussions.brief.edit') }}
      </v-btn>
    </div>

    <v-alert v-if="brief?.status === 'pending'" type="info" variant="tonal" density="compact" data-testid="brief-pending">{{ t('discussions.brief.preparing') }}</v-alert>
    <v-alert v-else-if="brief?.status === 'failed'" type="warning" variant="tonal" density="compact" data-testid="brief-failed">
      {{ t('discussions.brief.failed', { reason: t(briefFailKey(brief.failReason)) }) }}
      <template #append>
        <v-btn v-if="canRetry && undecided" size="small" variant="outlined" :loading="busy" data-testid="brief-retry" @click="emit('retry')">{{ t('discussions.brief.retry') }}</v-btn>
      </template>
    </v-alert>
    <p v-else-if="!brief" class="text-medium-emphasis">{{ t('discussions.brief.none') }}</p>

    <template v-if="brief && brief.status !== 'pending'">
      <template v-if="brief.context">
        <h3 class="text-subtitle-2 mt-3 mb-1">{{ t('discussions.brief.context') }}</h3>
        <MarkdownView :source="brief.context" />
      </template>
      <template v-if="brief.options.length">
        <h3 class="text-subtitle-2 mt-3 mb-1">{{ t('discussions.brief.options') }}</h3>
        <v-card
          v-for="o in brief.options"
          :key="o.key"
          variant="outlined"
          class="mb-2"
          :color="o.key === brief.recommendedKey ? 'primary' : undefined"
          data-testid="brief-option"
        >
          <v-card-text>
            <div class="font-weight-medium">
              {{ o.title }}
              <v-chip v-if="o.key === brief.recommendedKey" size="x-small" color="primary" class="ml-1">{{ t('discussions.brief.recommended') }}</v-chip>
            </div>
            <div v-if="o.pros" class="mt-1"><strong>{{ t('discussions.brief.pros') }}:</strong> <span class="pre">{{ o.pros }}</span></div>
            <div v-if="o.cons" class="mt-1"><strong>{{ t('discussions.brief.cons') }}:</strong> <span class="pre">{{ o.cons }}</span></div>
          </v-card-text>
        </v-card>
      </template>
      <template v-if="brief.recommendation">
        <h3 class="text-subtitle-2 mt-3 mb-1">{{ t('discussions.brief.recommendation') }}</h3>
        <p class="pre" data-testid="brief-recommendation">{{ brief.recommendation }}</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.pre { white-space: pre-wrap; }
</style>
