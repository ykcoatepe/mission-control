// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import { unnamedControls } from '../../components/ui/a11y.testkit'
import { STALE_WRITE_NOTE } from '../../lib/writes'
import JobsView from './JobsView'
import ScheduleView from './ScheduleView'
import type { CalendarEntry, CalendarPayload } from './scheduleLib'
import type { CronJob } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const META = { ok: true, stale: false, error: null }
const STALE_META = { ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The write succeeded; dependent readings are catching up' } }

function job(over: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: over.id, scheduler: 'openclaw', schedulerLabel: 'OpenClaw', schedule: '0 9 * * *', status: 'active', enabled: true,
    lastRun: null, nextRun: null, duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [],
    actions: { run: true, toggle: true, delete: true, model: true }, ...over,
  }
}

interface Sent {
  method: string
  path: string
  body: Record<string, unknown> | null
}

/**
 * A server that keeps state, and a gate on the read that follows a write: until the gate opens, the page has
 * only the write's response to show. Reads after the gate answer from the (already changed) state.
 */
function server(handlers: (sent: Sent, state: State) => Response | null, state: State) {
  const sent: Sent[] = []
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
      if (method === 'GET') {
        if (gate && (path === '/api/cron' || path === '/api/calendar')) await gate
        if (path === '/api/cron') return json({ jobs: state.jobs, summary: { active: 0, paused: 0, failed: 0 }, meta: META })
        if (path === '/api/calendar') return json({ entries: state.entries, meta: META })
        return json([])
      }
      sent.push({ method, path, body })
      gate = new Promise<void>((resolve) => { open = resolve })
      return handlers({ method, path, body }, state) ?? json({ error: { code: 'unexpected', message: path } }, 500)
    }),
  )
  return { sent, release: () => open() }
}

interface State {
  jobs: CronJob[]
  entries: CalendarEntry[]
}

