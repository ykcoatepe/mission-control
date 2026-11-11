// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import ScheduleView from './ScheduleView'
import type { CalendarEntry, CalendarPayload } from './scheduleLib'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const linked: CalendarEntry = {
  id: 'cron-openclaw:daily',
  title: 'Daily digest',
  schedule: '0 8 * * *',
  startsAt: null,
  status: 'active',
  assignee: 'Mudur',
  source: 'cron',
  linkedTaskId: null,
  linkedJobId: 'openclaw:daily',
  notes: '',
  userOverrides: [],
  cronDerived: { title: 'Daily digest', schedule: '0 8 * * *', notes: '', assignee: 'Mudur' },
}
const manual: CalendarEntry = {
  id: 'entry-1',
  title: 'Water plants',
  schedule: '0 9 * * *',
  startsAt: null,
  status: 'scheduled',
  assignee: 'Yordam',
  source: 'manual',
  linkedTaskId: null,
  linkedJobId: null,
  notes: '',
}

const clean: CalendarPayload = {
  entries: [linked, manual],
  diagnostics: { quarantined: { count: 0, ids: [] }, duplicates: { count: 0, ids: [] } },
  meta: { ok: true, stale: false, error: null },
}

function stubServer(payload: CalendarPayload) {
  const writes: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') return json(payload)
      writes.push({ url, method, headers: new Headers(init?.headers), body: init?.body })
      return json({ ok: true })
    }),
  )
  return writes
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function LocationProbe() {
  const location = useLocation()
  return createElement('output', { 'data-testid': 'search' }, location.search)
}

async function mount(initial = '/') {
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
          { initialEntries: [initial] },
          createElement(ToastProvider, null, createElement(ScheduleView), createElement(LocationProbe)),
        ),
      ),
    ),
  )
  await flush()
  return { host, root }
}

