/**
 * Pure geometry of the system synoptic. No DOM, no data: it turns counts and
 * a width into boxes, right-angle paths and arrowheads, so it can be tested.
 *
 *   Readers (left) --> GBrain core (centre) <-- Sources (right)
 *                            ^
 *                      Embedding queue (below the core)
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

export interface LayoutEdge {
  /** Id of the block this line leaves. Every line ends at the core. */
  blockId: string
  /** Right-angle path from the block to the core. */
  points: Point[]
  /** Triangle at the core end; its tip touches the core. */
  arrow: [Point, Point, Point]
  /** Anchor of the one small label and of the line's button. */
  label: Point & { align: 'start' | 'end' | 'center'; maxWidth: number }
}

export interface SynopticLayout {
  width: number
  height: number
  headers: Array<{ id: 'readers' | 'core' | 'sources'; x: number; y: number }>
  core: Box
  queue: Box
  readers: Array<{ index: number; box: Box }>
  groups: Array<{ index: number; box: Box }>
  /** Reader lines, then group lines, then the queue line. */
  edges: LayoutEdge[]
}

export const MIN_WIDTH = 720
export const PAD = 16
export const HEADER_H = 28
export const ROW_H = 56
export const ROW_GAP = 16
export const CORE_H = 176
export const QUEUE_H = 56
export const QUEUE_GAP = 56
const MIN_GUTTER = 96
const ARROW_LEN = 6
const ARROW_HALF = 4
const NEAR_CORE = 14

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Truncate with an ellipsis; `full` is for the `title` attribute. */
export function truncateLabel(text: string, maxChars: number): { text: string; full: string; truncated: boolean } {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return { text, full: text, truncated: false }
  if (limit === 1) return { text: '…', full: text, truncated: true }
  return { text: `${text.slice(0, limit - 1).trimEnd()}…`, full: text, truncated: true }
}

/** Evenly spread attachment points along the core edge. */
function spread(count: number, top: number, bottom: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [Math.round((top + bottom) / 2)]
  return Array.from({ length: count }, (_, i) => Math.round(top + ((bottom - top) * i) / (count - 1)))
}

/**
 * Right-angle lines from one side to the core. `dir` is +1 for lines that
 * travel rightwards (readers), -1 for lines that travel leftwards (sources).
 * Vertical runs are staggered so that no two lines overlap or cross.
 */
function sideEdges(
  blocks: Box[],
  dir: 1 | -1,
  coreEdgeX: number,
  targets: number[],
  zone: { near: number; step: number },
  labelReserve: number,
  prefix: string[],
): LayoutEdge[] {
  const meta = blocks.map((box, i) => {
    const y1 = box.y + box.h / 2
    return { i, box, y1, y2: targets[i], dy: targets[i] - y1 }
  })
  // Lines that go down: the topmost sits nearest the core. Lines that go up: the lowest does.
  const down = meta.filter((m) => m.dy > 0.5).sort((a, b) => a.y1 - b.y1)
  const up = meta.filter((m) => m.dy < -0.5).sort((a, b) => b.y1 - a.y1)
  const verticalX = new Map<number, number>()
  down.forEach((m, rank) => verticalX.set(m.i, zone.near - dir * rank * zone.step))
  up.forEach((m, rank) => verticalX.set(m.i, zone.near - dir * rank * zone.step))

  return meta.map((m) => {
    const startX = dir === 1 ? m.box.x + m.box.w : m.box.x
    const tipX = coreEdgeX
    const lineEndX = tipX - dir * ARROW_LEN
    const midX = verticalX.get(m.i)
    const points: Point[] =
      midX === undefined
        ? [{ x: startX, y: m.y1 }, { x: lineEndX, y: m.y1 }]
        : [
            { x: startX, y: m.y1 },
            { x: midX, y: m.y1 },
            { x: midX, y: m.y2 },
            { x: lineEndX, y: m.y2 },
          ]
    const endY = midX === undefined ? m.y1 : m.y2
    const arrow: [Point, Point, Point] = [
      { x: tipX, y: endY },
      { x: lineEndX, y: endY - ARROW_HALF },
      { x: lineEndX, y: endY + ARROW_HALF },
    ]
    return {
      blockId: prefix[m.i],
      points,
      arrow,
      label: {
        x: dir === 1 ? startX + 8 : startX - 8,
        y: m.y1 - 12,
        align: dir === 1 ? 'start' : 'end',
        maxWidth: labelReserve - 8,
      },
    }
  })
}

