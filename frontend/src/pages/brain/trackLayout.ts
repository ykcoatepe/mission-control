/**
 * Pure geometry of the Brain track diagram. No DOM and no data: counts in, boxes and track paths out, so
 * it can be tested. The diagram is drawn in a fixed viewBox and scaled to its container.
 *
 *   source groups (left) --tracks--> GBRAIN CORE (centre) --tracks--> readers (right)
 *                                        |
 *                                  embedding queue siding (below the core)
 */

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const VIEW_W = 820
export const GROUP_W = 252
export const GROUP_HEADER_H = 26
export const GROUP_ROW_H = 18
export const GROUP_PAD = 6
export const GROUP_GAP = 10

export const CORE_X = 392
export const CORE_W = 148
export const CORE_TOP = 176
export const CORE_H = 140

export const READER_X = 640
export const READER_W = 180
export const READER_H = 40
export const READER_GAP = 14

export const READINGS_X = 404
export const READINGS_ROW_H = 21
export const READINGS_TOP = 14

export const MAX_QUEUE_UNITS = 5
const UNIT_PITCH = 26
const MIN_HEIGHT = 424
const TRACK_STEP = 14
const CORNER = 10

export interface LayoutInput {
  /** Number of source rows in each group, in diagram order. A group with no sources still has one row (a note). */
  groupRows: readonly number[]
  readerCount: number
  /** Embedding jobs to draw on the siding (waiting + active); more than MAX_QUEUE_UNITS is shown as "+N". */
  queueUnits: number
}

export interface TrackLayout {
  width: number
  height: number
  groups: Array<{ index: number; box: Box; firstRowY: number }>
  core: Box
  readings: { x: number; firstRowY: number; rowH: number }
  queue: {
    label: Box
    /** The siding: down from the core, then right. */
    siding: Point[]
    bumper: Box
    units: Array<{ x: number; y: number }>
    more: number
    caption: Point
  }
  readers: Array<{ index: number; box: Box }>
  readerCaption: Point
  /** One track from each group into the core. */
  groupTracks: Array<{ index: number; points: Point[] }>
  /** One track from the core to each reader. */
  readerTracks: Array<{ index: number; points: Point[] }>
}

export const groupHeight = (rows: number) => GROUP_HEADER_H + GROUP_PAD * 2 + Math.max(1, rows) * GROUP_ROW_H

/** Evenly spread attachment points along a core edge. */
function spread(count: number, top: number, bottom: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [Math.round((top + bottom) / 2)]
  return Array.from({ length: count }, (_, i) => Math.round(top + ((bottom - top) * i) / (count - 1)))
}

/**
 * Right-angle tracks between a column of blocks and one side of the core. A track that has to go down
 * turns nearest the core when it starts highest; a track that has to go up turns nearest the core when
 * it starts lowest. That ordering is what keeps two tracks from crossing.
 */
function sideTracks(
  centres: readonly number[],
  targets: readonly number[],
  blockEdgeX: number,
  coreEdgeX: number,
): Point[][] {
  const direction = blockEdgeX < coreEdgeX ? 1 : -1
  const near = coreEdgeX - direction * 24
  const meta = centres.map((y1, index) => ({ index, y1, y2: targets[index] ?? y1 }))
  const down = meta.filter((m) => m.y2 - m.y1 > 0.5).sort((a, b) => a.y1 - b.y1)
  const up = meta.filter((m) => m.y2 - m.y1 < -0.5).sort((a, b) => b.y1 - a.y1)
  const turnX = new Map<number, number>()
  down.forEach((m, rank) => turnX.set(m.index, near - direction * rank * TRACK_STEP))
  up.forEach((m, rank) => turnX.set(m.index, near - direction * rank * TRACK_STEP))
  return meta.map((m) => {
    const bx = turnX.get(m.index)
    if (bx === undefined) return [{ x: blockEdgeX, y: m.y1 }, { x: coreEdgeX, y: m.y2 }]
    return [
      { x: blockEdgeX, y: m.y1 },
      { x: bx, y: m.y1 },
      { x: bx, y: m.y2 },
      { x: coreEdgeX, y: m.y2 },
    ]
  })
}

