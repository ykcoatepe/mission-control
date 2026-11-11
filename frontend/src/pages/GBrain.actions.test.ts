// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { health, minimalSynoptic, synoptic, withVerdict } from './brain/fixtures'
import type { OperationCapability } from './brain/types'

const mocks = vi.hoisted(() => ({
  postGBrainAction: vi.fn(),
  synoptic: null as unknown,
  health: null as unknown,
  timeline: null as unknown,
  capabilities: [] as unknown[],
}))

vi.mock('./gbrain/api', () => ({ postGBrainAction: mocks.postGBrainAction }))

vi.mock('../lib/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hooks')>()),
  useApi: (url: string) => {
    const data =
      url === '/api/gbrain/synoptic' ? mocks.synoptic
      : url === '/api/gbrain/health' ? mocks.health
      : url.startsWith('/api/gbrain/timeline') ? mocks.timeline
      : url === '/api/operations/overview' ? { ok: true, capabilities: mocks.capabilities, systems: { gbrain: { caveats: [] } } }
      : null
    return { data, loading: false, error: null, refetch: vi.fn().mockResolvedValue(undefined) }
  },
}))

import GBrain from './GBrain'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const meta = (observedAt: string, over: Record<string, unknown> = {}) => ({
  ok: true,
  stale: false,
  observedAt,
  ageMs: 1000,
  error: null,
  ...over,
})

function capability(over: Partial<OperationCapability>): OperationCapability {
  return {
    id: 'x',
    system: 'gbrain',
    label: 'X',
    description: 'Does x',
    kind: 'diagnostic',
    safetyClass: 'R0',
    requiresConfirmation: false,
    timeoutMs: 120_000,
    refreshAfter: false,
    enabled: true,
    disabledReason: '',
    actionEndpoint: '/api/gbrain/actions',
    ...over,
  }
}

const CAPABILITIES = [
  capability({ id: 'doctor-fast', label: 'Run fast doctor', refreshAfter: false }),
  capability({
    id: 'sync-sources',
    label: 'Sync local sources',
    kind: 'maintenance',
    safetyClass: 'W1',
    requiresConfirmation: true,
    refreshAfter: true,
  }),
  capability({ id: 'danger', label: 'Delete storage', safetyClass: 'W2', requiresConfirmation: true }),
]

function setup(over: { synoptic?: unknown; capabilities?: unknown[]; timeline?: unknown } = {}) {
  mocks.synoptic = over.synoptic ?? { data: synoptic(), meta: meta('2026-11-11T08:00:00.000Z') }
  mocks.health = health()
  mocks.timeline = over.timeline ?? { entries: [], retainedEntryCount: 0, incidentBanners: [], meta: meta('2026-11-11T08:00:00.000Z') }
  mocks.capabilities = over.capabilities ?? CAPABILITIES
}

function mount(path = '/') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MemoryRouter, { initialEntries: [path] }, createElement(GBrain)),
        ),
      ),
    )
  return { host, root, render }
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

afterEach(() => {
  mocks.postGBrainAction.mockReset()
  window.localStorage?.clear()
  document.body.innerHTML = ''
})

