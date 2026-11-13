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
const KEY = 'finding:alpha:E1:0123456789ab'

const signals = (attention: unknown = ATTENTION) => ({
  data: {
    systems: null,
    attention,
    automations: null,
    // Deliberately a different number: the loops signal must not leak into the one attention count.
    loops: { openFindings: 146, overdueConfirmations: 24 },
    services: null,
    usage: null,
  },
  meta,
})

const loops = (needsOperator: unknown, ack: unknown = null) => ({
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
        key: KEY,
        ackable: true,
        ack,
      },
    ],
  },
  meta,
})

interface Seen {
  signals: number
  loops: number
  writes: Array<{ method: string; path: string; body: unknown }>
}

function stub(signalsBody: unknown, loopsBody: unknown) {
  const seen: Seen = { signals: 0, loops: 0, writes: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      if (url === '/api/signals') {
        seen.signals++
        return signalsBody === null ? new Response('{}', { status: 503 }) : json(signalsBody)
      }
      if (url === '/api/loops') {
        seen.loops++
        return json(loopsBody)
      }
      return json({})
    }),
  )
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
  )
  return seen
}

/** A server that keeps the acknowledgement: POST sets it, DELETE clears it, and the readings follow. */
function stubServer() {
  const seen: Seen = { signals: 0, loops: 0, writes: [] }
  let ack: unknown = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') {
        seen.writes.push({ method, path: url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
        if (method === 'POST') ack = { kind: 'ack', at: new Date().toISOString(), until: null }
        else ack = null
        return json({ ok: true, key: KEY, ack })
      }
      if (url === '/api/signals') {
        seen.signals++
        return json(signals(ack ? { count: 0, worst: 'healthy', standing: 1, breakdown: null } : ATTENTION))
      }
      if (url === '/api/loops') {
        seen.loops++
        return json(loops(null, ack))
      }
      return json({})
    }),
  )
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
  )
  return seen
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
  await settle()
  return { host, root }
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const alarmText = (host: HTMLElement) => host.querySelector('[role="alert"], [role="status"]')?.textContent ?? ''
const railBadge = (host: HTMLElement) => host.querySelector('nav a[href="/attention"]') as HTMLAnchorElement

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Attention page: one number, shell and page', () => {
  it('shows the server attention count in the rail badge and in the alarm line, with the breakdown but not the restricted count', async () => {
    stub(signals(), loops(ATTENTION))
    const { host, root } = await mount()
    expect(railBadge(host).textContent).toContain('158')
    const alarm = alarmText(host)
    expect(alarm).toContain('158 need attention')
    expect(alarm).toContain('3 systems · 23 findings · 3 overdue')
    expect(alarm).not.toContain('restricted')
    // The top bar no longer carries a big attention pill.
    expect(host.querySelector('a[href="/attention"][aria-label]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('falls back to the loops copy of the same server number when the shell signal is unavailable, never to a sum', async () => {
    stub(null, loops(ATTENTION))
    const { host, root } = await mount()
    expect(alarmText(host)).toContain('158 need attention')
    await act(async () => root.unmount())
  })

  it('says the attention count was not read when neither source gave it, and does not show a zero', async () => {
    stub(null, { ...loops(null), data: { ...loops(null).data, attention: [] } })
    const { host, root } = await mount()
    expect(host.textContent).toContain('Nothing new needs you.')
    expect(host.textContent).toContain('The attention count was not read.')
    expect(host.textContent).not.toMatch(/\b0 need attention/)
    await act(async () => root.unmount())
  })

  it('shows the bounded summary in the list, not the full detail', async () => {
    stub(signals(), loops(ATTENTION))
    const { host, root } = await mount()
    const table = host.querySelector('table') as HTMLTableElement
    expect(table.textContent).toContain('Short first line')
    expect(table.textContent).not.toContain('longer second paragraph')
    await act(async () => root.unmount())
  })
})

describe('Attention page: acknowledge moves the row and the badge', () => {
  const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy()
    await act(async () => {
      element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()
  }
  const button = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll('tbody button')].find((b) => b.textContent?.trim() === label)

  it('acknowledging moves the item to Standing, clears the alarm and the rail badge, and Undo brings it back', async () => {
    const seen = stubServer()
    const { host, root } = await mount()
    expect(railBadge(host).textContent).toContain('158')
    const signalReads = seen.signals
    const loopReads = seen.loops

    await click(button(host, 'Acknowledge'))
    expect(seen.writes).toEqual([{ method: 'POST', path: '/api/attention/acks', body: { key: KEY, kind: 'ack' } }])
    // Both readings were fetched again after the write.
    expect(seen.signals).toBeGreaterThan(signalReads)
    expect(seen.loops).toBeGreaterThan(loopReads)
    expect(host.textContent).toContain('Nothing new needs you.')
    expect(railBadge(host).textContent).not.toContain('158')
    const standing = [...host.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === 'Standing')!
    expect(standing.textContent).toContain('1')

    await click([...standing.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Show'))
    await click(button(host, 'Undo'))
    expect(seen.writes[1]).toEqual({ method: 'DELETE', path: `/api/attention/acks/${encodeURIComponent(KEY)}`, body: null })
    expect(host.textContent).not.toContain('Nothing new needs you.')
    expect(railBadge(host).textContent).toContain('158')
    await act(async () => root.unmount())
  })
})

