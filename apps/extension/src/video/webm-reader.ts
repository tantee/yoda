/**
 * A small WebM (EBML) demuxer for the clips MediaRecorder writes (decision 1, path 2): the video track's codec, size
 * and frames. It reads SimpleBlocks and BlockGroup/Blocks without lacing, and Segments and Clusters of unknown size.
 */
export type WebmFrame = { timestampUs: number; key: boolean; data: Uint8Array }
/** `durationUs` is the written Duration, absent when MediaRecorder left it unknown. */
export type Webm = { codec: 'V_VP8' | 'V_VP9' | string; width: number; height: number; durationUs?: number; frames: WebmFrame[] }

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
}
/** Top-level Segment children: one of these ends an unknown-size Cluster. */
const SEGMENT_CHILDREN = new Set([0x114d9b74, ID.Info, ID.Tracks, ID.Cluster, 0x1c53bb6b, 0x1043a770, 0x1941a469, 0x1254c367])

/** `cut`: the element claims more bytes than its parent (or the file) holds: a file cut off mid-element. */
type El = { id: number; start: number; end: number; next: number; cut: boolean }

export function readWebm(input: ArrayBuffer | Uint8Array): Webm {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)

  const vint = (at: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } => {
    const first = b[at]
    if (first === undefined || first === 0) throw new Error('webm: bad element header')
    let len = 1
    while (!(first & (0x80 >> (len - 1)))) len++
    if (at + len > b.length) throw new Error('webm: truncated')
    let value = keepMarker ? first : first & (0xff >> len)
    let allOnes = value === (0xff >> len)
    for (let i = 1; i < len; i++) {
      value = value * 256 + b[at + i]!
      if (b[at + i] !== 0xff) allOnes = false
    }
    return { value, len, unknown: !keepMarker && allOnes }
  }

  const header = (at: number, parentEnd: number): El => {
    const id = vint(at, true)
    const size = vint(at + id.len, false)
    const start = at + id.len + size.len
    const end = size.unknown ? parentEnd : Math.min(parentEnd, start + size.value)
    return { id: id.value, start, end, next: end, cut: !size.unknown && start + size.value > parentEnd }
  }

  const uint = (e: El) => {
    let v = 0
    for (let i = e.start; i < e.end; i++) v = v * 256 + b[i]!
    return v
  }
  const str = (e: El) => new TextDecoder().decode(b.subarray(e.start, e.end)).replace(/\0+$/, '')

  /** The children of [start, end); `stop` ends an unknown-size parent at the next sibling of its own level. */
  function* children(start: number, end: number, stop?: (id: number) => boolean): Generator<El> {
    let at = start
    while (at < end) {
      let e: El
      try {
        e = header(at, end)
      } catch {
        // The file ends inside an element header: keep what was read.
        return
      }
      if (stop?.(e.id)) return
      yield e
      if (e.next <= at) throw new Error('webm: no progress')
      at = e.next
    }
  }

  if (b.length < 4 || dv.getUint32(0) !== ID.EBML) throw new Error('webm: not an EBML file')
  const ebml = header(0, b.length)
  const seg = header(ebml.next, b.length)
  if (seg.id !== ID.Segment) throw new Error('webm: no Segment')

  let scaleNs = 1_000_000
  let duration: number | null = null
  let track: { number: number; codec: string; width: number; height: number } | null = null
  const frames: WebmFrame[] = []

  const block = (e: El, clusterTc: number, keyFromFlags: boolean | null) => {
    const tn = vint(e.start, false)
    if (!track || tn.value !== track.number) return
    const at = e.start + tn.len
    const rel = dv.getInt16(at)
    const flags = b[at + 2]!
    if (flags & 0x06) throw new Error('webm: laced blocks are not supported')
    frames.push({
      timestampUs: Math.round(((clusterTc + rel) * scaleNs) / 1000),
      key: keyFromFlags ?? (flags & 0x80) !== 0,
      data: b.subarray(at + 3, e.end),
    })
  }

  let at = seg.start
  while (at < seg.end) {
    const e = header(at, seg.end)
    if (e.id === ID.Info) {
      for (const c of children(e.start, e.end)) {
        // 0 is invalid (every timestamp would be 0): the default 1 ms then.
        if (c.id === ID.TimecodeScale) scaleNs = uint(c) || 1_000_000
        else if (c.id === ID.Duration) duration = c.end - c.start === 4 ? dv.getFloat32(c.start) : dv.getFloat64(c.start)
      }
    } else if (e.id === ID.Tracks) {
      for (const te of children(e.start, e.end)) {
        if (te.id !== ID.TrackEntry || track) continue
        const t = { number: 0, type: 0, codec: '', width: 0, height: 0 }
        for (const c of children(te.start, te.end)) {
          if (c.id === ID.TrackNumber) t.number = uint(c)
          else if (c.id === ID.TrackType) t.type = uint(c)
          else if (c.id === ID.CodecID) t.codec = str(c)
          else if (c.id === ID.Video)
            for (const v of children(c.start, c.end)) {
              if (v.id === ID.PixelWidth) t.width = uint(v)
              else if (v.id === ID.PixelHeight) t.height = uint(v)
            }
        }
        if (t.type === 1) track = t
      }
    } else if (e.id === ID.Cluster) {
      let tc = 0
      let last = e.start
      for (const c of children(e.start, e.end, (id) => SEGMENT_CHILDREN.has(id))) {
        last = c.next
        if (c.id === ID.Timecode) tc = uint(c)
        // A frame cut off by the end of the file is dropped, not decoded half.
        else if (c.id === ID.SimpleBlock && !c.cut) block(c, tc, null)
        else if (c.id === ID.BlockGroup) {
          const kids = [...children(c.start, c.end)]
          const blk = kids.find((k) => k.id === ID.Block)
          // In a BlockGroup, a frame without a ReferenceBlock is a key frame.
          if (blk && !blk.cut && !c.cut) block(blk, tc, !kids.some((k) => k.id === ID.ReferenceBlock))
        }
      }
      // A Cluster ends where the next top-level element starts: an unknown-size one, and the first one after
      // fix-webm-duration, whose size runs to the end of the file.
      if (last < e.end) e.next = last
    }
    if (e.next <= at) throw new Error('webm: no progress')
    at = e.next
  }
  if (!track) throw new Error('webm: no video track')
  if (!frames.length) throw new Error('webm: no frames')
  const durationUs = duration != null && duration > 0 ? Math.round((duration * scaleNs) / 1000) : undefined
  return { codec: track.codec, width: track.width, height: track.height, ...(durationUs ? { durationUs } : {}), frames }
}
