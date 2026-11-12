import type { Diagram, DiagramSource, GroupTone } from './diagram'

/** Pixel height of the tallest line. One calibrated baseline, one linear scale. */
export const PROFILE_SCALE_PX = 140

export interface ProfileLine {
  id: string
  name: string
  full: string
  tone: GroupTone | undefined
  groupLabel: string
  pages: number | null
  chunks: number | null
  lastSyncAt: string | null
  syncOff: boolean
  /** 0 to 100, linear in pages. Null when pages were not read: no line is drawn. */
  percent: number | null
  /** Pixels at the default scale; a source with pages is never less than one pixel. Null when not read. */
  height: number | null
}

export interface Profile {
  lines: ProfileLine[]
  /** The pages of the tallest line: the scale's top. Null when nothing was read. */
  max: number | null
}

/**
 * Height of a line in pixels on a true linear scale: zero pages is the baseline, the tallest source is
 * `scale` pixels, and anything between is proportional. A source too small to see is still one pixel,
 * so it has a line and a label. No log scale, no minimum bar height beyond that one pixel.
 */
export function lineHeight(pages: number | null, max: number | null, scale = PROFILE_SCALE_PX): number | null {
  if (pages === null || max === null || max <= 0) return null
  if (pages <= 0) return 0
  return Math.max(1, Math.round((pages / max) * scale))
}

const toLine = (source: DiagramSource, max: number | null): ProfileLine => ({
  id: source.id,
  name: source.shortName,
  full: source.id,
  tone: source.tone,
  groupLabel: source.groupLabel,
  pages: source.pages,
  chunks: source.chunks,
  lastSyncAt: source.lastSyncAt,
  syncOff: source.syncOff,
  percent: source.pages === null || max === null || max <= 0 ? null : (source.pages / max) * 100,
  height: lineHeight(source.pages, max),
})

/** Longest label drawn for a source, in characters. */
export const LABEL_CHARS = 22

/** A label cut in the middle, so both the start and the end of the id stay readable. */
export function middleTruncate(text: string, max = LABEL_CHARS): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/**
 * The label of each source: its full id, cut in the middle only when it is long. Two sources never
 * share a label: any labels that come out the same are written in full (ids are unique).
 */
export function sourceLabels(ids: ReadonlyArray<string>, max = LABEL_CHARS): string[] {
  const cut = ids.map((id) => middleTruncate(id, max))
  const seen = new Map<string, number>()
  for (const label of cut) seen.set(label, (seen.get(label) ?? 0) + 1)
  return ids.map((id, i) => ((seen.get(cut[i]) ?? 0) > 1 ? id : cut[i]))
}

/** The line profile of the diagram, in diagram order. Labels are the full id, cut in the middle when long. */
export function buildProfile(diagram: Diagram): Profile {
  const read = diagram.sources.flatMap((source) => (source.pages === null ? [] : [source.pages]))
  const max = read.length ? Math.max(...read) : null
  const lines = diagram.sources.map((source) => toLine(source, max))
  const labels = sourceLabels(lines.map((line) => line.full))
  return { lines: lines.map((line, i) => ({ ...line, name: labels[i] })), max }
}

/** Approximate size of a count drawn above its line (12px tabular figures). */
const COUNT_CHAR_PX = 7
const COUNT_PAD_PX = 4
const COUNT_HEIGHT_PX = 14

/**
 * Which counts can be drawn above their lines without sitting on another count. The tallest line has
 * priority; a count that would collide is left out of the picture (it still shows on hover and focus).
 * `columnWidth` is the width of one source's column; null means unknown, so nothing is hidden.
 */
export function visibleCounts(
  lines: ReadonlyArray<Pick<ProfileLine, 'id' | 'pages' | 'height'>>,
  columnWidth: number | null,
  text: (pages: number | null) => string,
): Set<string> {
  if (columnWidth === null) return new Set(lines.map((line) => line.id))
  const boxes = lines.map((line, index) => ({
    id: line.id,
    x: (index + 0.5) * columnWidth,
    w: text(line.pages).length * COUNT_CHAR_PX + COUNT_PAD_PX,
    y: line.height ?? 0,
    pages: line.pages ?? -1,
  }))
  const kept: typeof boxes = []
  for (const box of [...boxes].sort((a, b) => b.pages - a.pages)) {
    const clash = kept.some((other) => Math.abs(other.x - box.x) < (other.w + box.w) / 2 && Math.abs(other.y - box.y) < COUNT_HEIGHT_PX)
    if (!clash) kept.push(box)
  }
  return new Set(kept.map((box) => box.id))
}
