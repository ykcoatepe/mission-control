// @vitest-environment jsdom

// Behaviour of the Usage page as a whole: the data-handling rules the page must keep
// no matter how it is laid out (historical months, no fabricated values, stable model
// colours, polling and calendar revalidation). Rendered against a stubbed network.

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Costs from './Costs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Handler = unknown | (() => unknown | Promise<unknown>)

let routes: Record<string, Handler> = {}
let calls: string[] = []
let root: Root | null = null
let host: HTMLElement | null = null

function respond(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const key = `${url.pathname}${url.search}`
    calls.push(`${init?.method ?? 'GET'} ${key}`)
    const handler = routes[key]
    if (handler === undefined) return respond({})
    const body = typeof handler === 'function' ? await (handler as () => unknown)() : handler
    return respond(body)
  }))
}

const NEVER = () => new Promise(() => {})

const CLEAN_META = { updatedAt: '2026-08-15T10:00:00Z', refreshing: false, stale: false }

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    source: 'token-usage.csv',
    period: { key: 'month', anchor: null },
    serverMonth: '2026-08',
    daily: [],
    dailyByModel: [],
    byService: [],
    agents: [],
    summary: { periodUsd: 0, thisMonthUsd: 0, periodTokens: 0, thisMonthTokens: 0, totalTokens: 0, periodApiEquivalentUsd: 20 },
    apiEquivalentReliability: 'estimated',
    meta: CLEAN_META,
    ...overrides,
  }
}

function dayRow(date: string, models: Record<string, number>) {
  const row: Record<string, unknown> = { date, totalCost: 0, apiEquivalentCost: 0, totalTokens: 0 }
  for (const [model, usd] of Object.entries(models)) {
    row[model] = 0
    row[`${model}_tokens`] = Math.round(usd * 1000)
    row[`${model}_apiEquivalentUsd`] = usd
    row[`${model}_apiEquivalentStatus`] = 'estimated'
    row.apiEquivalentCost = Number(row.apiEquivalentCost) + usd
    row.totalTokens = Number(row.totalTokens) + Math.round(usd * 1000)
  }
  return row
}

const MONTHS = {
  months: [{ month: '2026-07', hasData: true, sources: ['codexbar'] }],
  generatedAt: '2026-08-15T10:00:00Z',
  partial: false,
  sourceStatus: { hermes: 'ready', codexbar: 'ready', cached: 'ready' },
}

const EMPTY_CODEXBAR = {
  source: 'codexbar', provider: 'both', updatedAt: null, last30DaysCostUSD: 0, last30DaysTokens: 0,
  sessionCostUSD: 0, sessionTokens: 0, totals: { totalCost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 }, daily: [],
}

function baseRoutes(): Record<string, Handler> {
  return {
    '/api/config': { modules: {} },
    '/api/aws/costs': {},
    '/api/sessions': { sessions: [] },
    '/api/costs/codexbar': EMPTY_CODEXBAR,
    '/api/costs/months': MONTHS,
    '/api/costs?period=month': ledger(),
  }
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(Costs)))))
  await flush(10)
  return host
}

function button(label: RegExp | string) {
  const match = Array.from(host!.querySelectorAll<HTMLElement>('button, [role="tab"], [role="radio"]')).find(el => (
    typeof label === 'string'
      ? el.textContent?.trim() === label || el.getAttribute('aria-label') === label
      : label.test(el.textContent ?? '') || label.test(el.getAttribute('aria-label') ?? '')
  ))
  if (!match) throw new Error(`No control matches ${String(label)}`)
  return match
}

async function click(label: RegExp | string) {
  await act(async () => button(label).click())
  await flush(10)
}

function summaryText() {
  return host!.querySelector('[role="group"][aria-label^="Usage for"]')?.textContent ?? ''
}

function legend() {
  return Array.from(host!.querySelectorAll('ul[aria-label="Models in the chart"] li')).map(li => ({
    name: li.querySelector('span:last-child')?.textContent ?? '',
    color: li.querySelector('span')?.getAttribute('style') ?? '',
  }))
}

function tableFirstColumn() {
  return Array.from(host!.querySelectorAll('tbody tr')).map(row => row.querySelector('td, th')?.textContent?.trim() ?? '')
}

