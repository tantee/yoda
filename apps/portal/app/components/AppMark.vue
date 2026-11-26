<script setup lang="ts">
import { computed, useId } from 'vue'
import { useFunMode } from '~/composables/useFunMode'

/**
 * The product mark (docs/design/jedi-touch.md): an original blue tile with a geometric "Y". In fun mode the stem
 * becomes a soft light blade and a small four-point star sits beside it (it twinkles once on hover, never with
 * reduced motion). Off: the static mark, also used for the favicon. Drawn on a 32 px grid so it holds at 24–32 px.
 * `fun` overrides the admin setting (for previews).
 */
const props = withDefaults(defineProps<{ size?: number; fun?: boolean }>(), { size: 30, fun: undefined })
const { enabled } = useFunMode()
const isFun = computed(() => props.fun ?? enabled.value)
const blade = `app-mark-blade-${useId()}`
</script>

<template>
  <svg
    class="app-mark"
    :class="{ 'app-mark--fun': isFun }"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    aria-hidden="true"
    focusable="false"
    data-testid="app-mark"
    :data-fun="isFun ? 'on' : 'off'"
  >
    <rect width="32" height="32" rx="7.5" fill="#1F5FBF" />
    <template v-if="isFun">
      <defs>
        <linearGradient :id="blade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#FFFFFF" />
          <stop offset="1" stop-color="#6FA8FF" />
        </linearGradient>
      </defs>
      <path d="M9.5 7.5 L16 15.5 L22.5 7.5" fill="none" stroke="#FFFFFF" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M16 15.5 V25.5" stroke="#6FA8FF" stroke-opacity=".45" stroke-width="6" stroke-linecap="round" />
      <path d="M16 15.5 V25.5" :stroke="`url(#${blade})`" stroke-width="3" stroke-linecap="round" />
      <path class="app-mark__star" d="M24.5 18.5 Q25 21.5 28 22 Q25 22.5 24.5 25.5 Q24 22.5 21 22 Q24 21.5 24.5 18.5 Z" fill="#FFFFFF" />
    </template>
    <path v-else d="M9.5 7.5 L16 15.5 L22.5 7.5 M16 15.5 V25.5" fill="none" stroke="#FFFFFF" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.app-mark { display: block; flex: none; }
.app-mark__star { transform-box: fill-box; transform-origin: center; }
@media (prefers-reduced-motion: no-preference) {
  .app-mark--fun:hover .app-mark__star { animation: app-mark-twinkle .9s ease-out 1; }
}
@keyframes app-mark-twinkle {
  0%, 100% { transform: scale(1); opacity: 1; }
  45% { transform: scale(1.35) rotate(45deg); opacity: .75; }
}
</style>
