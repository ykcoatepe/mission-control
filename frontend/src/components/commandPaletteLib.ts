export interface PaletteEntry {
  id: string
  label: string
  /** Secondary text, also searched. */
  subtitle?: string
}

function score(query: string, entry: PaletteEntry): number {
  const label = entry.label.toLowerCase()
  const subtitle = (entry.subtitle ?? '').toLowerCase()
  if (label === query) return 100
  if (label.startsWith(query)) return 80
  if (label.split(/[\s\-_/:.]+/).some((word) => word.startsWith(query))) return 60
  if (label.includes(query)) return 40
  if (subtitle.includes(query)) return 20
  return 0
}

/**
 * Case-insensitive substring ranking. Better matches first, original order kept
 * among equals. An empty query returns the first `cap` entries unranked.
 */
export function rankEntries<T extends PaletteEntry>(query: string, entries: readonly T[], cap: number): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries.slice(0, cap)
  return entries
    .map((entry, index) => ({ entry, index, value: score(q, entry) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, cap)
    .map((item) => item.entry)
}
