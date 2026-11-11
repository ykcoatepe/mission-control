// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import ProvidersPanel from './ProvidersPanel'
import { providerRows } from './lib'
import type { UsageProvider } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const provider = (overrides: Partial<UsageProvider>): UsageProvider => ({
  id: 'codex',
  label: 'Codex App and CLI',
  state: 'ready',
  observedAt: new Date().toISOString(),
  coverage: 'complete',
  tokens: 2_400_000,
  apiEquivalentUsd: 816.9,
  billedUsd: null,
  billingKnown: false,
  hasRecords: true,
  coverageReason: 'none',
  skippedLines: null,
  oversizedLines: null,
  note: 'Local usage records',
  ...overrides,
})

async function render(providers: UsageProvider[], props: { pending?: boolean } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => createRoot(host).render(
    createElement(ProvidersPanel, { periodName: 'This month', rows: providerRows(providers), ...props }),
  ))
  return host
}

const cells = (host: HTMLElement) => Array.from(host.querySelectorAll('tbody tr')).map(tr =>
  Array.from(tr.querySelectorAll('td')).map(td => td.textContent ?? ''))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ProvidersPanel', () => {
  it('lists one row per provider the payload carries, and no other platform', async () => {
    const host = await render([
      provider({ id: 'claude_code', label: 'Claude Code' }),
      provider({ id: 'codex' }),
    ])
    const rows = cells(host)
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row[0])).toEqual(['Claude Code', 'Codex App and CLI'])
    expect(host.textContent).not.toMatch(/grok/i)
    expect(host.querySelector('h2')?.textContent).toBe('Platforms')
  })

  it('shows a read provider with state, freshness, tokens, API equivalent, billed and coverage', async () => {
    const host = await render([provider({ billedUsd: 12.5, billingKnown: true })])
    const [row] = cells(host)
    expect(row[1]).toContain('Ready')
    expect(row[1]).toContain('fresh')
    expect(row[2]).toBe('2.4M')
    expect(row[3]).toBe('$816.90')
    expect(row[4]).toBe('$12.50')
    expect(row[5]).toBe('Local usage records')
  })

  it('shows an unread provider as "Not read" with dashes, never 0', async () => {
    const host = await render([
      provider({ id: 'hermes', label: 'Hermes', state: 'unavailable', tokens: null, apiEquivalentUsd: null, billedUsd: null, observedAt: null, note: 'Usage has not been observed' }),
    ])
    const [row] = cells(host)
    expect(row[1]).toContain('Not read')
    expect(row[1]).not.toContain('fresh')
    expect(row.slice(2, 5)).toEqual(['—', '—', '—'])
    expect(row[5]).toContain('Usage has not been observed')
    expect(row.join(' ')).not.toMatch(/\$0|\b0\b/)
  })

  it('does not trust numbers sent with an unreadable provider', async () => {
    const host = await render([
      provider({ state: 'unavailable', tokens: 0, apiEquivalentUsd: 0, billedUsd: 0 }),
    ])
    const [row] = cells(host)
    expect(row.slice(2, 5)).toEqual(['—', '—', '—'])
  })

  it('a platform that was read and recorded nothing is "No usage recorded" with dashes, not Ready with zeros', async () => {
    const host = await render([
      provider({ id: 'openclaw', label: 'OpenClaw', tokens: 0, apiEquivalentUsd: 0, billedUsd: null, hasRecords: false, note: 'Local usage records; billing unknown unless explicitly recorded' }),
    ])
    const [row] = cells(host)
    expect(row[1]).toContain('No usage recorded')
    expect(row[1]).not.toContain('Ready')
    expect(row.slice(2, 5)).toEqual(['—', '—', '—'])
    expect(host.querySelector('tbody tr')!.textContent).not.toMatch(/\$0/)
  })

  it('billed shows a figure only when the server says billing is known', async () => {
    const host = await render([
      provider({ id: 'a', label: 'A', billedUsd: 0 }),
      provider({ id: 'b', label: 'B', billedUsd: 0, billingKnown: true }),
      provider({ id: 'c', label: 'C', billedUsd: 12.5, billingKnown: true }),
      provider({ id: 'd', label: 'D', billedUsd: null, billingKnown: true }),
      provider({ id: 'e', label: 'E', billedUsd: 12.5, billingKnown: false }),
    ])
    const rows = cells(host)
    expect(rows.map(row => row[4])).toEqual(['—', '$0.00', '$12.50', '—', '—'])
  })

  it('marks stale and partial providers in amber words, not as ready', async () => {
    const host = await render([
      provider({ id: 'claude_code', label: 'Claude Code', coverage: 'partial', coverageReason: 'standing_gaps', skippedLines: 99, oversizedLines: 99, note: 'Claude log scan incomplete' }),
      provider({ id: 'codex', state: 'stale' }),
    ])
    const [partial, stale] = cells(host)
    expect(partial[1]).toContain('Partial')
    expect(partial[1]).not.toContain('Ready')
    expect(partial[5]).toBe('Claude log scan incomplete 99 lines skipped (99 oversized).')
    expect(stale[1]).toContain('Stale')
    expect(stale[1]).toContain('stale')
  })

  it('explains how new platforms arrive, and says why the list is empty', async () => {
    const full = await render([provider({})])
    expect(full.textContent).toContain('A new platform appears here automatically once the backend has a provider for it.')
    document.body.innerHTML = ''
    const empty = await render([])
    expect(empty.querySelector('table')).toBeNull()
    expect(empty.textContent).toContain('No platform has been read yet')
  })

  it('shows a loading placeholder while the payload belongs to another period', async () => {
    const host = await render([provider({})], { pending: true })
    expect(host.querySelector('table')).toBeNull()
    expect(host.querySelector('[role="status"]')).not.toBeNull()
  })
})
