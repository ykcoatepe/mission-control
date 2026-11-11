// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Sidebar from '../components/Sidebar'
import TopBar from '../components/TopBar'
import { PageTitleProvider, ToastProvider } from '../components/ui'
import Attention from './Attention'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const NOW = new Date().toISOString()
const meta = { ok: true, stale: false, observedAt: NOW, ageMs: 0, error: null }

const ATTENTION = { count: 158, worst: 'critical', breakdown: { systems: 3, findings: 23, overdueConfirmations: 3, restricted: 129 } }

const signals = {
  data: {
    systems: null,
    attention: ATTENTION,
    automations: null,
    // Deliberately a different number: the loops signal must not leak into the one attention count.
    loops: { openFindings: 146, overdueConfirmations: 24 },
    services: null,
    usage: null,
  },
  meta,
}

const loops = (needsOperator: unknown) => ({
  data: {
    observedAt: NOW,
    totals: { projects: 1, openFindings: 1, pendingConfirmations: 0, overdueConfirmations: 24, needsOperator },
    projects: [
      {
        id: 'alpha',
        restricted: false,
        title: 'alpha',
        outcome: null,
        openFindings: { total: 1, bySeverity: { error: 1, warning: 0, info: 0 }, byCode: { E1: 1 } },
        pendingConfirmations: [],
        participants: [],
        lastActivityAt: NOW,
        errors: [],
      },
    ],
    attention: [
      {
        project: 'alpha',
        kind: 'finding',
        severity: 'error',
        code: 'E1',
        subject: 'P59',
        detail: 'Short first line\nA much longer second paragraph that only the drawer shows.',
        summary: 'Short first line',
        at: NOW,
      },
    ],
  },
  meta,
})

function stub(signalsBody: unknown, loopsBody: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      if (url === '/api/signals') return signalsBody === null ? new Response('{}', { status: 503 }) : json(signalsBody)
      if (url === '/api/loops') return json(loopsBody)
      return json({})
    }),
  )
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
  )
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const shell = createElement(
    'div',
    null,
    createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }),
    createElement(Sidebar, { collapsed: false, onToggleCollapsed: () => undefined, open: false, onClose: () => undefined }),
    createElement(Attention),
  )
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, { initialEntries: ['/attention'] }, createElement(ToastProvider, null, createElement(PageTitleProvider, null, shell))),
      ),
    ),
  )
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  return { host, root }
}

const statValue = (host: HTMLElement) => {
  const stat = [...host.querySelectorAll('[aria-label="Attention summary"] > *')].find((node) => node.textContent?.includes('Need attention'))
  return stat?.textContent ?? ''
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Attention page: one number in three places', () => {
  it('shows the server attention count in the pill, the sidebar badge and the page summary, with the breakdown as secondary text', async () => {
    stub(signals, loops(ATTENTION))
    const { host, root } = await mount()
    const pill = host.querySelector('a[href="/attention"][aria-label]') as HTMLAnchorElement
    expect(pill.textContent).toContain('158')
    const badge = host.querySelector('nav a[href="/attention"]') as HTMLAnchorElement
    expect(badge.textContent).toContain('158')
    const stat = statValue(host)
    expect(stat).toContain('158')
    expect(stat).toContain('3 systems · 23 findings · 3 overdue · 129 restricted')
    await act(async () => root.unmount())
  })

  it('falls back to the loops copy of the same server number when the shell signal is unavailable, never to a sum', async () => {
    stub(null, loops(ATTENTION))
    const { host, root } = await mount()
    expect(statValue(host)).toContain('158')
    await act(async () => root.unmount())
  })

  it('says "not read" when neither source gave the number', async () => {
    stub(null, loops(null))
    const { host, root } = await mount()
    const stat = statValue(host)
    expect(stat).toContain('not read')
    expect(stat).not.toMatch(/\b0\b/)
    await act(async () => root.unmount())
  })

  it('shows the bounded summary in the list, not the full detail', async () => {
    stub(signals, loops(ATTENTION))
    const { host, root } = await mount()
    const table = host.querySelector('table') as HTMLTableElement
    expect(table.textContent).toContain('Short first line')
    expect(table.textContent).not.toContain('longer second paragraph')
    await act(async () => root.unmount())
  })
})
