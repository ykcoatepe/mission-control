// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AttentionView from './AttentionView'
import type { ApiMeta, LoopsData } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const META: ApiMeta = { ok: true, stale: false, observedAt: new Date().toISOString(), ageMs: 0, error: null }

const DATA: LoopsData = {
  observedAt: META.observedAt,
  totals: { projects: 2, openFindings: 121, pendingConfirmations: 74, overdueConfirmations: 21 },
  projects: [
    { id: 'argus', restricted: true, openFindings: 117, pendingConfirmations: 74, overdueConfirmations: 21 },
    { id: 'calm', restricted: true, openFindings: 4, pendingConfirmations: 0, overdueConfirmations: 0 },
  ],
  attention: [
    { project: 'argus', kind: 'restricted', restricted: true, severity: 'error', count: 117 },
    {
      project: 'sahil',
      kind: 'finding',
      severity: 'warning',
      code: 'BINDING_DEAD',
      subject: 'self',
      detail: null,
      summary:
        'codex/01a1a0b8-ee6e-7473-b1ac-a0e46370ff66 silent since 2026-11-03T09:25:15+00:00 (rotated session?); managers self: mloop --project sahil unbind --host codex --session NEW && mloop --project sahil bind --name x',
      at: '2026-11-03T09:25:15Z',
    },
  ],
}

async function mount(data: LoopsData = DATA) {
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
          null,
          createElement(AttentionView, { data, meta: META, attention: null, refreshError: null, onRetry: () => undefined }),
        ),
      ),
    ),
  )
  return { host, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AttentionView', () => {
  it('marks overdue confirmations on a restricted row with an icon, the number and the word', async () => {
    const { host, root } = await mount()
    const overdue = [...host.querySelectorAll('tbody tr')]
      .find((tr) => tr.textContent?.includes('argus'))
      ?.querySelector('svg[aria-hidden="true"]')
    expect(overdue).not.toBeNull()
    const cellText = [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('argus'))?.textContent
    expect(cellText).toContain('21 overdue')
    // A restricted project with nothing overdue gets no marker.
    const calm = [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('calm'))
    expect(calm?.textContent).toContain('0 overdue')
    expect(calm?.querySelector('svg')).toBeNull()
    await act(async () => root.unmount())
  })

  it('counts chips in confirmations and findings, like the stats, and offers no chip that filters nothing', async () => {
    const { host, root } = await mount()
    const chips = [...host.querySelectorAll('[aria-label="Filter the attention list"] button')].map((b) => [...b.childNodes].map((n) => n.textContent?.trim()).filter(Boolean).join(' '))
    expect(chips).toContain('Overdue confirmations 21')
    expect(chips).toContain('Pending confirmations 74')
    // The one finding row plus both restricted rows match "findings": it equals All, so it is not a chip.
    expect(chips.some((chip) => chip?.startsWith('Findings'))).toBe(false)
    expect(chips[0]).toBe('All')
    await act(async () => root.unmount())
  })

  it('shows a command in a code block under a plain summary, not in the sentence', async () => {
    const { host, root } = await mount()
    const row = [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('sahil'))!
    expect(row.textContent).toContain('Session stopped answering')
    expect(row.textContent).toContain('BINDING_DEAD')
    // The command was long but complete: it sits in a code element, not in the summary line.
    const code = row.querySelector('code')
    expect(code?.textContent).toMatch(/^mloop --project sahil unbind/)
    const summary = row.querySelector('span[title]')?.textContent ?? ''
    expect(summary).not.toContain('mloop')
    expect(summary).not.toContain('2026-11-03T')
    expect(summary).toContain('01a1a0b8…')
    await act(async () => root.unmount())
  })
})
