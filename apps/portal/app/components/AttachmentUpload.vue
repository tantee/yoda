<script setup lang="ts">
import type { Attachment } from '@yoda/shared'
import { validateUpload } from '~/utils/upload'

/** With `conversationId` the file goes into that conversation (requesters); otherwise into the project. */
const props = defineProps<{ projectId?: string; conversationId?: string; workItemId?: string; taskId?: string }>()
const emit = defineEmits<{ uploaded: [Attachment] }>()

const { t } = useI18n()
const { upload, uploadToConversation } = useUpload()
const noAi = ref(false)
const busy = ref(false)
const over = ref(false)
const error = ref('')
const done = ref('')
const input = ref<HTMLInputElement | null>(null)

async function send(files: FileList | File[] | null | undefined) {
  const file = files?.[0]
  if (!file || busy.value) return
  error.value = ''
  done.value = ''
  const bad = validateUpload(file)
  if (bad) {
    error.value = t(bad)
    return
  }
  busy.value = true
  try {
    const a = props.conversationId
      ? await uploadToConversation(props.conversationId, file, { noAi: noAi.value })
      : await upload(props.projectId!, file, { workItemId: props.workItemId, taskId: props.taskId, noAi: noAi.value })
    done.value = `${t('knowledge.uploaded')}: ${a.fileName}`
    emit('uploaded', a)
  } catch (e) {
    error.value = t((e as { key?: string }).key ?? 'errors.generic')
  } finally {
    busy.value = false
    if (input.value) input.value.value = ''
  }
}

function onDrop(e: DragEvent) {
  over.value = false
  send(e.dataTransfer?.files)
}
</script>

<template>
  <div data-testid="attachment-upload">
    <div
      class="pa-6 text-center rounded border-dashed border-md"
      :class="over ? 'bg-primary-lighten-5' : ''"
      style="cursor: pointer"
      data-testid="dropzone"
      @click="input?.click()"
      @dragover.prevent="over = true"
      @dragleave="over = false"
      @drop.prevent="onDrop"
    >
      <v-icon icon="mdi-upload" class="mr-2" />
      <span>{{ busy ? t('knowledge.uploading') : t('knowledge.dropHere') }}</span>
      <input ref="input" type="file" hidden data-testid="file-input" @change="send(($event.target as HTMLInputElement).files)">
    </div>
    <v-checkbox v-model="noAi" :label="t('knowledge.uploadNoAi')" density="compact" hide-details data-testid="upload-no-ai" />
    <v-alert v-if="error" type="error" density="compact" class="mt-2" data-testid="upload-error">{{ error }}</v-alert>
    <v-alert v-if="done" type="success" density="compact" class="mt-2" data-testid="upload-done">{{ done }}</v-alert>
  </div>
</template>
