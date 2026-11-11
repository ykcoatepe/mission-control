// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import JobsView from './JobsView'
import ScheduleView from './ScheduleView'
import { describeEntryChanges, diffEntries, weekOffsetFor } from './scheduleLib'
import type { CalendarEntry } from './scheduleLib'
import type { CronJob } from './types'
import { planWeek } from './weekPlan'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const META = { ok: true, stale: false, error: null }

const at = (daysFromNow: number, hour: number) => {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  d.setHours(hour, 0, 0, 0)
  return d
}
const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const manual = (over: Partial<CalendarEntry> & { id: string }): CalendarEntry => ({
  title: over.id, schedule: '', startsAt: at(0, 10).toISOString(), status: 'scheduled', assignee: 'Yordam', source: 'manual',
  linkedTaskId: null, linkedJobId: null, ...over,
})
const recurringJob = (n: number): CalendarEntry => ({
  id: `cron-${n}`, title: `Job ${String(n).padStart(2, '0')}`, schedule: '0 9 * * *', startsAt: null, status: 'scheduled',
  assignee: 'Mudur', source: 'cron', linkedTaskId: null, linkedJobId: `job-${n}`,
})
const thirtyJobs = () => Array.from({ length: 30 }, (_, i) => recurringJob(i + 1))

function stubCalendar(entries: CalendarEntry[], write?: (body: Record<string, unknown>, entries: CalendarEntry[]) => Response) {
  let state = entries
  const sent: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    if ((init?.method ?? 'GET') === 'GET') return path === '/api/calendar' ? json({ entries: state, meta: META }) : json([])
    sent.push(`${init?.method} ${path}`)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const response = write ? write(body, state) : json({})
    return response
  }))
  return { sent, set: (next: CalendarEntry[]) => { state = next } }
}

function LocationProbe() {
  return createElement('output', { 'data-testid': 'search' }, useLocation().search)
}

async function mount(view: ReactElement, initial = '/') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [initial] }, createElement(ToastProvider, null, view, createElement(LocationProbe)))),
    ),
  )
  await settle()
  return root
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
const text = () => document.body.textContent ?? ''
const byText = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const entryButton = (id: string) => document.querySelector(`[data-entry-id="${id}"]`) as HTMLElement | null
const days = () => [...document.querySelectorAll('section[aria-label]')].filter((s) => s.querySelector('header'))

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const field = (label: string) => {
  const found = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))
  return (found?.getAttribute('for') ? document.getElementById(found.getAttribute('for')!) : null) as HTMLInputElement
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('week plan: dated entries come first', () => {
  it('orders a day as dated entries in time order, then recurring occurrences', () => {
    const day = at(0, 0)
    const plan = planWeek(
      [recurringJob(1), manual({ id: 'late', startsAt: at(0, 15).toISOString() }), recurringJob(2), manual({ id: 'early', startsAt: at(0, 8).toISOString() })],
      [day],
      { hideDisabled: false, todayStart: day },
    )
    const list = Object.values(plan.byDay)[0]
    expect(list.map((placed) => placed.entry.id)).toEqual(['early', 'late', 'cron-1', 'cron-2'])
  })

  it('counts what a write or sync changed', () => {
    const before = [manual({ id: 'a' }), manual({ id: 'b' }), manual({ id: 'c' })]
    const after = [manual({ id: 'a' }), manual({ id: 'b', title: 'renamed' }), manual({ id: 'd' })]
    const changes = diffEntries(before, after)
    expect(changes).toEqual({ added: 1, updated: 1, removed: 1 })
    expect(describeEntryChanges(changes)).toBe('3 entries changed: 1 added, 1 updated, 1 removed.')
    expect(describeEntryChanges(diffEntries(before, before))).toBe('No entries changed.')
  })

  it('finds the week offset of a date', () => {
    expect(weekOffsetFor(at(0, 12), new Date())).toBe(0)
    expect(weekOffsetFor(at(14, 12), new Date())).toBe(2)
    expect(weekOffsetFor(at(-7, 12), new Date())).toBe(-1)
  })
})