async function mount(view: ReactElement) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(ToastProvider, null, view)),
      ),
    ),
  )
  await settle()
  return root
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const text = () => document.body.textContent ?? ''
const byText = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const switchFor = (name: string) => document.querySelector(`[role="switch"][aria-label="${name}"]`) as HTMLButtonElement

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const field = (label: string) => {
  const found = [...document.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))
  const id = found?.getAttribute('for')
  return (id ? document.getElementById(id) : found?.querySelector('input, textarea, select')) as HTMLInputElement
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('automations: a write is on screen before the refetch lands', () => {
  it('toggle: the switch shows the new state at once, and a second click sends the opposite action', async () => {
    const state: State = { jobs: [job({ id: 'ok-job' })], entries: [] }
    const s = server(({ path, body }, st) => {
      if (!path.endsWith('/toggle')) return null
      st.jobs = st.jobs.map((j) => ({ ...j, enabled: Boolean(body?.enabled), status: body?.enabled ? 'active' : 'disabled' }))
      return json({ ok: true, message: 'ok', job: st.jobs[0], meta: META })
    }, state)
    const root = await mount(createElement(JobsView))
    expect(unnamedControls(document)).toEqual([])
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('true')

    await act(async () => switchFor('ok-job enabled').click())
    await settle()
    // The refetch is still held: what shows is the committed entity.
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('false')
    expect(s.sent).toEqual([{ method: 'POST', path: '/api/cron/ok-job/toggle', body: { enabled: false, scheduler: 'openclaw' } }])

    await act(async () => switchFor('ok-job enabled').click())
    await settle()
    expect(s.sent[1].body).toEqual({ enabled: true, scheduler: 'openclaw' })
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('true')
    s.release()
    await settle()
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('true')
    await act(async () => root.unmount())
  })

  it('toggle with no job in the answer shows nothing that was only asked for; the refetch decides', async () => {
    const state: State = { jobs: [job({ id: 'ok-job' })], entries: [] }
    const s = server(() => json({ ok: true, message: 'ok' }), state)
    const root = await mount(createElement(JobsView))
    await act(async () => switchFor('ok-job enabled').click())
    await settle()
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('true')
    s.release()
    await act(async () => root.unmount())
  })

  it('delete: the row is gone at once', async () => {
    const state: State = { jobs: [job({ id: 'ok-job' }), job({ id: 'other-job' })], entries: [] }
    const s = server(({ method }, st) => {
      if (method !== 'DELETE') return null
      st.jobs = st.jobs.filter((j) => j.id !== 'ok-job')
      return json({ ok: true, message: 'deleted', job: { id: 'ok-job', deleted: true }, meta: META })
    }, state)
    const root = await mount(createElement(JobsView))
    expect(text()).toContain('ok-job')
    await act(async () => (document.querySelector('button[aria-label="Delete ok-job"]') as HTMLButtonElement).click())
    await act(async () => byText('Delete')?.click())
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'DELETE', path: '/api/cron/ok-job' })
    expect(document.querySelector('tbody')?.textContent).not.toContain('ok-job')
    expect(document.querySelector('tbody')?.textContent).toContain('other-job')
    s.release()
    await act(async () => root.unmount())
  })

  it('create: the new automation is in the list at once', async () => {
    const state: State = { jobs: [job({ id: 'ok-job' })], entries: [] }
    const created = job({ id: 'new-job', name: 'Morning digest' })
    const s = server(({ path }, st) => {
      if (path !== '/api/cron/create') return null
      st.jobs = [...st.jobs, created]
      return json({ ok: true, message: 'created', job: { id: 'new-job' }, entity: created, meta: META })
    }, state)
    const root = await mount(createElement(JobsView))
    await act(async () => byText('Create automation')?.click())
    expect(unnamedControls(document)).toEqual([])
    await act(async () => {
      setValue(field('Name'), 'Morning digest')
      setValue(field('Schedule'), '0 8 * * *')
      setValue(field('Message'), 'Summarise the night')
    })
    await act(async () => byText('Create')?.click())
    await settle()
    expect(s.sent[0].path).toBe('/api/cron/create')
    expect(document.querySelector('tbody')?.textContent).toContain('Morning digest')
    s.release()
    await settle()
    expect(document.querySelector('tbody')?.textContent).toContain('Morning digest')
    await act(async () => root.unmount())
  })

  it("change a job's model: the new model shows at once", async () => {
    const state: State = { jobs: [job({ id: 'ok-job', model: 'anthropic/claude-sonnet-4-5' })], entries: [] }
    let chosen = ''
    const s = server(({ path, body }, st) => {
      if (!path.endsWith('/model')) return null
      chosen = String(body?.model)
      st.jobs = st.jobs.map((j) => ({ ...j, model: chosen }))
      return json({ ok: true, message: 'updated', job: st.jobs[0], meta: META })
    }, state)
    const root = await mount(createElement(JobsView))
    // The drawer opens from the row.
    await act(async () => (document.querySelector('tbody tr') as HTMLElement).click())
    const select = document.querySelector('select[aria-label="Model for ok-job"]') as HTMLSelectElement
    const next = [...select.options].map((o) => o.value).find((value) => value && value !== select.value)!
    await act(async () => setValue(select, next))
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'PATCH', path: '/api/cron/ok-job/model', body: { model: next } })
    expect((document.querySelector('select[aria-label="Model for ok-job"]') as HTMLSelectElement).value).toBe(next)
    s.release()
    await settle()
    expect((document.querySelector('select[aria-label="Model for ok-job"]') as HTMLSelectElement).value).toBe(next)
    await act(async () => root.unmount())
  })

  it('says, calmly, that the list may be behind when the write came back stale', async () => {
    const state: State = { jobs: [job({ id: 'ok-job' })], entries: [] }
    const s = server(({ path }, st) => {
      if (!path.endsWith('/toggle')) return null
      st.jobs = st.jobs.map((j) => ({ ...j, enabled: false, status: 'disabled' }))
      return json({ ok: true, message: 'ok', job: st.jobs[0], meta: STALE_META })
    }, state)
    const root = await mount(createElement(JobsView))
    expect(text()).not.toContain(STALE_WRITE_NOTE)
    await act(async () => switchFor('ok-job enabled').click())
    await settle()
    expect(text()).toContain(STALE_WRITE_NOTE)
    // A calm note, not an error toast.
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(switchFor('ok-job enabled').getAttribute('aria-checked')).toBe('false')
    s.release()
    await act(async () => root.unmount())
  })
})

