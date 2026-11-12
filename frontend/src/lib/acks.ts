import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'
import { describeApiError, sendJson } from './hooks'
import { SIGNALS_URL } from './signals'
import { apiQueryKey } from './writes'

/**
 * Acknowledge and shelve (the badge rule). The server holds the state; the page only asks.
 *
 *   POST   /api/attention/acks        { key, kind: 'ack' | 'shelve', until? } -> 200 { ok, key, ack }
 *   DELETE /api/attention/acks/:key                                          -> 200 { ok, key, ack: null }
 *
 * Nothing is applied before the server answers. After a 200 the signals (the rail badge, the top bar) and
 * the loops reading are fetched again and the row moves because the server now says so. After an error
 * nothing changes on the page except the message, shown next to the control with the server's own words.
 */

export const ACKS_URL = '/api/attention/acks'
const LOOPS_URL = '/api/loops'

export type ShelveChoice = '7d' | '30d' | 'forever'

export const SHELVE_OPTIONS: ReadonlyArray<{
  value: ShelveChoice
  label: string
}> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'forever', label: 'Until I undo' },
]

const DAY_MS = 86_400_000

/** The `until` a shelve choice sends: an ISO time, or null for "until I undo". */
export function shelveUntil(choice: ShelveChoice, now: number = Date.now()): string | null {
  if (choice === 'forever') return null
  return new Date(now + (choice === '7d' ? 7 : 30) * DAY_MS).toISOString()
}

export interface AckResult {
  ok?: boolean
  key?: string
  ack?: { kind: 'ack' | 'shelve'; at: string; until: string | null } | null
}

/** The request body of an acknowledge: no `until` (only a shelve takes one). */
export function acknowledgeRequest(key: string) {
  return sendJson<AckResult>(ACKS_URL, 'POST', { key, kind: 'ack' })
}

export function shelveRequest(key: string, choice: ShelveChoice, now: number = Date.now()) {
  return sendJson<AckResult>(ACKS_URL, 'POST', {
    key,
    kind: 'shelve',
    until: shelveUntil(choice, now),
  })
}

/** Keys contain ":", so the key is encoded in the path. */
export function undoRequest(key: string) {
  return sendJson<AckResult>(`${ACKS_URL}/${encodeURIComponent(key)}`, 'DELETE')
}

/**
 * Reads again what an acknowledgement changes: the shell signals and every loops reading (the list and the
 * project drawer). A failing refetch is not the write's failure; the row then moves on the next poll.
 */
export async function refetchAfterAck(client: QueryClient): Promise<void> {
  await Promise.allSettled([
    client.invalidateQueries({ queryKey: apiQueryKey(SIGNALS_URL) }),
    client.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === 'api' && typeof query.queryKey[1] === 'string' && query.queryKey[1].startsWith(LOOPS_URL),
    }),
  ])
}

export interface AckActions {
  /** Keys with a request in flight. */
  busy: ReadonlySet<string>
  /** The server's message for the last failed request on a key. Cleared when the key is tried again or succeeds. */
  errors: Readonly<Record<string, string>>
  acknowledge: (key: string) => Promise<boolean>
  shelve: (key: string, choice: ShelveChoice) => Promise<boolean>
  undo: (key: string) => Promise<boolean>
  /** Acknowledge several keys, one request after the other. */
  acknowledgeAll: (keys: ReadonlyArray<string>) => Promise<AcknowledgeAllResult>
  /** A bulk acknowledge is running. */
  bulkBusy: boolean
  /** The outcome of the last bulk acknowledge that stopped on an error; cleared when the next one starts. */
  bulkError: BulkAckError | null
}

export interface AcknowledgeAllResult {
  /** Keys the server accepted. */
  done: number
  /** The key that failed and the server's words; the rest were not tried. Null when every key was accepted. */
  failed: { key: string; message: string } | null
}

export interface BulkAckError {
  done: number
  total: number
  key: string
  message: string
}

/**
 * The page's acknowledge / shelve / undo, one request per key at a time. Each call resolves true when the
 * server accepted it and the readings were asked again, false when it failed (the message is in `errors`).
 */
export function useAckActions(): AckActions {
  const client = useQueryClient()
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const inFlight = useRef(new Set<string>())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<BulkAckError | null>(null)
  const bulkRunning = useRef(false)

  const run = useCallback(
    async (key: string, request: () => Promise<unknown>): Promise<boolean> => {
      if (inFlight.current.has(key)) return false
      inFlight.current.add(key)
      setBusy(new Set(inFlight.current))
      setErrors((current) => {
        if (!(key in current)) return current
        const rest = { ...current }
        delete rest[key]
        return rest
      })
      try {
        await request()
      } catch (error) {
        setErrors((current) => ({
          ...current,
          [key]: describeApiError(error, 'The change was not saved'),
        }))
        inFlight.current.delete(key)
        setBusy(new Set(inFlight.current))
        return false
      }
      // Keep the control busy until the row has moved, so it never flashes back to its old place.
      await refetchAfterAck(client)
      inFlight.current.delete(key)
      setBusy(new Set(inFlight.current))
      return true
    },
    [client],
  )

  const acknowledgeAll = useCallback(
    async (keys: ReadonlyArray<string>): Promise<AcknowledgeAllResult> => {
      if (bulkRunning.current) return { done: 0, failed: null }
      bulkRunning.current = true
      setBulkBusy(true)
      setBulkError(null)
      let done = 0
      let failed: AcknowledgeAllResult['failed'] = null
      // One request after the other, so the server's own order and limits apply; the first error stops it.
      for (const key of keys) {
        try {
          await acknowledgeRequest(key)
          done += 1
        } catch (error) {
          failed = { key, message: describeApiError(error, 'The change was not saved') }
          break
        }
      }
      if (failed) setBulkError({ done, total: keys.length, key: failed.key, message: failed.message })
      // What was accepted is real even when the run stopped: read the signals and the list again either way.
      if (done > 0) await refetchAfterAck(client)
      bulkRunning.current = false
      setBulkBusy(false)
      return { done, failed }
    },
    [client],
  )

  return {
    busy,
    errors,
    acknowledgeAll,
    bulkBusy,
    bulkError,
    acknowledge: useCallback((key) => run(key, () => acknowledgeRequest(key)), [run]),
    shelve: useCallback((key, choice) => run(key, () => shelveRequest(key, choice)), [run]),
    undo: useCallback((key) => run(key, () => undoRequest(key)), [run]),
  }
}