describe('schedule: a saved entry cannot hide behind "Show N more"', () => {
  it('lists the dated entry first, without expanding, under its own label', async () => {
    stubCalendar([...thirtyJobs(), manual({ id: 'standup', title: 'Standup' })])
    const root = await mount(createElement(ScheduleView))
    const today = days().find((section) => section.contains(entryButton('standup')))!
    expect(today).toBeDefined()
    expect(today.textContent).toContain('Entries')
    expect(today.textContent).toContain('Recurring')
    expect(today.textContent).toContain('Show 22 more')
    // The manual entry is before every recurring occurrence.
    const order = [...today.querySelectorAll('[data-entry-id]')].map((el) => (el as HTMLElement).dataset.entryId)
    expect(order[0]).toBe('standup')
    expect(order).toHaveLength(1 + 8)
    // Days without a dated entry carry no "Entries" label.
    const labelled = days().filter((section) => section.textContent?.includes('Entries'))
    expect(labelled).toEqual([today])
    await act(async () => root.unmount())
  })

  it('create: the entry is visible, focused and tagged "Saved" right after the dialog closes', async () => {
    const server = stubCalendar(thirtyJobs(), (body, entries) => {
      const created = manual({ id: 'cal-new', title: String(body.title), startsAt: String(body.startsAt) })
      server.set([...entries, created])
      return json({ ok: true, entry: created, entries: [...entries, created], meta: META })
    })
    const root = await mount(createElement(ScheduleView))
    await act(async () => byText('New entry')?.click())
    await act(async () => {
      setValue(field('Title'), 'Dentist')
      setValue(field('Starts at'), localInput(at(0, 10)))
    })
    await act(async () => byText('Save')?.click())
    await settle()
    const created = entryButton('cal-new')
    expect(created).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(created)
    expect(created?.textContent).toContain('Saved')
    expect(created?.hasAttribute('data-just-saved')).toBe(true)
    // Still above the collapsed recurring list.
    expect(created?.closest('section')?.textContent).toContain('Show 22 more')
    await act(async () => root.unmount())
  })

  it('edit: the entry is focused and tagged after the dialog closes', async () => {
    const server = stubCalendar([...thirtyJobs(), manual({ id: 'standup', title: 'Standup' })], (body, entries) => {
      const saved = { ...entries.find((entry) => entry.id === 'standup')!, ...body } as CalendarEntry
      const next = entries.map((entry) => (entry.id === 'standup' ? saved : entry))
      server.set(next)
      return json({ ok: true, entry: saved, entries: next, meta: META })
    })
    const root = await mount(createElement(ScheduleView))
    await act(async () => entryButton('standup')?.click())
    await act(async () => byText('Edit')?.click())
    await act(async () => setValue(field('Title'), 'Standup (moved)'))
    await act(async () => byText('Save')?.click())
    await settle()
    expect(document.activeElement).toBe(entryButton('standup'))
    expect(entryButton('standup')?.textContent).toContain('Standup (moved)')
    expect(entryButton('standup')?.textContent).toContain('Saved')
    // The drawer did not reopen over it.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('an entry outside the visible week gets a notice with a way to that week', async () => {
    const target = at(14, 10)
    const server = stubCalendar([], (body, entries) => {
      const created = manual({ id: 'far', title: 'Conference', startsAt: String(body.startsAt) })
      server.set([...entries, created])
      return json({ ok: true, entry: created, entries: [...entries, created], meta: META })
    })
    const root = await mount(createElement(ScheduleView))
    await act(async () => byText('New entry')?.click())
    await act(async () => {
      setValue(field('Title'), 'Conference')
      setValue(field('Starts at'), localInput(target))
    })
    await act(async () => byText('Save')?.click())
    await settle()
    const notice = [...document.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes('Saved for'))
    expect(notice?.textContent).toContain(`Saved for ${target.toLocaleDateString('en-US', { weekday: 'short' })} ${target.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
    expect(entryButton('far')).toBeNull()

    await act(async () => byText('Go to that week')?.click())
    await settle()
    expect(document.querySelector('[data-testid="search"]')?.textContent).toContain('week=2')
    expect(document.activeElement).toBe(entryButton('far'))
    expect(entryButton('far')?.textContent).toContain('Saved')
    expect(text()).not.toContain('Saved for')
    await act(async () => root.unmount())
  })

  it('an entry hidden by the search is said to be hidden, and "Show it" reveals it', async () => {
    const server = stubCalendar([manual({ id: 'standup', title: 'Standup' })], (body, entries) => {
      const created = manual({ id: 'cal-new', title: String(body.title), startsAt: String(body.startsAt) })
      server.set([...entries, created])
      return json({ ok: true, entry: created, entries: [...entries, created], meta: META })
    })
    const root = await mount(createElement(ScheduleView), '/?find=Standup')
    await act(async () => byText('New entry')?.click())
    await act(async () => {
      setValue(field('Title'), 'Dentist')
      setValue(field('Starts at'), localInput(at(0, 11)))
    })
    await act(async () => byText('Save')?.click())
    await settle()
    expect(text()).toContain('Saved, but hidden')
    expect(entryButton('cal-new')).toBeNull()
    await act(async () => byText('Show it')?.click())
    await settle()
    expect(entryButton('cal-new')).not.toBeNull()
    expect(document.activeElement).toBe(entryButton('cal-new'))
    await act(async () => root.unmount())
  })

  it('sync says how many entries changed', async () => {
    const server = stubCalendar([manual({ id: 'a' })], (_body, entries) => {
      const next = [...entries, manual({ id: 'b' }), manual({ id: 'c' })]
      server.set(next)
      return json({ ok: true, synced: true, entries: next, meta: META })
    })
    const root = await mount(createElement(ScheduleView))
    await act(async () => byText('Sync from cron')?.click())
    await settle()
    expect(text()).toContain('2 entries changed: 2 added.')
    await act(async () => root.unmount())
  })
})

describe('automations: a created job is never lost behind a filter', () => {
  const job = (over: Partial<CronJob> & { id: string }): CronJob => ({
    name: over.id, scheduler: 'openclaw', schedulerLabel: 'OpenClaw', schedule: '0 9 * * *', status: 'active', enabled: true,
    lastRun: null, nextRun: null, duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [],
    actions: { run: true, toggle: true, delete: true, model: true }, ...over,
  })
  const paused = job({ id: 'old-paused', status: 'disabled', enabled: false })

  function stubCron() {
    let jobs: CronJob[] = [paused]
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname
      if ((init?.method ?? 'GET') === 'GET') return path === '/api/cron' ? json({ jobs, summary: {}, meta: META }) : json([])
      const body = JSON.parse(String(init?.body)) as { job: { name: string } }
      const created = job({ id: 'new-job', name: body.job.name })
      jobs = [...jobs, created]
      return json({ ok: true, message: 'created', entity: created, job: { id: 'new-job' }, meta: META })
    }))
  }

  async function create(name: string) {
    await act(async () => byText('Create automation')?.click())
    await act(async () => {
      setValue(field('Name'), name)
      setValue(field('Schedule'), '0 8 * * *')
      setValue(field('Message'), 'Do it')
    })
    await act(async () => byText('Create')?.click())
    await settle()
  }
  const row = (name: string) => [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(name)) as HTMLElement | undefined

  it('shows, focuses and tags the new row when nothing hides it', async () => {
    stubCron()
    const root = await mount(createElement(JobsView))
    await create('Morning digest')
    const created = row('Morning digest')
    expect(created).toBeDefined()
    expect(document.activeElement).toBe(created)
    expect(created?.textContent).toContain('Created')
    expect(text()).not.toContain('hidden by the current filter')
    await act(async () => root.unmount())
  })

  it('says so when the filter would hide it, and "Show it" clears the filters and goes to it', async () => {
    stubCron()
    const root = await mount(createElement(JobsView), '/?state=disabled&q=old')
    expect(row('old-paused')).toBeDefined()
    await create('Morning digest')
    expect(text()).toContain('Created, hidden by the current filter')
    expect(row('Morning digest')).toBeUndefined()
    await act(async () => byText('Show it')?.click())
    await settle()
    expect(document.querySelector('[data-testid="search"]')?.textContent).toBe('')
    const created = row('Morning digest')
    expect(created).toBeDefined()
    expect(document.activeElement).toBe(created)
    expect(created?.textContent).toContain('Created')
    expect(text()).not.toContain('hidden by the current filter')
    await act(async () => root.unmount())
  })
})
