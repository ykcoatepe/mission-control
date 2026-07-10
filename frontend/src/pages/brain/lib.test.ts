import { afterEach, describe, expect, it, vi } from 'vitest'
import { postGBrainAction } from '../gbrain/api'
import {
  actionNeedsConfirmation,
  findSearchResults,
  selectionFromAttention,
  selectionFromEvidence,
  selectionFromSystem,
  sortAttention,
} from './lib'

describe('brain policies', () => {
  it('sorts critical before warning and remains stable by id', () => {
    const result = sortAttention([
      { id: 'b', severity: 'warning' },
      { id: 'c', severity: 'critical' },
      { id: 'a', severity: 'warning' },
    ] as never)
    expect(result.map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('requires confirmation only for W1', () => {
    expect(actionNeedsConfirmation({ safetyClass: 'R0', requiresConfirmation: false } as never)).toBe(false)
    expect(actionNeedsConfirmation({ safetyClass: 'W1', requiresConfirmation: true } as never)).toBe(true)
    expect(actionNeedsConfirmation({ safetyClass: 'W1', requiresConfirmation: false } as never)).toBe(false)
  })

  it('searches evidence, attention, and destinations without triggering actions', () => {
    const results = findSearchResults('hermes', {
      attention: [{ id: 'a', system: 'hermes', title: 'Hermes blocker', detail: '', detailHref: '/work' }],
      evidence: [],
    } as never)
    expect(results[0]).toMatchObject({ label: 'Hermes blocker', href: '/work', system: 'hermes' })
    expect(results.every((result) => 'href' in result && !('action' in result))).toBe(true)
  })

  it('builds drawer selections from systems, attention, and evidence', () => {
    const evidence = {
      id: 'proof-1',
      system: 'gbrain',
      kind: 'health',
      status: 'warning',
      observedAt: null,
      summary: 'Embedding queue delayed',
      sourceRef: 'gbrain.overview',
      detailHref: '/gbrain',
    } as const
    const system = {
      id: 'gbrain',
      label: 'GBrain',
      state: 'warning',
      freshness: 'fresh',
      caveats: ['Embedding queue delayed'],
      evidence: [evidence],
      detailHref: '/gbrain',
    } as never
    const attention = {
      id: 'attention-1',
      system: 'gbrain',
      title: 'Review embeddings',
      detail: 'Queue needs operator attention',
      detailHref: '/gbrain',
      evidenceRefs: ['proof-1'],
    } as never

    expect(selectionFromSystem(system)).toMatchObject({ title: 'GBrain', detail: 'warning · fresh' })
    expect(selectionFromAttention(attention, [evidence])).toMatchObject({ evidence: [evidence] })
    expect(selectionFromEvidence(evidence)).toMatchObject({ caveats: ['Embedding queue delayed'] })
  })
})

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
})
