// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/ui'
import { STALE_WRITE_NOTE } from '../lib/writes'
import Costs from './Costs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const LEDGER = {
  source: 'token-usage.csv',
  period: { key: 'month', anchor: null },
  serverMonth: '2026-11',
  daily: [], dailyByModel: [], byService: [], agents: [],
  summary: { periodUsd: 0, thisMonthUsd: 0, periodTokens: 0, thisMonthTokens: 0, totalTokens: 0 },
  budget: { monthly: 100 },
  meta: { updatedAt: '2026-11-11T10:00:00Z', refreshing: false, stale: false },
}

function stub(answer: () => Response) {
  const posts: unknown[] = []
  let gate: Promise<void> | null = null
  let release: () => void = () => undefined
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if ((init?.method ?? 'GET') !== 'GET') {
      posts.push({ path: url.pathname, body: JSON.parse(String(init?.body)) })
      gate = new Promise<void>((resolve) => { release = resolve })
      return answer()
    }
    if (url.pathname === '/api/costs') {
      if (gate) await gate
      return json(LEDGER)
    }
    if (url.pathname === '/api/sessions') return json({ sessions: [] })
    if (url.pathname === '/api/costs/months') return json({ months: [], generatedAt: null, partial: false, sourceStatus: {} })
    return json({ modules: {} })
  }))
  return { posts, release: () => release() }
}

async function mount() {
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

async function saveBudget(host: HTMLElement, amount: string) {
  const input = host.querySelector('input[type="number"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, amount)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement
  await act(async () => {
    save.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Costs: saving the budget', () => {
  it('shows the saved cap at once and says calmly when the reading is behind', async () => {
    const s = stub(() => json({ status: 'saved', budget: { monthly: 300 }, meta: { ok: false, stale: true } }))
    const { host, root } = await mount()
    expect(host.textContent).toContain('$100.00 a month')
    expect(host.textContent).not.toContain(STALE_WRITE_NOTE)
    await saveBudget(host, '250')
    expect(s.posts).toEqual([{ path: '/api/settings/budget', body: { monthly: 250 } }])
    // The refetch of the ledger is held: the page has only the answer to the write.
    // The server's committed cap (300) wins over what was sent (250).
    expect(host.textContent).toContain('$300.00 a month')
    expect(host.textContent).toContain(STALE_WRITE_NOTE)
    s.release()
    await act(async () => root.unmount())
  })

  it('trusts the committed budget over the value that was sent', async () => {
    const s = stub(() => json({ status: 'saved', budget: { monthly: null }, meta: { ok: true, stale: false } }))
    const { host, root } = await mount()
    await saveBudget(host, '250')
    expect(host.textContent).toContain('No cap is saved yet.')
    expect(host.textContent).not.toContain(STALE_WRITE_NOTE)
    s.release()
    await act(async () => root.unmount())
  })
})