beforeEach(() => {
  routes = baseRoutes()
  calls = []
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0))
  stubFetch()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host?.remove()
  host = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Usage page: a historical month', () => {
  const sessions = { sessions: [{ key: 'agent:main:main', model: 'live-session-model', totalTokens: 777_777, updatedAt: '2026-08-15T11:00:00Z' }] }
  const julyRows = {
    ...EMPTY_CODEXBAR,
    // The endpoint widens its scan for an anchored month, so the payload also carries a June row.
    daily: [
      {
        date: '2026-06-30', totalCost: 80, totalTokens: 9000, inputTokens: 9000, outputTokens: 0,
        models: [{ model: 'june-only-model', cost: 80, totalTokens: 9000 }],
      },
      {
        date: '2026-07-10', totalCost: 3, totalTokens: 4000, inputTokens: 3000, outputTokens: 1000,
        models: [{ model: 'july-codexbar-model', cost: 3, totalTokens: 4000 }],
      },
    ],
  }

  beforeEach(() => {
    routes['/api/config'] = { modules: { aws: true }, aws: { enabled: true } }
    routes['/api/aws/costs'] = { total: 999, credits: 1000, remaining: 1, daily: [], services: [] }
    routes['/api/sessions'] = sessions
    routes['/api/costs/codexbar?month=2026-07'] = julyRows
    // The anchored ledger has not landed yet; its slot is an empty pending payload.
    routes['/api/costs?period=month&month=2026-07'] = ledger({
      source: 'anchored.pending',
      period: { key: 'month', anchor: '2026-07' },
      summary: {},
      meta: { refreshing: true },
    })
  })

  it('anchors both queries to the month and shows only anchored data, never live totals', async () => {
    await mount()
    await click('Show July 2026')

    expect(calls).toContain('GET /api/costs?period=month&month=2026-07')
    expect(calls).toContain('GET /api/costs/codexbar?month=2026-07')

    // Token volume comes from the anchored codexbar rows, not today's sessions.
    expect(summaryText()).toContain('4,000 in this period')
    expect(host!.textContent).not.toContain('777,777')
    // AWS live billing always describes the current month, so it is not relabelled as July.
    expect(host!.textContent).not.toContain('$999')
    expect(summaryText()).toContain('API equivalent')

    // The model breakdown uses the anchored rows; live sessions are not that month's models.
    await click('By model')
    expect(tableFirstColumn().join(' ')).toContain('july-codexbar-model')
    expect(host!.textContent).not.toContain('live-session-model')
  })

  it('labels the live-only sessions view so current sessions are not read as the month\'s drivers', async () => {
    await mount()
    await click('Show July 2026')
    await click('Live sessions')
    expect(host!.textContent).toContain('not scoped to July 2026')
    // The session is still shown, but flagged as live rather than July usage.
    expect(host!.textContent).toContain('live-session-model')
  })

  it('reports a finished month as a total, not a projection', async () => {
    await mount()
    expect(summaryText()).toContain('Projection')
    await click('Show July 2026')
    expect(summaryText()).not.toContain('Projection')
  })

  it('treats anchored codexbar rows as activity even when the live 30-day figure is zero', async () => {
    await mount()
    await click('Show July 2026')
    expect(julyRows.last30DaysCostUSD).toBe(0)
    expect(summaryText()).toContain('$3.00')
  })

  it('never reports live session tokens as a past month\'s volume while its rows are missing', async () => {
    routes['/api/config'] = { modules: {} }
    routes['/api/costs/codexbar?month=2026-07'] = EMPTY_CODEXBAR
    routes['/api/costs?period=month'] = {
      source: 'sessions.fast_fallback', period: { key: 'month', anchor: null }, serverMonth: '2026-08',
      daily: [], byService: [], summary: {}, meta: { refreshing: true },
    }
    await mount()
    // Live view: the fallback may describe today's sessions.
    expect(host!.textContent).toContain('777,777 tokens')
    await click('Show July 2026')
    expect(host!.textContent).not.toContain('777,777')
  })

  it('totals and lists only the selected month\'s rows, not the whole widened scan', async () => {
    await mount()
    await click('Show July 2026')
    expect(summaryText()).toContain('4,000 in this period')
    expect(summaryText()).not.toContain('13,000')
    await click('By model')
    expect(host!.textContent).not.toContain('june-only-model')
  })

  it('divides an anchored month by its real length even when the payload has fewer day rows', async () => {
    routes['/api/costs?period=month&month=2026-07'] = ledger({
      period: { key: 'month', anchor: '2026-07' },
      daily: [{ date: '2026-07-01', tokens: 1 }, { date: '2026-07-02', tokens: 1 }],
      summary: { periodUsd: 0, thisMonthUsd: 0, periodTokens: 2, thisMonthTokens: 2, totalTokens: 2, periodApiEquivalentUsd: 62 },
      meta: CLEAN_META,
    })
    await mount()
    await click('Show July 2026')
    // $62 over July's 31 days is $2.00 a day; dividing by the two rows present would give $31.00.
    expect(summaryText()).toMatch(/Daily pace\$2\.00/)
  })

  it('stepping forward onto the current month drops the anchor and returns to the live view', async () => {
    await mount()
    await click('Show July 2026')
    expect(summaryText()).not.toContain('Projection')
    await click('Show August 2026')
    expect(summaryText()).toContain('Projection')
    expect(host!.querySelector('[aria-haspopup="dialog"]')?.textContent).toBe('August 2026')
  })
})

