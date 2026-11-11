// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import { STALE_WRITE_NOTE, UNCONFIRMED_TITLE } from '../../lib/writes'
import JobsView from './JobsView'
import { summarizeJobs } from './jobsSummary'
import type { CronJob } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const META = { ok: true, stale: false, error: null }
const STALE_META = { ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The command was sent; upstream confirmation is pending' } }

function job(over: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: over.id, scheduler: 'openclaw', schedulerLabel: 'OpenClaw', schedule: '0 9 * * *', status: 'active', enabled: true,
    lastRun: null, nextRun: null, duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [],
    actions: { run: true, toggle: true, delete: true, model: true }, ...over,
  }
}

type Answer = (state: { jobs: CronJob[] }, body: Record<string, unknown>) => Response

/** A server with state. After a write, reads wait for `release()`: until then the page has only the write's answer. */
function server(initial: CronJob[], answer: Answer) {
  const state = { jobs: initial }
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = []
  let reads = 0
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      if (path === '/api/cron') {
        reads++
        if (gate) await gate
        return json({ jobs: state.jobs, summary: {}, meta: META })
      }
      return json([])
    }
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    sent.push({ method, path, body })
    gate = new Promise<void>((resolve) => { open = resolve })
    return answer(state, body)
  }))
  return { sent, reads: () => reads, release: () => open() }
}

async function mount(initial = '/') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [initial] }, createElement(ToastProvider, null, createElement(JobsView))))),
  )
  await settle()
  return root
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
const text = () => document.body.textContent ?? ''
const switchFor = (name: string) => document.querySelector(`[role="switch"][aria-label="${name}"]`) as HTMLButtonElement
const checked = (name: string) => switchFor(name).getAttribute('aria-checked')
const row = (name: string) => [...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes(name)) as HTMLElement | undefined

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const PAUSED_REASON = 'Operator paused'
const REJECTION = `hermes reports enabled=true, state=paused, paused_at=2026-11-01T00:00:00.000Z; ${PAUSED_REASON}; requested change was not observed`

describe('toggle: the four answers', () => {
  const hermes = () => [job({ id: 'hermes:h1', name: 'Hermes job', scheduler: 'hermes', schedulerLabel: 'Hermes', enabled: false, status: 'disabled' })]

  it('verified: the confirmed state is on screen at once, with no warning', async () => {
    const s = server(hermes(), (state) => {
      state.jobs = state.jobs.map((j) => ({ ...j, enabled: true, status: 'active', verified: true }))
      return json({ ok: true, message: 'Hermes job enabled', verified: true, job: state.jobs[0], meta: META })
    })
    const root = await mount()
    expect(checked('Hermes job enabled')).toBe('false')
    await act(async () => switchFor('Hermes job enabled').click())
    await settle()
    expect(s.sent[0]).toMatchObject({ path: '/api/cron/hermes:h1/toggle', body: { enabled: true, scheduler: 'hermes' } })
    expect(checked('Hermes job enabled')).toBe('true')
    expect(text()).not.toContain(UNCONFIRMED_TITLE)
    expect(text()).not.toContain('Not confirmed')
    s.release()
    await act(async () => root.unmount())
  })

  it('sent but not confirmed: a warning, not a success, and the requested state is never shown as current', async () => {
    const s = server(hermes(), (state) =>
      json({
        ok: true, message: 'Hermes command sent; awaiting verification', verified: false, requested: { enabled: true },
        // The previous state, marked: nothing was promoted.
        job: { ...state.jobs[0], verified: false }, meta: STALE_META,
      }),
    )
    const root = await mount()
    await act(async () => switchFor('Hermes job enabled').click())
    await settle()
    expect(checked('Hermes job enabled')).toBe('false')
    const note = [...document.querySelectorAll('[data-tone="warning"]')].find((el) => el.textContent?.includes(UNCONFIRMED_TITLE))
    expect(note).toBeDefined()
    expect(text()).not.toContain(STALE_WRITE_NOTE)
    expect(row('Hermes job')?.textContent).toContain('Not confirmed')
    // The toast is a warning too.
    expect(document.querySelector('[data-tone="success"]')).toBeNull()
    expect(text()).toContain('not yet confirmed')
    // The refetch shows what the server reports: still paused.
    s.release()
    await settle()
    expect(checked('Hermes job enabled')).toBe('false')
    await act(async () => root.unmount())
  })

  for (const [code, message] of [
    ['upstream_rejected', REJECTION],
    ['upstream_unverified', 'hermes reports invalid job metadata'],
  ] as const) {
    it(`409 ${code}: the system's message is an error next to the control, and the real state is read again`, async () => {
      const s = server(hermes(), () => json({ error: { code, message } }, 409))
      const root = await mount()
      const readsBefore = s.reads()
      await act(async () => switchFor('Hermes job enabled').click())
      await settle()
      // Never an optimistic value, not even for a moment.
      expect(checked('Hermes job enabled')).toBe('false')
      const inline = row('Hermes job')?.querySelector('[role="alert"]')
      expect(inline?.textContent).toBe(message)
      expect(s.reads()).toBeGreaterThan(readsBefore)
      expect(text()).not.toContain(UNCONFIRMED_TITLE)
      s.release()
      await settle()
      expect(checked('Hermes job enabled')).toBe('false')
      // The error stays until the job is changed again; a second attempt clears it.
      expect(row('Hermes job')?.querySelector('[role="alert"]')?.textContent).toBe(message)
      await act(async () => root.unmount())
    })
  }

  it('409 on a paused Hermes job names the reason the system gave', async () => {
    server(hermes(), () => json({ error: { code: 'upstream_rejected', message: REJECTION } }, 409))
    const root = await mount()
    await act(async () => switchFor('Hermes job enabled').click())
    await settle()
    expect(row('Hermes job')?.textContent).toContain(PAUSED_REASON)
    await act(async () => root.unmount())
  })
})

