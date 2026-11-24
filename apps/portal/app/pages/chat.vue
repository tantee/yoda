<script setup lang="ts">
import type { Conversation, Message } from '@yoda/shared'
import { applySent, isSecretaryTyping, mergeLatest, mergeMessages } from '~/utils/chat'

const PAGE = 50
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const { byId: proposals, decidable, refresh: refreshProposals } = useProposals()

const conversations = ref<Conversation[]>([])
const selectedId = ref<string | null>(null)
const messages = ref<Message[]>([])
const hasMore = ref(false)
const loadError = ref('')
const loadingOlderFor = ref<string | null>(null)
const now = ref(Date.now())

const selected = computed(() => conversations.value.find(c => c.id === selectedId.value) ?? null)
const typing = computed(() => (selected.value ? isSecretaryTyping(selected.value.kind, messages.value, now.value) : false))

// Personal/intake first, then the rest by latest activity.
function ordered(list: Conversation[]): Conversation[] {
  const personal = (c: Conversation) => c.kind === 'personal' || c.kind === 'intake'
  return [...list].sort((a, b) =>
    Number(personal(b)) - Number(personal(a)) || (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''))
}

let convSeq = 0
async function loadConversations() {
  const mine = ++convSeq
  try {
    const list = await api<Conversation[]>('/conversations')
    if (mine === convSeq) conversations.value = ordered(list)
  } catch (e) {
    if (mine === convSeq) loadError.value = t(errorKey(e))
  }
}

let msgSeq = 0
let latestSeq = 0
async function selectConversation(id: string) {
  selectedId.value = id
  messages.value = []
  hasMore.value = false
  const mine = ++msgSeq
  try {
    const page = await api<Message[]>(`/conversations/${id}/messages`, { query: { limit: PAGE } })
    if (mine !== msgSeq) return
    messages.value = page
    hasMore.value = page.length === PAGE
    loadError.value = ''
    void markRead()
  } catch (e) {
    if (mine === msgSeq) loadError.value = t(errorKey(e))
  }
}

async function loadLatest() {
  const id = selectedId.value
  if (!id) return
  const mine = ++latestSeq
  try {
    const page = await api<Message[]>(`/conversations/${id}/messages`, { query: { limit: PAGE } })
    if (mine !== latestSeq || id !== selectedId.value) return
    const merged = mergeLatest(messages.value, hasMore.value, page, PAGE)
    messages.value = merged.messages
    hasMore.value = merged.hasMore
    void markRead()
  } catch {
    // live refresh failures are silent; the next event retries
  }
}

async function loadOlder() {
  const id = selectedId.value
  const first = messages.value[0]
  if (!id || !first || loadingOlderFor.value === id || !hasMore.value) return
  loadingOlderFor.value = id
  try {
    const page = await api<Message[]>(`/conversations/${id}/messages`, { query: { before: first.seq, limit: PAGE } })
    if (id !== selectedId.value) return
    messages.value = mergeMessages(messages.value, page)
    hasMore.value = page.length === PAGE
  } catch (e) {
    loadError.value = t(errorKey(e))
  } finally {
    if (loadingOlderFor.value === id) loadingOlderFor.value = null
  }
}

let readSeq = 0
let readFor = ''
async function markRead() {
  const id = selectedId.value
  const last = messages.value[messages.value.length - 1]
  if (!id || !last) return
  if (readFor !== id) {
    readFor = id
    readSeq = 0
  }
  if (last.seq <= readSeq) return
  readSeq = last.seq
  try {
    await api(`/conversations/${id}/read`, { method: 'POST', body: { seq: last.seq } })
    void loadConversations()
  } catch {
    readSeq = 0
  }
}

function onSent(m: Message) {
  messages.value = applySent(selectedId.value, messages.value, m)
  now.value = Date.now()
  void loadConversations()
}

function debounced(fn: () => void, ms = 200) {
  let timer: ReturnType<typeof setTimeout> | null = null
  onBeforeUnmount(() => timer && clearTimeout(timer))
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}
const latestSoon = debounced(loadLatest)
const conversationsSoon = debounced(loadConversations)
const proposalsSoon = debounced(refreshProposals)

useLiveEvents((e) => {
  if (e.type === 'message.created') {
    if (e.conversationId && e.conversationId === selectedId.value) latestSoon()
    conversationsSoon()
  } else if (e.type.startsWith('proposal.')) {
    proposalsSoon()
  }
}, () => {
  latestSoon()
  conversationsSoon()
  proposalsSoon()
})

let ticker: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  ticker = setInterval(() => (now.value = Date.now()), 5000)
  try {
    const personal = await api<Conversation>('/conversations/personal')
    await loadConversations()
    const wanted = typeof route.query.c === 'string' ? route.query.c : null
    await selectConversation(conversations.value.some(c => c.id === wanted) ? wanted! : personal.id)
  } catch (e) {
    loadError.value = t(errorKey(e))
  }
  void refreshProposals()
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
</script>

<template>
  <div class="chat-page">
    <h1 class="text-h5 mb-2">{{ t('nav.chat') }}</h1>
    <v-alert v-if="loadError" type="error" class="mb-2" data-testid="load-error">{{ loadError }}</v-alert>
    <v-card border class="chat-card">
      <v-row no-gutters class="fill-height">
        <v-col cols="12" md="3" class="thread-col">
          <ChatThreadList :conversations="conversations" :selected-id="selectedId" @select="selectConversation" />
        </v-col>
        <v-col cols="12" md="9" class="d-flex flex-column pane-col">
          <template v-if="selected">
            <v-alert
              v-if="selected.kind === 'work_item'"
              type="warning"
              density="compact"
              variant="tonal"
              class="ma-2"
              data-testid="requester-visible-banner"
            >{{ t('chat.visibleToRequester') }}</v-alert>
            <ChatMessageList
              :messages="messages"
              :conversation-id="selected.id"
              :kind="selected.kind"
              :has-more="hasMore"
              :typing="typing"
              :proposals="proposals"
              :decidable="decidable"
              @load-older="loadOlder"
              @decided="refreshProposals"
            />
            <v-divider />
            <ChatComposer :key="selected.id" :conversation-id="selected.id" @sent="onSent" />
          </template>
          <p v-else class="pa-4 text-medium-emphasis">{{ t('chat.select') }}</p>
        </v-col>
      </v-row>
    </v-card>
  </div>
</template>

<style scoped>
.chat-card { height: calc(100vh - 150px); min-height: 420px; overflow: hidden; }
.thread-col { overflow-y: auto; max-height: 100%; border-right: 1px solid rgba(128, 128, 128, 0.3); }
.pane-col { min-height: 0; max-height: 100%; }
</style>
