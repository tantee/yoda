<script setup lang="ts">
import type { Attachment } from '@yoda/shared'

defineProps<{ attachments: Attachment[] }>()
const { t } = useI18n()
const { download } = useUpload()
const error = ref('')

async function save(a: Attachment) {
  error.value = ''
  try {
    await download(a.id, a.fileName)
  } catch (e) {
    error.value = t((e as { key?: string }).key ?? 'errors.generic')
  }
}
</script>

<template>
  <div v-if="attachments.length" data-testid="attachment-list">
    <div class="d-flex flex-wrap ga-2">
      <v-chip
        v-for="a in attachments"
        :key="a.id"
        size="small"
        prepend-icon="mdi-paperclip"
        append-icon="mdi-download"
        data-testid="attachment-chip"
        @click="save(a)"
      >{{ a.fileName }}</v-chip>
    </div>
    <v-alert v-if="error" type="error" density="compact" class="mt-2">{{ error }}</v-alert>
  </div>
</template>