const buttons = () => [...document.querySelectorAll('button')]
const byText = (text: string) => buttons().find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ScheduleView', () => {
  it('has no Enable or Disable control on a scheduler-linked entry, and points to Jobs', async () => {
    stubServer(clean)
    const { root } = await mount()
    await act(async () => byText('Daily digest')?.click())
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawer.textContent).toContain('Status and next run come from the scheduler')
    expect([...drawer.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Disable')
    expect([...drawer.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Enable')
    expect(drawer.querySelector('a')?.getAttribute('href')).toContain('/automations?view=jobs&job=openclaw')
    await act(async () => root.unmount())
  })

  it('keeps Disable for a manual entry, and it patches only its status', async () => {
    const writes = stubServer(clean)
    const { root } = await mount()
    await act(async () => byText('Water plants')?.click())
    const disable = [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Disable')
    expect(disable).toBeDefined()
    await act(async () => disable!.click())
    await flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/calendar/entry-1', method: 'PATCH' })
    expect(JSON.parse(String(writes[0].body))).toEqual({ status: 'disabled' })
    expect(writes[0].headers.get('x-mc-request')).toBe('1')
    await act(async () => root.unmount())
  })

  it('syncs with a guarded POST that has no body', async () => {
    const writes = stubServer(clean)
    const { root } = await mount()
    await act(async () => byText('Sync from cron')?.click())
    await flush()
    expect(writes[0]).toMatchObject({ url: '/api/calendar/sync-cron', method: 'POST' })
    expect(writes[0].headers.get('x-mc-request')).toBe('1')
    expect(writes[0].body).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('shows one quiet notice for quarantined and duplicate rows and pauses writes', async () => {
    stubServer({
      ...clean,
      diagnostics: { quarantined: { count: 1, ids: ['bad-row'] }, duplicates: { count: 1, ids: ['dup'] } },
      meta: { ok: false, stale: true, error: { code: 'calendar_entries_quarantined', message: 'Malformed calendar entries were quarantined; the file was preserved' } },
    })
    const { host, root } = await mount()
    expect(host.textContent).toContain('Some schedule rows were set aside')
    expect(host.textContent).toContain('bad-row')
    expect(host.textContent).toContain('Some schedule rows share an id')
    expect(host.textContent).toContain('dup')
    expect(host.textContent).not.toContain('Showing the last good reading')
    expect(byText('New entry')?.disabled).toBe(true)
    expect(byText('Sync from cron')?.disabled).toBe(true)
    await act(async () => root.unmount())
  })

  it('is silent for a clean read', async () => {
    stubServer(clean)
    const { host, root } = await mount()
    expect(host.querySelectorAll('[data-tone]')).toHaveLength(0)
    expect(byText('New entry')?.disabled).toBe(false)
    await act(async () => root.unmount())
  })

  it('says the schedule may be behind when the scheduler is stale', async () => {
    stubServer({
      ...clean,
      meta: { ok: false, stale: true, error: { code: 'calendar_scheduler_stale', message: 'Unavailable scheduler rows were retained from last-good calendar data' } },
    })
    const { host, root } = await mount()
    expect(host.textContent).toContain('Schedule may be behind')
    expect(host.textContent).toContain('retained from last-good calendar data')
    expect(byText('New entry')?.disabled).toBe(false)
    await act(async () => root.unmount())
  })
})

describe('ScheduleView week grid', () => {
  // Wednesday 2026-11-11, local time. The grid shows Sunday 8 to Saturday 14.
  const at = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
  }
  const entry = (over: Partial<CalendarEntry> & { id: string }): CalendarEntry => ({ ...linked, title: over.id, linkedJobId: null, source: 'cron', ...over })
  const day = (label: string) => document.querySelector(`section[aria-label="${label}"]`) as HTMLElement
  const titles = (label: string) => [...day(label).querySelectorAll('button')].map((b) => b.textContent ?? '')

  it('puts a weekly job on its own day only', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'friday-report', schedule: '0 9 * * 5' }), entry({ id: 'sunday-review', schedule: '0 11 * * 0' })] })
    const { root } = await mount()
    expect(titles('Fri Nov 13').some((t) => t.includes('friday-report'))).toBe(true)
    for (const other of ['Sun Nov 8', 'Mon Nov 9', 'Tue Nov 10', 'Wed Nov 11', 'Thu Nov 12', 'Sat Nov 14']) {
      expect(titles(other).some((t) => t.includes('friday-report'))).toBe(false)
    }
    // Sunday 8 is already past: a recurring job is not drawn there, and does not move to other days.
    expect(document.querySelectorAll('section[aria-label$="Nov 8"] button, section[aria-label$="Nov 9"] button')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('sunday-review')
    await act(async () => root.unmount())
  })

  it('shows a job that runs every few minutes once per day, with its run count', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'sentinel', schedule: 'every 10m' })] })
    const { root } = await mount()
    expect(titles('Wed Nov 11')).toHaveLength(1)
    expect(titles('Wed Nov 11')[0]).toContain('every 10m · 144 runs')
    expect(titles('Tue Nov 10')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('lists schedules it cannot read under "Schedule not understood" instead of on every day', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'heartbeat', schedule: 'every' }), entry({ id: 'fine', schedule: '0 9 * * *' })] })
    const { root } = await mount()
    const list = document.querySelector('section[aria-label="Schedule not understood"]') as HTMLElement
    expect(list).not.toBeNull()
    expect(list.textContent).toContain('heartbeat')
    expect(list.textContent).toContain('No interval was reported')
    expect(list.textContent).not.toContain('fine')
    for (const label of ['Wed Nov 11', 'Thu Nov 12', 'Fri Nov 13']) expect(titles(label).some((t) => t.includes('heartbeat'))).toBe(false)
    await act(async () => root.unmount())
  })

  it('does not show the list when every schedule is understood', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'fine', schedule: '0 9 * * *' })] })
    const { root } = await mount()
    expect(document.querySelector('section[aria-label="Schedule not understood"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('keeps source filter, search and range in the URL, and restores them from it', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'alpha', schedule: '0 9 * * *' }), entry({ id: 'beta', schedule: '0 10 * * *', source: 'manual' })] })
    const { root } = await mount()
    const search = () => document.querySelector('[data-testid="search"]')!.textContent
    expect(search()).toBe('')
    await act(async () => byText('Scheduler')?.click())
    expect(search()).toBe('?source=cron')
    await act(async () => byText('Today')?.click())
    expect(search()).toContain('range=today')
    await act(async () => root.unmount())
    document.body.innerHTML = ''

    const again = await mount('/?source=manual&find=bet')
    expect(titles('Wed Nov 11').map((t) => t.replace(/\d.*/, ''))).toEqual(['beta'])
    expect((document.querySelector('input[type="search"], input[placeholder="Search by title"]') as HTMLInputElement).value).toBe('bet')
    await act(async () => again.root.unmount())
  })

  it('ignores an unknown filter value in the URL', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'alpha', schedule: '0 9 * * *' })] })
    const { root } = await mount('/?source=bogus&range=nonsense&week=abc')
    expect(titles('Wed Nov 11')).toHaveLength(1)
    await act(async () => root.unmount())
  })

  it('shows plain status words in the entry drawer', async () => {
    at()
    stubServer({ ...clean, entries: [entry({ id: 'alpha', schedule: '0 9 * * *', status: 'active' })] })
    const { root } = await mount()
    await act(async () => byText('alpha')?.click())
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawer.textContent).toContain('Active')
    expect(drawer.textContent).not.toMatch(/\bactive\b/)
    expect(drawer.textContent).toContain('Scheduler')
    await act(async () => root.unmount())
  })
})
