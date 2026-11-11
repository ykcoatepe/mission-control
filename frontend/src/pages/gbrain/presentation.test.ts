import { describe, expect, it } from 'vitest'
import { deriveQueueEvidenceStatus, timelineDeltaLines } from './presentation'

describe('GBrain presentation model', () => {
  it('describes only material changes between timeline snapshots', () => {
    const previous = {
      trust: { status: 'healthy' as const, score: 100 },
      metrics: { health: '100/100', embeddings: '100%', queue: '0 / 0 / 0', caveats: '0' },
      sourceFreshness: { status: 'healthy' as const },
    }
    const current = {
      trust: { status: 'warning' as const, score: 100 },
      metrics: { health: '100/100', embeddings: '100%', queue: '0 / 0 / 0', caveats: '1' },
      sourceFreshness: { status: 'healthy' as const },
    }

    expect(timelineDeltaLines(current, previous)).toEqual([
      'State Normal → Warning',
      'Notes 0 → 1',
    ])
    expect(timelineDeltaLines(current, current)).toEqual([])
  })

  it('names link extraction and source sync changes without conflating them', () => {
    const previous = {
      trust: { status: 'healthy' as const, score: 100 },
      metrics: { embeddingsDetail: '0 missing', missingEmbeddings: 0, stalePages: 0, caveats: '0' },
      sourceFreshness: { status: 'healthy' as const },
    }
    const current = {
      trust: { status: 'warning' as const, score: 100 },
      metrics: { embeddingsDetail: '3 missing', missingEmbeddings: 3, stalePages: 1, caveats: '1' },
      sourceFreshness: { status: 'warning' as const },
    }

    expect(timelineDeltaLines(current, previous)).toEqual([
      'State Normal → Warning',
      'Missing embeddings 0 → 3',
      'Link extraction Current → 1 stale page',
      'Source sync Fresh → Stale',
      'Notes 0 → 1',
    ])
  })

  it('shows catching-up pages as a link extraction change without calling them stale', () => {
    const base = {
      trust: { status: 'healthy' as const, score: 100 },
      sourceFreshness: { status: 'healthy' as const },
    }
    const clean = { ...base, metrics: { missingEmbeddings: 0, stalePages: 0, stalePagesOverdue: 0, caveats: '0' } }
    const catchingUp = { ...base, metrics: { missingEmbeddings: 0, stalePages: 3, stalePagesOverdue: 0, caveats: '0' } }
    const overdue = { ...base, metrics: { missingEmbeddings: 0, stalePages: 3, stalePagesOverdue: 3, caveats: '0' } }

    expect(timelineDeltaLines(catchingUp, clean)).toEqual(['Link extraction Current → Current · 3 catching up'])
    expect(timelineDeltaLines(overdue, catchingUp)).toEqual(['Link extraction Current · 3 catching up → 3 stale pages'])
  })

  it('labels missing embeddings as raw count, catching up inside tolerance and with the oldest age when overdue', () => {
    const base = {
      trust: { status: 'healthy' as const, score: 100 },
      sourceFreshness: { status: 'healthy' as const },
    }
    const clean = { ...base, metrics: { missingEmbeddings: 0, missingEmbeddingsOverdue: 0, stalePages: 0, stalePagesOverdue: 0, caveats: '0' } }
    const catchingUp = { ...base, metrics: { missingEmbeddings: 3, missingEmbeddingsOverdue: 0, missingEmbeddingsOldestAgeSeconds: 240, stalePages: 0, stalePagesOverdue: 0, caveats: '0' } }
    const overdue = { ...base, metrics: { missingEmbeddings: 3, missingEmbeddingsOverdue: 3, missingEmbeddingsOldestAgeSeconds: 1500, stalePages: 0, stalePagesOverdue: 0, caveats: '0' } }
    const overdueNoAge = { ...base, metrics: { missingEmbeddings: 3, missingEmbeddingsOverdue: 3, stalePages: 0, stalePagesOverdue: 0, caveats: '0' } }
    // Older snapshots without missingEmbeddingsOverdue count every missing embedding.
    const legacy = { ...base, metrics: { missingEmbeddings: 3, stalePages: 0, caveats: '0' } }

    expect(timelineDeltaLines(catchingUp, clean)).toEqual(['Missing embeddings 0 → 3 catching up (oldest 4m)'])
    expect(timelineDeltaLines(overdue, catchingUp)).toEqual(['Missing embeddings 3 catching up (oldest 4m) → 3 (oldest 25m)'])
    expect(timelineDeltaLines(overdueNoAge, clean)).toEqual(['Missing embeddings 0 → 3'])
    expect(timelineDeltaLines(legacy, catchingUp)).toEqual(['Missing embeddings 3 catching up (oldest 4m) → 3'])
  })

  it('leaves the oldest age out of a history line when asked, so an age tick is not a change', () => {
    const base = { trust: { status: 'warning' as const, score: 99 }, sourceFreshness: { status: 'healthy' as const } }
    const at12 = { ...base, metrics: { missingEmbeddings: 4, missingEmbeddingsOverdue: 4, missingEmbeddingsOldestAgeSeconds: 720, caveats: '3' } }
    const at15 = { ...base, metrics: { missingEmbeddings: 4, missingEmbeddingsOverdue: 4, missingEmbeddingsOldestAgeSeconds: 900, caveats: '3' } }
    expect(timelineDeltaLines(at15, at12)).toEqual(['Missing embeddings 4 (oldest 12m) → 4 (oldest 15m)'])
    expect(timelineDeltaLines(at15, at12, { withAge: false })).toEqual([])
  })

  it('judges the embedding queue on the overdue verdict and fails closed when the count is unavailable', () => {
    const live = { fallbackStatus: 'warning' as const, hasLiveHealth: true, countersAvailable: true, stalledJobs: 0 }
    expect(deriveQueueEvidenceStatus({ ...live, missingEmbeddings: 3, missingEmbeddingsOverdue: 0 })).toBe('healthy')
    expect(deriveQueueEvidenceStatus({ ...live, missingEmbeddings: 3, missingEmbeddingsOverdue: 3 })).toBe('warning')
    expect(deriveQueueEvidenceStatus({ ...live, missingEmbeddings: 3 })).toBe('warning')
    expect(deriveQueueEvidenceStatus({ ...live, missingEmbeddings: null, missingEmbeddingsOverdue: null, missingEmbeddingsUnavailable: true })).toBe('warning')
    expect(deriveQueueEvidenceStatus({ ...live, missingEmbeddings: 0, missingEmbeddingsOverdue: 0, missingEmbeddingsUnavailable: true })).toBe('warning')
  })

  it('keeps stale compiled pages separate from a clean embedding queue', () => {
    expect(deriveQueueEvidenceStatus({
      fallbackStatus: 'warning',
      hasLiveHealth: true,
      countersAvailable: true,
      missingEmbeddings: 0,
      stalledJobs: 0,
    })).toBe('healthy')

    expect(deriveQueueEvidenceStatus({
      fallbackStatus: 'healthy',
      hasLiveHealth: true,
      countersAvailable: true,
      missingEmbeddings: 3,
      stalledJobs: 0,
    })).toBe('warning')
  })
})