export function computeTrackLayout({ groupRows, readerCount, queueUnits }: LayoutInput): TrackLayout {
  // ---- groups ----
  let y = 0
  const groups = groupRows.map((rows, index) => {
    const h = groupHeight(rows)
    const box = { x: 0, y, w: GROUP_W, h }
    y += h + GROUP_GAP
    return { index, box, firstRowY: box.y + GROUP_HEADER_H + GROUP_PAD }
  })
  const leftBottom = Math.max(0, y - GROUP_GAP)

  // ---- core ----
  const core = { x: CORE_X, y: CORE_TOP, w: CORE_W, h: CORE_H }
  const coreMid = core.y + core.h / 2
  const entries = (count: number) => spread(count, core.y + 24, core.y + core.h - 24)

  // ---- readers ----
  const readersH = readerCount * READER_H + Math.max(0, readerCount - 1) * READER_GAP
  const readersTop = Math.max(8, Math.round(coreMid - readersH / 2))
  const readers = Array.from({ length: readerCount }, (_, index) => ({
    index,
    box: { x: READER_X, y: readersTop + index * (READER_H + READER_GAP), w: READER_W, h: READER_H },
  }))
  const readerBottom = readers.length ? readers[readers.length - 1].box.y + READER_H : readersTop

  // ---- queue siding ----
  const sidingX = core.x + 30
  const coreBottom = core.y + core.h
  const sidingY = coreBottom + 62
  // The siding stops short of the readers' column, so it never runs under the reader caption.
  const sidingEnd = READER_X - 28
  const shown = Math.max(0, Math.min(MAX_QUEUE_UNITS, Math.floor(queueUnits)))
  const queue = {
    label: { x: sidingX + 22, y: coreBottom + 14, w: 138, h: 26 },
    siding: [
      { x: sidingX, y: coreBottom },
      { x: sidingX, y: sidingY },
      { x: sidingEnd, y: sidingY },
    ],
    bumper: { x: sidingEnd, y: sidingY - 7, w: 3, h: 14 },
    units: Array.from({ length: shown }, (_, i) => ({ x: sidingX + 24 + i * UNIT_PITCH, y: sidingY - 24 })),
    more: Math.max(0, Math.floor(queueUnits) - MAX_QUEUE_UNITS),
    caption: { x: sidingX, y: sidingY + 28 },
  }

  const groupCentres = groups.map((g) => g.box.y + g.box.h / 2)
  const readerCentres = readers.map((r) => r.box.y + r.box.h / 2)
  const groupTracks = sideTracks(groupCentres, entries(groups.length), GROUP_W, core.x).map((points, index) => ({ index, points }))
  const readerTracks = sideTracks(readerCentres, entries(readers.length), READER_X, core.x + core.w)
    .map((points) => [...points].reverse())
    .map((points, index) => ({ index, points }))

  return {
    width: VIEW_W,
    height: Math.max(MIN_HEIGHT, leftBottom, queue.caption.y + 12, readerBottom + 56),
    groups,
    core,
    readings: { x: READINGS_X, firstRowY: READINGS_TOP, rowH: READINGS_ROW_H },
    queue,
    readers,
    readerCaption: { x: READER_X, y: readerBottom + 20 },
    groupTracks,
    readerTracks,
  }
}

/** A path through right-angle points with rounded corners. */
export function trackPath(points: readonly Point[], radius = CORNER): string {
  if (points.length === 0) return ''
  const parts = [`M${points[0].x} ${points[0].y}`]
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const here = points[i]
    const next = points[i + 1]
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y)
    const outLen = Math.hypot(next.x - here.x, next.y - here.y)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    if (r <= 0.5) {
      parts.push(`L${here.x} ${here.y}`)
      continue
    }
    const a = { x: here.x - ((here.x - prev.x) / inLen) * r, y: here.y - ((here.y - prev.y) / inLen) * r }
    const b = { x: here.x + ((next.x - here.x) / outLen) * r, y: here.y + ((next.y - here.y) / outLen) * r }
    parts.push(`L${a.x} ${a.y}`, `Q${here.x} ${here.y} ${b.x} ${b.y}`)
  }
  const last = points[points.length - 1]
  if (points.length > 1) parts.push(`L${last.x} ${last.y}`)
  return parts.join(' ')
}

/** Truncate with an ellipsis; `full` is for the `title`. */
export function truncateLabel(text: string, maxChars: number): { text: string; full: string; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return { text, full: text, truncated: false }
  if (limit === 1) return { text: '…', full: text, truncated: true }
  return { text: `${text.slice(0, limit - 1).trimEnd()}…`, full: text, truncated: true }
}

/** Greedy word wrap by character count. */
export function wrapWords(text: string, maxChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/**
 * Spatial arrow-key navigation: the nearest item in the pressed direction,
 * preferring items that are better aligned with the current one.
 */
export function moveFocus(
  items: ReadonlyArray<{ id: string; x: number; y: number }>,
  currentId: string,
  direction: Direction,
): string | null {
  const current = items.find((item) => item.id === currentId)
  if (!current) return items[0]?.id ?? null
  let best: { id: string; score: number } | null = null
  for (const item of items) {
    if (item.id === current.id) continue
    const dx = item.x - current.x
    const dy = item.y - current.y
    const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
    if (along <= 0) continue
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = along + across * 2
    if (!best || score < best.score) best = { id: item.id, score }
  }
  return best?.id ?? null
}
