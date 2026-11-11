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

function stubServer(scorecard: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      if (url === '/api/councils/summary') return json({ archive: { totalDecisions: 3 }, metrics: { activeDecisions: 0, totalDecisions: 3 }, councils: {} })
      if (url === '/api/councils/decisions') return json({ decisions: [] })
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
    expect(text).not.toContain('Unavailable')
    await act(async () => root.unmount())
  })

  it('stays unavailable when the scorecard gave no usable verdict either', async () => {
    stubServer({ metrics: {}, review: null })
    const { host, root } = await mount()
    const text = overallTile(host)?.textContent ?? ''
    expect(text).toContain('Unavailable')
    expect(text).toContain('no review reported')
    await act(async () => root.unmount())
  })

  it('does not read an unread real-work count as zero, and never defaults a missing verdict to green', async () => {
    stubServer({ metrics: {}, review: { governanceEventsLive24h: 4 } })
    const unreadCount = await mount()
    expect(overallTile(unreadCount.host)?.textContent).toContain('Unavailable')
    await act(async () => unreadCount.root.unmount())
    document.body.innerHTML = ''

    stubServer({ metrics: {}, review: { workflowSurfaceLive24h: 5 } })
    const noVerdict = await mount()
    expect(overallTile(noVerdict.host)?.textContent).not.toContain('Healthy')
    expect(overallTile(noVerdict.host)?.textContent).toContain('Unavailable')
    await act(async () => noVerdict.root.unmount())
  })
})
