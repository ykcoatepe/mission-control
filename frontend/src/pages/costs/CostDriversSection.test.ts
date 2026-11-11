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
  sources: [],
  sourcesPending: false,
  totalSourceTokens: 0,
  sessions: [],
  sessionsLiveOnlyNotice: null,
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
        { name: 'priced', rawNames: ['priced'], tokens: 10, cost: 0, apiEquivalentCost: 7, apiEquivalentAvailable: true, local: false, share: 0 },
        { name: 'local-only', rawNames: ['ollama/local-only'], tokens: 10, cost: 0, apiEquivalentCost: 0, apiEquivalentAvailable: false, local: true, share: 0 },
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

  it('marks preserved (stale) source data and explains each source\'s scope', async () => {
    const host = await render({
      tab: 'sources',
      sources: [
        source({ key: 'claude_code', label: 'Claude Code', status: 'stale' }),
        source({ key: 'codex_cli', label: 'Codex CLI' }),
      ],
      totalSourceTokens: 2000,
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

  it('shows a loading state instead of sources while the source split is pending', async () => {
    const host = await render({ tab: 'sources', sourcesPending: true })
    expect(host.querySelector('table')).toBeNull()
    expect(host.textContent).toContain('By source')
  })

  it('flags live sessions as not belonging to the month in view, only when asked to', async () => {
    const session = { sessionId: 's1', sessionName: 'Main Session', model: 'gpt', tokens: 10, timestamp: null, channel: 'agent' }
    const flagged = await render({ tab: 'sessions', sessions: [session], sessionsLiveOnlyNotice: 'Live sessions only: not scoped to June 2026.' })
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
})
