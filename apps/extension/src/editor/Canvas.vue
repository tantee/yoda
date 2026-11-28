<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { EditorDoc, Op } from './doc'
import { drawVector } from './draw'
import { applyDestructive, type VectorOp } from './flatten'
import type { Tool } from './Toolbar.vue'

/**
 * The editing surface: the screenshot with blur, redact and mosaic applied exactly as they will be burned in,
 * the annotations on top, and the shape being drawn. Coordinates are image pixels.
 */
const props = defineProps<{ base: ImageBitmap; doc: EditorDoc; tool: Tool; colour: string; block: number }>()
const emit = defineEmits<{ add: [Op]; text: [{ x: number; y: number }] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
/** The base with the destructive ops applied, recomputed only when those change. */
let pixels: HTMLCanvasElement | null = null
let pixelKey = ''
const drag = ref<{ x0: number; y0: number; x1: number; y1: number; points: number[] } | null>(null)

const destructiveKey = computed(() => JSON.stringify(props.doc.ops.filter((o) => o.kind === 'blur' || o.kind === 'redact' || o.kind === 'mosaic')))

function rebuildPixels() {
  if (pixels && pixelKey === destructiveKey.value) return
  const c = document.createElement('canvas')
  c.width = props.base.width
  c.height = props.base.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(props.base, 0, 0)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  applyDestructive({ data: data.data, width: data.width, height: data.height }, props.doc.ops)
  ctx.putImageData(data, 0, 0)
  pixels = c
  pixelKey = destructiveKey.value
}

function preview(): Op | null {
  const d = drag.value
  if (!d) return null
  const rect = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
  switch (props.tool) {
    case 'arrow':
      return { kind: 'arrow', points: [d.x0, d.y0, d.x1, d.y1], colour: props.colour, width: 4 }
    case 'box':
    case 'highlight':
      return { kind: props.tool, rect, colour: props.colour }
    case 'blur':
      return { kind: 'blur', rect, radius: 12 }
    case 'redact':
      return { kind: 'redact', rect }
    case 'mosaic':
      return { kind: 'mosaic', mode: 'rect', rect, block: props.block }
    case 'mosaic-brush':
      return { kind: 'mosaic', mode: 'brush', points: [...d.points], width: 32, block: props.block }
    case 'crop':
      return { kind: 'crop', rect }
    default:
      return null
  }
}

function render() {
  const c = canvas.value
  if (!c) return
  rebuildPixels()
  c.width = props.base.width
  c.height = props.base.height
  const ctx = c.getContext('2d')!
  ctx.drawImage(pixels!, 0, 0)
  drawVector(ctx, props.doc.ops.filter((o): o is VectorOp => o.kind !== 'blur' && o.kind !== 'redact' && o.kind !== 'mosaic' && o.kind !== 'crop'))
  const p = preview()
  if (p) {
    ctx.save()
    if (p.kind === 'arrow' || p.kind === 'box' || p.kind === 'highlight') drawVector(ctx, [p])
    else if (p.kind === 'mosaic' && p.mode === 'brush') {
      ctx.strokeStyle = 'rgba(31,95,191,0.5)'
      ctx.lineWidth = 32
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      for (let i = 0; i + 1 < p.points.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, p.points[i]!, p.points[i + 1]!)
      ctx.stroke()
    } else if ('rect' in p) {
      ctx.setLineDash([6, 4])
      ctx.strokeStyle = '#1F5FBF'
      ctx.lineWidth = 2
      ctx.strokeRect(p.rect.x, p.rect.y, p.rect.w, p.rect.h)
    }
    ctx.restore()
  }
  // The current crop, dimmed outside.
  const crop = [...props.doc.ops].reverse().find((o) => o.kind === 'crop')
  if (crop && crop.kind === 'crop') {
    ctx.save()
    ctx.fillStyle = 'rgba(11,37,69,0.45)'
    ctx.beginPath()
    ctx.rect(0, 0, c.width, c.height)
    ctx.rect(crop.rect.x, crop.rect.y, crop.rect.w, crop.rect.h)
    ctx.fill('evenodd')
    ctx.restore()
  }
}

function at(ev: PointerEvent): { x: number; y: number } {
  const c = canvas.value!
  const r = c.getBoundingClientRect()
  return { x: Math.round(((ev.clientX - r.left) / r.width) * c.width), y: Math.round(((ev.clientY - r.top) / r.height) * c.height) }
}

function down(ev: PointerEvent) {
  if (props.tool === 'select') return
  const p = at(ev)
  if (props.tool === 'step') {
    const n = props.doc.ops.reduce((m, o) => (o.kind === 'step' ? Math.max(m, o.n) : m), 0) + 1
    return emit('add', { kind: 'step', at: p, n })
  }
  if (props.tool === 'text') return emit('text', p)
  canvas.value!.setPointerCapture(ev.pointerId)
  drag.value = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, points: [p.x, p.y] }
}

function move(ev: PointerEvent) {
  if (!drag.value) return
  const p = at(ev)
  drag.value = { ...drag.value, x1: p.x, y1: p.y, points: props.tool === 'mosaic-brush' ? [...drag.value.points, p.x, p.y] : drag.value.points }
  render()
}

function up() {
  const op = preview()
  drag.value = null
  // Ignore accidental clicks: a shape needs some size.
  if (op && (!('rect' in op) || (op.rect.w > 3 && op.rect.h > 3)) && !(op.kind === 'arrow' && Math.hypot(op.points[2] - op.points[0], op.points[3] - op.points[1]) < 6)) emit('add', op)
  render()
}

watch(() => [props.doc, props.base], render, { deep: true })
onMounted(render)
</script>

<template>
  <canvas
    ref="canvas"
    class="editor-canvas"
    :class="`tool-${tool}`"
    data-testid="editor-canvas"
    @pointerdown="down"
    @pointermove="move"
    @pointerup="up"
    @pointercancel="up"
  />
</template>

<style scoped>
.editor-canvas { display: block; max-width: 100%; height: auto; touch-action: none; box-shadow: 0 1px 4px rgba(11, 37, 69, 0.15); background: #fff; }
.editor-canvas:not(.tool-select) { cursor: crosshair; }
</style>
