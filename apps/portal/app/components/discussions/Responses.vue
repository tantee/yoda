<script setup lang="ts">
import type { Discussion, DiscussionResponse } from '@yoda/shared'

const props = defineProps<{ discussion: Discussion; canRespond: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const api = useApi()

const responses = ref<DiscussionResponse[]>([])
const opinion = ref('')
const error = ref('')
const busy = ref(false)
const options = computed(() => props.discussion.brief?.options ?? [])
const optionTitle = (key: string | null) => options.value.find(o => o.key === key)?.title ?? key ?? ''
const fmt = (s: string) => new Date(s).toLocaleString(locale.value === 'en' ? 'en-GB' : 'th-TH')

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<DiscussionResponse[]>(`/discussions/${props.discussion.id}/responses`)
    if (mine === seq) responses.value = list
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}
defineExpose({ load })
onMounted(load)

async function send(body: Record<string, unknown>): Promise<boolean> {
  busy.value = true
  error.value = ''
  try {
    await api(`/discussions/${props.discussion.id}/responses`, { method: 'POST', body })
    seq++
    await load()
    emit('changed')
    return true
  } catch (e) {
    error.value = t(errorKey(e))
    return false
  } finally {
    busy.value = false
  }
}
async function sendOpinion() {
  if (!opinion.value.trim()) return
  if (await send({ kind: 'opinion', text: opinion.value.trim() })) opinion.value = ''
}
const vote = (key: string) => send({ kind: 'vote', optionKey: key })
</script>

<template>
  <section data-testid="responses">
    <h2 class="text-h6 mb-2">{{ t('discussions.thread.title') }}</h2>
    <div v-if="canRespond && options.length" class="d-flex flex-wrap ga-2 mb-3" data-testid="vote-buttons">
      <v-btn
        v-for="o in options"
        :key="o.key"
        size="small"
        :variant="discussion.myVote === o.key ? 'flat' : 'outlined'"
        :color="discussion.myVote === o.key ? 'primary' : undefined"
        :disabled="busy"
        data-testid="vote-btn"
        :data-mine="discussion.myVote === o.key"
        @click="vote(o.key)"
      >{{ o.title }} ({{ discussion.voteCounts[o.key] ?? 0 }})</v-btn>
    </div>
    <v-alert v-if="error" type="error" density="compact" class="mb-2" data-testid="responses-error">{{ error }}</v-alert>
    <p v-if="!responses.length" class="text-medium-emphasis">{{ t('discussions.thread.noResponses') }}</p>
    <v-card v-for="r in responses" :key="r.id" variant="outlined" class="mb-2" data-testid="response">
      <v-card-text class="py-2">
        <div class="text-caption text-medium-emphasis">
          {{ r.authorName }} · {{ fmt(r.createdAt) }}
          <template v-if="r.kind === 'vote'"> · {{ t('discussions.thread.voted', { option: optionTitle(r.optionKey) }) }}</template>
        </div>
        <div v-if="r.text" style="white-space: pre-wrap">{{ r.text }}</div>
      </v-card-text>
    </v-card>
    <template v-if="canRespond">
      <v-textarea v-model="opinion" :label="t('discussions.thread.opinion')" rows="2" auto-grow class="mt-2" data-testid="opinion-input" />
      <v-btn color="primary" :loading="busy" :disabled="!opinion.trim()" data-testid="opinion-send" @click="sendOpinion">{{ t('discussions.thread.send') }}</v-btn>
    </template>
  </section>
</template>