describe('Usage page: server calendar authority', () => {
  it('keeps a just-selected month when the server month is ahead of the browser clock', async () => {
    // Browser: 31 Aug 23:30. Server: already September.
    vi.setSystemTime(new Date(2026, 7, 31, 23, 30, 0))
    routes['/api/costs?period=month'] = ledger({ serverMonth: '2026-09', period: { key: 'month', anchor: null } })
    routes['/api/costs?period=month&month=2026-08'] = NEVER
    await mount()

    expect(host!.textContent).toContain('September 2026')
    await click('Show August 2026')
    await flush(50)

    // The anchored query is still loading (no payload, so no serverMonth). Falling back to
    // the browser clock would call August "the current month" and wipe the anchor.
    expect(calls).toContain('GET /api/costs?period=month&month=2026-08')
    expect(button(/August 2026/).getAttribute('aria-haspopup')).toBe('dialog')
    expect(host!.querySelector('[aria-haspopup="dialog"]')?.textContent).toBe('August 2026')
  })
})

describe('Usage page: no fabricated values', () => {
  it('shows nothing priced for sessions that have no priced ledger', async () => {
    routes['/api/sessions'] = { sessions: [{ key: 'agent:main:main', model: 'mystery-model', totalTokens: 5000, updatedAt: '2026-08-15T11:00:00Z' }] }
    routes['/api/costs?period=month'] = {
      source: 'sessions.fast_fallback', period: { key: 'month', anchor: null }, serverMonth: '2026-08',
      daily: [], byService: [], summary: {}, meta: { refreshing: true },
    }
    await mount()

    const summary = summaryText()
    expect(summary).not.toMatch(/\$\s?\d/)
    expect(summary).toContain('not read')
    expect(host!.textContent).toContain('Estimate unavailable')

    await click('By model')
    expect(tableFirstColumn().join(' ')).toContain('mystery-model')
    // The session carries tokens only: its API-equivalent cell is a dash, not a guessed price.
    const row = Array.from(host!.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('mystery-model'))
    expect(row?.querySelectorAll('td')[1]?.textContent).toBe('—')
    expect(row?.querySelectorAll('td')[2]?.textContent).toBe('—')
  })

  it('does not fall back to month or all-time tokens when the selected period is empty', async () => {
    routes['/api/costs?period=month'] = ledger({
      summary: { periodUsd: 0, periodTokens: 0, thisMonthTokens: 5000, totalTokens: 90_000, periodApiEquivalentUsd: 0 },
    })
    await mount()
    expect(summaryText()).toContain('0 in this period')
    expect(summaryText()).not.toContain('5,000')
    expect(summaryText()).not.toContain('90,000')
  })

  it('ranks the complete model set by API-equivalent cost and leaves unpriced models unranked by price', async () => {
    routes['/api/costs?period=month'] = ledger({
      byService: [
        { name: 'small-priced', tokens: 1000, cost: 0, apiEquivalentUsd: 1, apiEquivalentStatus: 'estimated' },
        { name: 'big-priced', tokens: 100, cost: 0, apiEquivalentUsd: 9, apiEquivalentStatus: 'estimated' },
        { name: 'huge-unpriced', tokens: 99_999, cost: 0, apiEquivalentStatus: 'unavailable' },
      ],
    })
    await mount()
    await click('By model')
    expect(tableFirstColumn()).toEqual(['big-priced', 'small-priced', 'huge-unpriced'])
    const unpriced = Array.from(host!.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('huge-unpriced'))
    expect(unpriced?.textContent).not.toMatch(/\$\s?\d+\.\d\d.*\$\s?\d+\.\d\d.*\$\s?\d+\.\d\d/)
    expect(unpriced?.querySelectorAll('td')[1]?.textContent).toBe('—')
  })
})

