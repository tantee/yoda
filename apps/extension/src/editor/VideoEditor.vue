<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Draft } from '../drafts/db'
import { CLIP_BITS_PER_SECOND, pickMimeType } from '../offscreen/recorder'
import { activeRegions, applyVideoMosaic, regionsForStill, scaleRect, type VideoRegion } from '../video/regions'
import { stillFrame } from '../video/still-frame'
import { defaultBlock, type Op } from './doc'

/**
 * Mosaic on video (decision 1): drag on the frame to draw a region, set its time range with the handles, then
 * Apply burns the regions into the clip by re-encoding it here, with the preview visible. Until then the video
 * cannot be sent. When neither path works, the only choices are "send without video" or "use a still frame".
 */
const props = defineProps<{ draft: Draft }>()
const emit = defineEmits<{ still: [{ bitmap: ImageBitmap; ops: Op[] }] }>()
const { t } = useI18n()

const player = ref<HTMLVideoElement | null>(null)
const preview = ref<HTMLCanvasElement | null>(null)
const overlay = ref<HTMLElement | null>(null)
const url = computed(() => (props.draft.video ? URL.createObjectURL(props.draft.video) : null))
watch(url, (_n, old) => old && URL.revokeObjectURL(old))

const size = ref({ w: 0, h: 0 })
const durationMs = ref(0)
const nowMs = ref(0)
const playing = ref(false)
const regions = computed(() => props.draft.videoRegions ?? [])
const active = computed(() => new Set(activeRegions(regions.value, nowMs.value).map((r) => r.id)))
const drag = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)

const applying = ref(false)
const progress = ref(0)
const hidden = ref(false)
const failed = ref(false)
let abort: AbortController | null = null

const seconds = (ms: number) => (ms / 1000).toFixed(1)

async function onMeta() {
  const v = player.value!
  size.value = { w: v.videoWidth, h: v.videoHeight }
  // A clip without a written duration: seek to the end once to learn it.
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e9
    await new Promise((r) => v.addEventListener('durationchange', r, { once: true }))
    v.currentTime = 0
  }
  durationMs.value = Math.round(v.duration * 1000)
}

function seek(ms: number) {
  if (player.value) player.value.currentTime = ms / 1000
  nowMs.value = ms
}

function toggle() {
  const v = player.value
  if (!v) return
  if (v.paused) void v.play()
  else v.pause()
}

function at(ev: PointerEvent): { x: number; y: number } {
  const r = overlay.value!.getBoundingClientRect()
  const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width)
  const y = Math.min(Math.max(ev.clientY - r.top, 0), r.height)
  return { x: Math.round((x / r.width) * size.value.w), y: Math.round((y / r.height) * size.value.h) }
}

function down(ev: PointerEvent) {
  if (applying.value || !size.value.w) return
  player.value?.pause()
  overlay.value!.setPointerCapture(ev.pointerId)
  const p = at(ev)
  drag.value = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
}

function move(ev: PointerEvent) {
  if (!drag.value) return
  const p = at(ev)
  drag.value = { ...drag.value, x1: p.x, y1: p.y }
}

