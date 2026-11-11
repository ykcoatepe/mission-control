// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import CostDriversSection from './CostDriversSection'
import type { AgentSplitItem, CostDriversSectionProps } from './CostDriversSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const source = (overrides: Partial<AgentSplitItem>): AgentSplitItem => ({
  key: 'openclaw',
  label: 'OpenClaw',
  summary: {},
  tokens: 1000,
  cost: 0,
  costLabel: 'Included',
  meteredCost: 0,
  estimatedCost: 0,
  apiEquivalentCost: 5,
  apiEquivalentAvailable: true,
  topModel: 'gpt-5.6',
  ...overrides,
})

const base: CostDriversSectionProps = {
  tab: null,
  setTab: () => {},
  models: [],
  modelApiEquivalentTotal: 0,
  platforms: [],
  platformsPending: false,
  totalPlatformTokens: 0,
  sessions: [],
  sessionsOnlyNotice: null,
  activeSessionCount: 0,
  sessionsWithoutTokens: 0,
  awsServices: null,
}

async function render(props: Partial<CostDriversSectionProps>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => createRoot(host).render(
    createElement(MemoryRouter, null, createElement(CostDriversSection, { ...base, ...props })),
  ))
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('CostDriversSection', () => {
  it('shows API-equivalent and tracked spend as separate columns, with a dash where no price exists', async () => {
    const host = await render({
      models: [
        { name: 'priced', rawNames: ['priced'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 7, apiEquivalentAvailable: true, isLocal: false, share: 0 },
        { name: 'local-only', rawNames: ['ollama/local-only'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 0, apiEquivalentAvailable: false, isLocal: true, share: 0 },
      ],
      modelApiEquivalentTotal: 7,
    })
    const headers = Array.from(host.querySelectorAll('th')).map(th => th.textContent)
    expect(headers).toEqual(expect.arrayContaining(['API equivalent', 'Tracked spend']))
    const rows = Array.from(host.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent))
    expect(rows[0][1]).toBe('$7.00')
    expect(rows[1][1]).toBe('—')
    expect(rows[1][2]).toBe('—')
    expect(host.textContent).toContain('Local')
  })

  it('tags a model Local only when the server said so: unknown (null) and false get no tag', async () => {
    const host = await render({
      models: [
        { name: 'explicit-local', rawNames: ['a'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 1, apiEquivalentAvailable: true, isLocal: true, share: 0 },
        // The name looks local; the server did not say it is, so no tag.
        { name: 'ollama/looks-local', rawNames: ['b'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 1, apiEquivalentAvailable: true, isLocal: null, share: 0 },
        { name: 'not-local', rawNames: ['c'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 1, apiEquivalentAvailable: true, isLocal: false, share: 0 },
      ],
      modelApiEquivalentTotal: 3,
    })
    const rows = Array.from(host.querySelectorAll('tbody tr')).map(tr => tr.querySelector('td')?.textContent ?? '')
    expect(rows[0]).toContain('Local')
    expect(rows[1]).not.toContain('Local')
    expect(rows[2]).not.toContain('Local')
  })

  it('marks preserved (stale) platform data and explains each platform\'s scope', async () => {
    const host = await render({
      tab: 'platforms',
      platforms: [
        source({ key: 'claude_code', label: 'Claude Code', status: 'stale' }),
        source({ key: 'codex_cli', label: 'Codex CLI' }),
      ],
      totalPlatformTokens: 2000,
    })
    const claude = Array.from(host.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('Claude Code'))
    const codex = Array.from(host.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('Codex CLI'))
    expect(claude?.textContent).toContain('Stale')
    expect(codex?.textContent).not.toContain('Stale')
    expect(claude?.textContent).toContain('Local Claude Code sessions')
    expect(codex?.textContent).toContain('Standalone Codex CLI runs')
    const titles = Array.from(host.querySelectorAll('[title]')).map(el => el.getAttribute('title') ?? '')
    expect(titles.some(t => t.includes('API-equivalent estimate, not a subscription invoice'))).toBe(true)
    expect(titles.some(t => t.includes('codex exec / CLI spawns'))).toBe(true)
  })

  it('shows a loading state instead of platforms while the platform split is pending', async () => {
    const host = await render({ tab: 'platforms', platformsPending: true })
    expect(host.querySelector('table')).toBeNull()
    expect(host.textContent).toContain('By platform')
    expect(host.textContent).not.toContain('By source')
  })

  it('uses one vocabulary and leaves tokens and cost to the Platforms panel', async () => {
    const host = await render({
      tab: 'platforms',
      platforms: [source({ key: 'codex', label: 'Codex App and CLI', tokens: 500 })],
      totalPlatformTokens: 1000,
    })
    const headers = Array.from(host.querySelectorAll('th')).map(th => th.textContent)
    expect(headers).toEqual(['Platform', 'Share of tokens', 'Top model', 'Billing'])
    expect(host.textContent).toContain('50.0%')
    expect(host.textContent).not.toMatch(/\bsource\b/i)
  })

  it('flags live sessions as not belonging to the month in view, only when asked to', async () => {
    const session = { sessionId: 's1', sessionName: 'Main Session', model: 'gpt', tokens: 10, timestamp: null, detail: 'Agent main', active: false }
    const flagged = await render({ tab: 'sessions', sessions: [session], sessionsOnlyNotice: 'Recent sessions only: not scoped to June 2026.' })
    expect(flagged.textContent).toContain('not scoped to June 2026')
    document.body.innerHTML = ''
    const plain = await render({ tab: 'sessions', sessions: [session] })
    expect(plain.textContent).not.toContain('not scoped')
    expect(plain.textContent).toContain('Main Session')
  })

  it('opens on AWS services when live billing supplies them, otherwise on models', async () => {
    const aws = await render({ awsServices: [{ name: 'EC2', cost: 4, share: 100 }] })
    expect(aws.textContent).toContain('EC2')
    document.body.innerHTML = ''
    const models = await render({ awsServices: null })
    expect(models.textContent).toContain('No model usage yet')
    expect(models.textContent).not.toContain('EC2')
  })

  it('shows a dash for unknown tracked spend, a real zero only when billing recorded zero', async () => {
    const host = await render({
      models: [
        { name: 'unknown-billing', rawNames: ['u'], platforms: [], tokens: 10, cost: null, apiEquivalentCost: 7, apiEquivalentAvailable: true, isLocal: false, share: 0 },
        { name: 'recorded-zero', rawNames: ['z'], platforms: [], tokens: 10, cost: 0, apiEquivalentCost: 1, apiEquivalentAvailable: true, isLocal: false, share: 0 },
        { name: 'billed', rawNames: ['b'], platforms: [], tokens: 10, cost: 3.5, apiEquivalentCost: 1, apiEquivalentAvailable: true, isLocal: false, share: 0 },
      ],
      modelApiEquivalentTotal: 9,
    })
    const tracked = Array.from(host.querySelectorAll('tbody tr')).map(row => {
      const cells = row.querySelectorAll('td, th')
      return cells[cells.length - 1].textContent?.trim()
    })
    expect(tracked).toEqual(['—', '$0.00', '$3.50'])
  })

  it('shows no share for a platform that has no tokens or could not be read, never 0.0%', async () => {
    const host = await render({
      platforms: [
        source({ key: 'a', label: 'A', tokens: 900 }),
        source({ key: 'b', label: 'B', tokens: 0 }),
        source({ key: 'c', label: 'C', tokens: 100, status: 'unavailable' }),
      ],
      totalPlatformTokens: 1000,
      tab: 'platforms',
    })
    const shares = Array.from(host.querySelectorAll('tbody tr')).map(row => row.querySelectorAll('td, th')[1].textContent?.trim())
    expect(shares[0]).toContain('90.0%')
    expect(shares.slice(1)).toEqual(['—', '—'])
  })
})
