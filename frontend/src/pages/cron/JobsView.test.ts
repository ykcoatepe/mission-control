// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import JobsView from './JobsView'
import type { CronJob } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function job(over: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: over.id, scheduler: 'openclaw', schedulerLabel: 'OpenClaw', schedule: '0 9 * * *', status: 'active', enabled: true,
    lastRun: null, nextRun: null, duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [],
    actions: { run: true, toggle: true, delete: true, model: true }, ...over,
  }
}

// 3 on (one failed, one waiting, one ok), 2 paused: API summary says active 3, paused 2, failed 1.
const jobs = [
  job({ id: 'ok-job', status: 'active' }),
  job({ id: 'bad-job', status: 'failed' }),
  job({ id: 'waiting-job', status: 'idle', schedule: 'every' }),
  job({ id: 'paused-a', status: 'disabled', enabled: false, scheduler: 'hermes', schedulerLabel: 'Hermes' }),
  job({ id: 'paused-b', status: 'disabled', enabled: false, scheduler: 'hermes', schedulerLabel: 'Hermes', payload: 'command', description: '__openclaw_memory_core_dream__' }),
]
const summary = { active: 3, paused: 2, failed: 1, nextRunAt: null }

function stub(payload: unknown = { jobs, summary }) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname
    return path === '/api/cron' ? json(payload) : json([])
  }))
}

function LocationProbe() {
  return createElement('output', { 'data-testid': 'search' }, useLocation().search)
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
        createElement(MemoryRouter, { initialEntries: [initial] }, createElement(ToastProvider, null, createElement(JobsView), createElement(LocationProbe))),
      ),
    ),
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return root
}

const text = () => document.body.textContent ?? ''
const search = () => document.querySelector('[data-testid="search"]')!.textContent
const byText = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined
const rowNames = () => [...document.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '')

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('JobsView summary', () => {
  it('shows the API summary numbers, and the Active filter agrees with them', async () => {
    stub()
    const root = await mount()
    const strip = document.querySelector('[aria-label="Automations summary"]') as HTMLElement
    expect(strip.textContent).toContain('Active3')
    expect(strip.textContent).toContain('Paused2')
    expect(strip.textContent).toContain('Failed1')
    expect(strip.textContent).not.toContain('failed last run')
    await act(async () => byText('Active')?.click())
    expect(rowNames()).toHaveLength(3)
    await act(async () => root.unmount())
  })

  it('shows the API number even when it differs from what the list suggests', async () => {
    stub({ jobs, summary: { ...summary, active: 31, paused: 144 } })
    const root = await mount()
    const strip = document.querySelector('[aria-label="Automations summary"]') as HTMLElement
    expect(strip.textContent).toContain('Active31')
    expect(strip.textContent).toContain('Paused144')
    await act(async () => root.unmount())
  })
})

describe('JobsView schedule column', () => {
  it('writes "Interval not reported" instead of the bare word "every"', async () => {
    stub()
    const root = await mount()
    const row = rowNames().find((name) => name.includes('waiting-job'))!
    expect(row).toContain('Interval not reported')
    expect(row).not.toMatch(/\bevery\b/)
    await act(async () => root.unmount())
  })
})

describe('JobsView filters in the URL', () => {
  it('writes state, scheduler and search to the URL and clears them with the defaults', async () => {
    stub()
    const root = await mount()
    expect(search()).toBe('')
    await act(async () => byText('Failed')?.click())
    expect(search()).toBe('?state=failed')
    expect(rowNames()).toHaveLength(1)
    await act(async () => byText('Hermes')?.click())
    expect(search()).toContain('scheduler=hermes')
    await act(async () => byText('All')?.click())
    expect(search()).toBe('?scheduler=hermes')
    await act(async () => byText('All schedulers')?.click())
    expect(search()).toBe('')
    await act(async () => root.unmount())
  })

  it('restores filters and search from the URL', async () => {
    stub()
    const root = await mount('/?state=disabled&scheduler=hermes&q=paused-b')
    expect(rowNames()).toHaveLength(1)
    expect(rowNames()[0]).toContain('paused-b')
    expect((document.querySelector('input[placeholder="Search jobs"]') as HTMLInputElement).value).toBe('paused-b')
    expect(text()).toContain('Showing 1 of 5')
    await act(async () => root.unmount())
  })

  it('treats an unknown value in the URL as no filter', async () => {
    stub()
    const root = await mount('/?state=bogus&scheduler=nope')
    expect(rowNames()).toHaveLength(5)
    await act(async () => root.unmount())
  })

  it('keeps other URL parameters when a filter changes', async () => {
    stub()
    const root = await mount('/?view=jobs&job=ok-job')
    await act(async () => byText('Failed')?.click())
    expect(search()).toContain('view=jobs')
    expect(search()).toContain('job=ok-job')
    expect(search()).toContain('state=failed')
    await act(async () => root.unmount())
  })
})

describe('JobsView drawer wording', () => {
  it('describes how a job runs in plain words and hides internal keys', async () => {
    stub()
    const root = await mount('/?job=paused-b')
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawer.textContent).toContain('Shell command in its own session')
    expect(drawer.textContent).not.toContain('agentTurn')
    expect(drawer.textContent).toContain('Built-in job')
    expect(drawer.textContent).toContain('__openclaw_memory_core_dream__')
    expect(drawer.querySelector('[aria-label="Description"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('shows "Interval not reported" in the drawer too', async () => {
    stub()
    const root = await mount('/?job=waiting-job')
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawer.textContent).toContain('Interval not reported')
    expect(drawer.textContent).toContain('Agent task in its own session')
    await act(async () => root.unmount())
  })
})

