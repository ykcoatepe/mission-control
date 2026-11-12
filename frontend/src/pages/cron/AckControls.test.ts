// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import JobsView from './JobsView'
import { ackNote, applyAck } from './acks'
import { isNewFailure, isStandingFailure, jobState } from './jobState'
import { summarizeJobs } from './jobsSummary'
import type { CronAck, CronApiResponse, CronJob } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function job(over: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: over.id, scheduler: 'openclaw', schedulerLabel: 'OpenClaw', schedule: '0 9 * * *', status: 'active', enabled: true,
    lastRun: null, nextRun: null, duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [],
    actions: { run: true, toggle: true, delete: true, model: true }, ackKey: `cron:openclaw:${over.id}`, ack: null, ...over,
  }
}

const NOW = Date.parse('2026-11-12T10:00:00Z')
const ACK: CronAck = { kind: 'ack', at: '2026-11-11T08:00:00.000Z', until: null }
const SHELVE: CronAck = { kind: 'shelve', at: '2026-11-11T08:00:00.000Z', until: '2026-11-19T08:00:00.000Z' }

const payload = (jobs: CronJob[]): CronApiResponse => {
  const failed = jobs.filter((j) => j.status === 'failed' && j.enabled)
  const standing = failed.filter((j) => j.ack).length
  return {
    jobs,
    summary: {
      active: jobs.filter((j) => j.enabled).length,
      paused: jobs.filter((j) => !j.enabled).length,
      failed: failed.length - standing,
      standingFailed: standing,
      nextRunAt: null,
    },
  }
}

interface Sent { path: string; method: string; body: unknown; headers: Headers }

/** A server that remembers acknowledgements: a POST or DELETE changes what the next GET returns. */
function stubServer(initial: CronJob[], refuse?: { status: number; code: string; message: string }) {
  let jobs = initial
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/cron' && method === 'GET') return json(payload(jobs))
    if (url.pathname.startsWith('/api/attention/acks')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      sent.push({ path: url.pathname, method, body, headers: new Headers(init?.headers) })
      if (refuse) return json({ error: { code: refuse.code, message: refuse.message } }, refuse.status)
      if (method === 'POST') {
        const ack = { kind: body.kind, at: new Date().toISOString(), until: body.until ?? null }
        jobs = jobs.map((j) => (j.ackKey === body.key ? { ...j, ack } : j))
        return json({ ok: true, key: body.key, ack })
      }
      const key = decodeURIComponent(url.pathname.replace('/api/attention/acks/', ''))
      jobs = jobs.map((j) => (j.ackKey === key ? { ...j, ack: null } : j))
      return json({ ok: true, key, ack: null })
    }
    return json([])
  }))
  return { sent }
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
        createElement(MemoryRouter, { initialEntries: [initial] }, createElement(ToastProvider, null, createElement(JobsView))),
      ),
    ),
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return root
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const text = () => document.body.textContent ?? ''
const strip = () => (document.querySelector('[aria-label="Automations summary"]') as HTMLElement).textContent ?? ''
const alarm = () => document.querySelector('[data-state="critical"][role="alert"]') as HTMLElement | null
const button = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
const rows = () => [...document.querySelectorAll('tbody tr')] as HTMLElement[]
const rowOf = (name: string) => rows().find((tr) => tr.textContent?.includes(name))!

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('a new failure is an alarm with one action', () => {
  it('shows the alarm line, a Failed count and the Acknowledge and Shelve controls on the failed row', async () => {
    stubServer([job({ id: 'ok', status: 'active' }), job({ id: 'bad', status: 'failed' })])
    const root = await mount()
    expect(alarm()).not.toBeNull()
    expect(alarm()!.textContent).toContain('1 automation failed its last run')
    expect(alarm()!.textContent).toContain('bad')
    expect(alarm()!.querySelectorAll('button')).toHaveLength(1)
    expect(button('Show failed')).toBeDefined()
    expect(strip()).toContain('Failed1')
    expect(strip()).not.toContain('Standing')
    const row = rowOf('bad')
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Acknowledge', 'Shelve…']))
    expect(rowOf('ok').textContent).not.toContain('Acknowledge')
    await act(async () => root.unmount())
  })

  it('Show failed filters the table to the new failures', async () => {
    stubServer([job({ id: 'ok' }), job({ id: 'bad', status: 'failed' }), job({ id: 'old', status: 'failed', ack: ACK })])
    const root = await mount()
    await act(async () => button('Show failed')?.click())
    expect(rows().map((tr) => tr.textContent)).toHaveLength(1)
    expect(rows()[0].textContent).toContain('bad')
    // Already looking at them: the alarm no longer offers the action.
    expect(button('Show failed')).toBeUndefined()
    await act(async () => root.unmount())
  })

  it('no alarm and no controls when nothing has failed', async () => {
    stubServer([job({ id: 'ok' }), job({ id: 'off', status: 'disabled', enabled: false })])
    const root = await mount()
    expect(alarm()).toBeNull()
    expect(text()).not.toContain('Acknowledge')
    await act(async () => root.unmount())
  })

  it('a job without an ack key (older payload) has no controls', async () => {
    stubServer([job({ id: 'bad', status: 'failed', ackKey: undefined })])
    const root = await mount()
    expect(alarm()).not.toBeNull()
    expect(button('Acknowledge')).toBeUndefined()
    expect(button('Shelve…')).toBeUndefined()
    await act(async () => root.unmount())
  })
})

