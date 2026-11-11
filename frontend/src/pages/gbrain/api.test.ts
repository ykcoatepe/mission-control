import { afterEach, describe, expect, it, vi } from 'vitest'
import { postGBrainAction } from './api'

describe('postGBrainAction', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts only the requested action and returns the result body', async () => {
    const payload = {
      ok: true,
      action: 'doctor-fast',
      status: 'complete',
      checkedAt: '2026-07-10T12:00:00.000Z',
      refreshAfter: true,
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })
    vi.stubGlobal('fetch', fetchMock)

    await expect(postGBrainAction('doctor-fast')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/api/gbrain/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'doctor-fast' }),
    })
  })

  it('retains useful non-2xx JSON payload on the thrown error', async () => {
    const payload = {
      ok: false,
      action: 'sync-sources',
      status: 'busy',
      error: 'Another GBrain action is already running',
      checkedAt: '2026-07-10T12:00:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => payload }))

    const error = await postGBrainAction('sync-sources').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ message: payload.error, payload })
  })

  it('sends explicit confirmation for confirmed actions', async () => {
    const payload = {
      ok: true,
      action: 'sync-sources',
      status: 'completed',
      checkedAt: '2026-07-10T12:00:00.000Z',
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload })
    vi.stubGlobal('fetch', fetchMock)

    await expect(postGBrainAction('sync-sources', true)).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith('/api/gbrain/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync-sources', confirmed: true }),
    })
  })
})
