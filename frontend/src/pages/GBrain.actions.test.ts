// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  postGBrainAction: vi.fn(),
  refetchOverview: vi.fn(),
  refetchTimeline: vi.fn(),
  overviewOverride: null as Record<string, unknown> | null,
  timelineOverride: null as Record<string, unknown> | null,
}))

vi.mock('../lib/hooks', () => ({
  formatDate: (value: string) => value,
  timeAgo: () => 'now',
  useApi: (url: string) => {
    if (url === '/api/gbrain/actions') {
      return {
        data: {
          ok: true,
          actions: [
            {
              id: 'doctor-fast',
              label: 'Run fast doctor',
              description: 'Read-only diagnostic',
              kind: 'diagnostic',
              command: 'gbrain doctor --json --fast',
              refreshAfter: false,
              timeoutMs: 30_000,
              safetyClass: 'R0',
              requiresConfirmation: false,
            },
            {
              id: 'sync-sources',
              label: 'Sync local sources',
              description: 'Incrementally refresh registered sources',
              kind: 'maintenance',
              command: 'gbrain sync --all',
              refreshAfter: true,
              timeoutMs: 120_000,
              safetyClass: 'W1',
              requiresConfirmation: true,
            },
            {
              id: 'danger',
              label: 'Delete storage',
              description: 'Must not be available',
              kind: 'repair',
              command: 'danger',
              refreshAfter: false,
              safetyClass: 'W2',
              requiresConfirmation: true,
            },
          ],
        },
        loading: false,
        error: null,
        refetch: mocks.refetchOverview,
      }
    }
    if (url.startsWith('/api/gbrain/timeline')) {
      return {
        data: mocks.timelineOverride || { enabled: true, entries: [], retainedEntryCount: 0, malformedLineCount: 0 },
        loading: false,
        error: null,
        refetch: mocks.refetchTimeline,
      }
    }
    return {
      data: mocks.overviewOverride || {
        ok: true,
        mode: 'live-read-only',
        refreshedAt: '2026-07-11T09:00:00Z',
        title: 'GBrain',
        subtitle: 'Shared memory',
        trust: {
          label: 'Live with caveats',
          status: 'warning',
          score: 100,
          lastVerifiedAt: '2026-07-11T09:00:00Z',
          source: 'gbrain.overview',
        },
        cockpit: {},
        nodes: [],
        edges: [],
        warnings: ['Embedding queue is pending'],
        caveats: ['Current proof has a caveat'],
        handoff: { source: 'overview', recommendedNextSlice: 'Review proof' },
        live: {
          health: {
            ok: true,
            checkedAt: '2026-07-11T09:00:00Z',
            status: 'stale',
            score: 100,
            metrics: {
              pages: 12,
              chunks: 24,
              embedded: 24,
              missingEmbeddings: 0,
              stalePages: 1,
              embeddingCoverage: 1,
              queue: { waiting: 0, active: 0, stalled: 0 },
            },
          },
          sources: {
            ok: true,
            checkedAt: '2026-07-11T09:00:00Z',
            freshness: { status: 'healthy', staleCount: 0, freshCount: 1, unknownCount: 0, untrackedCount: 0, oldestSourceId: null, oldestAgeHours: null, defaultThresholdHours: 72 },
            sources: [],
          },
        },
      },
      loading: false,
      error: null,
      refetch: mocks.refetchOverview,
    }
  },
}))

vi.mock('./gbrain/api', () => ({
  postGBrainAction: mocks.postGBrainAction,
}))

import GBrain from './GBrain'
import styles from './GBrain.module.css'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function buttonByText(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined
}

function healthyOverview() {
  return {
    ok: true,
    mode: 'live-read-only',
    refreshedAt: '2026-07-11T09:00:00Z',
    title: 'GBrain',
    subtitle: 'Shared memory',
    trust: {
      label: 'Live trusted',
      status: 'healthy',
      score: 100,
      lastVerifiedAt: '2026-07-11T09:00:00Z',
      source: 'gbrain call get_health',
    },
    cockpit: {},
    nodes: [],
    edges: [],
    warnings: [],
    caveats: [],
    handoff: { source: 'overview', recommendedNextSlice: 'Review proof' },
    live: {
      health: {
        ok: true,
        checkedAt: '2026-07-11T09:00:00Z',
        status: 'healthy',
        score: 100,
        metrics: {
          pages: 12,
          chunks: 24,
          embedded: 24,
          missingEmbeddings: 0,
          stalePages: 0,
          embeddingCoverage: 1,
          queue: { waiting: 0, active: 0, stalled: 0 },
        },
      },
      sources: {
        ok: true,
        checkedAt: '2026-07-11T09:00:00Z',
        freshness: { status: 'healthy', staleCount: 0, freshCount: 1, unknownCount: 0, untrackedCount: 0, oldestSourceId: null, oldestAgeHours: null, defaultThresholdHours: 72 },
        sources: [],
      },
    },
  }
}

