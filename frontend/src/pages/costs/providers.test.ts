import { describe, expect, it } from 'vitest'
import {
  joinNames,
  ledgerTokenReading,
  NO_PROVIDER_ISSUES,
  providerCoverageSentences,
  providerRows,
  summarizeProviderCoverage,
} from './lib'
import type { UsageProvider } from './types'

const provider = (overrides: Partial<UsageProvider>): UsageProvider => ({
  id: 'codex',
  label: 'Codex App and CLI',
  state: 'ready',
  observedAt: '2026-11-11T08:00:00.000Z',
  coverage: 'complete',
  tokens: 100,
  apiEquivalentUsd: 5,
  billedUsd: null,
  note: 'note',
  ...overrides,
})

describe('providerRows', () => {
  it('returns nothing for a payload without providers', () => {
    expect(providerRows(undefined)).toEqual([])
    expect(providerRows(null)).toEqual([])
    expect(providerRows([])).toEqual([])
  })

  it('keeps payload order and adds no platform the payload does not list', () => {
    const rows = providerRows([provider({ id: 'a', label: 'A' }), provider({ id: 'b', label: 'B' })])
    expect(rows.map(row => row.id)).toEqual(['a', 'b'])
  })

  it('treats an unavailable provider as not read and nulls every figure, even sent zeros', () => {
    const [row] = providerRows([provider({ state: 'unavailable', tokens: 0, apiEquivalentUsd: 0, billedUsd: 0 })])
    expect(row.read).toBe(false)
    expect(row.uiState).toBe('unavailable')
    expect(row.stateWord).toBe('Not read')
    expect(row.tokens).toBeNull()
    expect(row.apiEquivalentUsd).toBeNull()
    expect(row.billedUsd).toBeNull()
    expect(row.freshness).toBeNull()
  })

  it('treats a ready provider without a token reading as not read, never as healthy', () => {
    const [row] = providerRows([provider({ tokens: null })])
    expect(row.read).toBe(false)
    expect(row.uiState).toBe('unavailable')
  })

  it('treats a state the page does not know as not read', () => {
    const [row] = providerRows([provider({ state: 'warming' })])
    expect(row.read).toBe(false)
    expect(row.stateWord).toBe('Not read')
  })

  it('ignores non-finite numbers rather than rendering them', () => {
    const [row] = providerRows([provider({ apiEquivalentUsd: Number.NaN, billedUsd: Number.POSITIVE_INFINITY })])
    expect(row.apiEquivalentUsd).toBeNull()
    expect(row.billedUsd).toBeNull()
    expect(row.tokens).toBe(100)
  })

  it('a provider that was read and recorded nothing is its own quiet state, with no billed figure', () => {
    const [row] = providerRows([provider({ tokens: 0, apiEquivalentUsd: 0, billedUsd: 0 })])
    expect(row.read).toBe(true)
    expect(row.noRecords).toBe(true)
    expect(row.tokens).toBe(0)
    expect(row.apiEquivalentUsd).toBe(0)
    expect(row.billedUsd).toBeNull()
    expect(row.uiState).toBe('inactive')
    expect(row.stateWord).toBe('No usage recorded')
  })

  it('a provider with usage is not "no records", even when its API equivalent is unpriced', () => {
    const [row] = providerRows([provider({ tokens: 5, apiEquivalentUsd: null })])
    expect(row.noRecords).toBe(false)
    expect(row.uiState).toBe('healthy')
  })

  it('shows billed only for known billing: a positive figure or an explicit billingKnown', () => {
    const rows = providerRows([
      provider({ billedUsd: 0 }),
      provider({ billedUsd: 0, billingKnown: true }),
      provider({ billedUsd: 3.2 }),
      provider({ billedUsd: null, billingKnown: true }),
    ])
    expect(rows.map(row => row.billedUsd)).toEqual([null, 0, 3.2, null])
  })

  it('maps stale to a warning with a server freshness verdict', () => {
    const [row] = providerRows([provider({ state: 'stale' })])
    expect(row.uiState).toBe('warning')
    expect(row.stateWord).toBe('Stale')
    expect(row.freshness).toBe('stale')
  })

  it('shows known partial coverage in words, neutral and never green; an unknown coverage stays amber', () => {
    const [partial, unknown] = providerRows([provider({ coverage: 'partial' }), provider({ coverage: 'something' })])
    // Claude Code and Codex are normally partial here: a standing condition, not an alarm, and
    // not confirmed-normal either, so it gets the neutral dot rather than the green one.
    expect(partial.uiState).toBe('inactive')
    expect(partial.stateWord).toBe('Partial')
    expect(partial.coverage).toBe('partial')
    expect(unknown.coverage).toBe('unknown')
    expect(unknown.uiState).toBe('warning')
  })

  it('never gives a partial, stale, unread or no-record platform the healthy state', () => {
    const rows = providerRows([
      provider({ coverage: 'partial' }),
      provider({ coverage: 'x' }),
      provider({ state: 'stale' }),
      provider({ state: 'unavailable', tokens: null }),
      provider({ tokens: 0, apiEquivalentUsd: 0 }),
      provider({ tokens: 0, apiEquivalentUsd: 0, coverage: 'partial' }),
    ])
    expect(rows.map(row => row.uiState)).toEqual(['inactive', 'warning', 'warning', 'unavailable', 'inactive', 'inactive'])
    expect(rows.every(row => row.uiState !== 'healthy')).toBe(true)
  })

  it('maps a complete, ready provider to healthy and lets the age decide freshness', () => {
    const [row] = providerRows([provider({})])
    expect(row.uiState).toBe('healthy')
    expect(row.stateWord).toBe('Ready')
    expect(row.freshness).toBeUndefined()
  })

  it('drops blank notes', () => {
    expect(providerRows([provider({ note: '   ' })])[0].note).toBeNull()
    expect(providerRows([provider({ note: null })])[0].note).toBeNull()
  })
})

