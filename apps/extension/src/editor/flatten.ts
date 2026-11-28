import type { EditorDoc, Op } from './doc'
import { blurRect, cellsInStroke, pixelate, pixelateCells, redactRect, type Img, type Rect } from './pixels'

const DESTRUCTIVE = new Set(['blur', 'redact', 'mosaic'])
export type VectorOp = Exclude<Op, { kind: 'blur' | 'redact' | 'mosaic' | 'crop' }>

/** The pixel stage: blur, redact and mosaic applied to `img` in document order; returns the vector ops and the crop. */
export function applyDestructive(img: Img, ops: Op[]): { vector: VectorOp[]; crop: Rect | null } {
  for (const op of ops) {
    if (op.kind === 'blur') blurRect(img, op.rect, op.radius)
    else if (op.kind === 'redact') redactRect(img, op.rect)
    else if (op.kind === 'mosaic') {
      if (op.mode === 'rect') pixelate(img, op.rect, op.block)
      else pixelateCells(img, cellsInStroke(op.points, op.width, op.block, img.width, img.height), op.block)
    }
  }
  return { vector: ops.filter((o): o is VectorOp => !DESTRUCTIVE.has(o.kind) && o.kind !== 'crop'), crop: cropRect(ops) }
}

/** The last crop wins. */
export function cropRect(ops: Op[]): Rect | null {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i]!
    if (o.kind === 'crop') return o.rect
  }
  return null
}

/**
 * The image that is uploaded (the original never is): the base bitmap with blur, redact and mosaic burned into
 * its pixels, the vector annotations drawn on top (`drawVector`, the Konva stage), then the last crop, as PNG.
 */
export async function flatten(base: ImageBitmap, doc: EditorDoc, drawVector: (ctx: OffscreenCanvasRenderingContext2D, ops: VectorOp[]) => void | Promise<void>): Promise<Blob> {
  const canvas = new OffscreenCanvas(base.width, base.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(base, 0, 0)
  const data = ctx.getImageData(0, 0, base.width, base.height)
  const { vector, crop } = applyDestructive({ data: data.data, width: data.width, height: data.height }, doc.ops)
  ctx.putImageData(data, 0, 0)
  await drawVector(ctx, vector)
  if (!crop) return canvas.convertToBlob({ type: 'image/png' })
  const w = Math.max(1, Math.round(Math.min(crop.w, base.width - crop.x)))
  const h = Math.max(1, Math.round(Math.min(crop.h, base.height - crop.y)))
  const out = new OffscreenCanvas(w, h)
  out.getContext('2d')!.drawImage(canvas, Math.round(crop.x), Math.round(crop.y), w, h, 0, 0, w, h)
  return out.convertToBlob({ type: 'image/png' })
}
