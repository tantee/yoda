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
