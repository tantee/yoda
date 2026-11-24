<script setup lang="ts">
import type { Conversation } from '@yoda/shared'

defineProps<{ conversations: Conversation[]; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
const { t } = useI18n()

function title(c: Conversation): string {
  return c.kind === 'personal' || c.kind === 'intake' ? t('chat.personal') : c.title
}
function icon(c: Conversation): string {
  if (c.kind === 'personal' || c.kind === 'intake') return 'mdi-robot-outline'
  return c.kind === 'project' ? 'mdi-folder-outline' : 'mdi-clipboard-text-outline'
}
</script>

<template>
  <v-list density="compact" data-testid="thread-list">
    <v-list-subheader>{{ t('chat.threads') }}</v-list-subheader>
    <v-list-item
      v-for="c in conversations"
      :key="c.id"
      :active="c.id === selectedId"
      :prepend-icon="icon(c)"
      :title="title(c)"
      data-testid="thread-item"
      @click="emit('select', c.id)"
    >
      <template #append>
        <v-badge v-if="c.unread > 0" :content="c.unread" color="primary" inline data-testid="thread-unread" />
      </template>
    </v-list-item>
  </v-list>
</template>
