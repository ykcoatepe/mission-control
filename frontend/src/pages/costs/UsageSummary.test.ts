// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import UsageSummary from './UsageSummary'
import type { UsageSummaryProps } from './UsageSummary'
import type { ProviderCoverage } from './lib'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const base: UsageSummaryProps = {
  mode: 'api-equivalent',
  periodName: 'This month',
  periodCost: 50,
  previousPeriodCost: 40,
  trend: { direction: 'up', percentage: 25, label: null } as UsageSummaryProps['trend'],
  compareLabel: 'vs previous month',
  dailyPace: 2,
  projection: 60,
  completePeriod: false,
  trackedSpend: 12,
  trackedNote: null,
  periodTokens: 1234,
  reliability: 'estimated',
  sourceIssues: [],
  sourceIssueTone: 'info',
}

async function render(props: Partial<UsageSummaryProps> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => createRoot(host).render(createElement(UsageSummary, { ...base, ...props })))
  return host
}

const coverage = (overrides: Partial<ProviderCoverage>): ProviderCoverage => ({
  unread: [],
  partial: [],
  stale: [],
  gaps: [],
  unexplained: false,
  hasIssues: true,
  standingOnly: false,
  ...overrides,
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('UsageSummary', () => {
  it('keeps the API-equivalent estimate and tracked billing as separate figures', async () => {
    const host = await render()
    const text = host.textContent ?? ''
    expect(text).toContain('This month · API equivalent')
    expect(text).toContain('$50.00')
    expect(text).toMatch(/Tracked spend\$12\.00/)
  })

  it('says billing coverage is unavailable instead of showing tracked spend as zero', async () => {
    const host = await render({ trackedSpend: null })
    expect(host.textContent).toMatch(/Tracked spend.*not read/)
    expect(host.textContent).toContain('Billing not read')
    expect(host.textContent).not.toMatch(/Tracked spend\$0\.00/)
  })

  it('labels a partial estimate as an estimate, not an invoice', async () => {
    const host = await render({ reliability: 'partial' })
    expect(host.textContent).toContain('Partial estimate, not an invoice')
  })

  it('shows an unavailable estimate as a missing value with a warning, never as zero spend', async () => {
    const host = await render({ reliability: 'unavailable', periodCost: null, previousPeriodCost: null, dailyPace: null, projection: null })
    const text = host.textContent ?? ''
    expect(text).toContain('Estimate unavailable')
    expect(text).not.toMatch(/\$\s?0\.00/)
    expect(text).toMatch(/This month · API equivalent.*not read/)
  })

  it('distinguishes local-only usage and an empty period from a priced zero', async () => {
    expect((await render({ reliability: 'not_applicable' })).textContent).toContain('No public price to compare')
    document.body.innerHTML = ''
    expect((await render({ reliability: 'no_usage' })).textContent).toContain('No usage recorded')
  })

  it('reports a finished period as a total, with no projection', async () => {
    expect((await render()).textContent).toContain('Projection')
    document.body.innerHTML = ''
    expect((await render({ completePeriod: true })).textContent).not.toContain('Projection')
  })

  it('shows billed spend without an estimate notice when the source is live billing', async () => {
    const host = await render({ mode: 'tracked' })
    expect(host.textContent).toContain('This month · billed')
    expect(host.textContent).not.toContain('Estimate, not an invoice')
    expect(host.textContent).not.toMatch(/Tracked spend\$/)
  })

  it('surfaces source problems and in-flight refreshes', async () => {
    const warning = await render({ sourceIssues: ['Hermes could not be read, so totals may be low.'], sourceIssueTone: 'warning' })
    expect(warning.textContent).toContain('Some usage may be missing')
    expect(warning.textContent).toContain('Hermes could not be read')
    document.body.innerHTML = ''
    const info = await render({ sourceIssues: ['Still refreshing; figures may change.'], sourceIssueTone: 'info' })
    expect(info.textContent).toContain('Refreshing')
  })

  it('says the total is partial and names the unread platforms in the estimate notice', async () => {
    const host = await render({ reliability: 'partial', platformCoverage: coverage({ unread: ['Hermes', 'OpenClaw'] }) })
    const text = host.textContent ?? ''
    expect(text).toContain('This total is partial.')
    expect(text).toContain('Hermes and OpenClaw could not be read and are not counted.')
    expect(text).toContain('Partial estimate, not an invoice')
  })

  it('names platforms with incomplete records and stale readings', async () => {
    const host = await render({ platformCoverage: coverage({ partial: ['Claude Code'], stale: ['Codex App and CLI'] }) })
    const text = host.textContent ?? ''
    expect(text).toContain('Claude Code has incomplete records, so its figure may be low.')
    expect(text).toContain('Codex App and CLI shows the last good reading.')
    expect(text).not.toContain('could not be read')
  })

  it('keeps the notice about estimates quiet when every platform was read in full', async () => {
    const host = await render({ platformCoverage: coverage({ hasIssues: false }) })
    expect(host.textContent).not.toContain('This total is partial.')
    expect(host.textContent).toContain('Estimate, not an invoice')
  })

  it('shows tokens as not read, never 0, when no platform could be read', async () => {
    const host = await render({ periodTokens: null, platformCoverage: coverage({ unread: ['Claude Code', 'Codex App and CLI'] }) })
    const text = host.textContent ?? ''
    expect(text).toMatch(/Tokens.*not read/)
    expect(text).toContain('No platform could be read')
    expect(text).not.toMatch(/Tokens0/)
  })

  it('says "partial" once: the token figure carries no second partial flag', async () => {
    const host = await render({ platformCoverage: coverage({ unread: ['Hermes'] }) })
    expect(host.textContent).toContain('1,234 in this period')
    expect(host.textContent).not.toContain('in this period, partial')
  })

  it('partial records alone make one calm info notice that points at the Platforms table', async () => {
    const host = await render({
      reliability: 'estimated',
      platformCoverage: coverage({ partial: ['Claude Code', 'Codex'], standingOnly: true }),
    })
    const text = host.textContent ?? ''
    expect(text).toContain('Claude Code and Codex have incomplete records')
    expect(text).toContain('The Platforms table above says why, platform by platform.')
    expect(text.match(/This total is partial\./g)).toHaveLength(1)
    expect(host.querySelectorAll('[data-tone]')).toHaveLength(1)
    expect(host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('info')
  })

  it('a platform that was not read is a missing reading (hollow mark), not a coloured fault', async () => {
    const host = await render({ platformCoverage: coverage({ unread: ['Hermes'] }) })
    expect(host.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('unread')
    expect(host.querySelector('[data-tone] svg')).not.toBeNull()
    expect(host.querySelector('[data-state="warning"], [data-state="critical"]')).toBeNull()
    expect(host.textContent).toContain('Hermes could not be read and is not counted.')
  })

  it('names unresolved window gaps from the payload', async () => {
    const host = await render({ platformCoverage: coverage({ gaps: ['Codex overlaps another platform and could not be attributed with certainty.'] }) })
    expect(host.textContent).toContain('Codex overlaps another platform')
  })

  it('renders the Platforms slot directly after the headline strip, before the notices', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    await act(async () => createRoot(host).render(
      createElement(UsageSummary, { ...base }, createElement('section', { 'data-testid': 'slot' }, 'Platforms slot')),
    ))
    const strip = host.querySelector('[aria-label="Usage for This month"]')
    const slot = host.querySelector('[data-testid="slot"]')
    expect(strip?.nextElementSibling).toBe(slot)
    expect(slot?.nextElementSibling?.textContent).toContain('Estimate, not an invoice')
  })
})
