// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unnamedControls } from '../components/ui/a11y.testkit'
import { health, synoptic } from './brain/fixtures'
import type { OperationCapability } from './brain/types'

const mocks = vi.hoisted(() => ({ synoptic: null as unknown, health: null as unknown, capabilities: [] as unknown[] }))

vi.mock('../lib/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/hooks')>()),
  useApi: (url: string) => {
    const data =
      url === '/api/gbrain/synoptic' ? mocks.synoptic
      : url === '/api/gbrain/health' ? mocks.health
      : url.startsWith('/api/gbrain/timeline') ? { entries: [], retainedEntryCount: 0, incidentBanners: [], meta: meta() }
      : url === '/api/operations/overview' ? { ok: true, capabilities: mocks.capabilities, systems: { gbrain: { caveats: [] } } }
      : null
    return { data, loading: false, error: null, refetch: vi.fn().mockResolvedValue(undefined) }
  },
}))

import GBrain from './GBrain'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function meta() {
  return { ok: true, stale: false, observedAt: '2026-11-11T08:00:00.000Z', ageMs: 1000, error: null }
}

const doctor: OperationCapability = {
  id: 'doctor-fast',
  system: 'gbrain',
  label: 'Run fast doctor',
  description: 'Runs the fast doctor',
  kind: 'diagnostic',
  safetyClass: 'R0',
  requiresConfirmation: false,
  timeoutMs: 120_000,
  refreshAfter: true,
  enabled: true,
  disabledReason: '',
  actionEndpoint: '/api/gbrain/actions',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const base = { action: 'doctor-fast', label: 'Run fast doctor', mode: 'live-write', checkedAt: '2026-11-11T08:10:00.000Z', args: [], pending: false, refreshAfter: true, payload: {} }

/** The shape the real doctor produced: unhealthy, 45/100, one failing check with 110 issues. */
const FINDINGS = {
  ...base,
  ok: true,
  status: 'completed',
  outcome: 'findings',
  summary: 'Check finished: unhealthy (45/100); 1 check failed: resolver_health - 110 issues (39 errors, 71 warnings); 7 warnings.',
  result: {
    reportStatus: 'unhealthy',
    healthScore: 45,
    failing: [{ name: 'resolver_health', status: 'fail', message: '110 issue(s): 39 error(s), 71 warning(s)' }],
    warning: [
      { name: 'queue_health', status: 'warn', message: '3 stalled jobs' },
      { name: 'embed_coverage', status: 'warn', message: '12 pages missing embeddings' },
    ],
    counts: { failing: 1, warning: 7, checks: 25, warningOmitted: 5 },
  },
}

const CLEAN = {
  ...base,
  ok: true,
  status: 'completed',
  outcome: 'clean',
  summary: 'Check finished: healthy (100/100); nothing failed.',
  result: { reportStatus: 'healthy', healthScore: 100, failing: [], warning: [], counts: { failing: 0, warning: 0, checks: 25 } },
}

function stubActions(respond: () => Response | Promise<Response>) {
  const posts: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      posts.push({ url: new URL(input, 'http://localhost').pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
      return respond()
    }),
  )
  return posts
}