describe('summarizeProviderCoverage', () => {
  it('reports no issues when every provider was read in full', () => {
    const summary = summarizeProviderCoverage(providerRows([provider({}), provider({ id: 'b', label: 'B' })]))
    expect(summary).toEqual(NO_PROVIDER_ISSUES)
    expect(providerCoverageSentences(summary)).toEqual([])
  })

  it('names unread, partial and stale platforms separately', () => {
    const summary = summarizeProviderCoverage(providerRows([
      provider({ id: 'a', label: 'A', state: 'unavailable', tokens: null }),
      provider({ id: 'b', label: 'B', coverage: 'partial' }),
      provider({ id: 'c', label: 'C', state: 'stale', coverage: 'partial' }),
      provider({ id: 'd', label: 'D' }),
    ]))
    expect(summary.unread).toEqual(['A'])
    expect(summary.partial).toEqual(['B'])
    expect(summary.stale).toEqual(['C'])
    expect(summary.hasIssues).toBe(true)
    expect(summary.standingOnly).toBe(false)
  })

  it('partial records alone are a standing condition, not a warning', () => {
    const summary = summarizeProviderCoverage(providerRows([
      provider({ id: 'claude_code', label: 'Claude Code', coverage: 'partial' }),
      provider({ id: 'codex', label: 'Codex', coverage: 'partial' }),
      provider({ id: 'hermes', label: 'Hermes' }),
    ]), true)
    expect(summary.standingOnly).toBe(true)
    expect(summary.hasIssues).toBe(true)
    expect(summary.unexplained).toBe(false)
    expect(providerCoverageSentences(summary).join(' ')).toContain('Claude Code and Codex have incomplete records')
  })

  it('turns the payload missingProviders reasons into sentences and never double-counts an unread platform', () => {
    const rows = providerRows([
      provider({ id: 'hermes', label: 'Hermes', state: 'unavailable', tokens: null }),
      provider({ id: 'codex', label: 'Codex' }),
    ])
    const summary = summarizeProviderCoverage(rows, true, [
      { id: 'hermes', label: 'Hermes', reason: 'usage_unavailable' },
      { id: 'codex', label: 'Codex', reason: 'ownership_overlap_unresolved' },
      { id: 'openclaw', label: 'OpenClaw', reason: 'window_not_observed' },
    ])
    expect(summary.unread).toEqual(['Hermes', 'OpenClaw'])
    expect(summary.gaps).toEqual(['Codex overlaps another platform and could not be attributed with certainty.'])
    expect(summary.standingOnly).toBe(false)
    expect(summary.unexplained).toBe(false)
  })

  it('a partial window with an unpriced platform is not "standing only"', () => {
    const summary = summarizeProviderCoverage(
      providerRows([provider({ coverage: 'partial' })]),
      true,
      [{ id: 'codex', label: 'Codex', reason: 'partially_priced_usage' }],
    )
    expect(summary.standingOnly).toBe(false)
    expect(summary.gaps[0]).toContain('has no public price')
  })

  it('trusts the backend partial flag when no platform explains it', () => {
    const summary = summarizeProviderCoverage(providerRows([provider({})]), true)
    expect(summary.unexplained).toBe(true)
    expect(summary.hasIssues).toBe(true)
    expect(providerCoverageSentences(summary).join(' ')).toContain('The backend marks some usage as missing.')
  })

  it('does not call a total partial just because the backend flag is absent', () => {
    expect(summarizeProviderCoverage(providerRows([provider({})]), false).hasIssues).toBe(false)
  })

  it('counts every platform as unread when none could be read', () => {
    const summary = summarizeProviderCoverage(providerRows([
      provider({ id: 'a', label: 'A', state: 'unavailable', tokens: null }),
      provider({ id: 'b', label: 'B', state: 'unavailable', tokens: null }),
    ]))
    expect(summary.unread).toEqual(['A', 'B'])
  })
})

