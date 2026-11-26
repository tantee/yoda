<script setup lang="ts">
import type { Discussion, DiscussionResponse } from '@yoda/shared'
import { initials } from '~/utils/nav'

/**
 * The discussion thread (proposal §8.2): opinions as a comment list (initials, name, time, text) and one
 * "ลงความเห็น" composer. Votes are summarised on the option cards; `vote(key)` is exposed for them and
 * `loaded` hands the page every response (to show who voted for what).
 */
const props = defineProps<{ discussion: Discussion; canRespond: boolean }>()
const emit = defineEmits<{ changed: []; loaded: [list: DiscussionResponse[]] }>()
const { t } = useI18n()
const api = useApi()

const responses = ref<DiscussionResponse[]>([])
const opinion = ref('')
const error = ref('')
const busy = ref(false)
const tried = ref(false)
const opinions = computed(() => responses.value.filter(r => r.kind === 'opinion' || r.text))
const options = computed(() => props.discussion.brief?.options ?? [])
const optionTitle = (key: string | null) => options.value.find(o => o.key === key)?.title ?? key ?? ''
const { dateTime, relative } = useDateFormat()

let seq = 0
async function load() {
  const mine = ++seq
  try {
    const list = await api<DiscussionResponse[]>(`/discussions/${props.discussion.id}/responses`)
    if (mine !== seq) return
    responses.value = list
    emit('loaded', list)
  } catch (e) {
    if (mine === seq) error.value = t(errorKey(e))
  }
}
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
  tried.value = true
  if (!opinion.value.trim()) return
  if (await send({ kind: 'opinion', text: opinion.value.trim() })) {
    opinion.value = ''
    tried.value = false
  }
}
const vote = (key: string) => send({ kind: 'vote', optionKey: key })
defineExpose({ load, vote, busy })
</script>

<template>
  <section data-testid="responses">
    <h2 class="resp-title">{{ t('discussions.thread.title') }}<span class="count-pill ml-2">{{ opinions.length }}</span></h2>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-2" data-testid="responses-error">{{ error }}</v-alert>
    <v-card>
      <p v-if="!opinions.length" class="text-body-2 text-medium-emphasis pa-4 mb-0">{{ t('discussions.thread.noResponses') }}</p>
      <ul v-else class="resp-list">
        <li v-for="r in opinions" :key="r.id" class="resp" data-testid="response">
          <v-avatar size="32" color="primary-soft" class="resp__avatar" aria-hidden="true">{{ initials(r.authorName) }}</v-avatar>
          <div class="resp__body">
            <div class="resp__meta">
              <span class="font-weight-medium">{{ r.authorName }}</span>
              <span class="text-caption text-medium-emphasis" :title="dateTime(r.createdAt)">{{ relative(r.createdAt) }}</span>
              <span v-if="r.kind === 'vote'" class="text-caption text-medium-emphasis">· {{ t('discussions.thread.voted', { option: optionTitle(r.optionKey) }) }}</span>
            </div>
            <div class="resp__text">{{ r.text }}</div>
          </div>
        </li>
      </ul>
      <div v-if="canRespond" class="resp-composer">
        <v-textarea
          v-model="opinion"
          :label="t('discussions.thread.opinion')"
          rows="2"
          auto-grow
          :error-messages="tried && !opinion.trim() ? [t('discussions.thread.opinionRequired')] : []"
          data-testid="opinion-input"
        />
        <div class="d-flex mt-2">
          <v-spacer />
          <v-btn color="primary" :loading="busy" prepend-icon="mdi-send-outline" data-testid="opinion-send" @click="sendOpinion">{{ t('discussions.thread.send') }}</v-btn>
        </div>
      </div>
    </v-card>
  </section>
</template>

<style scoped>
.resp-title { display: flex; align-items: center; margin: 0 0 8px; font-size: 1rem; font-weight: 600; }
.resp-list { list-style: none; margin: 0; padding: 0; }
.resp { display: flex; gap: 12px; padding: 12px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.resp:first-child { border-top: 0; }
.resp__avatar { flex: none; font-size: .75rem; font-weight: 600; color: rgb(var(--v-theme-on-primary-soft)); }
.resp__body { min-width: 0; flex: 1 1 auto; }
.resp__meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.resp__text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .9375rem; line-height: 1.7; }
.resp-composer { padding: 12px 16px 16px; border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
</style>