describe('Brain home: verdict and readings', () => {
  it('says normal only when everything read is normal, with configured readers as quiet normal blocks', async () => {
    setup()
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).toContain('GBrain is normal')
    expect(host.textContent).toContain('last probe')
    expect(host.textContent).toContain('Link extraction')
    expect(host.textContent).not.toMatch(/proof|evidence|caveat|allowlisted|R0|W1|Living Brain Map/i)
    // A set-up reader is a present, ordinary block: no state dot, no state attribute, "Set up" under the name.
    const reader = host.querySelector('[data-syn-id="reader:hermes"]')
    expect(reader?.hasAttribute('data-state')).toBe(false)
    expect(reader?.getAttribute('data-presence')).toBe('set_up')
    expect(reader?.textContent).toContain('Set up')
    expect(reader?.textContent).not.toMatch(/configured/i)
    expect(reader?.querySelector('[data-state]')).toBeNull()
    expect(host.textContent).toContain("Set up to use GBrain. Live connections can't be read from this machine.")
    expect(host.textContent).not.toContain('Configured, not observed')
    expect(host.textContent).not.toContain('Connection telemetry is not observable locally.')
    expect(host.textContent).not.toContain('Reader connections are not observed')
    await act(async () => root.unmount())
  })

  it('never presents a missing core reading or a stale snapshot as normal', async () => {
    // The payload verdict carries the reason, as the server builds it.
    const syn = withVerdict(synoptic(), { elementId: 'gbrain-core', state: 'unavailable', text: 'GBrain core reading unavailable.' })
    syn.core = { ...syn.core, state: 'unavailable', pages: { ...syn.core.pages, value: null, state: 'unavailable', observedAt: null } }
    setup({ synoptic: { data: syn, meta: meta('2026-11-11T08:00:00.000Z', { stale: true }) } })
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).not.toContain('GBrain is normal')
    expect(host.textContent).toContain('GBrain readings are incomplete: GBrain core reading unavailable')
    expect(host.textContent).toContain('stale')
    expect(host.querySelector('[data-syn-id="core"]')?.textContent).toContain('—')
    await act(async () => root.unmount())
  })

  it('renders a minimal payload without crashing and does not call it normal', async () => {
    setup({ synoptic: { data: minimalSynoptic(), meta: meta('2026-11-11T08:00:00.000Z') } })
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).not.toContain('GBrain is normal')
    expect(host.querySelector('[data-syn-id="core"]')).not.toBeNull()
    await act(async () => root.unmount())
  })

  it('shows an error state, not a healthy page, when the synoptic is missing', async () => {
    setup({ synoptic: { data: null, meta: meta('2026-11-11T08:00:00.000Z', { ok: false }) } })
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).toContain('GBrain could not be read')
    expect(host.textContent).not.toContain('GBrain is normal')
    await act(async () => root.unmount())
  })

  it('shows an unreadable timeline (503, so no data) as could not be read, never as an empty list', async () => {
    setup()
    mocks.timeline = null
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).toContain('Recent readings could not be read.')
    expect(host.textContent).not.toContain('No readings have been recorded yet.')
    await act(async () => root.unmount())
  })

  it('takes the verdict line from the payload verdict: a reason the blocks do not show still reaches the page', async () => {
    const syn = withVerdict(synoptic(), { elementId: 'embed-job-probe', state: 'unavailable', text: 'Embed-job probe unavailable; the missing-embedding verdict uses embedding age only.' })
    setup({ synoptic: { data: syn, meta: meta('2026-11-11T08:00:00.000Z') } })
    const { host, render, root } = mount()
    await render()
    expect(host.querySelector('[role="status"][class*="sentence"]')?.textContent ?? host.textContent).toContain(
      'GBrain readings are incomplete: Embed-job probe unavailable',
    )
    expect(host.textContent).not.toContain('GBrain is normal')
    await act(async () => root.unmount())
  })

  it('keeps recovered regressions as history: they never change the verdict, and acknowledging clears them together', async () => {
    const banner = (snapshotId: string) => ({
      title: 'Worst recent regression still needs acknowledgement',
      detail: '3 caveats at 2026-11-11T08:05:20.562Z.',
      snapshotId,
      kind: 'recent-regression',
    })
    setup({
      timeline: {
        entries: [],
        retainedEntryCount: 0,
        incidentBanners: [banner('a'), banner('a'), banner('b')],
        meta: meta('2026-11-11T08:00:00.000Z'),
      },
    })
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).toContain('GBrain is normal')
    expect(host.textContent?.match(/Recovered:/g)).toHaveLength(2)
    expect(host.textContent).toContain('Recovered: 3 notes')
    await act(async () => button('Acknowledge all 2')?.click())
    expect(host.textContent).not.toContain('Recovered:')
    await act(async () => root.unmount())
  })
})

