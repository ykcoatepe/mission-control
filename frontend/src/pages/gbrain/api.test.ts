import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../lib/hooks'
import { resolvePendingActionResult } from '../brain/BrainHomeState'
import { postGBrainAction } from './api'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function lastRequest(mock: ReturnType<typeof vi.fn>) {
  const [url, init] = mock.mock.calls[0] as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers) }
}

describe('postGBrainAction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts only the requested action, with the write header, and returns the result body', async () => {
    const payload = {
      ok: true,
      action: 'doctor-fast',
      status: 'complete',
      checkedAt: '2026-07-10T12:00:00.000Z',
      refreshAfter: true,
    }
    const fetchMock = vi.fn().mockResolvedValue(json(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(postGBrainAction('doctor-fast')).resolves.toEqual(payload)
    const { url, init, headers } = lastRequest(fetchMock)
    expect(url).toBe('/api/gbrain/actions')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ action: 'doctor-fast' }))
    expect(headers.get('x-mc-request')).toBe('1')
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('reads the unified error shape and keeps the action result, with error as text', async () => {
    const payload = {
      ok: false,
      action: 'sync-sources',
      status: 'busy',
      error: { code: 'gbrain_action_busy', message: 'Another GBrain action is already running' },
      checkedAt: '2026-07-10T12:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload, 409)))

    const error = await postGBrainAction('sync-sources').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'gbrain_action_busy',
      message: 'Another GBrain action is already running',
      payload: { ...payload, error: 'Another GBrain action is already running' },
    })
  })

  it('still reads a legacy string error', async () => {
    const payload = { ok: false, status: 'busy', error: 'Another GBrain action is already running', checkedAt: '2026-07-10T12:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload, 409)))
    const error = await postGBrainAction('sync-sources').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 409, message: payload.error, payload })
  })

  it('reads the central error contract when the lane is quarantined (503)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ error: { code: 'gbrain_action_quarantined', message: 'Action lane is quarantined' } }, 503)),
    )
    const error = await postGBrainAction('doctor-fast').catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 503, code: 'gbrain_action_quarantined', message: 'Action lane is quarantined' })
    expect(resolvePendingActionResult(error)).toBeNull()
  })

  it('a timed-out action that is still cleaning up stays recognisable as pending', async () => {
    const payload = {
      ok: false,
      status: 'timed-out',
      pending: true,
      refreshAfter: true,
      summary: 'cleanup running',
      error: { code: 'gbrain_action_timed_out', message: 'GBrain action timed out.' },
      checkedAt: '2026-07-10T12:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(payload, 504)))
    const error = await postGBrainAction('sync-sources', true).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ status: 504, code: 'gbrain_action_timed_out' })
    expect(resolvePendingActionResult(error)).toMatchObject({
      pending: true,
      refreshAfter: true,
      summary: 'cleanup running',
      error: 'GBrain action timed out.',
    })
  })

  it('sends explicit confirmation for confirmed actions', async () => {
    const payload = {
      ok: true,
      action: 'sync-sources',
      status: 'completed',
      checkedAt: '2026-07-10T12:00:00.000Z',
    }
    const fetchMock = vi.fn().mockResolvedValue(json(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(postGBrainAction('sync-sources', true)).resolves.toEqual(payload)
    expect(lastRequest(fetchMock).init.body).toBe(JSON.stringify({ action: 'sync-sources', confirmed: true }))
  })
})