const dragRect = computed(() => {
  const d = drag.value
  return d && { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
})

function up() {
  const rect = dragRect.value
  drag.value = null
  // Ignore accidental clicks: a region needs some size.
  if (!rect || rect.w <= 3 || rect.h <= 3) return
  const end = durationMs.value || nowMs.value + 2000
  let fromMs = Math.round(nowMs.value)
  const toMs = Math.min(end, fromMs + 2000)
  if (toMs - fromMs < 100) fromMs = Math.max(0, toMs - 2000)
  const r: VideoRegion = { id: crypto.randomUUID(), rect, fromMs, toMs, block: defaultBlock(size.value.w, size.value.h) }
  props.draft.videoRegions = [...regions.value, r]
}

function setRange(i: number, range: number[]) {
  const [fromMs, toMs] = range as [number, number]
  props.draft.videoRegions = regions.value.map((r, k) => (k === i ? { ...r, fromMs, toMs: Math.max(toMs, fromMs + 100) } : r))
}

function remove(i: number) {
  props.draft.videoRegions = regions.value.filter((_, k) => k !== i)
}

/** A rect in video pixels, as percentages of the frame, for the overlay. */
const box = (r: { x: number; y: number; w: number; h: number }) => ({
  left: `${(r.x / size.value.w) * 100}%`,
  top: `${(r.y / size.value.h) * 100}%`,
  width: `${(r.w / size.value.w) * 100}%`,
  height: `${(r.h / size.value.h) * 100}%`,
})

async function apply() {
  const src = props.draft.video
  if (!src || !regions.value.length || !preview.value) return
  player.value?.pause()
  applying.value = true
  progress.value = 0
  failed.value = false
  abort = new AbortController()
  const applied = JSON.parse(JSON.stringify(regions.value)) as VideoRegion[]
  try {
    const r = await applyVideoMosaic(src, applied, {
      mimeType: pickMimeType((type) => MediaRecorder.isTypeSupported(type)),
      bitsPerSecond: CLIP_BITS_PER_SECOND,
      onProgress: (p) => (progress.value = p),
      signal: abort.signal,
      preview: preview.value,
    })
    if (r.ok) {
      props.draft.video = r.blob
      // Only the regions burned in now; any added meanwhile still need an apply.
      const done = new Set(applied.map((x) => x.id))
      props.draft.videoRegions = regions.value.filter((x) => !done.has(x.id))
      props.draft.videoMosaicApplied = true
      // A new video is a new report body: never let an earlier upload of the original answer for it.
      props.draft.idempotencyKey = crypto.randomUUID()
    } else if (!r.cancelled) failed.value = true
  } finally {
    applying.value = false
    abort = null
  }
}

function cancel() {
  abort?.abort()
}

function sendWithout() {
  props.draft.video = undefined
  props.draft.videoRegions = []
  failed.value = false
}

const stilling = ref(false)

async function useStill() {
  const src = props.draft.video
  if (!src || stilling.value) return
  stilling.value = true
  try {
    const t = nowMs.value
    const { bitmap, seekMs } = await stillFrame(src, t)
    // The frame may differ in size from the video the regions were drawn on (a tab resized mid-clip).
    const frame = { w: bitmap.width, h: bitmap.height }
    const ops: Op[] = regionsForStill(regions.value, seekMs, t).map((r) => ({ kind: 'mosaic', mode: 'rect', rect: scaleRect(r.rect, size.value, frame), block: r.block }))
    failed.value = false
    emit('still', { bitmap, ops })
  } finally {
    stilling.value = false
  }
}

const onVisibility = () => (hidden.value = document.visibilityState === 'hidden')
onMounted(() => document.addEventListener('visibilitychange', onVisibility))
onBeforeUnmount(() => {
  abort?.abort()
  document.removeEventListener('visibilitychange', onVisibility)
  if (url.value) URL.revokeObjectURL(url.value)
})
</script>

<template>
  <div class="vid" data-testid="video-editor">
    <div class="vid__frame">
      <video
        v-show="!applying"
        ref="player"
        :src="url ?? undefined"
        class="vid__player"
        muted
        playsinline
        data-testid="editor-video"
        @loadedmetadata="onMeta"
        @timeupdate="nowMs = (player?.currentTime ?? 0) * 1000"
        @seeked="nowMs = (player?.currentTime ?? 0) * 1000"
        @play="playing = true"
        @pause="playing = false"
      />
      <canvas v-show="applying" ref="preview" class="vid__player" data-testid="video-preview" />
      <div
        v-if="!applying && size.w"
        ref="overlay"
        class="vid__overlay"
        data-testid="video-overlay"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
      >
        <div
          v-for="(r, i) in regions"
          :key="r.id"
          class="vid__region"
          :class="{ 'vid__region--on': active.has(r.id) }"
          :style="box(r.rect)"
          :data-rect="`${r.rect.x},${r.rect.y},${r.rect.w},${r.rect.h},${r.block}`"
          :data-testid="`video-region-box-${i}`"
        >
          <span class="vid__label">{{ i + 1 }}</span>
        </div>
        <div v-if="dragRect" class="vid__region vid__region--drag" :style="box(dragRect)" />
      </div>
    </div>

    <div v-if="!applying" class="vid__controls">
      <v-btn :icon="playing ? 'mdi-pause' : 'mdi-play'" size="small" variant="text" :title="playing ? t('video.pause') : t('video.play')" data-testid="video-play" @click="toggle" />
      <v-slider
        :model-value="nowMs"
        :max="durationMs || 1"
        :step="100"
        hide-details
        density="compact"
        color="primary"
        class="vid__scrubber"
        data-testid="video-scrubber"
        @update:model-value="seek"
      />
      <span class="text-caption text-medium-emphasis vid__time" data-testid="video-time">{{ seconds(nowMs) }} / {{ seconds(durationMs) }} s</span>
    </div>

    <div class="vid__panel">
      <h3 class="text-subtitle-2">{{ t('video.title') }}</h3>
      <p class="text-caption text-medium-emphasis mb-2">{{ t('video.hint') }}</p>
      <v-alert v-if="draft.videoMosaicApplied && !regions.length" type="success" variant="tonal" density="compact" class="mb-2" data-testid="video-applied">{{ t('video.applied') }}</v-alert>
      <p v-if="!regions.length" class="text-caption text-medium-emphasis" data-testid="video-no-regions">{{ t('video.noRegions') }}</p>
      <div v-for="(r, i) in regions" :key="r.id" class="vid__row" :data-testid="`video-region-${i}`">
        <span class="text-body-2 vid__name">{{ t('video.region', { n: i + 1 }) }}</span>
        <v-range-slider
          :model-value="[r.fromMs, r.toMs]"
          :max="durationMs || r.toMs"
          :step="100"
          :disabled="applying"
          hide-details
          density="compact"
          color="primary"
          strict
          :data-testid="`video-region-range-${i}`"
          @update:model-value="(v: number[]) => setRange(i, v)"
        />
        <span class="text-caption text-medium-emphasis vid__range">{{ t('video.regionRange', { from: seconds(r.fromMs), to: seconds(r.toMs) }) }}</span>
        <v-btn icon="mdi-delete-outline" size="small" variant="text" :disabled="applying" :title="t('common.remove')" :data-testid="`video-region-delete-${i}`" @click="remove(i)" />
      </div>
      <template v-if="applying">
        <v-alert :type="hidden ? 'warning' : 'info'" variant="tonal" density="compact" class="mt-2" data-testid="video-keep-visible">
          {{ hidden ? t('video.paused') : t('video.keepVisible') }}
        </v-alert>
        <v-progress-linear :model-value="progress * 100" color="primary" height="6" rounded class="mt-2" data-testid="video-progress" />
        <div class="d-flex align-center mt-1">
          <span class="text-caption">{{ t('video.applying', { p: Math.round(progress * 100) }) }}</span>
          <v-spacer />
          <v-btn size="small" variant="text" data-testid="video-cancel" @click="cancel">{{ t('common.cancel') }}</v-btn>
        </div>
      </template>
      <template v-else-if="regions.length">
        <v-alert type="warning" variant="tonal" density="compact" class="mt-2" data-testid="video-pending">{{ t('video.pending') }}</v-alert>
        <v-btn color="primary" class="mt-2" prepend-icon="mdi-checkerboard" data-testid="video-apply" @click="apply">{{ t('video.apply') }}</v-btn>
      </template>
    </div>

    <v-dialog :model-value="failed" max-width="480" persistent>
      <v-card data-testid="video-failed">
        <v-card-title class="text-subtitle-1">{{ t('video.failedTitle') }}</v-card-title>
        <v-card-text>
          <p class="mb-3">{{ t('video.failedText') }}</p>
          <v-slider :model-value="nowMs" :max="durationMs || 1" :step="100" hide-details density="compact" color="primary" data-testid="video-still-time" @update:model-value="seek" />
          <span class="text-caption text-medium-emphasis">{{ t('video.stillAt', { s: seconds(nowMs) }) }}</span>
        </v-card-text>
        <v-card-actions class="justify-end">
          <v-btn variant="text" data-testid="video-send-without" @click="sendWithout">{{ t('video.sendWithout') }}</v-btn>
          <v-btn color="primary" variant="flat" :loading="stilling" data-testid="video-use-still" @click="useStill">{{ t('video.useStill') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.vid { display: flex; flex-direction: column; gap: 8px; }
.vid__frame { position: relative; align-self: flex-start; max-width: 100%; line-height: 0; background: #000; }
.vid__player { display: block; max-width: 100%; max-height: calc(100vh - 260px); }
.vid__overlay { position: absolute; inset: 0; cursor: crosshair; touch-action: none; }
.vid__region { position: absolute; border: 2px dashed rgba(255, 255, 255, 0.7); box-shadow: 0 0 0 1px rgba(11, 37, 69, 0.6); }
.vid__region--on {
  border-style: solid;
  border-color: #1f5fbf;
  background: repeating-conic-gradient(rgba(31, 95, 191, 0.45) 0 25%, rgba(255, 255, 255, 0.35) 0 50%) 0 0 / 16px 16px;
}
.vid__region--drag { border-color: #1f5fbf; }
.vid__label { position: absolute; top: 2px; left: 4px; font: 600 12px/1 system-ui, sans-serif; color: #fff; text-shadow: 0 0 2px #000; }
.vid__controls { display: flex; align-items: center; gap: 8px; }
.vid__scrubber { flex: 1; }
.vid__time { white-space: nowrap; }
.vid__panel { background: rgb(var(--v-theme-surface)); border-radius: 8px; padding: 12px; }
.vid__row { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto auto; align-items: center; gap: 8px; }
.vid__name, .vid__range { white-space: nowrap; }
</style>
