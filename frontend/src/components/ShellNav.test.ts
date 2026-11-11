// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    systems: {
      gbrain: { state: 'warning', observedAt: new Date().toISOString(), reason: 'Embed-job probe unavailable.', detailHref: '/gbrain' },
      hermes: { state: 'warning', observedAt: new Date().toISOString(), reason: 'Hermes has a caveat.', detailHref: '/work' },
      openclaw: null,
    },
    attention: { count: 30, worst: 'critical', breakdown: { systems: 3, findings: 2, overdueConfirmations: 4, restricted: 21 } },
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
  it('shows the count once in words (top-bar pill, with the breakdown) and as a bare number in the sidebar badge', async () => {
    stubShell(false)
    const { host, root } = await mount(
      createElement('div', null, createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }), createElement(Sidebar, { collapsed: false, onToggleCollapsed: () => undefined, open: false, onClose: () => undefined })),
    )
    const pill = host.querySelector('a[href="/attention"][aria-label]') as HTMLAnchorElement
    expect(pill.getAttribute('aria-label')).toBe('30 need attention, 3 systems · 2 findings · 4 overdue · 21 restricted')
    const badge = [...host.querySelectorAll('nav a[href="/attention"]')].map((a) => a.textContent ?? '').join(' ')
    expect(badge).toContain('30')
    expect(badge).toContain('need attention')
    // The sidebar badge is the number only: the breakdown belongs to the top-bar pill.
    expect(badge).not.toContain('systems')
    expect(host.querySelector('nav a[href="/attention"] [title]')).toBeNull()
    // The loops signal's overdue count (24) is a different number and must not stand in for the attention count.
    expect(badge).not.toContain('24')
    await act(async () => root.unmount())
  })

  it('annunciators show the server reason and follow detailHref only to a screen that exists', async () => {
    stubShell(false)
    const { host, root } = await mount(
      createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }),
    )
    const gbrain = host.querySelector('ul[aria-label="Systems"] a[href="/gbrain"]') as HTMLAnchorElement
    expect(gbrain.getAttribute('title')).toBe('GBrain: warning. Embed-job could not be read.')
    // "/work" is a removed screen: the link falls back to the Services page instead of redirecting home.
    const hermes = [...host.querySelectorAll('ul[aria-label="Systems"] a')].find((a) => a.textContent?.includes('Hermes')) as HTMLAnchorElement
    expect(hermes.getAttribute('href')).toBe('/services')
    expect(hermes.getAttribute('title')).toBe('Hermes: warning. Hermes has a caveat.')
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

function stubSignals(signals: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      return url === '/api/signals' ? json(signals) : json({})
    }),
  )
  vi.stubGlobal(
    'matchMedia',
    (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList,
  )
}

describe('an unread count is not quiet', () => {
  const unreadSignals = {
    data: { ...SIGNALS.data, attention: null, automations: null, services: { down: null }, systems: { gbrain: null, hermes: null, openclaw: null } },
    meta: SIGNALS.meta,
  }

  it('shows a grey "not read" pill in the top bar instead of hiding the attention count', async () => {
    stubSignals(unreadSignals)
    const { host, root } = await mount(createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }))
    const pill = host.querySelector('a[href="/attention"]') as HTMLAnchorElement
    expect(pill).not.toBeNull()
    expect(pill.getAttribute('aria-label')).toBe('Attention not read')
    expect(pill.getAttribute('data-state')).toBe('unavailable')
    expect(pill.textContent).not.toMatch(/\b0\b/)
    await act(async () => root.unmount())
  })

  it('marks the sidebar items whose count was not read, without a number', async () => {
    stubSignals(unreadSignals)
    const { host, root } = await mount(
      createElement(Sidebar, { collapsed: false, onToggleCollapsed: () => undefined, open: false, onClose: () => undefined }),
    )
    for (const path of ['/attention', '/automations', '/services']) {
      const link = host.querySelector(`nav a[href="${path}"]`) as HTMLAnchorElement
      expect(link.querySelector('[data-tone="unread"]')).not.toBeNull()
      expect(link.textContent).toContain('count not read')
      expect(link.textContent).not.toMatch(/\d/)
    }
    await act(async () => root.unmount())
  })

  it('shows neither a pill nor a marker for a real zero', async () => {
    stubSignals({ data: { ...SIGNALS.data, attention: { count: 0, worst: null }, services: { down: 0 } }, meta: SIGNALS.meta })
    const { host, root } = await mount(createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }))
    expect(host.querySelector('a[href="/attention"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('top bar data age', () => {
  it('names the shell signals in its tooltip so it does not contradict a page freshness', async () => {
    stubShell(false)
    const { host, root } = await mount(createElement(TopBar, { onOpenMenu: () => undefined, onOpenPalette: () => undefined }))
    const age = host.querySelector('[title^="Signals updated"]') as HTMLElement
    expect(age).not.toBeNull()
    expect(age.textContent).toMatch(/^Updated /)
    const refresh = host.querySelector('button[aria-label="Refresh data"]') as HTMLButtonElement
    expect(refresh.getAttribute('title')).toMatch(/^Refresh data\. Signals updated /)
    await act(async () => root.unmount())
  })
})

describe('top bar layout contract', () => {
  // jsdom cannot measure layout. The four widths (1100, 1280, 1440, 1680) were measured in headless Chrome;
  // this keeps the rules that make the title survive from being edited away.
  const css = readFileSync(join(__dirname, 'TopBar.module.css'), 'utf8')

  it('keeps the page title at its content width and makes the bar a size container', () => {
    const title = css.slice(css.indexOf('.title {'), css.indexOf('}', css.indexOf('.title {')))
    expect(title).toMatch(/flex:\s*0 0 auto/)
    expect(css.slice(css.indexOf('.bar {'), css.indexOf('}', css.indexOf('.bar {')))).toMatch(/container-type:\s*inline-size/)
  })

  it('yields in a fixed order as the bar narrows: age, breakdown, words, annunciators, search, systems menu', () => {
    const steps = [...css.matchAll(/@container \(max-width: (\d+)px\)\s*{([^]*?)\n}\n/g)].map((match) => ({ width: Number(match[1]), body: match[2] }))
    const find = (needle: RegExp) => steps.find((step) => needle.test(step.body))?.width ?? 0
    const order = [find(/\.ageText/), find(/\.attentionSecondary/), find(/\.attentionWords/), find(/\.annName/), find(/\.paletteText/), find(/\.systemsMenu/)]
    expect(order.every((width) => width > 0)).toBe(true)
    expect([...order].sort((a, b) => b - a)).toEqual(order)
    expect(new Set(order).size).toBe(order.length)
  })
})
