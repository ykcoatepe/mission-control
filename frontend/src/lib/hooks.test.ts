import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  describeApiError,
  fetchJson,
  isBusyError,
  isUnavailableError,
  parseRetryAfter,
  postForm,
  postJson,
  retryOnce,
  sendJson,
  writeFailureMessage,
} from './hooks'

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    ...init,
  })
}

function stubFetch(response: Response) {
  const mock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', mock)
  return mock
}

function sentHeaders(mock: ReturnType<typeof vi.fn>) {
  return new Headers((mock.mock.calls[0][1] as RequestInit).headers)
}

afterEach(() => vi.unstubAllGlobals())

describe('error contract', () => {
  it('surfaces status, code and message from { error: { code, message } }', async () => {
    stubFetch(json({ error: { code: 'invalid_budget', message: 'monthly budget must be a finite number' } }, { status: 400 }))
    const error = await fetchJson('/api/settings/budget').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_budget', message: 'monthly budget must be a finite number' })
  })

  it('falls back to the status when the body is not JSON', async () => {
    stubFetch(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const error = await fetchJson('/api/x').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 502, code: 'http_error', message: 'HTTP 502' })
  })

  it('reads a 503 envelope with data: null as not available, taking the meta error', async () => {
    stubFetch(json({ data: null, meta: { ok: false, error: { code: 'gbrain_graph_pending', message: 'Graph is warming up' } } }, { status: 503 }))
    const error = await fetchJson('/api/gbrain/synoptic').catch((reason: unknown) => reason)
    expect(isUnavailableError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'gbrain_graph_pending', message: 'Graph is warming up' })
  })

  it('a 503 without any message still says it is not available', async () => {
    stubFetch(json({ data: null, meta: { ok: false, error: null } }, { status: 503 }))
    const error = await fetchJson('/api/gbrain/synoptic').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 503, code: 'unavailable' })
    expect(describeApiError(error)).toBe('Not available right now.')
  })

  it('keeps the legacy action-result shape ({ status, error: text }) readable', async () => {
    stubFetch(json({ ok: false, status: 'busy', error: 'Another GBrain action is already running.' }, { status: 409 }))
    const error = await fetchJson('/api/gbrain/actions').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 409, code: 'busy', message: 'Another GBrain action is already running.' })
    expect((error as ApiError).payload).toMatchObject({ status: 'busy' })
  })

  it('429 carries Retry-After and reads as busy', async () => {
    stubFetch(json({ error: { code: 'lane_busy', message: 'busy' } }, { status: 429, headers: { 'retry-after': '7' } }))
    const error = await fetchJson('/api/gbrain/search?q=x').catch((reason: unknown) => reason)
    expect(isBusyError(error)).toBe(true)
    expect((error as ApiError).retryAfterMs).toBe(7000)
    expect(describeApiError(error)).toBe('The server is busy, try again in 7 seconds.')
  })

  it('has no old Turkish or pattern-hack text', async () => {
    stubFetch(json({ error: { code: 'bad_request', message: 'The string did not match the expected pattern.' } }, { status: 400 }))
    const error = await fetchJson('/api/x').catch((reason: unknown) => reason)
    expect(describeApiError(error)).toBe('The string did not match the expected pattern.')
  })

  it('does not retry client errors or an unavailable reading, but retries a server fault once', () => {
    expect(retryOnce(0, new ApiError({ status: 400, code: 'x', message: 'x' }))).toBe(false)
    expect(retryOnce(0, new ApiError({ status: 429, code: 'x', message: 'x' }))).toBe(false)
    expect(retryOnce(0, new ApiError({ status: 503, code: 'x', message: 'x' }))).toBe(false)
    expect(retryOnce(0, new ApiError({ status: 500, code: 'x', message: 'x' }))).toBe(true)
    expect(retryOnce(1, new ApiError({ status: 500, code: 'x', message: 'x' }))).toBe(false)
    expect(retryOnce(0, new TypeError('network'))).toBe(true)
  })

  it('writeFailureMessage names the action and the server reason', () => {
    const error = new ApiError({ status: 409, code: 'calendar_override_unavailable', message: 'Sync cron before clearing a legacy override' })
    expect(writeFailureMessage('Schedule save failed', error)).toBe('Schedule save failed: Sync cron before clearing a legacy override')
  })
})

describe('Retry-After', () => {
  it('parses seconds and dates, and ignores junk', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
    const now = Date.parse('2026-11-11T10:00:00Z')
    expect(parseRetryAfter('Wed, 11 Nov 2026 10:00:09 GMT', now)).toBe(9000)
  })
})

describe('write guard header', () => {
  it('adds X-MC-Request: 1 to every write method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const mock = stubFetch(json({ ok: true }))
      await sendJson('/api/x', method, { a: 1 })
      expect(sentHeaders(mock).get('x-mc-request')).toBe('1')
      expect((mock.mock.calls[0][1] as RequestInit).method).toBe(method)
    }
  })

  it('adds it for a direct fetchJson write too, and keeps caller headers', async () => {
    const mock = stubFetch(json({ ok: true }))
    await fetchJson('/api/x', { method: 'post', headers: { 'X-Other': 'y' } })
    expect(sentHeaders(mock).get('x-mc-request')).toBe('1')
    expect(sentHeaders(mock).get('x-other')).toBe('y')
  })

  it('does not add it to reads', async () => {
    const mock = stubFetch(json({ ok: true }))
    await fetchJson('/api/x')
    expect((mock.mock.calls[0][1] as RequestInit | undefined)?.headers).toBeUndefined()
  })

  it('postJson sends a JSON body; postForm leaves the content type to the browser', async () => {
    const mock = stubFetch(json({ ok: true }))
    await postJson('/api/x', { monthly: null })
    expect(sentHeaders(mock).get('content-type')).toBe('application/json')
    expect((mock.mock.calls[0][1] as RequestInit).body).toBe('{"monthly":null}')

    const form = new FormData()
    form.append('config', new Blob(['{}']), 'mc.json')
    const formMock = stubFetch(json({ ok: true }))
    await postForm('/api/settings/import', form)
    expect(sentHeaders(formMock).get('x-mc-request')).toBe('1')
    expect(sentHeaders(formMock).get('content-type')).toBeNull()
  })

  it('a write with no body sends no content type', async () => {
    const mock = stubFetch(json({ ok: true }))
    await postJson('/api/calendar/sync-cron')
    expect(sentHeaders(mock).get('content-type')).toBeNull()
    expect((mock.mock.calls[0][1] as RequestInit).body).toBeUndefined()
  })
})
