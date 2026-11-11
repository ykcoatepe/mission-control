import { queryOptions, useQuery } from '@tanstack/react-query'

/**
 * The one HTTP layer of the app.
 *
 * Error contract (server/core/http.js): every API error is
 * `{ error: { code, message } }` with a real status (400/403/404/405/409/429/
 * 500/503). A reading that is not available answers 503 with an envelope
 * `{ data: null, meta }`. Both become an `ApiError`.
 *
 * Write guard (server/core/guard.js): every non-GET request must carry
 * `X-MC-Request: 1`. The header is added here, in `fetchJson`, so no call site
 * can forget it. `sendJson`, `postJson` and `postForm` are the only way pages
 * write; `writeGuard.test.ts` fails when a raw `fetch` with a write method
 * appears anywhere else.
 */

export const WRITE_GUARD_HEADER = 'X-MC-Request'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Milliseconds from a `Retry-After` header; null when the server sent none. */
  readonly retryAfterMs: number | null
  /** The parsed JSON error body, when there was one (action results keep theirs here). */
  readonly payload: unknown

  constructor(init: { status: number; code: string; message: string; retryAfterMs?: number | null; payload?: unknown }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs ?? null
    this.payload = init.payload ?? null
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** `Retry-After` is delay-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Math.min(Number(raw), 3600) * 1000
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), 3600 * 1000) : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Reads `code` and `message` out of an error body, whichever shape the server used. */
export function readErrorBody(body: unknown): { code: string | null; message: string | null } {
  const root = record(body)
  if (!root) return { code: null, message: null }
  const error = root.error
  // The contract: { error: { code, message } }.
  const detail = record(error)
  if (detail) return { code: text(detail.code), message: text(detail.message) }
  // GBrain action results keep their own shape: { status, error: 'text' }.
  if (text(error)) return { code: text(root.status), message: text(error) }
  // A 503 envelope: { data: null, meta: { error: { code, message } } }.
  const metaError = record(record(root.meta)?.error)
  if (metaError) return { code: text(metaError.code), message: text(metaError.message) }
  return { code: null, message: null }
}

async function readBody(res: Response): Promise<unknown> {
  try {
    if (typeof res.text === 'function') {
      const raw = await res.text()
      return raw ? JSON.parse(raw) : null
    }
    return await res.json()
  } catch {
    return null
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await readBody(res)
  const { code, message } = readErrorBody(body)
  const fallbackMessage = res.status === 503 ? 'Not available right now' : `HTTP ${res.status}`
  return new ApiError({
    status: res.status,
    code: code ?? (res.status === 503 ? 'unavailable' : 'http_error'),
    message: message ?? fallbackMessage,
    retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
    payload: body,
  })
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const requestUrl =
    typeof window === 'undefined' ? url : new URL(url, window.location.origin).toString()
  const method = (init?.method ?? 'GET').toUpperCase()
  let request = init
  if (!SAFE_METHODS.has(method)) {
    const headers = new Headers(init?.headers)
    headers.set(WRITE_GUARD_HEADER, '1')
    request = { ...init, headers }
  }
  const res = await fetch(requestUrl, request)
  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  const contentType = (res.headers?.get?.('content-type') || '').toLowerCase()
  if (!contentType.includes('application/json')) {
    const preview = (await res.text()).slice(0, 90).replace(/\s+/g, ' ')
    throw new ApiError({
      status: res.status,
      code: 'invalid_response',
      message: `API returned non-JSON payload (${contentType || 'unknown'}): ${preview}`,
    })
  }
  return res.json()
}

/** JSON write. The only way a page sends POST, PUT, PATCH or DELETE with a JSON body. */
export function sendJson<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  return fetchJson<T>(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export function postJson<T = unknown>(url: string, body?: unknown): Promise<T> {
  return sendJson<T>(url, 'POST', body)
}

/** Multipart write (file upload). The browser sets the content type and boundary. */
export function postForm<T = unknown>(url: string, form: FormData): Promise<T> {
  return fetchJson<T>(url, { method: 'POST', body: form })
}

// ---- what to tell the person ----

/** "try again in 4 seconds" from a Retry-After delay. */
export function retryDelayText(retryAfterMs: number | null): string {
  if (retryAfterMs === null) return 'try again in a moment'
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  if (seconds < 90) return `try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
  const minutes = Math.ceil(seconds / 60)
  return `try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/** 429: the server is busy. Honours `Retry-After`. */
export function isBusyError(error: unknown): error is ApiError {
  return isApiError(error) && error.status === 429
}

/** 503: the reading or service is not available (an envelope with `data: null`, or an unavailable service). */
export function isUnavailableError(error: unknown): error is ApiError {
  return isApiError(error) && error.status === 503
}

/**
 * One readable sentence for any failure. 400 and 409 carry the server's own
 * message (validation, conflict); 429 says to try again later; 503 says the
 * thing is not available. Anything else falls back to the message, then to
 * `fallback`.
 */
export function describeApiError(error: unknown, fallback = 'Something went wrong'): string {
  if (isApiError(error)) {
    if (error.status === 429) return `The server is busy, ${retryDelayText(error.retryAfterMs)}.`
    if (error.status === 503) return error.message && error.message !== 'Not available right now' ? error.message : 'Not available right now.'
    return error.message || fallback
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** Toast text for a failed write: what was being done, then the reason. */
export function writeFailureMessage(action: string, error: unknown): string {
  return `${action}: ${describeApiError(error)}`
}

/** Client errors and unavailable readings will not change on a retry; anything else gets one. */
export function retryOnce(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && (error.status < 500 || error.status === 503)) return false
  return failureCount < 1
}

export function apiQueryOptions<T>(url: string, interval?: number) {
  return queryOptions<T, Error>({
    queryKey: ['api', url],
    queryFn: () => fetchJson<T>(url),
    refetchInterval: interval && interval > 0 ? interval : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: retryOnce,
  })
}

export function useApi<T>(url: string, interval?: number) {
  const query = useQuery(apiQueryOptions<T>(url, interval))
  const failure = query.error
  const error = failure ? describeApiError(failure, 'Unknown error') : null

  return {
    data: query.data ?? null,
    loading: query.isLoading,
    error,
    /** The typed failure, for pages that treat 429 (busy) or 503 (not available) differently. */
    failure: isApiError(failure) ? failure : null,
    refetch: () => query.refetch(),
  }
}