describe('Usage page: model colours', () => {
  const month = ledger({
    summary: { periodUsd: 0, periodTokens: 1, thisMonthTokens: 1, totalTokens: 1, periodApiEquivalentUsd: 30 },
    dailyByModel: [dayRow('2026-08-01', { 'alpha-model': 10, 'beta-model': 8, 'gamma-model': 4 })],
  })
  const week = ledger({
    period: { key: '7d', anchor: null },
    summary: { periodUsd: 0, periodTokens: 1, thisMonthTokens: 1, totalTokens: 1, periodApiEquivalentUsd: 30 },
    dailyByModel: [dayRow('2026-08-14', { 'beta-model': 12, 'gamma-model': 6, 'delta-model': 3 })],
  })

  const colourOf = (name: string) => legend().find(item => item.name === name)?.color

  it('keeps each model on its colour in every view: Month, 7 days and back', async () => {
    routes['/api/costs?period=month'] = month
    routes['/api/costs?period=7d'] = week
    await mount()
    const before = { beta: colourOf('beta-model'), gamma: colourOf('gamma-model'), alpha: colourOf('alpha-model') }
    expect(new Set(Object.values(before)).size).toBe(3)
    for (const colour of Object.values(before)) expect(colour).toMatch(/var\(--series-[1-6]\)/)

    await click('7 days')
    expect(colourOf('beta-model')).toBe(before.beta)
    expect(colourOf('gamma-model')).toBe(before.gamma)
    // alpha is not in this period, but it still owns its colour: the newcomer must not take it,
    // otherwise the same colour would mean a different model in the next view.
    const delta = colourOf('delta-model')
    expect(Object.values(before)).not.toContain(delta)

    await click('Month')
    expect(colourOf('alpha-model')).toBe(before.alpha)
    expect(colourOf('beta-model')).toBe(before.beta)
    expect(colourOf('gamma-model')).toBe(before.gamma)

    await click('7 days')
    expect(colourOf('delta-model')).toBe(delta)
  })

  it('retains the assignments while the replacement period is still loading', async () => {
    let releaseWeek: (value: unknown) => void = () => {}
    routes['/api/costs?period=month'] = month
    routes['/api/costs?period=7d'] = () => new Promise(resolve => { releaseWeek = resolve })
    await mount()
    const betaBefore = colourOf('beta-model')
    const alphaBefore = colourOf('alpha-model')

    await click('7 days')
    expect(legend()).toEqual([]) // nothing to colour yet
    await act(async () => releaseWeek(week))
    await flush(10)

    expect(colourOf('beta-model')).toBe(betaBefore)
    expect(colourOf('delta-model')).not.toBe(alphaBefore)
  })

  it('does not let reasoning metrics reserve a model colour', async () => {
    const row = dayRow('2026-08-01', { 'alpha-model': 10, 'beta-model': 8 })
    // A reasoning column carries numbers of its own; it must still not become a series.
    row['alpha-model_reasoning'] = 5000
    row['alpha-model_reasoning_tokens'] = 5000
    row['alpha-model_reasoning_apiEquivalentUsd'] = 2
    row['beta-model_reasoning'] = 4000
    routes['/api/costs?period=month'] = ledger({ dailyByModel: [row] })
    await mount()
    expect(legend().map(item => item.name).sort()).toEqual(['alpha-model', 'beta-model'])
  })
})