describe('Brain home: maintenance actions', () => {
  it('runs a Check directly once, gates a Change behind a confirmation, cancels safely and omits W2', async () => {
    setup()
    mocks.postGBrainAction.mockResolvedValue({ ok: true, action: 'doctor-fast', status: 'completed', summary: 'Complete', checkedAt: 'x', refreshAfter: false })
    const { host, render, root } = mount()
    await render()

    expect(host.textContent).toContain('Maintenance')
    expect(host.textContent).toContain('Check')
    expect(host.textContent).toContain('Change (asks first)')
    expect(host.textContent).not.toContain('Delete storage')

    const check = host.querySelector('section[aria-labelledby="maint-check"] button') as HTMLButtonElement
    await act(async () => {
      check.click()
      check.click()
    })
    expect(mocks.postGBrainAction).toHaveBeenCalledOnce()
    expect(mocks.postGBrainAction).toHaveBeenCalledWith('doctor-fast', false)

    mocks.postGBrainAction.mockClear()
    const change = host.querySelector('section[aria-labelledby="maint-change"] button') as HTMLButtonElement
    change.focus()
    await act(async () => change.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Sync local sources')
    expect(dialog?.textContent).toContain('2 minutes')
    expect(dialog?.textContent).toContain('sync-sources')

    await act(async () => button('Cancel')?.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.activeElement).toBe(change)
    await act(async () => root.unmount())
  })

  it('words the confirmation plainly: sentence-case button, the id once, state and age as two facts', async () => {
    setup()
    const { host, render, root } = mount()
    await render()
    await act(async () => (host.querySelector('section[aria-labelledby="maint-change"] button') as HTMLButtonElement).click())
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement
    expect(button('Run sync')).toBeDefined()
    expect(dialog.textContent).not.toContain('Exact action')
    expect(dialog.textContent).not.toMatch(/(unavailable|healthy|warning|critical) (fresh|stale)/i)
    expect(dialog.textContent).toContain('Last read')
    expect(dialog.textContent?.split('sync-sources').length).toBe(2)
    await act(async () => button('Cancel')?.click())
    await act(async () => root.unmount())
  })

  it('confirms a Change with explicit confirmation, then stays verifying until a newer fresh reading arrives', async () => {
    setup()
    mocks.postGBrainAction.mockResolvedValue({ ok: true, action: 'sync-sources', status: 'completed', summary: 'Synced', checkedAt: 'x', refreshAfter: true })
    const { host, render, root } = mount()
    await render()

    await act(async () => (host.querySelector('section[aria-labelledby="maint-change"] button') as HTMLButtonElement).click())
    await act(async () => button('Run sync')?.click())
    expect(mocks.postGBrainAction).toHaveBeenCalledOnce()
    expect(mocks.postGBrainAction).toHaveBeenCalledWith('sync-sources', true)
    expect(host.textContent).toContain('Verifying')
    expect(host.textContent).toContain('waiting for a newer reading')

    // Same reading time: still verifying.
    await render()
    expect(host.textContent).toContain('Verifying')

    // A stale reading, even with a later time, does not count.
    mocks.synoptic = { data: synoptic(), meta: meta('2026-11-11T08:05:00.000Z', { stale: true }) }
    await render()
    expect(host.textContent).toContain('Verifying')

    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
    mocks.synoptic = { data: synoptic(), meta: meta('2026-11-11T08:05:00.000Z') }
    await render()
    expect(host.textContent).toContain('Verified')
    expect(host.textContent).not.toContain('Verifying')
    // The shell's signals are read again when the reading catches up, not on their next poll.
    const readsSignals = spy.mock.calls.some(([filters]) => {
      const predicate = (filters as { predicate?: (query: { queryKey: unknown[] }) => boolean } | undefined)?.predicate
      return predicate?.({ queryKey: ['api', '/api/signals'] }) === true
    })
    expect(readsSignals).toBe(true)
    spy.mockRestore()
    await act(async () => root.unmount())
  })

  it('re-resolves the current capability on confirm and refuses a changed policy', async () => {
    setup()
    const { host, render, root } = mount()
    await render()
    await act(async () => (host.querySelector('section[aria-labelledby="maint-change"] button') as HTMLButtonElement).click())
    mocks.capabilities = [CAPABILITIES[0], { ...CAPABILITIES[1], enabled: false }, CAPABILITIES[2]]
    await render()
    await act(async () => button('Run sync')?.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Action was not started')
    await act(async () => root.unmount())
  })

  it('keeps a timed-out action pending instead of failed', async () => {
    setup()
    mocks.postGBrainAction.mockRejectedValue({
      payload: { ok: false, action: 'sync-sources', status: 'timed-out', pending: true, refreshAfter: true, summary: 'Cleanup is still running', checkedAt: 'x' },
    })
    const { host, render, root } = mount()
    await render()
    await act(async () => (host.querySelector('section[aria-labelledby="maint-change"] button') as HTMLButtonElement).click())
    await act(async () => button('Run sync')?.click())
    expect(host.textContent).toContain('Cleanup is still running')
    expect(host.textContent).not.toContain('Failed')
    await act(async () => root.unmount())
  })

  it('offers no actions, and says so, when the capabilities could not be read', async () => {
    setup()
    mocks.capabilities = null as unknown as unknown[]
    const { host, render, root } = mount()
    await render()
    expect(host.textContent).toContain('Maintenance actions could not be read')
    expect(host.querySelector('section[aria-labelledby="maint-check"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('opens an element detail with its actions and keeps Change behind the confirmation', async () => {
    const syn = synoptic()
    syn.sources[0] = { ...syn.sources[0], state: 'warning', items: syn.sources[0].items.map((i) => (i.id === 'mission-control' ? { ...i, state: 'warning' as const, behind: 2 } : i)) }
    setup({
      synoptic: { data: syn, meta: meta('2026-11-11T08:00:00.000Z') },
      capabilities: [...CAPABILITIES, capability({ id: 'retry-failed-sync', label: 'Retry failed syncs', safetyClass: 'W1', requiresConfirmation: true, refreshAfter: true })],
    })
    const { host, render, root } = mount()
    await render()
    await act(async () => (host.querySelector('[data-syn-id="group:projects"]') as HTMLButtonElement).click())
    const drawer = document.querySelector('[role="dialog"]')
    expect(drawer?.textContent).toContain('Retry failed syncs')
    await act(async () => [...(drawer?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Retry failed syncs')?.click())
    expect(mocks.postGBrainAction).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('retry-failed-sync')
    await act(async () => root.unmount())
  })
})

describe('/gbrain route', () => {
  it('opens the Knowledge view when a query is present', async () => {
    setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, headers: new Headers() }))
    const { host, render, root } = mount('/gbrain?q=term')
    await render()
    const input = host.querySelector('input[type="search"]') as HTMLInputElement
    expect(input.value).toBe('term')
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Knowledge')
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  })
})