afterEach(() => {
  mocks.postGBrainAction.mockReset()
  mocks.refetchOverview.mockReset()
  mocks.refetchTimeline.mockReset()
  mocks.overviewOverride = null
  mocks.timelineOverride = null
  window.localStorage?.clear()
  document.body.innerHTML = ''
})

describe('GBrain Explore action controls', () => {
  it('runs R0 directly, gates W1 behind scoped confirmation, cancels safely, and omits W2', async () => {
    mocks.postGBrainAction.mockResolvedValue({
      ok: true,
      action: 'doctor-fast',
      label: 'Run fast doctor',
      status: 'complete',
      summary: 'Complete',
      checkedAt: '2026-07-11T09:00:01Z',
      refreshAfter: false,
    })
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Degraded')
    expect(host.textContent).toContain('Brain quality100/100')
    expect(host.textContent).toContain('Compiled truth1 page behind')
    expect(host.textContent).toContain('Source syncFresh')
    expect(host.textContent).toContain('Probe checkednow')
    expect(host.textContent).not.toContain('Trust score')
    expect(host.textContent).not.toContain('Last verified')
    expect(host.textContent).not.toContain('100% operational')
    expect(host.textContent).toContain('R0 diagnostics')
    expect(host.textContent).toContain('W1 maintenance')
    expect(host.textContent.indexOf('R0 diagnostics')).toBeLessThan(host.textContent.indexOf('W1 maintenance'))
    expect(host.textContent).not.toContain('Delete storage')
    const r0 = buttonByText(host, 'Run fast doctor')
    expect(r0).toBeTruthy()
    await act(async () => {
      r0?.click()
      r0?.click()
    })
    expect(mocks.postGBrainAction).toHaveBeenCalledOnce()
    expect(mocks.postGBrainAction).toHaveBeenCalledWith('doctor-fast', false)

    mocks.postGBrainAction.mockClear()
    const w1 = buttonByText(host, 'Sync local sources')
    w1?.focus()
    await act(async () => w1?.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('W1 · GBrain')
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('warning · fresh')
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('2 minutes')

    await act(async () => buttonByText(host, 'Cancel')?.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(w1)

    await act(async () => w1?.click())
    mocks.postGBrainAction.mockResolvedValue({
      ok: true,
      action: 'sync-sources',
      label: 'Sync local sources',
      status: 'complete',
      summary: 'Complete',
      checkedAt: '2026-07-11T09:00:02Z',
      refreshAfter: false,
    })
    await act(async () => buttonByText(host, 'Run Sync local sources')?.click())
    expect(mocks.postGBrainAction).toHaveBeenCalledOnce()
    expect(mocks.postGBrainAction).toHaveBeenCalledWith('sync-sources', true)

    await act(async () => root.unmount())
  })

  it('refreshes overview and timeline when a pending action payload is rejected', async () => {
    mocks.refetchOverview.mockResolvedValue(undefined)
    mocks.refetchTimeline.mockResolvedValue(undefined)
    mocks.postGBrainAction.mockRejectedValue({
      payload: {
        ok: false,
        action: 'sync-sources',
        label: 'Sync local sources',
        status: 'timed-out',
        pending: true,
        refreshAfter: true,
        summary: 'Cleanup is still running',
        checkedAt: '2026-07-11T09:00:03Z',
      },
    })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    const w1 = buttonByText(host, 'Sync local sources')
    await act(async () => w1?.click())
    await act(async () => buttonByText(host, 'Run Sync local sources')?.click())

    expect(mocks.postGBrainAction).toHaveBeenCalledWith('sync-sources', true)
    expect(host.textContent).toContain('Cleanup is still running')
    expect(mocks.refetchOverview).toHaveBeenCalledOnce()
    expect(mocks.refetchTimeline).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
  })

  it('keeps failed live probes unavailable instead of crashing or presenting fallback scores as live proof', async () => {
    const overview = healthyOverview()
    mocks.overviewOverride = {
      ...overview,
      trust: { ...overview.trust, label: 'Health probe unavailable', status: 'warning', score: 90 },
      warnings: ['Live health probe unavailable'],
      live: {
        health: {
          ok: false,
          checkedAt: '2026-07-11T09:00:00Z',
          status: 'unavailable',
          error: 'gbrain health did not return JSON',
        },
        sources: {
          ok: false,
          checkedAt: '2026-07-11T09:00:00Z',
          status: 'unavailable',
          error: 'gbrain sources list did not return parseable output',
          sources: [],
        },
      },
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Brain qualityUnavailable')
    expect(host.textContent).toContain('Compiled truthUnavailable')
    expect(host.textContent).toContain('Source syncUnavailable')
    expect(host.textContent).toContain('Probe checkedUnavailable')
    expect(host.textContent).not.toContain('Brain quality90/100')
    await act(async () => root.unmount())
  })

  it('keeps recovered regressions visible for acknowledgement without degrading current proof', async () => {
    mocks.overviewOverride = healthyOverview()
    mocks.timelineOverride = {
      enabled: true,
      entries: [],
      retainedEntryCount: 0,
      malformedLineCount: 0,
      incidentBanners: [{
        status: 'warning',
        title: 'Worst recent regression still needs acknowledgement',
        detail: '1 stale page at 2026-07-11T08:00:00Z.',
        snapshotId: 'regression-1',
        kind: 'recent-regression',
      }],
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Operational')
    expect(host.textContent).toContain('Recovered regression awaiting acknowledgement')
    expect(host.querySelectorAll('#gbrain-recovered-incidents li')).toHaveLength(0)

    await act(async () => host.querySelector<HTMLButtonElement>('#gbrain-recovered-incidents-toggle')?.click())
    expect(host.textContent).toContain('Worst recent regression still needs acknowledgement')
    expect(host.querySelectorAll('#gbrain-recovered-incidents li')).toHaveLength(1)
    expect(host.querySelector('[role="status"] button')).toBeNull()

    const acknowledgeHistory = buttonByText(host, 'Acknowledge history')
    expect(acknowledgeHistory).toBeTruthy()
    await act(async () => acknowledgeHistory?.click())
    expect(host.textContent).not.toContain('Recovered regression awaiting acknowledgement')
    expect(host.textContent).not.toContain('Worst recent regression still needs acknowledgement')
    expect(host.textContent).toContain('Operational')
    await act(async () => root.unmount())
  })

  it('shows every recovered regression together and clears them as one batch', async () => {
    mocks.overviewOverride = healthyOverview()
    mocks.timelineOverride = {
      enabled: true,
      entries: [],
      retainedEntryCount: 0,
      malformedLineCount: 0,
      incidentBanners: [
        {
          status: 'warning',
          title: 'Worst recent regression still needs acknowledgement',
          detail: '185 missing embeddings at 2026-07-11T08:00:00Z.',
          snapshotId: 'regression-worst',
          kind: 'recent-regression',
        },
        {
          status: 'warning',
          title: 'Worst recent regression still needs acknowledgement',
          detail: '9 stale pages at 2026-07-11T07:00:00Z.',
          snapshotId: 'regression-stale',
          kind: 'recent-regression',
        },
        {
          status: 'warning',
          title: 'Worst recent regression still needs acknowledgement',
          detail: '185 missing embeddings at 2026-07-11T07:30:00Z.',
          snapshotId: 'regression-worst',
          kind: 'recent-regression',
        },
      ],
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Recovered regressions awaiting acknowledgement (2)')
    expect(host.querySelectorAll('#gbrain-recovered-incidents li')).toHaveLength(0)

    await act(async () => host.querySelector<HTMLButtonElement>('#gbrain-recovered-incidents-toggle')?.click())
    expect(host.textContent).toContain('185 missing embeddings')
    expect(host.textContent).toContain('9 stale pages')
    expect(host.querySelectorAll('[aria-label^="Recovered regressions awaiting acknowledgement"] li')).toHaveLength(2)

    await act(async () => buttonByText(host, 'Acknowledge all 2')?.click())
    expect(host.textContent).not.toContain('Recovered regressions awaiting acknowledgement')
    expect(host.textContent).not.toContain('185 missing embeddings')
    expect(host.textContent).not.toContain('9 stale pages')
    await act(async () => root.unmount())
  })

  it('never promotes a historical regression into the current operational severity', async () => {
    const overview = healthyOverview()
    mocks.overviewOverride = {
      ...overview,
      trust: { ...overview.trust, label: 'Live with caveats', status: 'warning' },
      caveats: ['Current proof has a caveat'],
    }
    mocks.timelineOverride = {
      enabled: true,
      entries: [],
      retainedEntryCount: 0,
      malformedLineCount: 0,
      incidentBanners: [{
        status: 'critical',
        title: 'Worst recent regression still needs acknowledgement',
        detail: '20 missing embeddings at 2026-07-11T08:00:00Z.',
        snapshotId: 'historical-critical-regression',
        kind: 'recent-regression',
      }],
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Degraded')
    expect(host.textContent).not.toContain('Action required')
    expect(host.textContent).toContain('Recovered regression awaiting acknowledgement')
    await act(async () => root.unmount())
  })

  it('keeps map controls mounted across timeline refreshes so keyboard focus is preserved', async () => {
    const overview = healthyOverview()
    mocks.overviewOverride = {
      ...overview,
      nodes: [{
        id: 'gbrain-core',
        label: 'GBrain Core',
        kind: 'core',
        status: 'healthy',
        summary: 'Shared memory kernel',
        proof: { label: 'Live health', source: 'gbrain', verifiedAt: '2026-07-11T09:00:00Z', detail: 'Verified' },
        metrics: [],
        risks: [],
        nextSafeAction: 'Continue monitoring',
      }],
    }
    const timelineAt = (capturedAt: string) => ({
      enabled: true,
      entries: [{
        id: capturedAt,
        capturedAt,
        actor: 'mission-control',
        trust: { label: 'Live trusted', status: 'healthy', score: 100, source: 'gbrain', lastVerifiedAt: capturedAt },
        metrics: {},
        bridgeProof: [],
        sourceFreshness: { status: 'healthy', label: 'Fresh', warningCount: 0, defaultThresholdHours: 72 },
        warnings: [],
      }],
      retainedEntryCount: 1,
      malformedLineCount: 0,
      diff: { kind: 'unchanged', summary: 'No material trust change.', changes: [] },
    })
    mocks.timelineOverride = timelineAt('2026-07-11T09:00:00Z')

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))
    const mapNode = buttonByText(host, 'GBrain Core')
    mapNode?.focus()
    expect(document.activeElement).toBe(mapNode)

    mocks.timelineOverride = timelineAt('2026-07-11T09:01:00Z')
    await act(async () => root.render(createElement(GBrain)))

    expect(document.activeElement).toBe(mapNode)
    expect(mapNode?.isConnected).toBe(true)
    await act(async () => root.unmount())
  })

  it('restarts only the decorative map layer for repeated actions even while a timeline diff stays active', async () => {
    mocks.timelineOverride = {
      enabled: true,
      entries: [],
      retainedEntryCount: 0,
      malformedLineCount: 0,
      diff: { kind: 'changed', summary: '1 trust field changed.', changes: [] },
    }
    mocks.postGBrainAction.mockResolvedValue({
      ok: true,
      action: 'doctor-fast',
      label: 'Run fast doctor',
      status: 'complete',
      summary: 'Complete',
      checkedAt: '2026-07-11T09:00:01Z',
      refreshAfter: false,
    })

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))
    const firstLayer = host.querySelector(`.${styles.mapAnimationLayer}`)
    const r0 = buttonByText(host, 'Run fast doctor')

    await act(async () => r0?.click())
    const secondLayer = host.querySelector(`.${styles.mapAnimationLayer}`)
    await act(async () => r0?.click())
    const thirdLayer = host.querySelector(`.${styles.mapAnimationLayer}`)

    expect(firstLayer).toBeTruthy()
    expect(secondLayer).not.toBe(firstLayer)
    expect(thirdLayer).not.toBe(secondLayer)
    expect(mocks.postGBrainAction).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })

  it('shows independent timeline counters and discloses changes omitted from the compact row', async () => {
    mocks.overviewOverride = healthyOverview()
    const timelineEntry = (id: string, metrics: Record<string, string | number>, sourceStatus: string) => ({
      id,
      capturedAt: `2026-07-11T09:00:0${id === 'current' ? '2' : '1'}Z`,
      actor: 'mission-control',
      trust: { label: 'Live trusted', status: 'healthy', score: 100, source: 'gbrain call get_health', lastVerifiedAt: '2026-07-11T09:00:00Z' },
      metrics,
      bridgeProof: [],
      sourceFreshness: { status: sourceStatus, label: 'Freshness', warningCount: 0, defaultThresholdHours: 72 },
      warnings: [],
    })
    mocks.timelineOverride = {
      enabled: true,
      entries: [
        timelineEntry('current', { health: '100/100', embeddings: '100%', missingEmbeddings: 2, stalePages: 3, queue: '0 / 0 / 1', caveats: '1' }, 'warning'),
        timelineEntry('previous', { health: '100/100', embeddings: '100%', missingEmbeddings: 0, stalePages: 0, queue: '0 / 0 / 0', caveats: '0' }, 'healthy'),
      ],
      retainedEntryCount: 2,
      malformedLineCount: 0,
      diff: { kind: 'changed', summary: '5 trust fields changed.', changes: [] },
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(GBrain)))

    expect(host.textContent).toContain('Missing embeddings 0 → 2')
    expect(host.textContent).toContain('Compiled truth Current → 3 stale pages')
    expect(host.textContent).toContain('+2 more changes')
    await act(async () => root.unmount())
  })
})