describe('Usage page: polling and calendar revalidation', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0))
  })

  const count = (path: string) => calls.filter(call => call === `GET ${path}`).length

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  async function mountWithFakeTimers() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(Costs)))))
    await advance(5)
  }

  it('re-polls the costs query while the data is a fast fallback, then stops once it settles', async () => {
    let settled = false
    routes['/api/costs?period=month'] = () => settled
      ? ledger()
      : { source: 'sessions.fast_fallback', period: { key: 'month', anchor: null }, serverMonth: '2026-08', daily: [], byService: [], summary: {}, meta: { refreshing: true } }
    await mountWithFakeTimers()
    expect(count('/api/costs?period=month')).toBe(1)
    await advance(2500)
    expect(count('/api/costs?period=month')).toBe(2)
    settled = true
    await advance(2500)
    expect(count('/api/costs?period=month')).toBe(3)
    await advance(30_000)
    expect(count('/api/costs?period=month')).toBe(3)
  })

  it('revalidates the usage queries and the month availability when the window regains focus', async () => {
    await mountWithFakeTimers()
    const before = {
      costs: count('/api/costs?period=month'),
      codexbar: count('/api/costs/codexbar'),
      months: count('/api/costs/months'),
    }
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await advance(5)
    expect(count('/api/costs?period=month')).toBe(before.costs + 1)
    expect(count('/api/costs/codexbar')).toBe(before.codexbar + 1)
    expect(count('/api/costs/months')).toBe(before.months + 1)
  })

  it('revalidates calendar metadata on a 30 minute cadence, independent of browser midnight', async () => {
    await mountWithFakeTimers()
    const before = count('/api/costs?period=month')
    await advance(29 * 60 * 1000)
    expect(count('/api/costs?period=month')).toBe(before)
    await advance(60 * 1000 + 5)
    expect(count('/api/costs?period=month')).toBe(before + 1)
  })
})

describe('Usage page: unknown is never zero', () => {
  const unknownBilling = ledger({
    summary: { periodUsd: null, thisMonthUsd: null, periodTokens: 300, thisMonthTokens: 300, totalTokens: 300, periodApiEquivalentUsd: 12 },
    byService: [
      { name: 'Claude Code / claude-opus-x', tokens: 100, cost: null, costSource: 'unknown', costStatus: 'unknown', apiEquivalentUsd: 5, apiEquivalentStatus: 'estimated' },
      { name: 'Claude Code / claude-opus-y', tokens: 100, cost: null, costSource: 'unknown', costStatus: 'unknown', apiEquivalentUsd: 4, apiEquivalentStatus: 'estimated' },
      { name: 'Hermes / recorded-model', tokens: 100, cost: 2.5, costSource: 'recorded', costStatus: 'recorded', apiEquivalentUsd: 3, apiEquivalentStatus: 'estimated' },
      { name: 'Hermes / free-model', tokens: 50, cost: 0, costSource: 'recorded', costStatus: 'recorded', apiEquivalentUsd: 0, apiEquivalentStatus: 'estimated' },
    ],
  })

  function trackedSpendCells() {
    const headers = Array.from(host!.querySelectorAll('thead th')).map(th => th.textContent?.trim())
    const column = headers.indexOf('Tracked spend')
    return Array.from(host!.querySelectorAll('tbody tr')).map(row => ({
      name: row.querySelector('td, th')?.textContent?.trim() ?? '',
      tracked: row.querySelectorAll('td, th')[column]?.textContent?.trim() ?? '',
    }))
  }

  it('shows a dash in Tracked spend for a model whose billing is unknown, and a real $0.00 only for a recorded zero', async () => {
    routes['/api/costs?period=month'] = unknownBilling
    await mount()
    const cells = trackedSpendCells()
    expect(cells.find(row => row.name.startsWith('Claude Opus'))?.tracked).toBe('—')
    expect(cells.find(row => row.name.includes('recorded-model'))?.tracked).toBe('$2.50')
    expect(cells.find(row => row.name.includes('free-model'))?.tracked).toBe('$0.00')
    // The headline already says the tracked spend is not read.
    expect(summaryText()).toContain('Tracked spend')
    expect(summaryText()).not.toMatch(/Tracked spend\s*\$0/)
  })

  it('one variant with unknown billing makes the grouped model unknown, not a partial sum', async () => {
    routes['/api/costs?period=month'] = ledger({
      summary: { periodUsd: null, periodTokens: 200, thisMonthTokens: 200, totalTokens: 200, periodApiEquivalentUsd: 9 },
      byService: [
        { name: 'Claude Code / claude-opus-x', tokens: 100, cost: 4, costSource: 'recorded', costStatus: 'recorded', apiEquivalentUsd: 5, apiEquivalentStatus: 'estimated' },
        { name: 'Claude Code / claude-opus-y', tokens: 100, cost: null, costSource: 'unknown', costStatus: 'unknown', apiEquivalentUsd: 4, apiEquivalentStatus: 'estimated' },
      ],
    })
    await mount()
    expect(trackedSpendCells()).toEqual([{ name: expect.stringContaining('Claude Opus'), tracked: '—' }])
  })

  it('shows live-session models without a spend figure', async () => {
    routes['/api/costs?period=month'] = ledger({ source: 'sessions.fallback', summary: {}, byService: [] })
    routes['/api/sessions'] = { sessions: [{ key: 'agent:main:main', model: 'live-session-model', totalTokens: 4000, updatedAt: '2026-08-15T11:00:00Z' }] }
    await mount()
    expect(trackedSpendCells().map(row => row.tracked)).toEqual(['—'])
  })

  it('a platform that recorded nothing is "No usage recorded" with dashes and no billed figure', async () => {
    routes['/api/costs?period=month'] = ledger({
      providers: [
        { id: 'codex', label: 'Codex', state: 'ready', observedAt: '2026-08-15T10:00:00Z', coverage: 'complete', tokens: 50, apiEquivalentUsd: 4, billedUsd: null, note: null },
        { id: 'openclaw', label: 'OpenClaw', state: 'ready', observedAt: '2026-08-15T10:00:00Z', coverage: 'complete', tokens: 0, apiEquivalentUsd: 0, billedUsd: null, hasRecords: false, billingKnown: false, coverageReason: 'none', note: 'billing unknown unless explicitly recorded' },
      ],
    })
    await mount()
    const rows = Array.from(host!.querySelectorAll('#usage-platforms tbody tr')).map(row => Array.from(row.querySelectorAll('td, th')).map(cell => cell.textContent?.trim() ?? ''))
    const openclaw = rows.find(row => row[0] === 'OpenClaw')!
    expect(openclaw[1]).toContain('No usage recorded')
    expect(openclaw.slice(2, 5)).toEqual(['—', '—', '—'])
  })
})