describe('an acknowledged or shelved failure is standing, not new', () => {
  it('acknowledged: no alarm, not in the Failed count, a quiet Standing count, a note and Undo', async () => {
    stubServer([job({ id: 'ok' }), job({ id: 'old', status: 'failed', ack: ACK })])
    const root = await mount()
    expect(alarm()).toBeNull()
    expect(strip()).toContain('Failed0')
    expect(strip()).toContain('Standing failures1')
    const row = rowOf('old')
    expect(row.textContent).toContain('Failed')
    expect(row.textContent).toContain('Acknowledged')
    expect(button('Undo')).toBeDefined()
    expect(button('Acknowledge')).toBeUndefined()
    // Neutral: the square mark is there, but the row has no critical-coloured pill.
    expect(row.querySelector('[data-state="critical"][data-shape="square"]')).not.toBeNull()
    expect(row.querySelector('[class*="pill"][data-state="critical"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('shelved: says until when', async () => {
    stubServer([job({ id: 'old', status: 'failed', ack: SHELVE })])
    const root = await mount()
    expect(rowOf('old').textContent).toMatch(/Shelved until 19 Nov/)
    expect(alarm()).toBeNull()
    await act(async () => root.unmount())
  })

  it('the Standing filter lists them and Failed does not', async () => {
    stubServer([job({ id: 'bad', status: 'failed' }), job({ id: 'old', status: 'failed', ack: ACK })])
    const root = await mount()
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Standing'))?.click())
    expect(rows().map((tr) => tr.textContent)).toHaveLength(1)
    expect(rows()[0].textContent).toContain('old')
    await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Failed'))?.click())
    expect(rows()[0].textContent).toContain('bad')
    expect(rows().map((tr) => tr.textContent)).toHaveLength(1)
    await act(async () => root.unmount())
  })

  it('a standing failure sorts below a new one', async () => {
    stubServer([job({ id: 'a-old', status: 'failed', ack: ACK }), job({ id: 'b-bad', status: 'failed' })])
    const root = await mount()
    expect(rows()[0].textContent).toContain('b-bad')
    await act(async () => root.unmount())
  })
})

describe('the controls write acknowledgements', () => {
  it('Acknowledge posts the job key, the alarm goes, and the row becomes standing', async () => {
    const server = stubServer([job({ id: 'bad', status: 'failed' })])
    const root = await mount()
    await act(async () => button('Acknowledge')?.click())
    await settle()
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]).toMatchObject({ path: '/api/attention/acks', method: 'POST', body: { key: 'cron:openclaw:bad', kind: 'ack' } })
    expect(server.sent[0].headers.get('X-MC-Request')).toBe('1')
    expect(alarm()).toBeNull()
    expect(strip()).toContain('Failed0')
    expect(rowOf('bad').textContent).toContain('Acknowledged')
    await act(async () => root.unmount())
  })

  it('Shelve… asks for a length; 7 days sends a date a week ahead, and nothing is sent before the choice', async () => {
    const server = stubServer([job({ id: 'bad', status: 'failed' })])
    const root = await mount()
    await act(async () => button('Shelve…')?.click())
    expect(server.sent).toHaveLength(0)
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['7 days', '30 days', 'Until I undo', 'Cancel']))
    const before = Date.now()
    await act(async () => button('7 days')?.click())
    await settle()
    expect(server.sent).toHaveLength(1)
    const { body } = server.sent[0] as { body: { key: string; kind: string; until: string } }
    expect(body).toMatchObject({ key: 'cron:openclaw:bad', kind: 'shelve' })
    const week = Date.parse(body.until) - before
    expect(week).toBeGreaterThan(6.99 * 86_400_000)
    expect(week).toBeLessThan(7.01 * 86_400_000)
    expect(alarm()).toBeNull()
    expect(rowOf('bad').textContent).toContain('Shelved until')
    await act(async () => root.unmount())
  })

  it('"Until I undo" sends until null, and Cancel sends nothing', async () => {
    const server = stubServer([job({ id: 'bad', status: 'failed' })])
    const root = await mount()
    await act(async () => button('Shelve…')?.click())
    await act(async () => button('Cancel')?.click())
    expect(server.sent).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => button('Shelve…')?.click())
    await act(async () => button('Until I undo')?.click())
    await settle()
    expect(server.sent[0].body).toEqual({ key: 'cron:openclaw:bad', kind: 'shelve', until: null })
    expect(rowOf('bad').textContent).toContain('Shelved until undone')
    await act(async () => root.unmount())
  })

  it('Undo deletes the acknowledgement by its encoded key and the failure counts as new again', async () => {
    const server = stubServer([job({ id: 'old', status: 'failed', ack: ACK })])
    const root = await mount()
    await act(async () => button('Undo')?.click())
    await settle()
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0]).toMatchObject({ path: '/api/attention/acks/cron%3Aopenclaw%3Aold', method: 'DELETE' })
    expect(server.sent[0].headers.get('X-MC-Request')).toBe('1')
    expect(alarm()).not.toBeNull()
    expect(strip()).toContain('Failed1')
    await act(async () => root.unmount())
  })

  it('a refusal keeps the alarm, says why, and leaves the row as it was', async () => {
    stubServer([job({ id: 'bad', status: 'failed' })], { status: 409, code: 'not_ackable', message: 'This item does not count now' })
    const root = await mount()
    await act(async () => button('Acknowledge')?.click())
    await settle()
    expect(alarm()).not.toBeNull()
    expect(text()).toContain('was not acknowledged')
    expect(text()).toContain('This item does not count now')
    expect(button('Acknowledge')).toBeDefined()
    await act(async () => root.unmount())
  })

  it('the drawer offers the same controls for a failed job', async () => {
    const server = stubServer([job({ id: 'bad', status: 'failed' })])
    const root = await mount('/?job=bad')
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    const ack = [...drawer.querySelectorAll('button')].find((b) => b.textContent === 'Acknowledge') as HTMLButtonElement
    expect(ack).toBeDefined()
    await act(async () => ack.click())
    await settle()
    expect(server.sent[0].body).toMatchObject({ key: 'cron:openclaw:bad', kind: 'ack' })
    await act(async () => root.unmount())
  })
})

