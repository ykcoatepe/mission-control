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
    attention: { count: 30, worst: 'critical', standing: 117, restricted: 21, breakdown: { systems: 3, findings: 23, overdueConfirmations: 4 } },
    automations: { failed: 0, standingFailed: 2, nextRunAt: null },
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

const noop = () => undefined
const topBar = () => createElement(TopBar, { onOpenMenu: noop, onOpenPalette: noop })
const rail = () => createElement(Sidebar, { collapsed: false, onToggleCollapsed: noop, open: false, onClose: noop })

describe('the shell reads the badge rule', () => {
  it('has no attention pill in the top bar: the rail badge carries the count', async () => {
    stubShell(false)
    const { host, root } = await mount(topBar())
    expect(host.querySelector('a[href="/attention"]')).toBeNull()
    expect(host.textContent).not.toMatch(/need attention/)
    await act(async () => root.unmount())
  })

  it('counts only new items in the Attention badge: not standing, not restricted', async () => {
    stubShell(false)
    const { host, root } = await mount(rail())
    const link = host.querySelector('nav a[href="/attention"]') as HTMLAnchorElement
    const badge = link.querySelector('[data-testid="nav-badge"]') as HTMLElement
    expect(badge.getAttribute('data-state')).toBe('critical')
    expect(badge.textContent).toContain('30')
    expect(badge.textContent).toContain('need attention')
    expect(link.textContent).not.toContain('117')
    expect(link.textContent).not.toContain('21')
    // The loops signal's overdue count (24) is a different number and must not stand in for it.
    expect(link.textContent).not.toContain('24')
    // The badge shows a shape, not colour alone.
    expect(badge.querySelector('svg')?.getAttribute('data-shape')).toBe('square')
    await act(async () => root.unmount())
  })

  it('draws no Attention badge when only standing items remain', async () => {
    stubSignals({ data: { ...SIGNALS.data, attention: { count: 0, worst: 'healthy', standing: 147, restricted: 129 } }, meta: SIGNALS.meta })
    const { host, root } = await mount(rail())
    const link = host.querySelector('nav a[href="/attention"]') as HTMLAnchorElement
    expect(link.querySelector('[data-testid="nav-badge"]')).toBeNull()
    expect(link.querySelector('[data-state]')).toBeNull()
    expect(link.textContent).toBe('Attention')
    await act(async () => root.unmount())
  })

  it('badges Automations with failed jobs that are not acknowledged, and has no Services badge', async () => {
    stubSignals({ data: { ...SIGNALS.data, automations: { failed: 3, standingFailed: 2, nextRunAt: null }, services: { down: 4 } }, meta: SIGNALS.meta })
    const { host, root } = await mount(rail())
    const automations = host.querySelector('nav a[href="/automations"] [data-testid="nav-badge"]') as HTMLElement
    expect(automations.textContent).toContain('3')
    expect(automations.textContent).toContain('failed')
    expect(host.querySelector('nav a[href="/services"] [data-testid="nav-badge"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('lists the routes flat, in the order of the spec', async () => {
    stubShell(false)
    const { host, root } = await mount(rail())
    const labels = [...host.querySelectorAll('nav a')].map((a) => a.querySelector('span')?.textContent)
    expect(labels).toEqual(['Brain', 'Attention', 'Automations', 'Usage', 'Services', 'Local models', 'Settings', 'Audit'])
    expect(host.querySelectorAll('nav h2')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('annunciators read mark + name + word, with the server reason, and follow detailHref only to a screen that exists', async () => {
    stubShell(false)
    const { host, root } = await mount(topBar())
    const gbrain = host.querySelector('ul[aria-label="Systems"] a[href="/gbrain"]') as HTMLAnchorElement
    expect(gbrain.getAttribute('title')).toBe('GBrain: caution. Embed-job could not be read.')
    expect(gbrain.textContent).toBe('GBraincaution')
    expect(gbrain.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
    // "/work" is a removed screen: the link falls back to the Services page instead of redirecting home.
    const hermes = [...host.querySelectorAll('ul[aria-label="Systems"] a')].find((a) => a.textContent?.includes('Hermes')) as HTMLAnchorElement
    expect(hermes.getAttribute('href')).toBe('/services')
    expect(hermes.getAttribute('title')).toBe('Hermes: caution. Hermes has a caveat.')
    const openclaw = [...host.querySelectorAll('ul[aria-label="Systems"] a')].find((a) => a.textContent?.includes('OpenClaw')) as HTMLAnchorElement
    expect(openclaw.textContent).toBe('OpenClawnot read')
    expect(openclaw.querySelector('svg')?.getAttribute('data-shape')).toBe('ring')
    await act(async () => root.unmount())
  })

  it('a normal system stays neutral: its word is shown, with the plain circle', async () => {
    const now = new Date().toISOString()
    stubSignals({
      data: { ...SIGNALS.data, systems: { gbrain: { state: 'healthy', observedAt: now }, hermes: { state: 'healthy', observedAt: now }, openclaw: { state: 'healthy', observedAt: now } } },
      meta: SIGNALS.meta,
    })
    const { host, root } = await mount(topBar())
    const first = host.querySelector('ul[aria-label="Systems"] a') as HTMLAnchorElement
    expect(first.textContent).toBe('GBrainnormal')
    expect(first.getAttribute('data-state')).toBe('healthy')
    expect(first.querySelector('svg')?.getAttribute('data-shape')).toBe('circle')
    await act(async () => root.unmount())
  })

  it('gives the page title a title attribute so it is readable when shortened', async () => {
    stubShell(false)
    const { host, root } = await mount(topBar())
    const h1 = host.querySelector('h1') as HTMLHeadingElement
    expect(h1.getAttribute('title')).toBe(h1.textContent)
    await act(async () => root.unmount())
  })

  it('offers the command palette as "Search or run…"', async () => {
    stubShell(false)
    const { host, root } = await mount(topBar())
    expect(host.querySelector('button[aria-label="Open command palette"]')?.textContent).toContain('Search or run…')
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

  it('marks the rail items whose count was not read with a hollow circle and no number', async () => {
    stubSignals(unreadSignals)
    const { host, root } = await mount(rail())
    for (const path of ['/attention', '/automations']) {
      const link = host.querySelector(`nav a[href="${path}"]`) as HTMLAnchorElement
      expect(link.querySelector('svg[data-shape="ring"]')).not.toBeNull()
      expect(link.textContent).toContain('count not read')
      expect(link.textContent).not.toMatch(/\d/)
    }
    await act(async () => root.unmount())
  })

  it('shows every system as not read, never as normal', async () => {
    stubSignals(unreadSignals)
    const { host, root } = await mount(topBar())
    const words = [...host.querySelectorAll('ul[aria-label="Systems"] a')].map((a) => a.textContent)
    expect(words).toEqual(['GBrainnot read', 'Hermesnot read', 'OpenClawnot read'])
    await act(async () => root.unmount())
  })

  it('shows neither a badge nor a marker for a real zero', async () => {
    stubSignals({ data: { ...SIGNALS.data, attention: { count: 0, worst: 'healthy' }, automations: { failed: 0, nextRunAt: null } }, meta: SIGNALS.meta })
    const { host, root } = await mount(rail())
    expect(host.querySelector('[data-testid="nav-badge"]')).toBeNull()
    expect(host.querySelector('nav svg[data-shape="ring"]')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('top bar data age', () => {
  it('annotates only a stale reading, and names the shell signals in the tooltip', async () => {
    stubShell(false)
    const { host, root } = await mount(topBar())
    const age = host.querySelector('[title^="Signals updated"]') as HTMLElement
    expect(age).not.toBeNull()
    // A fresh reading carries no annotation.
    expect(age.textContent).toBe('')
    const refresh = host.querySelector('button[aria-label="Refresh data"]') as HTMLButtonElement
    expect(refresh.getAttribute('title')).toMatch(/^Refresh data\. Signals updated /)
    await act(async () => root.unmount())
  })

  it('says "as of" with a caution mark when the signals are stale', async () => {
    stubSignals({ ...SIGNALS, meta: { ...SIGNALS.meta, stale: true } })
    const { host, root } = await mount(topBar())
    const note = host.querySelector('[title="The server is serving an older reading."]') as HTMLElement
    expect(note.textContent).toMatch(/^Signals as of \d{2}:\d{2}$/)
    expect(note.querySelector('svg')?.getAttribute('data-shape')).toBe('triangle')
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

  it('yields in a fixed order as the bar narrows: stale note, system words, names, search, systems menu', () => {
    const steps = [...css.matchAll(/@container \(max-width: (\d+)px\)\s*{([^]*?)\n}\n/g)].map((match) => ({ width: Number(match[1]), body: match[2] }))
    const find = (needle: RegExp) => steps.find((step) => needle.test(step.body))?.width ?? 0
    const order = [find(/\.staleText/), find(/\.annWord/), find(/\.annName/), find(/\.paletteText/), find(/\.systemsMenu/)]
    expect(order.every((width) => width > 0)).toBe(true)
    expect([...order].sort((a, b) => b - a)).toEqual(order)
    expect(new Set(order).size).toBe(order.length)
  })
})
