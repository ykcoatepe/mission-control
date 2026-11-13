// The model -> chart colour memory, kept in localStorage so a model keeps its colour
// across reloads as well as across periods. Storage may be missing, full or blocked
// (private windows, site data cleared): every access is guarded and the page works without it.

import { SERIES_COLOR_COUNT, seriesColorToken } from './lib'

export const SERIES_COLOR_STORAGE_KEY = 'mc.usage.seriesColors.v1'

const VALID_TOKENS: ReadonlySet<string> = new Set(
  Array.from({ length: SERIES_COLOR_COUNT }, (_, slot) => seriesColorToken(slot)),
)

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Remembered model id -> `var(--chart-N)` pairs; anything unreadable or unknown is dropped. */
export function loadSeriesColorMemory(store: Storage | null = storage()): Map<string, string> {
  const memory = new Map<string, string>()
  if (!store) return memory
  try {
    const parsed: unknown = JSON.parse(store.getItem(SERIES_COLOR_STORAGE_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return memory
    Object.entries(parsed as Record<string, unknown>).forEach(([id, token]) => {
      if (id && typeof token === 'string' && VALID_TOKENS.has(token)) memory.set(id, token)
    })
  } catch {
    return new Map()
  }
  return memory
}

export function saveSeriesColorMemory(memory: ReadonlyMap<string, string>, store: Storage | null = storage()): void {
  if (!store) return
  try {
    store.setItem(SERIES_COLOR_STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)))
  } catch {
    // Not remembered: the colours still hold for this visit.
  }
}
