<script setup lang="ts">
import { nextTick, ref, useI18n } from '#imports'
import { TOKEN_GROUP_LENGTH, tokenGroups } from '~/utils/setup'

/**
 * The setup token as 5 boxes of 4 (proposal §8.2, mockup `installer-token.html`). The whole token can be pasted
 * into any box; case, dashes and spaces do not matter, and letters that are not in the token alphabet are dropped.
 */
const model = defineModel<string[]>({ required: true })
const emit = defineEmits<{ submit: [] }>()
const { t } = useI18n()
const boxes = ref<HTMLInputElement[]>([])

function focus(i: number) {
  void nextTick(() => boxes.value[Math.min(i, model.value.length - 1)]?.focus())
}

function onInput(i: number, e: Event) {
  const raw = (e.target as HTMLInputElement).value
  // Typing past a box, or a paste, flows on into the next boxes.
  const before = model.value.slice(0, i).join('')
  const after = model.value.slice(i + 1).join('')
  const next = tokenGroups(before + raw + (raw.length > TOKEN_GROUP_LENGTH ? '' : after))
  model.value = next
  const filled = next.findIndex((g) => g.length < TOKEN_GROUP_LENGTH)
  if (raw.length >= TOKEN_GROUP_LENGTH) focus(filled === -1 ? next.length - 1 : filled)
}

function onKey(i: number, e: KeyboardEvent) {
  if (e.key === 'Backspace' && !model.value[i] && i > 0) focus(i - 1)
  if (e.key === 'Enter') emit('submit')
}
</script>

<template>
  <div class="token-box" role="group" :aria-label="t('setup.token.groupsLabel')" data-testid="setup-token-box">
    <template v-for="(g, i) in model" :key="i">
      <input
        :ref="(el) => { if (el) boxes[i] = el as HTMLInputElement }"
        :value="g"
        class="token-box__seg"
        :aria-label="t('setup.token.segmentLabel', { n: i + 1 })"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        :data-testid="`setup-token-${i}`"
        @input="onInput(i, $event)"
        @keydown="onKey(i, $event)"
      >
      <span v-if="i < model.length - 1" class="token-box__dash" aria-hidden="true">–</span>
    </template>
  </div>
</template>

<style scoped>
.token-box { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; }
.token-box__seg {
  width: 0; flex: 1 1 0; min-width: 0; height: 48px; text-align: center; font-family: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.125rem; letter-spacing: .08em; text-transform: uppercase; border: 1px solid rgba(var(--v-border-color), .38); border-radius: 8px;
  background: rgb(var(--v-theme-surface)); color: rgb(var(--v-theme-on-surface));
}
.token-box__seg:focus { outline: none; border-color: rgb(var(--v-theme-primary)); box-shadow: 0 0 0 1px rgb(var(--v-theme-primary)); }
.token-box__dash { color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity)); }
@media (max-width: 420px) { .token-box__seg { font-size: .9375rem; letter-spacing: 0; height: 44px; } .token-box { gap: 3px; } }
</style>
