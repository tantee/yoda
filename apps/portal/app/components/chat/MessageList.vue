<script setup lang="ts">
import type { ConversationKind, Message, Proposal } from '@yoda/shared'
import { groupMessages, isNearBottom, scrollPlan, systemMarkerKey } from '~/utils/chat'
import { relativeDay } from '~/utils/timeline'

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
const { t } = useI18n()
const { me } = useMe()
const scroller = ref<HTMLElement | null>(null)

const groups = computed(() => groupMessages(props.messages))

const { date, dateTime, time } = useDateFormat()
function dayLabel(day: string): string {
  const rel = relativeDay(day)
  return rel ? t(`timeline.${rel}`, { date: date(day) }) : date(day)
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

// Keep the view stable: stick to the bottom for new messages when the reader is there (or sent them), hold the
// position when older ones are prepended, and offer a "new messages" pill when someone posts while scrolled up.
const pill = ref(false)
/** The reader is at the bottom: content that grows later (markdown, attachments, proposal cards) keeps them there. */
let stuck = true
let lastCid = ''
let prevFirst: string | undefined
let prevLast: string | undefined
watch(
  () => [props.conversationId, props.messages[0]?.id, props.messages.at(-1)?.id, props.typing] as const,
  async ([cid, first, last]) => {
    const el = scroller.value // flush 'pre': the DOM still shows the old content here
    const oldHeight = el?.scrollHeight ?? 0
    const switched = cid !== lastCid
    const plan = scrollPlan({
      switched,
      prepended: !switched && first !== prevFirst && last === prevLast,
      appended: !switched && last !== prevLast && last !== undefined,
      nearBottom: !el || isNearBottom(el),
      lastMine: props.messages.length > 0 && mine(props.messages[props.messages.length - 1]!),
    })
    lastCid = cid
    prevFirst = first
    prevLast = last
    if (switched) pill.value = false
    await nextTick()
    const after = scroller.value
    if (!after) return
    if (plan === 'hold') after.scrollTop += after.scrollHeight - oldHeight
    else if (plan === 'bottom') toBottom()
    else if (plan === 'pill') {
      pill.value = true
      stuck = false
    }
  },
  { flush: 'pre' },
)
function toBottom(smooth = false) {
  const el = scroller.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  pill.value = false
  stuck = true
}
const content = ref<HTMLElement | null>(null)
let observer: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !content.value) return
  observer = new ResizeObserver(() => {
    const el = scroller.value
    if (el && stuck) el.scrollTop = el.scrollHeight
  })
  observer.observe(content.value)
})
onBeforeUnmount(() => observer?.disconnect())
function onScroll() {
  const el = scroller.value
  if (!el) return
  stuck = isNearBottom(el)
  if (pill.value && stuck) pill.value = false
  if (el.scrollTop < 40 && props.hasMore) emit('loadOlder')
}
</script>

<template>
  <div class="message-pane">
    <div ref="scroller" class="message-scroll" data-testid="message-list" @scroll.passive="onScroll">
      <div ref="content">
        <div v-if="hasMore" class="text-center mb-2">
          <v-btn size="small" variant="text" color="primary" data-testid="load-older" @click="emit('loadOlder')">{{ t('chat.loadOlder') }}</v-btn>
        </div>
        <slot v-if="!messages.length" name="empty">
          <p class="text-medium-emphasis text-center" data-testid="chat-empty">{{ t('chat.empty') }}</p>
        </slot>
        <template v-for="g in groups" :key="g.day">
          <div class="day-divider" data-testid="day-divider"><span>{{ dayLabel(g.day) }}</span></div>
          <div
            v-for="m in g.items"
            :key="m.id"
            class="message"
            :class="[`message--${m.authorKind}`, { 'message--mine': mine(m) }]"
            :data-testid="`message-${m.authorKind}`"
          >
            <div class="bubble">
              <div class="bubble__meta">
                <span v-if="m.authorKind === 'ai'" class="bubble__ai"><v-icon icon="mdi-robot-outline" size="14" aria-hidden="true" />{{ author(m) }}</span>
                <span v-else-if="!mine(m)" class="bubble__author">{{ author(m) }}</span>
                <time :datetime="m.createdAt" :title="dateTime(m.createdAt)" class="tabular-nums">{{ time(m.createdAt) }}</time>
              </div>
              <MarkdownView v-if="m.authorKind === 'ai'" :source="m.text" />
              <div v-else class="message-text">{{ text(m) }}</div>
              <AttachmentList :attachments="m.attachments" :conversation-id="conversationId" class="mt-1" />
              <ChatActionCard
                v-for="(card, i) in m.actions"
                :key="i"
                :card="card"
                :proposal="card.type === 'proposal' ? proposals[card.proposalId] : undefined"
                :can-decide="card.type === 'proposal' && decidable.includes(card.proposalId)"
                :conversation-kind="kind"
                @decided="emit('decided')"
              />
            </div>
          </div>
        </template>
        <div v-if="typing" class="typing text-body-2 text-medium-emphasis" data-testid="typing">
          <v-progress-circular indeterminate size="14" width="2" color="ai" aria-hidden="true" />{{ t('chat.typing') }}
        </div>
      </div>
    </div>
    <v-btn
      v-if="pill"
      class="new-pill"
      color="primary"
      variant="flat"
      size="small"
      rounded="pill"
      append-icon="mdi-arrow-down"
      data-testid="new-messages-pill"
      @click="toBottom(true)"
    >{{ t('chat.newMessages') }}</v-btn>
  </div>
</template>

<style scoped>
.message-pane { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.message-scroll { overflow-y: auto; flex: 1 1 auto; min-height: 0; padding: 12px 16px; background: rgb(var(--v-theme-background)); }
.day-divider { display: flex; justify-content: center; margin: 12px 0 8px; }
.day-divider span {
  font-size: .75rem; font-weight: 500; padding: 2px 10px; border-radius: 10px;
  background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.message { display: flex; margin-bottom: 8px; justify-content: flex-start; }
.message--mine { justify-content: flex-end; }
.message--system { justify-content: center; }
.bubble {
  max-width: min(680px, 88%); min-width: 0; padding: 8px 12px; border-radius: 12px;
  background: rgb(var(--v-theme-surface)); border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.message--mine .bubble { background: rgb(var(--v-theme-primary-soft)); color: rgb(var(--v-theme-on-primary-soft)); border-color: transparent; border-bottom-right-radius: 4px; }
.message--ai .bubble { border-bottom-left-radius: 4px; }
.message--person:not(.message--mine) .bubble { background: rgb(var(--v-theme-surface-light)); border-color: transparent; border-bottom-left-radius: 4px; }
.message--system .bubble { background: transparent; border-style: dashed; font-style: italic; font-size: .875rem; text-align: center; }
.bubble__meta { display: flex; align-items: center; gap: 8px; font-size: .75rem; margin-bottom: 2px; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.message--mine .bubble__meta { justify-content: flex-end; color: rgb(var(--v-theme-on-primary-soft)); }
.bubble__ai { display: inline-flex; align-items: center; gap: 4px; color: rgb(var(--v-theme-ai)); font-weight: 600; }
.bubble__author { font-weight: 600; color: rgb(var(--v-theme-on-surface)); }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.typing { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.new-pill { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 2; }
</style>
