// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/ui'
import ScheduleView from './ScheduleView'
import type { CalendarPayload } from './scheduleLib'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const clean: CalendarPayload = {
  entries: [],
  diagnostics: { quarantined: { count: 0, ids: [] }, duplicates: { count: 0, ids: [] } },
  meta: { ok: true, stale: false, error: null, repairAvailable: false },
}
const damaged = (repairAvailable: boolean): CalendarPayload => ({
  entries: [],
  diagnostics: { quarantined: { count: 2, ids: ['bad-1', null] }, duplicates: { count: 1, ids: ['dup'] } },
  meta: { ok: false, stale: true, error: { code: 'calendar_entries_quarantined', message: 'Malformed entries were quarantined' }, repairAvailable },
})

async function mount(payload: CalendarPayload) {
  vi.stubGlobal('fetch', vi.fn(async () => json(payload)))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MemoryRouter, null, createElement(ToastProvider, null, createElement(ScheduleView))),
      ),
    ),
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { host, root }
}

const alarms = () => [...document.querySelectorAll('[data-state="warning"][role="status"]')] as HTMLElement[]

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Schedule alarm line', () => {
  it('a damaged calendar is one alarm line with the repair as its only action', async () => {
    const { root } = await mount(damaged(true))
    expect(alarms()).toHaveLength(1)
    expect(alarms()[0].textContent).toContain('Caution')
    expect(alarms()[0].textContent).toContain('Some schedule rows were set aside')
    expect([...alarms()[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Repair calendar'])
    await act(async () => root.unmount())
  })

  it('without a repair on offer the alarm line has no action', async () => {
    const { root } = await mount(damaged(false))
    expect(alarms()).toHaveLength(1)
    expect(alarms()[0].querySelectorAll('button')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('a clean calendar has no alarm line at all', async () => {
    const { root } = await mount(clean)
    expect(document.querySelector('[role="alert"], [data-state="warning"][role="status"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('shows the seven days as stacked blocks, each with its count, not as a grid', async () => {
    const { host, root } = await mount(clean)
    const days = [...host.querySelectorAll('section[aria-label]')].filter((s) => /\d/.test(s.getAttribute('aria-label') ?? ''))
    expect(days).toHaveLength(7)
    expect(host.textContent).toContain('Nothing scheduled.')
    await act(async () => root.unmount())
  })
})
