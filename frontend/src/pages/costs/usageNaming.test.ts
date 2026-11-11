import { describe, expect, it } from 'vitest'
import {
  canonicalModelName,
  chartSummary,
  describeSession,
  modelIdentity,
  normalizedModelId,
  periodReading,
  providerRows,
  splitModelKey,
  uniqueModelNames,
} from './lib'
import { loadSeriesColorMemory, saveSeriesColorMemory, SERIES_COLOR_STORAGE_KEY } from './seriesColorStore'
import type { ChartDataRow, UsageProvider } from './types'

describe('model names: platform and model are two fields', () => {
  it('splits "<platform> / <model>" and leaves a bare model alone', () => {
    expect(splitModelKey('Claude Code / claude-opus-5-5')).toEqual({ platform: 'Claude Code', model: 'claude-opus-5-5' })
    expect(splitModelKey('Hermes / openai-codex/gpt-6.1-sol')).toEqual({ platform: 'Hermes', model: 'openai-codex/gpt-6.1-sol' })
    expect(splitModelKey('gpt-5.4')).toEqual({ platform: null, model: 'gpt-5.4' })
  })

  it('names every family the same way, with the version', () => {
    expect(canonicalModelName('Claude Code / claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(canonicalModelName('Claude Code / claude-fable-5-2')).toBe('Claude Fable 5.2')
    expect(canonicalModelName('Claude Code / claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5')
    expect(canonicalModelName('Codex App and CLI / openai/gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(canonicalModelName('Hermes / openai-codex/gpt-6-astra')).toBe('GPT-6 Astra')
    expect(canonicalModelName('Hermes / unknown/gpt-5.6-terra')).toBe('GPT-5.6 Terra')
    expect(canonicalModelName('Hermes / custom/Qwen3.8-Flash-Next-UD-Q3_K_XL')).toBe('Qwen3.8-Flash-Next-UD-Q3_K_XL')
  })

  it('routing differences do not make a different model, version differences do', () => {
    const ids = [
      'Claude Code / claude-opus-5-5',
      'Hermes / anthropic/claude-opus-5-5',
      'Hermes / claude-subscription-directsdk-experimental/claude-opus-5-5[1m]',
    ].map(normalizedModelId)
    expect(new Set(ids).size).toBe(1)
    expect(normalizedModelId('Claude Code / claude-opus-4-8')).not.toBe(ids[0])
    expect(canonicalModelName('claude-opus-4-8')).not.toBe(canonicalModelName('claude-opus-5-5'))
  })

  it('two different models never share a display name', () => {
    const items = ['claude-opus-5-5', 'claude-opus-4-8', 'a/Model_X', 'b/model-x'].map(modelIdentity)
    const names = uniqueModelNames(items)
    expect(names.size).toBe(4)
    expect(new Set(names.values()).size).toBe(4)
    // A forced collision: the same name for two ids gets the id appended to both.
    const forced = uniqueModelNames([{ id: 'one', name: 'Same' }, { id: 'two', name: 'Same' }, { id: 'three', name: 'Other' }])
    expect(forced.get('one')).toBe('Same (one)')
    expect(forced.get('two')).toBe('Same (two)')
    expect(forced.get('three')).toBe('Other')
  })
})

describe('describeSession', () => {
  it('never shows a chat id from the raw key', () => {
    const named = describeSession({ key: 'agent:main:telegram:direct:473633590', displayName: 'agent:main:telegram:direct:473633590', agentId: 'main' })
    expect(named).toEqual({ name: 'Telegram direct chat', detail: 'Agent main · Telegram' })
    expect(JSON.stringify(named)).not.toContain('473633590')
  })

  it('prefers a label or a real display name, and names the main session', () => {
    expect(describeSession({ key: 'agent:main:cron:abc', displayName: 'Cron: nightly review' }).name).toBe('Cron: nightly review')
    expect(describeSession({ key: 'agent:main:cron:abc', label: 'Nightly' }).name).toBe('Nightly')
    expect(describeSession({ key: 'agent:ocr-worker:main', displayName: 'agent:ocr-worker:main', agentId: 'ocr-worker' })).toEqual({ name: 'ocr-worker main session', detail: 'Agent ocr-worker' })
  })
})

describe('periodReading', () => {
  it('a part-way day is "so far": not like-for-like, never projected', () => {
    expect(periodReading('day', null, false)).toMatchObject({ inProgress: true, likeForLike: false })
    expect(periodReading('day', null, false).projectionWithheld).toMatch(/not over/)
  })

  it('the first days of a month are not projected; later ones are', () => {
    expect(periodReading('month', { end: '2026-11-03' }, false).projectionWithheld).toBe('Too early to project the month: 3 of 30 days have passed.')
    expect(periodReading('month', { end: '2026-11-07' }, false).projectionWithheld).not.toBeNull()
    expect(periodReading('month', { end: '2026-11-08' }, false).projectionWithheld).toBeNull()
    expect(periodReading('month', { end: '2026-11-11' }, false)).toMatchObject({ likeForLike: true, projectionWithheld: null })
  })

  it('a finished month is a total: compared, never withheld', () => {
    expect(periodReading('month', { end: '2026-10-31' }, true)).toEqual({ inProgress: false, likeForLike: true, projectionWithheld: null })
  })

  it('seven days are compared and projected', () => {
    expect(periodReading('7d', null, false)).toEqual({ inProgress: true, likeForLike: true, projectionWithheld: null })
  })
})

describe('platform coverage sentences', () => {
  const provider = (overrides: Partial<UsageProvider>): UsageProvider => ({
    id: 'p', label: 'P', state: 'ready', observedAt: null, coverage: 'partial', tokens: 1, apiEquivalentUsd: 1,
    billedUsd: null, billingKnown: false, hasRecords: true, coverageReason: 'standing_gaps', skippedLines: null, oversizedLines: null, note: 'actual_cost_usd oversized lines',
    ...overrides,
  })

  it('are built from the reason and counters, not from the provider note', () => {
    const rows = providerRows([
      provider({ skippedLines: 1, oversizedLines: 1 }),
      provider({ skippedLines: 1200, oversizedLines: 200 }),
      provider({ coverageReason: 'unresolved_overlap' }),
      provider({ coverageReason: 'none', coverage: 'complete' }),
      provider({ state: 'unavailable', tokens: null }),
    ])
    expect(rows[0].coverageDetail).toBe('1 log line was too large to read, so this figure may be low.')
    expect(rows[1].coverageDetail).toBe('1,200 log lines could not be read (200 too large), so this figure may be low.')
    expect(rows[2].coverageDetail).toMatch(/another platform/)
    expect(rows[3].coverageDetail).toBeNull()
    expect(rows[4].coverageDetail).toBe('Could not be read, so it is left out of the totals.')
    rows.forEach(row => expect(row.coverageDetail ?? '').not.toMatch(/actual_cost_usd|oversized lines/))
  })
})

describe('chartSummary', () => {
  it('names the span, the total and the busiest day', () => {
    const rows = [
      { day: '1', fullDate: '2026-11-01', total: 10, totalTokens: 1 },
      { day: '2', fullDate: '2026-11-02', total: 30, totalTokens: 1 },
    ] as unknown as ChartDataRow[]
    expect(chartSummary(rows)).toBe('Daily spend, 2 days, $40.00 in total. Busiest day 2026-11-02, $30.00.')
    expect(chartSummary([])).toBe('Daily spend chart, no days')
  })
})

describe('series colour memory', () => {
  const store = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage
  }

  it('round-trips and drops anything that is not a known series token', () => {
    const s = store()
    saveSeriesColorMemory(new Map([['a', 'var(--series-2)']]), s)
    expect(loadSeriesColorMemory(s).get('a')).toBe('var(--series-2)')
    s.setItem(SERIES_COLOR_STORAGE_KEY, JSON.stringify({ a: 'var(--series-9)', b: '#ff0000', c: 'var(--series-4)' }))
    expect([...loadSeriesColorMemory(s)]).toEqual([['c', 'var(--series-4)']])
  })

  it('survives corrupt data, a missing store and a store that throws', () => {
    const s = store()
    s.setItem(SERIES_COLOR_STORAGE_KEY, '{not json')
    expect(loadSeriesColorMemory(s).size).toBe(0)
    expect(loadSeriesColorMemory(null).size).toBe(0)
    const broken = { getItem: () => { throw new Error('x') }, setItem: () => { throw new Error('x') } } as unknown as Storage
    expect(loadSeriesColorMemory(broken).size).toBe(0)
    expect(() => saveSeriesColorMemory(new Map([['a', 'var(--series-1)']]), broken)).not.toThrow()
  })
})