describe('other states keep their meaning', () => {
  it('a paused job is off: a dash, never coloured', async () => {
    stubServer([job({ id: 'off', status: 'disabled', enabled: false })])
    const root = await mount()
    const row = rowOf('off')
    expect(row.textContent).toContain('Paused')
    expect(row.querySelector('[data-shape="dash"]')).not.toBeNull()
    expect(row.querySelector('[data-state="critical"], [data-state="warning"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('"Due now" and "Overdue since" still show on the job rows', async () => {
    stubServer([
      job({ id: 'due', nextRun: '2026-11-12T09:59:00Z', nextRunDue: true }),
      job({ id: 'late', nextRun: '2026-08-15T00:30:00Z', nextRunOverdue: true }),
    ])
    const root = await mount()
    expect(rowOf('due').textContent).toContain('Due now')
    expect(rowOf('late').textContent).toContain('Overdue since')
    await act(async () => root.unmount())
  })
})

describe('acknowledgement helpers', () => {
  it('jobState: only an unacknowledged failure is new; a paused job is off', () => {
    expect(isNewFailure({ status: 'failed', enabled: true })).toBe(true)
    expect(isNewFailure({ status: 'failed', enabled: true, ack: ACK })).toBe(false)
    expect(isStandingFailure({ status: 'failed', enabled: true, ack: SHELVE })).toBe(true)
    expect(isStandingFailure({ status: 'failed', enabled: false, ack: SHELVE })).toBe(false)
    expect(jobState({ status: 'failed', enabled: true, ack: ACK })).toMatchObject({ state: 'critical', standing: true })
    expect(jobState({ status: 'failed', enabled: true }).standing).toBeUndefined()
    expect(jobState({ status: 'active', enabled: false }).state).toBe('inactive')
  })

  it('summarizeJobs derives new and standing counts from the list when the API gives none', () => {
    const list = [job({ id: 'a', status: 'failed' }), job({ id: 'b', status: 'failed', ack: ACK }), job({ id: 'c', status: 'failed', ack: SHELVE })]
    expect(summarizeJobs(list, undefined, NOW)).toMatchObject({ failed: 1, standingFailed: 2 })
    expect(summarizeJobs(list, { failed: 3, standingFailed: 0 }, NOW)).toMatchObject({ failed: 3, standingFailed: 0 })
  })

  it('applyAck moves one failure between the counts and back', () => {
    const base = payload([job({ id: 'a', status: 'failed' }), job({ id: 'b', status: 'active' })])
    const acked = applyAck(base, 'cron:openclaw:a', ACK)
    expect(acked.jobs![0].ack).toEqual(ACK)
    expect(acked.summary).toMatchObject({ failed: 0, standingFailed: 1 })
    expect(applyAck(acked, 'cron:openclaw:a', null).summary).toMatchObject({ failed: 1, standingFailed: 0 })
    // Re-shelving a standing failure changes no count; a healthy job moves none.
    expect(applyAck(acked, 'cron:openclaw:a', SHELVE).summary).toMatchObject({ failed: 0, standingFailed: 1 })
    expect(applyAck(base, 'cron:openclaw:b', ACK).summary).toMatchObject({ failed: 1, standingFailed: 0 })
  })

  it('ackNote', () => {
    expect(ackNote(ACK)).toBe('Acknowledged')
    expect(ackNote(SHELVE)).toBe('Shelved until 19 Nov')
    expect(ackNote({ ...SHELVE, until: null })).toBe('Shelved until undone')
  })
})

describe('Acknowledge all on Automations', () => {
  const fail = (id: string) => job({ id, status: 'failed' })

  it('stays out of the alarm line, which keeps its one action Show failed, and sits in the Automations header from two new failures', async () => {
    stubServer([fail('a'), fail('b'), job({ id: 'ok' })])
    const root = await mount()
    expect(alarm()!.querySelectorAll('button')).toHaveLength(1)
    expect(alarm()!.textContent).toContain('Show failed')
    expect(alarm()!.textContent).not.toContain('Acknowledge all')
    const header = [...document.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === 'Automations') as HTMLElement
    expect([...header.querySelectorAll('header button')].map((b) => b.textContent)).toContain('Acknowledge all (2)')
    await act(async () => root.unmount())
  })

  it('is not offered for a single failure', async () => {
    stubServer([fail('a'), job({ id: 'ok' })])
    const root = await mount()
    expect(text()).not.toContain('Acknowledge all')
    await act(async () => root.unmount())
  })

  it('uses the same shared action cell as Attention: Acknowledge then Shelve… in an Actions column', async () => {
    stubServer([fail('a'), fail('b')])
    const root = await mount()
    expect([...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toContain('Actions')
    for (const row of rows()) {
      const cell = row.querySelector('[data-ack-actions]') as HTMLElement
      expect([...cell.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Acknowledge', 'Shelve…'])
    }
    await act(async () => root.unmount())
  })

  it('asks first with the same words as Attention, then posts every key one after the other and reads the list again', async () => {
    const server = stubServer([fail('a'), fail('b'), job({ id: 'ok' })])
    const root = await mount()
    await act(async () => button('Acknowledge all (2)')?.click())
    const dialog = document.querySelector('[role="alertdialog"]') as HTMLElement
    expect(dialog.textContent).toContain('Acknowledge 2 items?')
    expect(dialog.textContent).toContain('alerts you again')
    expect(server.sent).toHaveLength(0)
    await act(async () => ([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Acknowledge 2') as HTMLButtonElement).click())
    await settle()
    await settle()
    expect(server.sent.map((call) => call.body)).toEqual([
      { key: 'cron:openclaw:a', kind: 'ack' },
      { key: 'cron:openclaw:b', kind: 'ack' },
    ])
    // The list was asked again: the failures are standing and the alarm is gone.
    expect(alarm()).toBeNull()
    expect(strip()).toContain('Failed0')
    await act(async () => root.unmount())
  })

  it('stops at the first error and says how far it got, in the server words', async () => {
    const server = stubServer([fail('a'), fail('b'), fail('c')], { status: 409, code: 'conflict', message: 'The ledger is busy' })
    const root = await mount()
    await act(async () => button('Acknowledge all (3)')?.click())
    await act(async () => button('Acknowledge 3')?.click())
    await settle()
    await settle()
    expect(server.sent).toHaveLength(1)
    const notice = [...document.querySelectorAll('[role="alert"]')].find((el) => el.textContent?.includes('stopped'))
    expect(notice?.textContent).toContain('Acknowledged 0 of 3 and stopped: The ledger is busy')
    await act(async () => root.unmount())
  })
})

describe('the Automations summary is a compact readings row', () => {
  it('puts each label and its number side by side on one line, with no hero numerals', async () => {
    stubServer([job({ id: 'ok' }), job({ id: 'bad', status: 'failed' })])
    const root = await mount()
    const row = document.querySelector('[aria-label="Automations summary"]') as HTMLElement
    const readings = [...row.children] as HTMLElement[]
    for (const label of ['Active', 'Paused', 'Failed', 'Next run']) {
      expect(readings.some((reading) => reading.querySelector('span')?.textContent === label), label).toBe(true)
    }
    // Label and value are siblings of one reading (inline), not a label stacked over a large value.
    for (const reading of readings) expect(reading.querySelectorAll('span').length).toBeGreaterThanOrEqual(2)
    expect(row.querySelector('[class*="Stat_value"], [class*="stat"]')).toBeNull()
    await act(async () => root.unmount())
  })
})