export interface LayoutInput {
  width: number
  /** Block ids, top to bottom. */
  readerIds: string[]
  groupIds: string[]
  queueId: string
}

export function computeSynopticLayout({ width: rawWidth, readerIds, groupIds, queueId }: LayoutInput): SynopticLayout {
  const width = Math.max(MIN_WIDTH, Math.round(rawWidth))
  const coreW = clamp(Math.round(width * 0.26), 200, 280)
  const colW = clamp(Math.floor((width - 2 * PAD - coreW - 2 * MIN_GUTTER) / 2), 140, 220)
  const gutter = Math.floor((width - 2 * PAD - coreW - 2 * colW) / 2)
  const readersX = PAD
  const coreX = PAD + colW + gutter
  const sourcesX = coreX + coreW + gutter

  const rows = Math.max(readerIds.length, groupIds.length, 1)
  const stackH = (n: number) => (n <= 0 ? 0 : n * ROW_H + (n - 1) * ROW_GAP)
  const bodyH = Math.max(stackH(rows), CORE_H)
  const bodyTop = PAD + HEADER_H
  const coreTop = bodyTop + Math.round((bodyH - CORE_H) / 2)
  const stackTop = (n: number) => bodyTop + Math.round((bodyH - stackH(n)) / 2)

  const place = (n: number, x: number) =>
    Array.from({ length: n }, (_, i): Box => ({ x, y: stackTop(n) + i * (ROW_H + ROW_GAP), w: colW, h: ROW_H }))
  const readerBoxes = place(readerIds.length, readersX)
  const groupBoxes = place(groupIds.length, sourcesX)

  const core: Box = { x: coreX, y: coreTop, w: coreW, h: CORE_H }
  const queue: Box = { x: coreX, y: coreTop + CORE_H + QUEUE_GAP, w: coreW, h: QUEUE_H }

  const attachTop = coreTop + 28
  const attachBottom = coreTop + CORE_H - 28
  // Labels sit above the first horizontal run, so vertical runs stay beyond the label reserve.
  const labelReserve = clamp(Math.round(gutter * 0.7), 64, 140)
  const zoneWidth = Math.max(8, gutter - labelReserve - NEAR_CORE)
  const longest = Math.max(1, readerIds.length, groupIds.length)
  const step = Math.max(4, Math.floor(zoneWidth / longest))

  const readerEdges = sideEdges(
    readerBoxes,
    1,
    coreX,
    spread(readerIds.length, attachTop, attachBottom),
    { near: coreX - NEAR_CORE, step },
    labelReserve,
    readerIds,
  )
  const groupEdges = sideEdges(
    groupBoxes,
    -1,
    coreX + coreW,
    spread(groupIds.length, attachTop, attachBottom),
    { near: coreX + coreW + NEAR_CORE, step },
    labelReserve,
    groupIds,
  )
  const queueTipY = queue.y - 0
  const queueMidX = Math.round(coreX + coreW / 2)
  const queueEdge: LayoutEdge = {
    blockId: queueId,
    // The line runs up from the queue to the core's lower edge.
    points: [{ x: queueMidX, y: queue.y }, { x: queueMidX, y: core.y + core.h + ARROW_LEN }],
    arrow: [
      { x: queueMidX, y: core.y + core.h },
      { x: queueMidX - ARROW_HALF, y: core.y + core.h + ARROW_LEN },
      { x: queueMidX + ARROW_HALF, y: core.y + core.h + ARROW_LEN },
    ],
    label: {
      x: queueMidX + 12,
      y: Math.round((core.y + core.h + queueTipY) / 2) - 8,
      align: 'start',
      maxWidth: Math.floor(coreW / 2) - 12,
    },
  }

  const height = Math.max(stackTop(rows) + stackH(rows), queue.y + QUEUE_H) + PAD

  return {
    width,
    height,
    headers: [
      { id: 'readers', x: readersX, y: PAD },
      { id: 'core', x: coreX, y: PAD },
      { id: 'sources', x: sourcesX, y: PAD },
    ],
    core,
    queue,
    readers: readerBoxes.map((box, index) => ({ index, box })),
    groups: groupBoxes.map((box, index) => ({ index, box })),
    edges: [...readerEdges, ...groupEdges, queueEdge],
  }
}

export function pathData(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
}

export function arrowData(arrow: readonly Point[]): string {
  return `${pathData(arrow)} Z`
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