async function mountAndRun() {
  mocks.synoptic = { data: synoptic(), meta: meta() }
  mocks.health = health()
  mocks.capabilities = [doctor]
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(GBrain)))),
  )
  const run = host.querySelector('section[aria-labelledby="maint-check"] button') as HTMLButtonElement
  await act(async () => {
    run.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined
const resultPanel = () => document.querySelector('section[aria-label="Run fast doctor result"]') as HTMLElement | null

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('a check that ran and found problems', () => {
  it('shows a result panel with the findings, never a failed action', async () => {
    const posts = stubActions(() => json(FINDINGS))
    const { host, root } = await mountAndRun()
    expect(posts).toEqual([{ url: '/api/gbrain/actions', body: { action: 'doctor-fast' } }])

    const panel = resultPanel()
    expect(panel).not.toBeNull()
    expect(unnamedControls(document)).toEqual([])
    expect(panel?.querySelector('h2')?.textContent).toBe('Run fast doctor')
    expect(panel?.textContent).toContain('1 check failed: resolver_health')
    expect(panel?.textContent).toContain('Health score 45/100')
    expect(panel?.textContent).toContain('1 check failing')
    expect(panel?.querySelector('li')?.textContent).toBe('resolver_health110 issue(s): 39 error(s), 71 warning(s)')
    // Unhealthy report: critical, in the shared state vocabulary.
    expect(panel?.querySelector('[data-state="critical"]')?.textContent).toContain('Findings')
    // Warnings are collapsed below, with the count the report gave and the number not listed.
    const warnings = panel?.querySelector('details') as HTMLDetailsElement
    expect(warnings.open).toBe(false)
    expect(warnings.querySelector('summary')?.textContent).toBe('7 warnings')
    expect(warnings.textContent).toContain('queue_health')
    expect(warnings.textContent).toContain('5 more not listed')

    // Worded as a result: the status notice says the check finished and nothing failed.
    expect(host.textContent).not.toContain('GBrain action failed')
    expect(host.textContent).not.toMatch(/\bFailed\b/)
    expect(host.textContent).toContain('Run fast doctor finished')
    await act(async () => root.unmount())
  })

  it('uses a warning, not critical, when the report does not say unhealthy', async () => {
    stubActions(() => json({ ...FINDINGS, result: { ...FINDINGS.result, reportStatus: 'degraded', failing: [], counts: { failing: 0, warning: 7 } } }))
    const { root } = await mountAndRun()
    const state = resultPanel()?.querySelector('[data-state]')
    expect(state?.getAttribute('data-state')).toBe('warning')
    await act(async () => root.unmount())
  })

  it('copies the summary and stays until dismissed', async () => {
    stubActions(() => json(FINDINGS))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { root } = await mountAndRun()
    await act(async () => button('Copy summary')?.click())
    expect(writeText).toHaveBeenCalledOnce()
    const text = String(writeText.mock.calls[0][0])
    expect(text).toContain('Run fast doctor: Check finished: unhealthy (45/100)')
    expect(text).toContain('Health score: 45/100')
    expect(text).toContain('- resolver_health: 110 issue(s): 39 error(s), 71 warning(s)')
    expect(button('Copied')).toBeDefined()

    expect(resultPanel()).not.toBeNull()
    await act(async () => button('Dismiss')?.click())
    expect(resultPanel()).toBeNull()
    await act(async () => root.unmount())
  })

  it('goes away when the next action starts', async () => {
    let calls = 0
    stubActions(() => json(++calls === 1 ? FINDINGS : CLEAN))
    const { host, root } = await mountAndRun()
    expect(resultPanel()?.textContent).toContain('resolver_health')
    const run = host.querySelector('section[aria-labelledby="maint-check"] button') as HTMLButtonElement
    await act(async () => {
      run.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(resultPanel()?.textContent).not.toContain('resolver_health')
    await act(async () => root.unmount())
  })
})

describe('a clean check', () => {
  it('is quiet and healthy: no lists, no warning', async () => {
    stubActions(() => json(CLEAN))
    const { root } = await mountAndRun()
    const panel = resultPanel()
    expect(panel?.textContent).toContain('healthy (100/100)')
    expect(panel?.querySelector('[data-state="healthy"]')?.textContent).toContain('No findings')
    expect(panel?.querySelector('ul')).toBeNull()
    expect(panel?.querySelector('details')).toBeNull()
    expect(panel?.querySelector('[data-state="warning"], [data-state="critical"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('a check that could not run', () => {
  it('words a spawn failure as a failure and shows no findings', async () => {
    stubActions(() => json({ ...base, ok: false, status: 'failed', error: { code: 'spawn_failed', message: 'Could not start gbrain' } }, 502))
    const { host, root } = await mountAndRun()
    expect(resultPanel()).toBeNull()
    expect(host.textContent).toContain('Failed')
    expect(host.textContent).toContain('Could not start gbrain')
    expect(host.textContent).not.toMatch(/Health score|check failing|Findings/)
    await act(async () => root.unmount())
  })

  it('keeps a timeout pending, not failed and not a finding', async () => {
    stubActions(() =>
      json({ ...base, ok: false, status: 'timed-out', pending: true, summary: 'Timed out after 120 seconds; cleanup is still running', error: { code: 'timeout', message: 'Timed out' } }, 504),
    )
    const { host, root } = await mountAndRun()
    expect(resultPanel()).toBeNull()
    expect(host.textContent).toContain('Waiting for a reading')
    expect(host.textContent).toContain('cleanup is still running')
    expect(host.textContent).not.toMatch(/Health score|check failing|Findings/)
    await act(async () => root.unmount())
  })

  it('treats a 200 without a recognised report as done, not as a finding', async () => {
    stubActions(() => json({ ...base, ok: true, status: 'completed', summary: 'Complete' }))
    const { host, root } = await mountAndRun()
    expect(resultPanel()).toBeNull()
    expect(host.textContent).toContain('Complete')
    await act(async () => root.unmount())
  })
})
