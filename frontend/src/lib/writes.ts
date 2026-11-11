import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { onWriteSucceeded } from './hooks'
import { SIGNALS_URL } from './signals'

/**
 * Read-your-writes on the page.
 *
 * A write answers with the committed entity and a `meta`. `meta.stale: true`
 * means the write succeeded but the server could not refresh its own reading
 * afterwards, so a list read right now may still be a moment behind. The page
 * shows the entity it was given (nothing flashes back), refetches, and says so
 * calmly when the reading is behind.
 */

export const STALE_WRITE_NOTE = 'Saved. The list may take a moment to catch up.'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** True when a write response says the post-write refresh did not complete. */
export function isStaleWrite(response: unknown): boolean {
  return record(record(response)?.meta)?.stale === true
}

export function apiQueryKey(url: string) {
  return ['api', url] as const
}

/**
 * Puts what the server just committed into a cached reading, so the screen
 * shows it at once, then marks the reading for a fresh fetch. A fetch that was
 * already in flight is cancelled first: it started before the write and must
 * not overwrite the entity with the older state.
 */
export async function applyCommitted<T>(
  client: QueryClient,
  url: string,
  update: (current: T) => T,
): Promise<void> {
  const key = apiQueryKey(url)
  await client.cancelQueries({ queryKey: key })
  client.setQueryData<T>(key, (current) => (current === undefined ? current : update(current)))
  void client.invalidateQueries({ queryKey: key })
}

/**
 * Everything the shell shows that a write can change: the top bar's systems and attention count, and the
 * sidebar badges, all read `/api/signals`. Refetches it once. A failing refetch is swallowed here: the write
 * it follows already succeeded.
 */
export function afterWrite(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: apiQueryKey(SIGNALS_URL) }).catch(() => undefined)
}

/** Mount once, inside the query provider: every accepted write refreshes the shell's signals at once. */
export function useAfterWriteRefresh(): void {
  const client = useQueryClient()
  useEffect(() => onWriteSucceeded(() => afterWrite(client)), [client])
}
