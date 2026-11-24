<script setup lang="ts">
import type { Attachment, Message } from '@yoda/shared'

const props = defineProps<{ conversationId: string }>()
const emit = defineEmits<{ sent: [message: Message] }>()
const { t } = useI18n()
const api = useApi()
const { uploadToConversation } = useUpload()

const text = ref('')
const pending = ref<Attachment[]>([])
const busy = ref(false)
const uploading = ref(0)
const error = ref('')
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

// A draft belongs to its conversation.
watch(() => props.conversationId, () => {
  text.value = ''
  pending.value = []
  error.value = ''
})

async function addFiles(files: File[]) {
  error.value = ''
  for (const f of files) {
    uploading.value++
    try {
      pending.value.push(await uploadToConversation(props.conversationId, f))
    } catch (e) {
      error.value = t((e as { key?: string }).key ?? 'errors.generic')
    } finally {
      uploading.value--
    }
  }
}

function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) {
    e.preventDefault()
    void addFiles(files)
  }
}
function onDrop(e: DragEvent) {
  dragging.value = false
  void addFiles([...(e.dataTransfer?.files ?? [])])
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  void addFiles([...(input.files ?? [])])
  input.value = ''
}

const canSend = computed(() => !busy.value && !uploading.value && text.value.trim().length > 0)

async function send() {
  if (!canSend.value) return
  busy.value = true
  error.value = ''
  try {
    const message = await api<Message>(`/conversations/${props.conversationId}/messages`, {
      method: 'POST',
      body: { text: text.value.trim(), attachmentIds: pending.value.map(a => a.id) },
    })
    text.value = ''
    pending.value = []
    emit('sent', message)
  } catch (e) {
    error.value = errorKey(e) === 'errors.generic' ? t('chat.sendFailed') : t(errorKey(e))
  } finally {
    busy.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
}
</script>

<template>
  <div
    class="composer pa-2"
    :class="{ dragging }"
    data-testid="composer"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <v-alert v-if="error" type="error" density="compact" class="mb-2" data-testid="composer-error">{{ error }}</v-alert>
    <div v-if="pending.length || uploading" class="d-flex flex-wrap ga-2 mb-2">
      <v-chip
        v-for="a in pending"
        :key="a.id"
        size="small"
        closable
        prepend-icon="mdi-paperclip"
        data-testid="pending-attachment"
        @click:close="pending = pending.filter(p => p.id !== a.id)"
      >{{ a.fileName }}</v-chip>
      <v-progress-circular v-if="uploading" indeterminate size="20" />
    </div>
    <div class="d-flex align-end ga-2">
      <input ref="fileInput" type="file" hidden multiple data-testid="file-input" @change="onPick">
      <v-btn icon="mdi-paperclip" variant="text" :title="t('chat.attach')" @click="fileInput?.click()" />
      <v-textarea
        v-model="text"
        :placeholder="t('chat.placeholder')"
        rows="1"
        max-rows="6"
        auto-grow
        hide-details
        density="compact"
        variant="outlined"
        data-testid="composer-text"
        @keydown="onKeydown"
        @paste="onPaste"
      />
      <v-btn icon="mdi-send" color="primary" :disabled="!canSend" :loading="busy" :title="t('chat.send')" data-testid="composer-send" @click="send" />
    </div>
  </div>
</template>

<style scoped>
.composer.dragging { outline: 2px dashed rgb(var(--v-theme-primary)); outline-offset: -4px; }
</style>
