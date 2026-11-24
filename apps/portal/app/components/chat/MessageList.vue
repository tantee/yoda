<script setup lang="ts">
import type { ConversationKind, Message, Proposal } from '@yoda/shared'
import { groupMessages, systemMarkerKey } from '~/utils/chat'

const props = defineProps<{
  messages: Message[]
  conversationId: string
  kind: ConversationKind
  hasMore: boolean
  typing: boolean
  proposals: Record<string, Proposal>
  decidable: string[]
}>()
const emit = defineEmits<{ loadOlder: []; decided: [] }>()
const { t, locale } = useI18n()
const { me } = useMe()
const scroller = ref<HTMLElement | null>(null)

const groups = computed(() => groupMessages(props.messages))

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00+07:00`).toLocaleDateString(locale.value === 'th' ? 'th-TH' : 'en-GB', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
  })
}
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale.value === 'th' ? 'th-TH' : 'en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
  })
}
function author(m: Message): string {
  if (m.authorKind === 'ai') return t('chat.ai')
  if (m.authorKind === 'system') return t('chat.system')
  return m.authorName ?? ''
}
function text(m: Message): string {
  const key = systemMarkerKey(m)
  return key ? t(key) : m.text
}
const mine = (m: Message) => m.authorKind === 'person' && !!me.value && m.authorId === me.value.id

// Keep the view stable: stick to the bottom for new messages, hold position when older ones are prepended.
let lastCid = ''
let prevFirst: string | undefined
let prevLast: string | undefined
watch(
  () => [props.conversationId, props.messages[0]?.id, props.messages.at(-1)?.id, props.typing] as const,
  async ([cid, first, last]) => {
    const el = scroller.value // flush 'pre': the DOM still shows the old content here
    const oldHeight = el?.scrollHeight ?? 0
    const nearBottom = !el || oldHeight - el.scrollTop - el.clientHeight < 80
    const switched = cid !== lastCid
    const prepended = !switched && first !== prevFirst && last === prevLast
    const lastMine = props.messages.length > 0 && mine(props.messages[props.messages.length - 1]!)
    lastCid = cid
    prevFirst = first
    prevLast = last
    await nextTick()
    const after = scroller.value
    if (!after) return
    if (prepended) after.scrollTop += after.scrollHeight - oldHeight
    else if (switched || nearBottom || lastMine) after.scrollTop = after.scrollHeight
  },
  { flush: 'pre' },
)
function onScroll() {
  const el = scroller.value
  if (el && el.scrollTop < 40 && props.hasMore) emit('loadOlder')
}
</script>

<template>
  <div ref="scroller" class="message-scroll pa-3" data-testid="message-list" @scroll.passive="onScroll">
    <div v-if="hasMore" class="text-center mb-2">
      <v-btn size="small" variant="text" data-testid="load-older" @click="emit('loadOlder')">{{ t('chat.loadOlder') }}</v-btn>
    </div>
    <p v-if="!messages.length" class="text-medium-emphasis text-center" data-testid="chat-empty">{{ t('chat.empty') }}</p>
    <template v-for="g in groups" :key="g.day">
      <div class="text-center text-caption text-medium-emphasis my-2" data-testid="day-divider">{{ dayLabel(g.day) }}</div>
      <div
        v-for="m in g.items"
        :key="m.id"
        class="d-flex mb-2"
        :class="mine(m) ? 'justify-end' : 'justify-start'"
        :data-testid="`message-${m.authorKind}`"
      >
        <v-sheet
          :color="mine(m) ? 'primary' : m.authorKind === 'system' ? undefined : 'surface-variant'"
          :border="m.authorKind === 'system'"
          rounded="lg"
          class="bubble pa-2"
        >
          <div class="text-caption opacity-80">{{ author(m) }} · {{ timeLabel(m.createdAt) }}</div>
          <MarkdownView v-if="m.authorKind === 'ai'" :source="m.text" />
          <div v-else class="message-text" :class="{ 'font-italic': m.authorKind === 'system' }">{{ text(m) }}</div>
          <AttachmentList :attachments="m.attachments" :conversation-id="conversationId" class="mt-1" />
          <ChatActionCard
            v-for="(card, i) in m.actions"
            :key="i"
            :card="card"
            :proposal="card.type === 'proposal' ? proposals[card.proposalId] : undefined"
            :can-decide="card.type === 'proposal' && decidable.includes(card.proposalId)"
            @decided="emit('decided')"
          />
        </v-sheet>
      </div>
    </template>
    <div v-if="typing" class="text-caption text-medium-emphasis" data-testid="typing">{{ t('chat.typing') }}</div>
  </div>
</template>

<style scoped>
.message-scroll { overflow-y: auto; flex: 1 1 auto; min-height: 0; }
.bubble { max-width: min(640px, 85%); }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