describe('schedule: a calendar write is in the grid before the refetch lands', () => {
  const noon = () => {
    const d = new Date()
    d.setHours(12, 0, 0, 0)
    return d
  }
  const entry = (over: Partial<CalendarEntry> & { id: string }): CalendarEntry => ({
    title: over.id, schedule: '', startsAt: noon().toISOString(), status: 'scheduled', assignee: 'Yordam', source: 'manual',
    linkedTaskId: null, linkedJobId: null, ...over,
  })
  const localInput = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  it('create: the new entry is on the grid right after the POST resolves, and every dialog button has a name', async () => {
    const state: State = { jobs: [], entries: [entry({ id: 'standup' })] }
    const s = server(({ method, path, body }, st) => {
      if (method !== 'POST' || path !== '/api/calendar') return null
      const created = entry({ id: 'cal-2', title: String(body?.title), startsAt: String(body?.startsAt) })
      st.entries = [...st.entries, created]
      return json({ ok: true, entry: created, entries: st.entries, meta: { ...META, repairAvailable: false } })
    }, state)
    const root = await mount(createElement(ScheduleView))
    expect(unnamedControls(document)).toEqual([])
    await act(async () => byText('New entry')?.click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(unnamedControls(document)).toEqual([])
    const footer = [...document.querySelectorAll('[role="dialog"] button')].filter((b) => ['Cancel', 'Save'].includes(b.textContent ?? ''))
    expect(footer.map((b) => b.getAttribute('aria-label'))).toEqual(['Cancel', 'Save'])
    await act(async () => {
      setValue(field('Title'), 'Planning')
      setValue(field('Starts at'), localInput(noon()))
    })
    await act(async () => byText('Save')?.click())
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'POST', path: '/api/calendar', body: { title: 'Planning' } })
    expect(text()).toContain('Planning')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    s.release()
    await settle()
    expect(text()).toContain('Planning')
    await act(async () => root.unmount())
  })

  it('edit: the entry shows its new title right after the PATCH resolves', async () => {
    const state: State = { jobs: [], entries: [entry({ id: 'standup', title: 'Standup' })] }
    const s = server(({ method, path, body }, st) => {
      if (method !== 'PATCH' || path !== '/api/calendar/standup') return null
      const saved = { ...st.entries[0], ...body }
      st.entries = [saved as CalendarEntry]
      return json({ ok: true, entry: saved, entries: st.entries, meta: META })
    }, state)
    const root = await mount(createElement(ScheduleView))
    await act(async () => ([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Standup')) as HTMLButtonElement).click())
    expect(unnamedControls(document)).toEqual([])
    await act(async () => byText('Edit')?.click())
    expect(unnamedControls(document)).toEqual([])
    await act(async () => setValue(field('Title'), 'Standup (moved)'))
    await act(async () => byText('Save')?.click())
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'PATCH', path: '/api/calendar/standup', body: { title: 'Standup (moved)' } })
    expect(text()).toContain('Standup (moved)')
    s.release()
    await act(async () => root.unmount())
  })

  it('says the list may be behind when the calendar write came back stale', async () => {
    const state: State = { jobs: [], entries: [] }
    const s = server(({ method, path, body }, st) => {
      if (method !== 'POST' || path !== '/api/calendar') return null
      const created = entry({ id: 'cal-2', title: String(body?.title), startsAt: String(body?.startsAt) })
      st.entries = [created]
      return json({ ok: true, entry: created, entries: st.entries, meta: STALE_META })
    }, state)
    const root = await mount(createElement(ScheduleView))
    await act(async () => byText('New entry')?.click())
    await act(async () => {
      setValue(field('Title'), 'Planning')
      setValue(field('Starts at'), localInput(noon()))
    })
    await act(async () => byText('Save')?.click())
    await settle()
    expect(text()).toContain(STALE_WRITE_NOTE)
    expect(text()).toContain('Planning')
    s.release()
    await act(async () => root.unmount())
  })

  it('repair calendar: the damaged rows are gone from the notice at once', async () => {
    const damaged: CalendarPayload = {
      entries: [entry({ id: 'standup' })],
      diagnostics: { quarantined: { count: 2, ids: ['a', 'b'] }, duplicates: { count: 0, ids: [] } },
      meta: { ok: false, stale: true, error: { code: 'calendar_entries_quarantined', message: 'Malformed calendar entries were quarantined; the file was preserved' }, repairAvailable: true },
    }
    const state: State = { jobs: [], entries: damaged.entries }
    let current: CalendarPayload = damaged
    const sent: string[] = []
    let release: () => void = () => undefined
    let gate: Promise<void> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname
      if ((init?.method ?? 'GET') === 'GET') {
        if (gate) await gate
        return path === '/api/calendar' ? json(current) : json([])
      }
      sent.push(path)
      gate = new Promise<void>((resolve) => { release = resolve })
      current = { entries: state.entries, diagnostics: { quarantined: { count: 0, ids: [] }, duplicates: { count: 0, ids: [] } }, meta: META }
      return json({ ok: true, repaired: true, counts: { kept: 1, quarantined: 2, duplicates: 0 }, backupPath: null, entries: state.entries, meta: STALE_META })
    }))
    const root = await mount(createElement(ScheduleView))
    expect(text()).toContain('Some schedule rows were set aside')
    await act(async () => byText('Repair calendar')?.click())
    expect(unnamedControls(document)).toEqual([])
    await act(async () => ([...document.querySelectorAll('[role="alertdialog"] button')].at(-1) as HTMLButtonElement).click())
    await settle()
    expect(sent).toEqual(['/api/calendar/repair'])
    expect(text()).not.toContain('Some schedule rows were set aside')
    expect(text()).toContain(STALE_WRITE_NOTE)
    release()
    await act(async () => root.unmount())
  })
})