describe('Usage page: AWS billing request', () => {
  it('does not request AWS costs while the public config says AWS is off, or before the config has loaded', async () => {
    routes['/api/config'] = { modules: { aws: false }, aws: { enabled: false } }
    await mount()
    expect(calls.some(call => call.includes('/api/aws/costs'))).toBe(false)
  })

  it('requests AWS costs when the config turns the integration on', async () => {
    routes['/api/config'] = { modules: { aws: true }, aws: { enabled: true } }
    routes['/api/aws/costs'] = { total: 5, credits: 100, remaining: 50, daily: [], services: [] }
    await mount()
    expect(calls).toContain('GET /api/aws/costs')
  })
})

describe('Usage page: the period is in the address', () => {
  function Probe() {
    const here = useLocation()
    return createElement('output', { 'data-testid': 'location' }, `${here.pathname}${here.search}`)
  }
  const location = () => host!.querySelector('[data-testid="location"]')?.textContent

  async function mountAt(path: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root!.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(QueryClientProvider, { client }, createElement(Probe), createElement(Costs)))))
    await flush(10)
  }

  beforeEach(() => {
    routes['/api/costs?period=7d'] = ledger({ period: { key: '7d', anchor: null } })
    routes['/api/costs?period=day'] = ledger({ period: { key: 'day', anchor: null } })
  })

  it('writes the chosen period and month to the query and leaves the defaults out', async () => {
    await mountAt('/usage')
    expect(location()).toBe('/usage')
    await click('7 days')
    expect(location()).toBe('/usage?period=7d')
    await click('Day')
    expect(location()).toBe('/usage?period=day')
    await click('Month')
    expect(location()).toBe('/usage')
    await click('Show July 2026')
    expect(location()).toBe('/usage?month=2026-07')
  })

  it('opens on the period and month named in the address, and ignores a value it does not know', async () => {
    await mountAt('/usage?period=7d')
    expect(calls).toContain('GET /api/costs?period=7d')
    document.body.innerHTML = ''
    calls = []
    await mountAt('/usage?period=bogus&month=not-a-month')
    expect(calls).toContain('GET /api/costs?period=month')
    expect(calls.some(call => call.includes('month=not-a-month'))).toBe(false)
  })
})

