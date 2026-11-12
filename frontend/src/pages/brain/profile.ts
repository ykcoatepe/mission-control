import type { UiState } from '../../lib/state'
import type { Diagram, DiagramSource, GroupTone } from './diagram'

/** Pixel height of the tallest line. One calibrated baseline, one linear scale. */
export const PROFILE_SCALE_PX = 200

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
  state: UiState
  /** 0 to 100, linear in pages. Null when pages were not read: no line is drawn. */
  percent: number | null
  /** Share of all pages that were read (0 to 100). Null when pages were not read. */
  share: number | null
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

const toLine = (source: DiagramSource, max: number | null, total: number): ProfileLine => ({
  id: source.id,
  name: source.shortName,
  full: source.id,
  tone: source.tone,
  groupLabel: source.groupLabel,
  pages: source.pages,
  chunks: source.chunks,
  lastSyncAt: source.lastSyncAt,
  syncOff: source.syncOff,
  state: source.state,
  percent: source.pages === null || max === null || max <= 0 ? null : (source.pages / max) * 100,
  share: source.pages === null || total <= 0 ? null : (source.pages / total) * 100,
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

/** Words that say what a source is, not which one: dropped from the end of a short name. */
const GENERIC_TAIL = new Set(['code', 'github', 'com', 'agent', 'memories', 'memory', 'manuals', 'standards', 'ops', 'line', 'main', 'dev', 'docs'])

/** Longest short label, in characters. */
export const SHORT_CHARS = 12

const tokens = (id: string) => id.split(/[-_.\s]+/).filter(Boolean)

/** The leading words of an id: enough for about six characters, then `extra` more words. */
function lead(words: string[], extra: number): string {
  let out = ''
  let more = extra
  let enough = false
  for (const word of words) {
    if (enough) {
      if (more <= 0) break
      more -= 1
    }
    out = out ? `${out}-${word}` : word
    if (out.length >= 6) enough = true
  }
  return out
}

/**
 * A short name for each id, derived the same way every time: trailing generic words ("code", "agent",
 * "memories"…) are dropped and the leading, distinguishing words are kept ("gstack-code-github-com-x" is
 * "gstack", "tk-a320-line-ops" is "tk-a320"). Two ids never share a label: a clash takes more of the
 * id's own words, then the id cut in the middle, then the id in full (ids are unique). Never longer than
 * SHORT_CHARS except for that last resort.
 */
export function shortLabels(ids: ReadonlyArray<string>, max = SHORT_CHARS): string[] {
  const words = ids.map((id) => {
    const all = tokens(id)
    const kept = [...all]
    while (kept.length > 1 && GENERIC_TAIL.has(kept[kept.length - 1].toLowerCase())) kept.pop()
    return { all, kept: kept.length ? kept : [id] }
  })
  const fit = (text: string) => middleTruncate(text, max)
  const labels = words.map((w) => fit(lead(w.kept, 0)))
  const taken = (list: string[]) => {
    const seen = new Map<string, number>()
    for (const label of list) seen.set(label, (seen.get(label) ?? 0) + 1)
    return (label: string) => (seen.get(label) ?? 0) > 1
  }
  // A clash takes more words, one at a time, from the id's own words.
  for (let extra = 1; extra <= 4; extra += 1) {
    const clash = taken(labels)
    words.forEach((w, i) => {
      if (clash(labels[i])) labels[i] = middleTruncate(lead(w.all, extra), max + 6)
    })
  }
  // Still the same: the id cut in the middle, then in full.
  const cut = labels.map((label, i) => (taken(labels)(label) ? middleTruncate(ids[i], max + 4) : label))
  const again = taken(cut)
  return cut.map((label, i) => (again(label) ? ids[i] : label))
}

/** "0, 5,000, 10,000": a few round tick values from zero up to (not beyond) `max`. */
export function axisTicks(max: number | null, count = 4): number[] {
  if (max === null || max <= 0) return []
  const rough = max / count
  const mag = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((candidate) => candidate >= rough * 0.75) ?? 10 * mag
  const ticks: number[] = []
  for (let value = 0; value <= max + 1e-9; value += step) ticks.push(Math.round(value))
  return ticks
}

/**
 * Which row (0 or 1) each label goes on so two neighbours never touch: labels that would collide with
 * the one before are put on the second row. `columnWidth` null (unknown) puts everything on row 0.
 */
export function staggerRows(labels: ReadonlyArray<string>, columnWidth: number | null, charPx = 7): number[] {
  if (columnWidth === null) return labels.map(() => 0)
  const edge = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  return labels.map((label, index) => {
    const half = (label.length * charPx) / 2
    const centre = (index + 0.5) * columnWidth
    const left = centre - half - 4
    const row = left >= edge[0] ? 0 : left >= edge[1] ? 1 : 0
    edge[row] = centre + half
    return row
  })
}

/** The line profile of the diagram, in diagram order. Labels are short names (see shortLabels); the full id is for hover and focus. */
export function buildProfile(diagram: Diagram): Profile {
  const read = diagram.sources.flatMap((source) => (source.pages === null ? [] : [source.pages]))
  const max = read.length ? Math.max(...read) : null
  const total = read.reduce((sum, pages) => sum + pages, 0)
  const lines = diagram.sources.map((source) => toLine(source, max, total))
  const labels = shortLabels(lines.map((line) => line.full))
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

/** "4.3%" below 10, "21%" from 10; "not read" when the pages were not. */
export function shareOf(line: Pick<ProfileLine, 'share'>): string {
  if (line.share === null) return 'not read'
  return `${line.share >= 10 ? Math.round(line.share) : Math.round(line.share * 10) / 10}%`
}

