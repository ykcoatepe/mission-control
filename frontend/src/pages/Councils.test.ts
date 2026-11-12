// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageTitleProvider, ToastProvider } from '../components/ui'
import Councils from './Councils'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubServer(scorecard: unknown, extra: { summary?: unknown; decisions?: unknown } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      if (url === '/api/councils/summary') return json(extra.summary ?? { archive: { totalDecisions: 3 }, metrics: { activeDecisions: 0, totalDecisions: 3 }, councils: {} })
      if (url === '/api/councils/decisions') return json(extra.decisions ?? { decisions: [] })
      if (url === '/api/councils/governance/scorecard') return json(scorecard)
      return json({ error: { code: 'not_found', message: 'No API route' } }, 404)
    }),
  )
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(ToastProvider, null, createElement(PageTitleProvider, null, createElement(Councils))),
        ),
      ),
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

const overallTile = (host: HTMLElement) =>
  [...host.querySelectorAll('[aria-label^="Governance versus real workflow"] > *')].find((el) => el.textContent?.startsWith('Overall'))

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Audit: Overall', () => {
  it('says what the scorecard reported when it has no review, not "Unavailable"', async () => {
    stubServer({ overall: 'green', metrics: {}, review: null })
    const { host, root } = await mount()
    const text = overallTile(host)?.textContent ?? ''
    expect(text).toContain('Scorecard: green')
    expect(text).toContain('no review recorded')
    expect(text).not.toContain('Not read')
    await act(async () => root.unmount())
  })

  it('stays not read when the scorecard gave no usable verdict either', async () => {
    stubServer({ metrics: {}, review: null })
    const { host, root } = await mount()
    const text = overallTile(host)?.textContent ?? ''
    expect(text).toContain('Not read')
    expect(text).toContain('no review reported')
    await act(async () => root.unmount())
  })

  it('does not read an unread real-work count as zero, and never defaults a missing verdict to green', async () => {
    stubServer({ metrics: {}, review: { governanceEventsLive24h: 4 } })
    const unreadCount = await mount()
    expect(overallTile(unreadCount.host)?.textContent).toContain('Not read')
    await act(async () => unreadCount.root.unmount())
    document.body.innerHTML = ''

    stubServer({ metrics: {}, review: { workflowSurfaceLive24h: 5 } })
    const noVerdict = await mount()
    expect(overallTile(noVerdict.host)?.textContent).not.toContain('Normal')
    expect(overallTile(noVerdict.host)?.textContent).toContain('Not read')
    await act(async () => noVerdict.root.unmount())
  })
})

const alarm = (host: HTMLElement) => host.querySelector('[role="alert"], [role="status"][data-state]') as HTMLElement | null

describe('Audit: the alarm line', () => {
  it('is absent when nothing is abnormal, and says what the archive is instead', async () => {
    stubServer({ overall: 'green', metrics: { delegationAutorunInfraFailureAttempts: 0 }, review: { workflowSurfaceLive24h: 12, governanceEventsLive24h: 3 } })
    const { host, root } = await mount()
    expect(alarm(host)).toBeNull()
    expect(host.textContent).toContain('Read-only archive')
    await act(async () => root.unmount())
  })

  it('is one critical line for failed attempts, naming the open decisions that come second', async () => {
    stubServer(
      { overall: 'green', metrics: { delegationAutorunInfraFailureAttempts: 2 }, review: { workflowSurfaceLive24h: 12 } },
      { summary: { archive: { totalDecisions: 3 }, metrics: { activeDecisions: 1, totalDecisions: 3 }, councils: {} } },
    )
    const { host, root } = await mount()
    const lines = host.querySelectorAll('[data-state="critical"][role="alert"]')
    expect(lines).toHaveLength(1)
    expect(lines[0].textContent).toContain('2 automatic task attempts failed')
    expect(lines[0].textContent).toContain('1 council decision is still open')
    await act(async () => root.unmount())
  })

  it('offers to show the open decisions, and the table lists them with their real time', async () => {
    stubServer(
      { overall: 'green', metrics: {}, review: { workflowSurfaceLive24h: 4 } },
      {
        summary: { archive: { totalDecisions: 2 }, metrics: { activeDecisions: 1, totalDecisions: 2 }, councils: {} },
        decisions: {
          decisions: [
            { decisionId: 'D-1', council: 'EC', context: 'Pick a vendor', decision: 'open', owner: 'ops', risk: 'low', updatedAt: '2026-11-11T12:41:00Z' },
            { decisionId: 'D-2', council: 'OC', context: 'Rotate keys', decision: 'approved', owner: 'ops', risk: 'low', updatedAt: '2026-11-10T09:00:00Z' },
          ],
        },
      },
    )
    const { host, root } = await mount()
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(host.querySelector('time')?.getAttribute('datetime')).toBe('2026-11-11T12:41:00.000Z')
    const show = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show open decisions')) as HTMLButtonElement
    await act(async () => show.click())
    expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(host.querySelector('tbody')?.textContent).toContain('D-1')
    await act(async () => root.unmount())
  })
})
