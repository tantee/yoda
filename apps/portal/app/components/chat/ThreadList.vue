<script setup lang="ts">
import type { Conversation } from '@yoda/shared'
import { capCount } from '~/utils/nav'
import { threadIcon } from '~/utils/chat'

defineProps<{ conversations: Conversation[]; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useI18n()
const { relative, dateTime } = useDateFormat()

function title(c: Conversation): string {
  return c.kind === 'personal' || c.kind === 'intake' ? t('chat.personal') : c.title
}
</script>

<template>
  <nav class="thread-list" :aria-label="t('chat.threads')" data-testid="thread-list">
    <h2 class="thread-list__head text-subtitle-2">{{ t('chat.threads') }}</h2>
    <v-list density="compact" class="py-1" bg-color="transparent">
      <v-list-item
        v-for="c in conversations"
        :key="c.id"
        :active="c.id === selectedId"
        color="primary"
        rounded="lg"
        class="thread-item mx-2 mb-1"
        lines="two"
        data-testid="thread-item"
        @click="emit('select', c.id)"
      >
        <template #prepend>
          <v-icon :icon="threadIcon(c.kind)" size="20" aria-hidden="true" />
        </template>
        <v-list-item-title class="thread-item__title" :class="{ 'font-weight-bold': c.unread > 0 }">{{ title(c) }}</v-list-item-title>
        <v-list-item-subtitle v-if="c.lastMessageAt" class="tabular-nums" :title="dateTime(c.lastMessageAt)">{{ t(`chat.kind.${c.kind}`) }} · {{ relative(c.lastMessageAt) }}</v-list-item-subtitle>
        <v-list-item-subtitle v-else>{{ t(`chat.kind.${c.kind}`) }}</v-list-item-subtitle>
        <template #append>
          <span v-if="c.unread > 0" class="thread-unread tabular-nums" :aria-label="t('chat.unread', { n: c.unread })" data-testid="thread-unread">{{ capCount(c.unread) }}</span>
        </template>
      </v-list-item>
    </v-list>
  </nav>
</template>

<style scoped>
.thread-list__head { margin: 0; padding: 12px 16px 4px; font-weight: 600; }
.thread-item__title { white-space: normal !important; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.35; }
.thread-item :deep(.v-list-item__prepend) { align-self: flex-start; padding-top: 2px; }
.thread-unread {
  min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center;
  font-size: .75rem; font-weight: 600; background: rgb(var(--v-theme-primary)); color: rgb(var(--v-theme-on-primary));
}
</style>
