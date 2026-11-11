// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { PageTitleProvider } from './ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const SIGNALS = {
  data: {
    systems: { gbrain: { state: 'warning', observedAt: new Date().toISOString() }, hermes: null, openclaw: null },
    attention: { count: 30, worst: 'critical' },
    automations: { failed: 0, nextRunAt: null },
    loops: { openFindings: 146, overdueConfirmations: 24 },
    services: { down: 0 },
    usage: null,
  },
  meta: { ok: true, stale: false, observedAt: new Date().toISOString(), ageMs: 0, error: null },
}

function stubShell(narrow: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      return url === '/api/signals' ? json(SIGNALS) : json({})
    }),
  )
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({ matches: narrow && query.includes('899'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
  )
}

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(PageTitleProvider, null, node)))),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('mobile navigation drawer', () => {
  const sidebar = (open: boolean, onClose = () => undefined) =>
    createElement(Sidebar, { collapsed: false, onToggleCollapsed: () => undefined, open, onClose })

  it('is a modal dialog while open on a narrow screen, with a close button', async () => {
    stubShell(true)
    const onClose = vi.fn()
    const { host, root } = await mount(sidebar(true, onClose))
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.getAttribute('role')).toBe('dialog')
    expect(aside.getAttribute('aria-modal')).toBe('true')
    expect(aside.getAttribute('aria-label')).toBe('Navigation')
    const close = host.querySelector('button[aria-label="Close navigation"]') as HTMLButtonElement
    await act(async () => close.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
  })

  it('is a plain landmark when closed, and on a wide screen', async () => {
    stubShell(true)
    const closed = await mount(sidebar(false))
    expect((closed.host.querySelector('aside') as HTMLElement).hasAttribute('role')).toBe(false)
    await act(async () => closed.root.unmount())
    document.body.innerHTML = ''

    stubShell(false)
    const wide = await mount(sidebar(true))
    const aside = wide.host.querySelector('aside') as HTMLElement
    expect(aside.hasAttribute('role')).toBe(false)
    expect(aside.hasAttribute('aria-modal')).toBe(false)
    await act(async () => wide.root.unmount())
  })
})

describe('one attention number', () => {
  it('shows the same count and words in the top-bar pill and the sidebar badge, with overdue as secondary text', async () => {
    stubShell(false)
    const { host, root } = await mount(
      createElement('div', null, createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }), createElement(Sidebar, { collapsed: false, onToggleCollapsed: () => undefined, open: false, onClose: () => undefined })),
    )
    const pill = host.querySelector('a[href="/attention"][aria-label]') as HTMLAnchorElement
    expect(pill.getAttribute('aria-label')).toBe('30 need attention, 24 overdue')
    const badge = [...host.querySelectorAll('nav a[href="/attention"]')].map((a) => a.textContent ?? '').join(' ')
    expect(badge).toContain('30')
    expect(badge).toContain('need attention')
    expect(badge).toContain('24 overdue')
    // The old sidebar number (overdue confirmations alone) must not stand in for the attention count.
    expect(badge).not.toMatch(/^Attention24\b/)
    await act(async () => root.unmount())
  })

  it('gives the page title a title attribute so it is readable when shortened', async () => {
    stubShell(false)
    const { host, root } = await mount(createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }))
    const h1 = host.querySelector('h1') as HTMLHeadingElement
    expect(h1.getAttribute('title')).toBe(h1.textContent)
    await act(async () => root.unmount())
  })
})