describe('JobsView with a scheduler that could not be read', () => {
  const GOOD = { sourceSucceeded: true, observedAt: new Date().toISOString() }
  const UNREAD = { sourceSucceeded: false, observedAt: null }
  const hermesOnly = jobs.filter((j) => j.scheduler === 'hermes')
  const strip = () => (document.querySelector('[aria-label="Automations summary"]') as HTMLElement).textContent ?? ''

  it('both read: numbers and counts show, no notice', async () => {
    stub({ jobs, summary, schedulers: { openclaw: GOOD, hermes: GOOD }, meta: { ok: true, stale: false, error: null } })
    const root = await mount()
    expect(strip()).toContain('Failed1')
    expect(text()).not.toContain('could not be read')
    expect(byText('OpenClaw')?.textContent).toContain('3')
    await act(async () => root.unmount())
  })

  it('OpenClaw unread: warns, shows dashes instead of 0, and OpenClaw has no count', async () => {
    stub({
      jobs: hermesOnly,
      summary: { active: 0, paused: 2, failed: 0, nextRunAt: null },
      schedulers: { openclaw: UNREAD, hermes: GOOD },
      meta: { ok: false, stale: true, error: { code: 'scheduler_stale', message: 'One or more scheduler readings are unavailable or cached' } },
    })
    const root = await mount()
    expect(text()).toContain('OpenClaw could not be read')
    expect(strip()).toContain('Failed—')
    expect(strip()).not.toContain('Failed0')
    expect(strip()).toContain('Active—')
    expect(strip()).toContain('OpenClaw not read')
    const chip = byText('OpenClaw')!
    expect(chip.textContent).toContain('not read')
    expect(chip.textContent).not.toMatch(/\d/)
    expect(byText('Failed')?.textContent).not.toMatch(/\d/)
    expect(byText('Hermes')?.textContent).toContain('2')
    await act(async () => root.unmount())
  })

  it('OpenClaw filter on an unread scheduler says it was not read, not that nothing matches', async () => {
    stub({ jobs: hermesOnly, summary, schedulers: { openclaw: UNREAD, hermes: GOOD }, meta: { ok: false, stale: true } })
    const root = await mount('/?scheduler=openclaw')
    expect(text()).toContain('OpenClaw was not read')
    expect(text()).not.toContain('No jobs match')
    await act(async () => root.unmount())
  })

  it('Hermes unread names Hermes', async () => {
    stub({
      jobs: jobs.filter((j) => j.scheduler === 'openclaw'),
      summary,
      schedulers: { openclaw: GOOD, hermes: UNREAD },
      meta: { ok: false, stale: true },
    })
    const root = await mount()
    expect(text()).toContain('Hermes could not be read')
    expect(strip()).toContain('Hermes not read')
    expect(strip()).not.toContain('OpenClaw not read')
    await act(async () => root.unmount())
  })

  it('both unread: no list, an explicit not-read state, no create call to action', async () => {
    stub({ jobs: [], summary: { active: 0, paused: 0, failed: 0, nextRunAt: null }, schedulers: { openclaw: UNREAD, hermes: UNREAD }, meta: { ok: false, stale: true } })
    const root = await mount()
    expect(text()).toContain('OpenClaw could not be read')
    expect(text()).toContain('Hermes could not be read')
    expect(text()).toContain('Automations were not read')
    expect(text()).not.toContain('No automations yet')
    expect(strip()).not.toMatch(/(Active|Paused|Failed)0/)
    await act(async () => root.unmount())
  })

  it('stale but served: keeps the rows and the numbers, and warns', async () => {
    const stale = { sourceSucceeded: true, stale: true, staleAgeMs: 420_000, observedAt: new Date(Date.now() - 420_000).toISOString() }
    stub({ jobs, summary, schedulers: { openclaw: stale, hermes: GOOD }, meta: { ok: false, stale: true } })
    const root = await mount()
    expect(text()).toContain('OpenClaw jobs are from an older reading')
    expect(strip()).toContain('Failed1')
    expect(rowNames()).toHaveLength(5)
    await act(async () => root.unmount())
  })
})

describe('JobsView drawer details', () => {
  it('a failed job says why when the API gives a reason, and says so when it does not', async () => {
    stub({ jobs: [job({ id: 'bad', status: 'failed', lastError: 'Gateway timeout' }), job({ id: 'bad2', status: 'failed' })], summary })
    let root = await mount('/?job=bad')
    expect((document.querySelector('[role="dialog"]') as HTMLElement).textContent).toContain('Gateway timeout')
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    root = await mount('/?job=bad2')
    const drawer = (document.querySelector('[role="dialog"]') as HTMLElement).textContent
    expect(drawer).toContain('Why it failed')
    expect(drawer).toContain('No reason reported')
    await act(async () => root.unmount())
  })

  it('a description cut by the list ends with an ellipsis', async () => {
    stub({ jobs: [job({ id: 'long', description: 'x'.repeat(120) }), job({ id: 'short', description: 'Short one' })], summary })
    let root = await mount('/?job=long')
    expect((document.querySelector('[aria-label="Description"]') as HTMLElement).textContent).toContain('x…')
    await act(async () => root.unmount())
    document.body.innerHTML = ''
    root = await mount('/?job=short')
    expect((document.querySelector('[aria-label="Description"]') as HTMLElement).textContent).not.toContain('…')
    await act(async () => root.unmount())
  })

  it('focus returns to the button that opened a confirmation from the drawer', async () => {
    stub()
    const root = await mount('/?job=ok-job')
    const drawerRun = document.querySelector('[data-return-focus="run"]') as HTMLButtonElement
    await act(async () => drawerRun.click())
    const cancel = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement
    await act(async () => cancel.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(document.activeElement).toBe(document.querySelector('[data-return-focus="run"]'))
    await act(async () => root.unmount())
  })
})
