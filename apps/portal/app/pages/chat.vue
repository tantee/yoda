<script setup lang="ts">
import type { Conversation, Message } from '@yoda/shared'
import { useDisplay } from 'vuetify'
import { applySent, isSecretaryTyping, mergeLatest, mergeMessages, threadIcon } from '~/utils/chat'

const PAGE = 50
const { t } = useI18n()
const api = useApi()
const route = useRoute()
const { byId: proposals, decidable, refresh: refreshProposals } = useProposals()
const { smAndDown } = useDisplay()
const { me } = useMe()
/** Below 960 px the thread list is a drawer over the conversation (master/detail). */
const threadsOpen = ref(false)
const loading = ref(true)

const conversations = ref<Conversation[]>([])
const selectedId = ref<string | null>(null)
const messages = ref<Message[]>([])
const hasMore = ref(false)
const loadError = ref('')
const loadingOlderFor = ref<string | null>(null)
const now = ref(Date.now())

const selected = computed(() => conversations.value.find(c => c.id === selectedId.value) ?? null)
const pageTitle = computed(() => (me.value?.isStaff ? t('nav.chat') : t('nav.assistant')))
const selectedTitle = computed(() => {
  const c = selected.value
  if (!c) return ''
  return c.kind === 'personal' || c.kind === 'intake' ? t('chat.personal') : c.title
})
const otherUnread = computed(() => conversations.value.filter(c => c.id !== selectedId.value).reduce((n, c) => n + c.unread, 0))
const suggestions = computed(() => (me.value?.isStaff ? ['chat.suggest.myWork', 'chat.suggest.status'] : ['chat.suggest.newRequest', 'chat.suggest.myRequests']))
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
  threadsOpen.value = false
  if (id === selectedId.value && messages.value.length) return
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
  } finally {
    loading.value = false
  }
  void refreshProposals()
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
</script>

<template>
  <div class="chat-page">
    <h1 class="text-h5 chat-title" :class="{ 'sr-only': smAndDown }" data-testid="page-title">{{ pageTitle }}</h1>
    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-2" closable data-testid="load-error" @click:close="loadError = ''">{{ loadError }}</v-alert>
    <v-card class="chat-card">
      <aside v-if="!smAndDown" class="thread-col">
        <ChatThreadList :conversations="conversations" :selected-id="selectedId" @select="selectConversation" />
      </aside>
      <section class="pane-col" :aria-label="selectedTitle || pageTitle">
        <header v-if="smAndDown" class="pane-head">
          <v-btn
            icon
            variant="text"
            density="comfortable"
            :aria-label="t('chat.threads')"
            :title="t('chat.threads')"
            data-testid="threads-open"
            @click="threadsOpen = true"
          >
            <v-badge v-if="otherUnread > 0" dot color="primary"><v-icon icon="mdi-forum-outline" /></v-badge>
            <v-icon v-else icon="mdi-forum-outline" />
          </v-btn>
          <v-icon v-if="selected" :icon="threadIcon(selected.kind)" size="18" aria-hidden="true" />
          <h2 class="pane-head__title text-subtitle-2">{{ selectedTitle }}</h2>
        </header>
        <template v-if="selected">
          <v-alert
            v-if="selected.kind === 'work_item'"
            type="warning"
            density="compact"
            variant="tonal"
            icon="mdi-eye-outline"
            class="ma-2 pane-banner"
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
          >
            <template v-if="selected.kind === 'personal' || selected.kind === 'intake'" #empty>
              <EmptyState :title="t('chat.emptyAssistant')" :text="t('chat.emptyAssistantHint')" icon="mdi-robot-outline" data-testid="chat-empty">
                <div class="d-flex flex-wrap justify-center ga-2">
                  <v-chip v-for="k in suggestions" :key="k" size="small" variant="outlined" prepend-icon="mdi-lightbulb-on-outline">{{ t(k) }}</v-chip>
                </div>
              </EmptyState>
            </template>
          </ChatMessageList>
          <ChatComposer :key="selected.id" :conversation-id="selected.id" @sent="onSent" />
        </template>
        <div v-else-if="loading" class="pa-4" data-testid="chat-loading"><SkeletonList :rows="4" /></div>
        <p v-else class="pa-4 text-medium-emphasis">{{ t('chat.select') }}</p>
      </section>
    </v-card>
    <v-navigation-drawer
      v-if="smAndDown"
      v-model="threadsOpen"
      temporary
      location="left"
      color="surface"
      width="320"
      data-testid="thread-drawer"
    >
      <ChatThreadList :conversations="conversations" :selected-id="selectedId" @select="selectConversation" />
    </v-navigation-drawer>
  </div>
</template>

<style scoped>
/* The page fills the space between the top bar and the bottom navigation, so the composer always stays in view. */
.chat-page {
  display: flex; flex-direction: column; gap: 8px;
  height: calc(100dvh - var(--v-layout-top, 56px) - var(--v-layout-bottom, 0px) - 48px); min-height: 360px;
}
@media (max-width: 1023px) {
  .chat-page { height: calc(100dvh - var(--v-layout-top, 56px) - var(--v-layout-bottom, 0px) - 40px); }
}
.chat-title { margin: 0; }
.chat-card { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.thread-col { flex: 0 0 300px; overflow-y: auto; border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.pane-col { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.pane-banner { flex: none; }
.pane-head { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 4px 12px 4px 4px; border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); }
.pane-head__title { margin: 0; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