describe('other writes keep the same rules', () => {
  it('delete that is not confirmed leaves the row, says so, and does not claim it was deleted', async () => {
    const s = server([job({ id: 'openclaw:o1', name: 'Digest' })], (state) =>
      json({ ok: true, verified: false, job: { ...state.jobs[0], verified: false }, meta: STALE_META }),
    )
    const root = await mount()
    await act(async () => (document.querySelector('button[aria-label="Delete Digest"]') as HTMLButtonElement).click())
    await act(async () => ([...document.querySelectorAll('[role="alertdialog"] button')].at(-1) as HTMLButtonElement).click())
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'DELETE' })
    expect(row('Digest')).toBeDefined()
    expect(text()).toContain(UNCONFIRMED_TITLE)
    expect(text()).not.toContain('"Digest" deleted')
    s.release()
    await act(async () => root.unmount())
  })

  it('a model change that is refused shows the message and the real model', async () => {
    const s = server([job({ id: 'openclaw:o1', name: 'Digest', model: 'anthropic/claude-sonnet-4-5' })], () =>
      json({ error: { code: 'upstream_rejected', message: 'openclaw reports model=anthropic/claude-sonnet-4-5; requested change was not observed' } }, 409),
    )
    const root = await mount('/?job=openclaw:o1')
    const select = document.querySelector('select[aria-label="Model for Digest"]') as HTMLSelectElement
    const before = select.value
    const next = [...select.options].map((o) => o.value).find((value) => value && value !== before)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, next)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(s.sent[0]).toMatchObject({ method: 'PATCH', body: { model: next } })
    expect((document.querySelector('select[aria-label="Model for Digest"]') as HTMLSelectElement).value).toBe(before)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('requested change was not observed')
    s.release()
    await act(async () => root.unmount())
  })
})

describe('overdue and paused jobs', () => {
  const overdue = job({
    id: 'hermes:h1', name: 'Hermes job', scheduler: 'hermes', schedulerLabel: 'Hermes',
    nextRun: '2026-08-15T00:00:00.000Z', nextRunOverdue: true, pausedReason: PAUSED_REASON, pausedAt: '2026-11-01T00:00:00.000Z',
    schedulerState: 'scheduled', upstreamEnabled: true,
  })

  it('says "Overdue since" in warning tone instead of "Next run 88d ago", and it is not the summary next run', async () => {
    server([overdue], () => json({}))
    const root = await mount()
    const cell = row('Hermes job')?.querySelector('[data-state="warning"]')
    expect(cell?.textContent).toMatch(/^Overdue since Aug 15/)
    expect(row('Hermes job')?.textContent).not.toMatch(/\d+d ago/)
    const strip = document.querySelector('[aria-label="Automations summary"]')?.textContent ?? ''
    expect(strip).not.toContain('Hermes job')
    await act(async () => root.unmount())
  })

  it('shows the pause reason as plain text in the job detail, with the overdue time', async () => {
    server([overdue], () => json({}))
    const root = await mount('/?job=hermes:h1')
    const drawer = document.querySelector('[role="dialog"]')
    expect(drawer?.textContent).toContain('Paused because')
    expect(drawer?.textContent).toContain(PAUSED_REASON)
    expect(drawer?.textContent).toContain('Overdue since Aug 15')
    await act(async () => root.unmount())
  })

  it('the summary skips an overdue run even when its time is in the future by the browser clock', () => {
    const later = Date.now() + 3600_000
    const summary = summarizeJobs(
      [job({ id: 'a', nextRun: new Date(later).toISOString(), nextRunOverdue: true }), job({ id: 'b', nextRun: new Date(later + 1000).toISOString() })],
      undefined,
      Date.now(),
    )
    expect(summary.nextRun?.name).toBe('b')
  })
})
