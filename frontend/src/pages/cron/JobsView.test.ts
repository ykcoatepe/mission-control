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
    expect(strip.textContent).toContain('1 failed last run')
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