describe('Usage page: the comparison says which days it compares', () => {
  it('labels the live-month comparison with the elapsed days of the month before, not "previous month"', async () => {
    routes['/api/costs?period=month'] = ledger({
      period: { key: 'month', anchor: null, start: '2026-08-01', end: '2026-08-11', previousStart: '2026-07-01', previousEnd: '2026-07-11', previousIsPartial: true },
      summary: {
        periodUsd: null, periodTokens: 10, thisMonthTokens: 10, totalTokens: 10,
        periodApiEquivalentUsd: 20, previousPeriodApiEquivalentUsd: 100, previousPeriodApiEquivalentReliability: 'estimated',
      },
    })
    await mount()
    expect(summaryText()).toContain('vs the first 11 days of July ($100.00)')
    expect(summaryText()).not.toContain('previous month')
  })

  it('names the dates the server compared, not the dates the page works out from the current window', async () => {
    routes['/api/costs?period=month'] = ledger({
      // The current window says 11 days; the server says it compared only 5 (the 7th to the 11th).
      period: { key: 'month', anchor: null, start: '2026-08-01', end: '2026-08-11', previousStart: '2026-07-07', previousEnd: '2026-07-11', previousIsPartial: true },
      summary: {
        periodUsd: null, periodTokens: 10, thisMonthTokens: 10, totalTokens: 10,
        periodApiEquivalentUsd: 20, previousPeriodApiEquivalentUsd: 100, previousPeriodApiEquivalentReliability: 'estimated',
      },
    })
    await mount()
    expect(summaryText()).toContain('vs 7–11 July ($100.00)')
    expect(summaryText()).not.toContain('first 11 days')
  })

  it('says "previous month" when the server sent no comparison dates, and does not invent a span', async () => {
    routes['/api/costs?period=month'] = ledger({
      period: { key: 'month', anchor: null, start: '2026-08-01', end: '2026-08-11' },
      summary: {
        periodUsd: null, periodTokens: 10, thisMonthTokens: 10, totalTokens: 10,
        periodApiEquivalentUsd: 20, previousPeriodApiEquivalentUsd: 100, previousPeriodApiEquivalentReliability: 'estimated',
      },
    })
    await mount()
    expect(summaryText()).toContain('vs the previous month ($100.00)')
    expect(summaryText()).not.toContain('first 11 days')
  })
})

describe('Usage page: colours stay with the model across Day, 7 days and Month', () => {
  it('a model keeps its colour when a period shows a different set of models', async () => {
    const colourOf = (name: string) => legend().find(item => item.name === name)?.color
    routes['/api/costs?period=month'] = ledger({
      dailyByModel: [dayRow('2026-08-01', { 'a-model': 40, 'b-model': 30, 'c-model': 20, 'd-model': 10 })],
    })
    routes['/api/costs?period=day'] = ledger({
      period: { key: 'day', anchor: null },
      dailyByModel: [dayRow('2026-08-15', { 'e-model': 9, 'c-model': 8 })],
    })
    routes['/api/costs?period=7d'] = ledger({
      period: { key: '7d', anchor: null },
      dailyByModel: [dayRow('2026-08-14', { 'd-model': 9, 'e-model': 8, 'a-model': 7 })],
    })
    await mount()
    const month = ['a', 'b', 'c', 'd'].map(name => colourOf(`${name}-model`))
    await click('Day')
    const day = { c: colourOf('c-model'), e: colourOf('e-model') }
    await click('7 days')
    const week = { a: colourOf('a-model'), d: colourOf('d-model'), e: colourOf('e-model') }
    await click('Month')

    expect(day.c).toBe(month[2])
    expect(week.a).toBe(month[0])
    expect(week.d).toBe(month[3])
    expect(week.e).toBe(day.e)
    expect(['a', 'b', 'c', 'd'].map(name => colourOf(`${name}-model`))).toEqual(month)
    expect(month).not.toContain(day.e)
  })
})
