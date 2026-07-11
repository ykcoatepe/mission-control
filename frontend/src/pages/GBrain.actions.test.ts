// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  postGBrainAction: vi.fn(),
  refetchOverview: vi.fn(),
  refetchTimeline: vi.fn(),
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
        data: { enabled: true, entries: [], retainedEntryCount: 0, malformedLineCount: 0 },
        loading: false,
        error: null,
        refetch: mocks.refetchTimeline,
      }
    }
    return {
      data: {
        ok: true,
        mode: 'live-read-only',
        refreshedAt: '2026-07-11T09:00:00Z',
        title: 'GBrain',
        subtitle: 'Shared memory',
        trust: {
          label: 'Live with caveats',
          status: 'warning',
          score: 90,
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
          sources: {
            checkedAt: '2026-07-11T09:00:00Z',
            freshness: { status: 'healthy', staleCount: 0, freshCount: 1 },
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

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function buttonByText(host: HTMLElement, text: string) {
  return [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) as HTMLButtonElement | undefined
}

afterEach(() => {
  mocks.postGBrainAction.mockReset()
  mocks.refetchOverview.mockReset()
  mocks.refetchTimeline.mockReset()
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
})
