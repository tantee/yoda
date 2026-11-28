/** Pixel operations on RGBA image data, burned into the exported screenshot (D3). Pure, so they are tested. */
export type Img = { data: Uint8ClampedArray; width: number; height: number }
export type Rect = { x: number; y: number; w: number; h: number }

function clampRect(img: Img, r: Rect): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(0, Math.floor(Math.min(r.x, r.x + r.w)))
  const y0 = Math.max(0, Math.floor(Math.min(r.y, r.y + r.h)))
  const x1 = Math.min(img.width, Math.ceil(Math.max(r.x, r.x + r.w)))
  const y1 = Math.min(img.height, Math.ceil(Math.max(r.y, r.y + r.h)))
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}

/** Fills one block with its mean colour (edges clamped to the image). */
function fillBlock(img: Img, x0: number, y0: number, x1: number, y1: number): void {
  const sum = [0, 0, 0, 0]
  let n = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      for (let c = 0; c < 4; c++) sum[c]! += img.data[i + c]!
      n++
    }
  if (!n) return
  const mean = sum.map((s) => Math.round(s / n))
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(mean, (y * img.width + x) * 4)
}

/** Mosaic: each `block`-sized cell inside the rect becomes its mean colour. The grid starts at the rect. */
export function pixelate(img: Img, rect: Rect, block: number): void {
  const r = clampRect(img, rect)
  if (!r) return
  const b = Math.max(2, Math.round(block))
  for (let y = r.y0; y < r.y1; y += b) for (let x = r.x0; x < r.x1; x += b) fillBlock(img, x, y, Math.min(x + b, r.x1), Math.min(y + b, r.y1))
}

/** The image-grid cells (index = row * cols + col) whose square meets the stroke (a polyline of `width`). */
export function cellsInStroke(points: number[], width: number, block: number, w: number, h: number): number[] {
  const cols = Math.ceil(w / block)
  const rows = Math.ceil(h / block)
  const half = width / 2
  const out = new Set<number>()
  const segs: [number, number, number, number][] = []
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i]!
    const y = points[i + 1]!
    if (i + 3 < points.length) segs.push([x, y, points[i + 2]!, points[i + 3]!])
    else if (i === 0) segs.push([x, y, x, y])
  }
  // Distance from a point to a segment; a cell is in when its square comes within `half` of the stroke's centre line.
  const dist = (px: number, py: number, [ax, ay, bx, by]: [number, number, number, number]) => {
    const dx = bx - ax
    const dy = by - ay
    const len = dx * dx + dy * dy
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }
  for (const s of segs) {
    const minC = Math.max(0, Math.floor((Math.min(s[0], s[2]) - half) / block))
    const maxC = Math.min(cols - 1, Math.floor((Math.max(s[0], s[2]) + half) / block))
    const minR = Math.max(0, Math.floor((Math.min(s[1], s[3]) - half) / block))
    const maxR = Math.min(rows - 1, Math.floor((Math.max(s[1], s[3]) + half) / block))
    for (let r = minR; r <= maxR; r++)
      for (let c = minC; c <= maxC; c++) {
        // The square's closest point to the segment is within half the diagonal of its centre.
        const cx = c * block + block / 2
        const cy = r * block + block / 2
        if (dist(cx, cy, s) <= half + (block * Math.SQRT2) / 2) out.add(r * cols + c)
      }
  }
  return [...out].sort((a, b) => a - b)
}

/** Mosaic brush: each listed grid cell becomes its mean colour. */
export function pixelateCells(img: Img, cells: number[], block: number): void {
  const cols = Math.ceil(img.width / block)
  for (const cell of cells) {
    const x = (cell % cols) * block
    const y = Math.floor(cell / cols) * block
    fillBlock(img, x, y, Math.min(x + block, img.width), Math.min(y + block, img.height))
  }
}

/** Redact: a solid fill (the theme's dark ink by default). */
export function redactRect(img: Img, rect: Rect, rgb: [number, number, number] = [26, 36, 51]): void {
  const r = clampRect(img, rect)
  if (!r) return
  const fill = [rgb[0], rgb[1], rgb[2], 255]
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) img.data.set(fill, (y * img.width + x) * 4)
}

/** Blur: three box-blur passes (close to a Gaussian of the same radius), within the rect only. */
export function blurRect(img: Img, rect: Rect, radius: number): void {
  const r = clampRect(img, rect)
  if (!r) return
  const w = r.x1 - r.x0
  const h = r.y1 - r.y0
  const k = Math.max(1, Math.round(radius / 2))
  let buf = new Float32Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) buf[(y * w + x) * 4 + c] = img.data[((r.y0 + y) * img.width + r.x0 + x) * 4 + c]!
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length)
    const n = horizontal ? w : h
    const m = horizontal ? h : w
    for (let j = 0; j < m; j++)
      for (let c = 0; c < 4; c++) {
        const at = (i: number) => (horizontal ? (j * w + i) * 4 + c : (i * w + j) * 4 + c)
        let sum = 0
        for (let i = -k; i <= k; i++) sum += src[at(Math.min(n - 1, Math.max(0, i)))]!
        for (let i = 0; i < n; i++) {
          out[at(i)] = sum / (2 * k + 1)
          sum += src[at(Math.min(n - 1, i + k + 1))]! - src[at(Math.max(0, i - k))]!
        }
      }
    return out
  }
  for (let p = 0; p < 3; p++) buf = pass(pass(buf, true), false)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) img.data[((r.y0 + y) * img.width + r.x0 + x) * 4 + c] = buf[(y * w + x) * 4 + c]!
}
