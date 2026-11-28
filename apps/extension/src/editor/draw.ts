import type { VectorOp } from './flatten'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Draws the vector annotations (arrow, box, highlight, text, step), the same on screen and in the export. */
export function drawVector(ctx: Ctx, ops: VectorOp[]): void {
  for (const op of ops) {
    ctx.save()
    if (op.kind === 'arrow') {
      const [x1, y1, x2, y2] = op.points
      const head = Math.max(10, op.width * 4)
      const a = Math.atan2(y2 - y1, x2 - x1)
      ctx.strokeStyle = op.colour
      ctx.fillStyle = op.colour
      ctx.lineWidth = op.width
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2 - Math.cos(a) * head * 0.8, y2 - Math.sin(a) * head * 0.8)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7))
      ctx.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7))
      ctx.closePath()
      ctx.fill()
    } else if (op.kind === 'box') {
      ctx.strokeStyle = op.colour
      ctx.lineWidth = 3
      ctx.strokeRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h)
    } else if (op.kind === 'highlight') {
      ctx.fillStyle = op.colour
      ctx.globalAlpha = 0.3
      ctx.fillRect(op.rect.x, op.rect.y, op.rect.w, op.rect.h)
    } else if (op.kind === 'text') {
      ctx.font = `600 ${op.size}px 'IBM Plex Sans Thai', 'IBM Plex Sans', sans-serif`
      ctx.textBaseline = 'top'
      const m = ctx.measureText(op.text)
      ctx.fillStyle = 'rgba(255,255,255,0.85)'
      ctx.fillRect(op.at.x - 4, op.at.y - 3, m.width + 8, op.size + 8)
      ctx.fillStyle = op.colour
      ctx.fillText(op.text, op.at.x, op.at.y)
    } else if (op.kind === 'step') {
      const r = 14
      ctx.fillStyle = '#B3261E'
      ctx.beginPath()
      ctx.arc(op.at.x, op.at.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.font = `600 16px 'IBM Plex Sans', sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(op.n), op.at.x, op.at.y + 1)
    }
    ctx.restore()
  }
}
