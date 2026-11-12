import type { Diagram, DiagramSource, GroupTone } from './diagram'

/** Pixel height of the tallest line. One calibrated baseline, one linear scale. */
export const PROFILE_SCALE_PX = 96

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

/** The line profile of the diagram, in diagram order. Short names that collide fall back to the full id. */
export function buildProfile(diagram: Diagram): Profile {
  const read = diagram.sources.flatMap((source) => (source.pages === null ? [] : [source.pages]))
  const max = read.length ? Math.max(...read) : null
  const lines = diagram.sources.map((source) => toLine(source, max))
  const seen = new Map<string, number>()
  for (const line of lines) seen.set(line.name, (seen.get(line.name) ?? 0) + 1)
  return { lines: lines.map((line) => ((seen.get(line.name) ?? 0) > 1 ? { ...line, name: line.full } : line)), max }
}
