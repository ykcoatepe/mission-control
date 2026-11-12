// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/ui'
import Costs from './Costs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function ledger(overrides: { spent: number; budget: number | null; stale?: boolean }) {
  return {
    source: 'token-usage.csv',
    period: { key: 'month', anchor: null },
    serverMonth: '2026-11',
    daily: [], dailyByModel: [], byService: [], agents: [],
    summary: { periodUsd: overrides.spent, thisMonthUsd: overrides.spent, periodTokens: 10, thisMonthTokens: 10, totalTokens: 10 },
    budget: { monthly: overrides.budget },
    meta: { updatedAt: '2026-11-11T10:00:00Z', refreshing: false, stale: overrides.stale === true },
  }
}

async function mount(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/costs') return json(body)
    if (url.pathname === '/api/sessions') return json({ sessions: [] })
    if (url.pathname === '/api/costs/months') return json({ months: [], generatedAt: null, partial: false, sourceStatus: {} })
    return json({ modules: {} })
  }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  await act(async () =>
    root.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Costs))))),
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  return { host, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Costs: the alarm line', () => {
  it('is absent when the spend is within the budget and every scan completed', async () => {
    const { host, root } = await mount(ledger({ spent: 30, budget: 100 }))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[class*="AlarmLine"]')).toBeNull()
    const meter = host.querySelector('#usage-budget [role="meter"]') as HTMLElement
    expect(meter.getAttribute('aria-valuenow')).toBe('30')
    expect(meter.closest('[data-state]')?.getAttribute('data-state')).toBe('healthy')
    await act(async () => root.unmount())
  })

  it('says critical, once, when the spend is over the budget', async () => {
    const { host, root } = await mount(ledger({ spent: 130, budget: 100 }))
    const alarms = host.querySelectorAll('[role="alert"]')
    expect(alarms).toHaveLength(1)
    expect(alarms[0].textContent).toContain('Critical')
    expect(alarms[0].textContent).toContain('Over budget by $30.00')
    const meter = host.querySelector('#usage-budget [role="meter"]') as HTMLElement
    expect(meter.closest('[data-state]')?.getAttribute('data-state')).toBe('critical')
    await act(async () => root.unmount())
  })

  it('turns the bar to caution above 70% of the budget without raising an alarm', async () => {
    const { host, root } = await mount(ledger({ spent: 80, budget: 100 }))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    const meter = host.querySelector('#usage-budget [role="meter"]') as HTMLElement
    expect(meter.closest('[data-state]')?.getAttribute('data-state')).toBe('warning')
    await act(async () => root.unmount())
  })

  it('names a failed scan with one action to scan again', async () => {
    const { host, root } = await mount(ledger({ spent: 30, budget: 100, stale: true }))
    const alarm = host.querySelector('[role="status"][data-state="warning"]') as HTMLElement
    expect(alarm.textContent).toContain('Caution')
    expect(alarm.textContent).toContain('The latest usage scan did not complete')
    expect(alarm.querySelectorAll('button')).toHaveLength(1)
    expect(alarm.querySelector('button')?.textContent).toBe('Scan again')
    await act(async () => root.unmount())
  })

  it('shows no budget bar when no budget is saved', async () => {
    const { host, root } = await mount(ledger({ spent: 500, budget: null }))
    expect(host.querySelector('#usage-budget [role="meter"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => root.unmount())
  })
})