describe('providerCoverageSentences', () => {
  it('says the total is partial and names the unread platforms', () => {
    const sentences = providerCoverageSentences({ ...NO_PROVIDER_ISSUES, hasIssues: true, unread: ['Hermes'] })
    expect(sentences[0]).toBe('This total is partial.')
    expect(sentences).toContain('Hermes could not be read and is not counted.')
  })

  it('uses plural forms for several platforms', () => {
    const sentences = providerCoverageSentences({ ...NO_PROVIDER_ISSUES, hasIssues: true, unread: ['A', 'B', 'C'], partial: ['D', 'E'] })
    expect(sentences).toContain('A, B and C could not be read and are not counted.')
    expect(sentences).toContain('D and E have incomplete records, so their figures may be low.')
  })

  it('joins names', () => {
    expect(joinNames([])).toBe('')
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B'])).toBe('A and B')
  })
})

describe('ledgerTokenReading', () => {
  it('returns the period tokens', () => {
    expect(ledgerTokenReading({ periodTokens: 42, thisMonthTokens: 1000 })).toBe(42)
    expect(ledgerTokenReading({ periodTokens: 0 })).toBe(0)
  })

  it('returns null, not 0, when no platform could be read', () => {
    expect(ledgerTokenReading({ periodTokens: null })).toBeNull()
    expect(ledgerTokenReading(undefined)).toBeNull()
    expect(ledgerTokenReading(null)).toBeNull()
  })

  it('does not substitute a month figure for a period that was not read', () => {
    expect(ledgerTokenReading({ periodTokens: null, thisMonthTokens: 1000, totalTokens: 2000 })).toBeNull()
  })

  it('falls back to older fields only when the payload has no periodTokens at all', () => {
    expect(ledgerTokenReading({ thisMonthTokens: 1000, totalTokens: 2000 })).toBe(1000)
    expect(ledgerTokenReading({ totalTokens: 2000 })).toBe(2000)
    expect(ledgerTokenReading({})).toBeNull()
  })
})
