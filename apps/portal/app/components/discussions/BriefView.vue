<script setup lang="ts">
import type { Discussion } from '@yoda/shared'
import { briefFailKey } from '~/utils/discussions'

/**
 * The brief of a discussion: context and recommendation. An AI brief sits in the AI container ("ร่างโดย AI");
 * a person's in a plain card. The options are `DiscussionsOptionCards`. AI text is untrusted: sanitized markdown
 * for the context, plain text for the rest.
 */
const props = defineProps<{ discussion: Discussion; canEdit?: boolean; canRetry?: boolean; busy?: boolean }>()
const emit = defineEmits<{ edit: []; retry: [] }>()
const { t } = useI18n()
const brief = computed(() => props.discussion.brief)
const undecided = computed(() => props.discussion.state === 'open' || props.discussion.state === 'scheduled')
const ai = computed(() => brief.value?.status === 'ready' && brief.value.source === 'ai')
const recommendedTitle = computed(() => brief.value?.options.find(o => o.key === brief.value?.recommendedKey)?.title ?? '')
const editable = computed(() => props.canEdit && undecided.value && brief.value?.status !== 'pending')
</script>

<template>
  <section data-testid="brief">
    <div class="brief-head">
      <h2 class="brief-title">{{ t('discussions.brief.title') }}</h2>
      <StatusChip v-if="ai" kind="aiDraft" value="normal" :label="t('discussions.brief.aiPrepared')" size="x-small" data-testid="ai-prepared" />
      <span v-else-if="brief?.status === 'ready'" class="text-caption text-medium-emphasis">{{ t('discussions.brief.personWritten') }}</span>
      <v-spacer />
      <v-btn v-if="editable" size="small" variant="text" color="primary" prepend-icon="mdi-pencil-outline" data-testid="brief-edit" @click="emit('edit')">
        {{ t('discussions.brief.edit') }}
      </v-btn>
    </div>

    <v-card v-if="brief?.status === 'pending'" class="brief-state" data-testid="brief-pending">
      <StatusChip kind="aiStatus" value="drafting" :label="t('discussions.brief.preparing')" />
      <span class="text-body-2 text-medium-emphasis">{{ t('discussions.brief.preparingHint') }}</span>
    </v-card>
    <v-alert v-else-if="brief?.status === 'failed'" type="warning" variant="tonal" density="compact" class="brief-failed" data-testid="brief-failed">
      {{ t('discussions.brief.failed', { reason: t(briefFailKey(brief.failReason)) }) }}
      <template #append>
        <v-btn v-if="canRetry && undecided" size="small" variant="outlined" :loading="busy" data-testid="brief-retry" @click="emit('retry')">{{ t('discussions.brief.retry') }}</v-btn>
      </template>
    </v-alert>
    <p v-else-if="!brief" class="text-body-2 text-medium-emphasis">{{ t('discussions.brief.none') }}</p>

    <template v-if="brief && brief.status !== 'pending' && (brief.context || brief.recommendation)">
      <AiDraft v-if="ai">
        <template v-if="brief.context">
          <h3 class="brief-sub">{{ t('discussions.brief.context') }}</h3>
          <MarkdownView :source="brief.context" class="brief-reading" />
        </template>
        <div v-if="brief.recommendation" class="brief-rec" data-testid="brief-recommendation">
          <h3 class="brief-sub">{{ t('discussions.brief.recommendation') }}<template v-if="recommendedTitle">: {{ recommendedTitle }}</template></h3>
          <p class="pre mb-0">{{ brief.recommendation }}</p>
        </div>
      </AiDraft>
      <v-card v-else class="card-body">
        <template v-if="brief.context">
          <h3 class="brief-sub">{{ t('discussions.brief.context') }}</h3>
          <MarkdownView :source="brief.context" class="brief-reading" />
        </template>
        <div v-if="brief.recommendation" class="brief-rec" data-testid="brief-recommendation">
          <h3 class="brief-sub">{{ t('discussions.brief.recommendation') }}<template v-if="recommendedTitle">: {{ recommendedTitle }}</template></h3>
          <p class="pre mb-0">{{ brief.recommendation }}</p>
        </div>
      </v-card>
    </template>
  </section>
</template>

<style scoped>
.brief-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.brief-title { margin: 0; font-size: 1rem; font-weight: 600; }
.brief-sub { margin: 0 0 4px; font-size: .875rem; font-weight: 600; }
.brief-reading { max-width: 720px; }
.brief-rec { margin-top: 12px; }
.brief-rec:first-child { margin-top: 0; }
.brief-state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; }
.pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
