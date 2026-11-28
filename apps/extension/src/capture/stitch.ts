/** Where to scroll for a full-page capture: whole viewports, the last aligned to the (capped) bottom. */
export function planStitch(page: { scrollHeight: number; viewportHeight: number; dpr: number }, cap = 15000): { offsets: number[]; height: number; truncated: boolean } {
  const vh = Math.max(1, Math.floor(page.viewportHeight))
  // The cap is in device pixels (canvas limits): fewer CSS pixels on a high-density screen.
  const cssCap = Math.floor(cap / Math.max(1, page.dpr))
  const height = Math.min(Math.max(1, Math.ceil(page.scrollHeight)), cssCap)
  const truncated = page.scrollHeight > cssCap
  if (height <= vh) return { offsets: [0], height, truncated }
  const offsets: number[] = []
  for (let y = 0; y + vh < height; y += vh) offsets.push(y)
  offsets.push(height - vh)
  return { offsets, height, truncated }
}

export type Rect = { left: number; top: number; width: number; height: number }

/**
 * Where each captured frame goes on the stitched canvas. A frame is the whole visible tab; only the scroller's box
 * (`view`, in CSS pixels: the viewport for the document, the element's client box for an inner scroller) is taken
 * from it, so an app shell's static header or side bar is not pasted into every band. `scale` is device pixels per
 * CSS pixel of the frames.
 */
export function framePlacements(offsets: number[], view: Rect, scale: number): { canvas: { width: number; height: number }; draws: { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number }[] } {
  const px = (v: number) => Math.round(v * scale)
  const last = offsets.length ? offsets[offsets.length - 1]! : 0
  return {
    canvas: { width: px(view.width), height: px(last + view.height) },
    draws: offsets.map((y) => ({ sx: px(view.left), sy: px(view.top), sw: px(view.width), sh: px(view.height), dx: 0, dy: px(y) })),
  }
}
