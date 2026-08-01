import { describe, it, expect } from 'vitest'
import {
  formatCurrency,
  formatPreciseCurrency,
  formatTokens,
  formatCompactTokenValue,
  formatComparisonValue,
  parseMonthlyBudgetInput,
  canonicalModelName,
  formatSessionName,
  hashColor,
  codexbarRowsForPeriod,
  buildCodexbarChartData,
  calendarRefreshQueryKeys,
  millisecondsUntilNextCalendarDay,
  previousCodexbarRows,
  sumCostRows,
  costReliabilityLabel,
  aggregateCostReliabilityLabel,
  summarizeCostReliability,
  trackedSpendPresentation,
  apiEquivalentMetricValues,
  budgetSpendValue,
  awsBillingDataAvailable,
  apiEquivalentPeriodValue,
  awsIntegrationEnabled,
  comparisonLabels,
  codexbarQueryPath,
  costsQueryPath,
  currentMonthKey,
  daysInMonthKey,
  isPastMonthAnchor,
  monthKeyLabel,
  monthNavigationState,
  previousMonthKey,
  shiftMonthKey,
} from './lib'

// ---------------------------------------------------------------------------
// formatCurrency
// ---------------------------------------------------------------------------

describe('formatCurrency', () => {
  it('formats a positive number', () => {
    expect(formatCurrency(1.5)).toBe('$1.50')
  })
  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00')
  })
  it('formats a large number', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })
  it('formats negative values', () => {
    expect(formatCurrency(-5.75)).toBe('-$5.75')
  })
  it('treats Infinity as 0', () => {
    expect(formatCurrency(Infinity)).toBe('$0.00')
  })
  it('treats NaN as 0', () => {
    expect(formatCurrency(NaN)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// formatPreciseCurrency
// ---------------------------------------------------------------------------

describe('formatPreciseCurrency', () => {
  it('uses toFixed(6) for small positive values under 0.01', () => {
    expect(formatPreciseCurrency(0.000123)).toBe('$0.000123')
  })
  it('uses toFixed(6) for small negative values with abs < 0.01', () => {
    expect(formatPreciseCurrency(-0.000123)).toBe('$-0.000123')
  })
  it('delegates to formatCurrency for values >= 0.01', () => {
    expect(formatPreciseCurrency(0.01)).toBe('$0.01')
    expect(formatPreciseCurrency(1.5)).toBe('$1.50')
  })
  it('treats 0 as formatCurrency (not < 0.01 branch)', () => {
    // Math.abs(0) > 0 is false, so falls through to formatCurrency
    expect(formatPreciseCurrency(0)).toBe('$0.00')
  })
  it('treats NaN as 0', () => {
    expect(formatPreciseCurrency(NaN)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe('formatTokens', () => {
  it('formats integer token counts with commas', () => {
    expect(formatTokens(1000000)).toBe('1,000,000')
  })
  it('rounds fractional values', () => {
    expect(formatTokens(1500.7)).toBe('1,501')
  })
  it('formats zero', () => {
    expect(formatTokens(0)).toBe('0')
  })
  it('treats NaN as 0', () => {
    expect(formatTokens(NaN)).toBe('0')
  })
  it('treats Infinity as 0', () => {
    expect(formatTokens(Infinity)).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// formatCompactTokenValue
// ---------------------------------------------------------------------------

describe('formatCompactTokenValue', () => {
  it('formats large numbers compactly', () => {
    // 1000000 -> "1M"
    expect(formatCompactTokenValue(1_000_000)).toBe('1M')
  })
  it('formats thousands', () => {
    expect(formatCompactTokenValue(5_500)).toBe('5.5K')
  })
  it('formats small numbers without suffix', () => {
    expect(formatCompactTokenValue(42)).toBe('42')
  })
  it('treats NaN as 0', () => {
    expect(formatCompactTokenValue(NaN)).toBe('0')
  })
})

// ---------------------------------------------------------------------------
// formatComparisonValue
// ---------------------------------------------------------------------------

describe('formatComparisonValue', () => {
  it('returns "No previous baseline" for null', () => {
    expect(formatComparisonValue(null)).toBe('No previous baseline')
  })
  it('returns "No previous baseline" for undefined', () => {
    expect(formatComparisonValue(undefined)).toBe('No previous baseline')
  })
  it('returns "No previous baseline" for NaN', () => {
    expect(formatComparisonValue(NaN)).toBe('No previous baseline')
  })
  it('formats a valid number as currency', () => {
    expect(formatComparisonValue(2.5)).toBe('$2.50')
  })
  it('formats zero as currency', () => {
    expect(formatComparisonValue(0)).toBe('$0.00')
  })
})

// ---------------------------------------------------------------------------
// costReliabilityLabel
// ---------------------------------------------------------------------------

describe('costReliabilityLabel', () => {
  it('uses neutral copy when billing data is not tracked', () => {
    expect(costReliabilityLabel({ costSource: 'unknown' })).toBe('Not tracked')
    expect(costReliabilityLabel()).toBe('Not tracked')
  })

  it('keeps explicit billing modes distinct', () => {
    expect(costReliabilityLabel({ costSource: 'included' })).toBe('Included')
    expect(costReliabilityLabel({ costSource: 'api' })).toBe('Metered')
    expect(costReliabilityLabel({ costSource: 'fallback' })).toBe('Estimated')
  })
})

describe('aggregateCostReliabilityLabel', () => {
  it('marks included and untracked usage as partially tracked', () => {
    expect(aggregateCostReliabilityLabel([
      { name: 'included', tokens: 100, costSource: 'included' },
      { name: 'unknown', tokens: 10, costSource: 'unknown' },
    ])).toBe('Partial')
  })

  it('keeps uniform active usage labels and ignores empty rows', () => {
    expect(aggregateCostReliabilityLabel([
      { name: 'included', tokens: 100, costSource: 'included' },
      { name: 'empty', tokens: 0, cost: 0, costSource: 'unknown' },
    ])).toBe('Included')
  })

  it('marks fully tracked mixed billing modes as mixed', () => {
    expect(aggregateCostReliabilityLabel([
      { name: 'included', tokens: 100, costSource: 'included' },
      { name: 'metered', tokens: 10, cost: 1, costSource: 'api' },
    ])).toBe('Mixed')
  })

  it('keeps metered and estimated amounts separate in mixed summaries', () => {
    expect(summarizeCostReliability([
      { name: 'metered', tokens: 10, cost: 1.25, costSource: 'api' },
      { name: 'estimated', tokens: 20, cost: 2.5, costSource: 'fallback_estimate' },
      { name: 'unknown', tokens: 5, costSource: 'unknown' },
    ])).toEqual({
      label: 'Partial',
      meteredCost: 1.25,
      estimatedCost: 2.5,
    })
  })
})

describe('trackedSpendPresentation', () => {
  it('does not present partial billing coverage as a complete zero-spend projection', () => {
    expect(trackedSpendPresentation({
      reliability: 'partial_unknown',
      unknownSourceCount: 2,
    })).toEqual({
      isPartial: true,
      valueQualifier: 'Tracked spend from available billing data',
      coverageLabel: '2 billing sources unknown',
      projectionAvailable: false,
    })
  })

  it('keeps projections available when tracked billing coverage is complete', () => {
    expect(trackedSpendPresentation({
      reliability: 'normalized',
      unknownSourceCount: 0,
    })).toEqual({
      isPartial: false,
      valueQualifier: null,
      coverageLabel: null,
      projectionAvailable: true,
    })
  })

  it('does not inherit unrelated ledger uncertainty when the selected billing source is complete', () => {
    expect(trackedSpendPresentation({
      reliability: 'partial_unknown',
      unknownSourceCount: 2,
      selectedSourceIsComplete: true,
    })).toEqual({
      isPartial: false,
      valueQualifier: null,
      coverageLabel: null,
      projectionAvailable: true,
    })
  })
})

describe('apiEquivalentMetricValues', () => {
  it('builds comparable API-equivalent averages and projections from partial estimates', () => {
    expect(apiEquivalentMetricValues({
      periodCost: 100,
      previousPeriodCost: 80,
      dayCount: 5,
      previousDayCount: 4,
      reliability: 'partial',
      previousReliability: 'estimated',
    })).toEqual({
      periodCost: 100,
      previousPeriodCost: 80,
      dailyAverage: 20,
      previousDailyAverage: 20,
      projectedMonthly: 600,
    })
  })

  it('does not manufacture zero API-equivalent metrics when the estimate is unavailable', () => {
    expect(apiEquivalentMetricValues({
      periodCost: null,
      previousPeriodCost: 80,
      dayCount: 5,
      previousDayCount: 5,
      reliability: 'unavailable',
      previousReliability: 'estimated',
    })).toEqual({
      periodCost: null,
      previousPeriodCost: null,
      dailyAverage: null,
      previousDailyAverage: null,
      projectedMonthly: null,
    })
  })

  it('withholds an unreliable previous baseline without hiding the current estimate', () => {
    expect(apiEquivalentMetricValues({
      periodCost: 100,
      previousPeriodCost: 80,
      dayCount: 5,
      previousDayCount: 5,
      reliability: 'estimated',
      previousReliability: 'unavailable',
    })).toEqual({
      periodCost: 100,
      previousPeriodCost: null,
      dailyAverage: 20,
      previousDailyAverage: null,
      projectedMonthly: 600,
    })
  })
})

describe('apiEquivalentPeriodValue', () => {
  it('preserves a missing partial estimate as unavailable instead of manufacturing zero', () => {
    expect(apiEquivalentPeriodValue({
      reliability: 'partial',
      periodValue: null,
      fallbackValue: null,
    })).toBeNull()
    expect(apiEquivalentPeriodValue({
      reliability: 'partial',
      periodValue: 0,
      fallbackValue: null,
    })).toBe(0)
    expect(apiEquivalentPeriodValue({
      reliability: 'estimated',
      periodValue: null,
      fallbackValue: 5,
    })).toBe(5)
    expect(apiEquivalentPeriodValue({
      reliability: 'unavailable',
      periodValue: 5,
      fallbackValue: null,
    })).toBeNull()
  })
})

describe('budgetSpendValue', () => {
  it('prefers AWS actual billing even when a ledger is also active', () => {
    expect(budgetSpendValue({
      hasAwsData: true,
      awsTotal: 50,
      ledgerActive: true,
      ledgerMonthSpend: 0,
      trackedSpendComplete: false,
    })).toBe(50)
  })

  it('withholds budget math when non-AWS tracked coverage is incomplete', () => {
    expect(budgetSpendValue({
      hasAwsData: false,
      awsTotal: null,
      ledgerActive: true,
      ledgerMonthSpend: 0,
      trackedSpendComplete: false,
    })).toBeNull()
  })
})

describe('awsBillingDataAvailable', () => {
  it('treats an enabled zero-dollar AWS response as authoritative billing data', () => {
    expect(awsBillingDataAvailable(true, { total: 0 })).toBe(true)
    expect(awsBillingDataAvailable(false, { total: 0 })).toBe(false)
    expect(awsBillingDataAvailable(true, null)).toBe(false)
  })
})

describe('awsIntegrationEnabled', () => {
  it('requires both the AWS module and integration flags', () => {
    expect(awsIntegrationEnabled({ modules: { aws: true }, aws: { enabled: true } })).toBe(true)
    expect(awsIntegrationEnabled({ modules: { aws: true }, aws: { enabled: false } })).toBe(false)
    expect(awsIntegrationEnabled({ modules: { aws: false }, aws: { enabled: true } })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseMonthlyBudgetInput
// ---------------------------------------------------------------------------

describe('parseMonthlyBudgetInput', () => {
  it('parses positive and zero values', () => {
    expect(parseMonthlyBudgetInput('42.25')).toEqual({ monthly: 42.25, error: null })
    expect(parseMonthlyBudgetInput('0')).toEqual({ monthly: 0, error: null })
  })

  it('treats blank input as not ready to save', () => {
    expect(parseMonthlyBudgetInput('   ')).toEqual({ monthly: null, error: null })
  })

  it('rejects negative and invalid values', () => {
    expect(parseMonthlyBudgetInput('-10')).toEqual({ monthly: null, error: 'Budget must be zero or positive.' })
    expect(parseMonthlyBudgetInput('nope')).toEqual({ monthly: null, error: 'Budget must be zero or positive.' })
  })
})

// ---------------------------------------------------------------------------
// canonicalModelName
// ---------------------------------------------------------------------------

describe('canonicalModelName', () => {
  it('maps gpt-5.4-mini variant', () => {
    expect(canonicalModelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
  })
  it('maps gpt-5.4-nano variant', () => {
    expect(canonicalModelName('openai/gpt-5.4-nano')).toBe('GPT-5.4 Nano')
  })
  it('maps gpt-5.4 (base)', () => {
    // must not match mini/nano first — they are checked first in the implementation
    expect(canonicalModelName('gpt-5.4')).toBe('GPT-5.4')
  })
  it('maps gpt-5.3-codex-spark', () => {
    expect(canonicalModelName('openai/gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
  })
  it('maps gpt-5.3', () => {
    expect(canonicalModelName('gpt-5.3')).toBe('GPT-5.3')
  })
  it('maps claude-sonnet-4-6', () => {
    expect(canonicalModelName('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
  })
  it('maps generic claude-sonnet', () => {
    expect(canonicalModelName('anthropic/claude-sonnet')).toBe('Claude Sonnet')
  })
  it('maps claude-opus', () => {
    expect(canonicalModelName('claude-opus')).toBe('Claude Opus')
  })
  it('maps claude-haiku', () => {
    expect(canonicalModelName('claude-haiku')).toBe('Claude Haiku')
  })
  it('strips ollama/ prefix and title-cases the model name', () => {
    expect(canonicalModelName('ollama/llama-3.2')).toBe('Llama 3.2')
  })
  it('strips ollama/ prefix and removes tag (colon part)', () => {
    expect(canonicalModelName('ollama/mistral:latest')).toBe('Mistral')
  })
  it('strips openrouter/ prefix', () => {
    // openrouter/meta-llama/llama-3-70b-instruct:nitro -> "Llama 3 70b Instruct"
    expect(canonicalModelName('openrouter/meta-llama/llama-3-70b-instruct')).toBe('Llama 3 70b Instruct')
  })
  it('returns the raw model string for unknown models', () => {
    expect(canonicalModelName('some-unknown-model')).toBe('some-unknown-model')
  })
  it('returns "Unknown" for empty string', () => {
    expect(canonicalModelName('')).toBe('Unknown')
  })
})

// ---------------------------------------------------------------------------
// formatSessionName
// ---------------------------------------------------------------------------

describe('formatSessionName', () => {
  it('extracts channel name from key containing #', () => {
    expect(formatSessionName('slack#general')).toBe('#general')
  })
  it('returns "Main Session" for agent:main:main', () => {
    expect(formatSessionName('agent:main:main')).toBe('Main Session')
  })
  it('returns "Sub-Agent" for keys containing :subagent:', () => {
    expect(formatSessionName('agent:foo:subagent:bar')).toBe('Sub-Agent')
  })
  it('uses displayName if provided and no special pattern matches', () => {
    expect(formatSessionName('random:key', 'My Session')).toBe('My Session')
  })
  it('falls back to last segment (truncated to 12 chars)', () => {
    // substring(0, 12) keeps 12 characters (indices 0–11)
    expect(formatSessionName('a:b:verylongsessionname')).toBe('verylongsess')
  })
})

// ---------------------------------------------------------------------------
// hashColor
// ---------------------------------------------------------------------------

describe('hashColor', () => {
  it('returns a string starting with # for any input', () => {
    const color = hashColor('test-model')
    expect(color).toMatch(/^#|^rgba/)
  })
  it('is deterministic — same input returns same color', () => {
    expect(hashColor('some-model')).toBe(hashColor('some-model'))
  })
  it('returns a value from the palette for an empty string', () => {
    const color = hashColor('')
    expect(typeof color).toBe('string')
    expect(color.length).toBeGreaterThan(0)
  })
})

describe('CodexBar calendar periods', () => {
  const rows = [
    { date: '2026-06-11', totalCost: 1, totalTokens: 10, inputTokens: 0, outputTokens: 0, models: [] },
    { date: '2026-07-01', totalCost: 2, totalTokens: 20, inputTokens: 0, outputTokens: 0, models: [] },
    { date: '2026-07-13', totalCost: 3, totalTokens: 30, inputTokens: 0, outputTokens: 0, models: [] },
  ]
  const now = new Date('2026-07-13T12:00:00+03:00')

  it('does not treat old sparse activity rows as current day or current week', () => {
    expect(codexbarRowsForPeriod(rows, 'day', now).map(row => row.date)).toEqual(['2026-07-13'])
    const week = codexbarRowsForPeriod(rows, '7d', now)
    expect(week).toHaveLength(7)
    expect(week[0].date).toBe('2026-07-07')
    expect(week.at(-1)?.date).toBe('2026-07-13')
    expect(sumCostRows(week) / week.length).toBeCloseTo(3 / 7)
    const month = codexbarRowsForPeriod(rows, 'month', now)
    expect(month).toHaveLength(13)
    expect(month[0].date).toBe('2026-07-01')
    expect(month.at(-1)?.date).toBe('2026-07-13')
    expect(sumCostRows(month)).toBe(5)
  })

  it('selects previous baselines by date rather than array position', () => {
    const day = previousCodexbarRows(rows, 'day', now)
    expect(day).toHaveLength(1)
    expect(day[0]).toMatchObject({ date: '2026-07-12', totalCost: 0 })
    const week = previousCodexbarRows(rows, '7d', now)
    expect(week).toHaveLength(7)
    expect(sumCostRows(week)).toBe(2)
    const month = previousCodexbarRows(rows, 'month', now)
    expect(month).toHaveLength(13)
    expect(month[0].date).toBe('2026-06-01')
    expect(month.at(-1)?.date).toBe('2026-06-13')
    expect(sumCostRows(month)).toBe(1)
  })

  it('uses the actual shorter previous-month span for daily averages', () => {
    expect(previousCodexbarRows([], 'month', new Date('2026-03-31T12:00:00+03:00'))).toHaveLength(28)
  })

  it('keeps a zero-spend CodexBar period renderable without model series', () => {
    const zeroDay = codexbarRowsForPeriod(rows, 'day', new Date('2026-07-12T12:00:00+03:00'))

    expect(buildCodexbarChartData(zeroDay, [])).toEqual([{
      day: '12',
      fullDate: '2026-07-12',
      total: 0,
      totalTokens: 0,
    }])
  })

  it('schedules a period-bound refresh at the next local midnight', () => {
    const now = new Date(2026, 6, 13, 23, 59, 59, 500)
    expect(millisecondsUntilNextCalendarDay(now)).toBe(500)
  })

  it('refreshes CodexBar and the active usage period at a calendar boundary', () => {
    expect(calendarRefreshQueryKeys('7d')).toEqual([
      ['api', '/api/costs/codexbar'],
      ['api', '/api/costs?period=7d'],
    ])
  })
})

// ---------------------------------------------------------------------------
// Historical month anchor
// ---------------------------------------------------------------------------

describe('month anchor helpers', () => {
  const now = new Date(2026, 7, 1, 14, 30) // 2026-08-01, local

  it('formats and walks month keys across a year boundary', () => {
    expect(currentMonthKey(now)).toBe('2026-08')
    expect(monthKeyLabel('2026-07')).toBe('July 2026')
    expect(previousMonthKey('2026-01')).toBe('2025-12')
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01')
    expect(shiftMonthKey('2026-08', -24)).toBe('2024-08')
  })

  it('knows the real length of each anchored month', () => {
    expect(daysInMonthKey('2026-07')).toBe(31)
    expect(daysInMonthKey('2026-06')).toBe(30)
    expect(daysInMonthKey('2026-02')).toBe(28)
    expect(daysInMonthKey('2024-02')).toBe(29)
  })

  it('treats only finished months as past anchors', () => {
    expect(isPastMonthAnchor('2026-07', now)).toBe(true)
    expect(isPastMonthAnchor('2026-08', now)).toBe(false)
    expect(isPastMonthAnchor('2026-09', now)).toBe(false)
    expect(isPastMonthAnchor(null, now)).toBe(false)
    expect(isPastMonthAnchor('nonsense', now)).toBe(false)
    expect(isPastMonthAnchor('2026-13', now)).toBe(false)
  })

  it('sends the anchor only on the Monthly period', () => {
    expect(costsQueryPath('month', null)).toBe('/api/costs?period=month')
    expect(costsQueryPath('month', '2026-07')).toBe('/api/costs?period=month&month=2026-07')
    expect(costsQueryPath('7d', '2026-07')).toBe('/api/costs?period=7d')
    expect(costsQueryPath('day', '2026-07')).toBe('/api/costs?period=day')
  })

  it('widens the codexbar request only for an anchored past month', () => {
    const now = new Date(2026, 7, 1)
    expect(codexbarQueryPath('2026-07', now)).toBe('/api/costs/codexbar?month=2026-07')
    expect(codexbarQueryPath('2026-08', now)).toBe('/api/costs/codexbar')
    expect(codexbarQueryPath(null, now)).toBe('/api/costs/codexbar')
  })

  it('skips calendar-day invalidation for an immutable past month', () => {
    expect(calendarRefreshQueryKeys('month', '2026-07')).toEqual([])
    expect(calendarRefreshQueryKeys('month', null)).toEqual([
      ['api', '/api/costs/codexbar'],
      ['api', '/api/costs?period=month'],
    ])
    expect(calendarRefreshQueryKeys('7d', '2026-07')).toEqual([
      ['api', '/api/costs/codexbar'],
      ['api', '/api/costs?period=7d'],
    ])
  })

  it('stops the navigator at the current month and at the history floor', () => {
    const live = monthNavigationState(null, now, 24)
    expect(live).toMatchObject({
      activeMonth: '2026-08',
      currentMonth: '2026-08',
      label: 'August 2026',
      isCurrentMonth: true,
      canGoForward: false,
      canGoBack: true,
      previousMonth: '2026-07',
    })

    const anchored = monthNavigationState('2026-07', now, 24)
    expect(anchored).toMatchObject({
      activeMonth: '2026-07',
      label: 'July 2026',
      isCurrentMonth: false,
      canGoForward: true,
      canGoBack: true,
      nextMonth: '2026-08',
      previousMonth: '2026-06',
    })

    const floor = monthNavigationState('2024-08', now, 24)
    expect(floor.canGoBack).toBe(false)
    expect(floor.canGoForward).toBe(true)
    expect(monthNavigationState('2024-09', now, 24).canGoBack).toBe(true)
  })
})

describe('anchored CodexBar month rows', () => {
  const rows = [
    { date: '2026-06-11', totalCost: 1, totalTokens: 10, inputTokens: 0, outputTokens: 0, models: [] },
    { date: '2026-07-01', totalCost: 2, totalTokens: 20, inputTokens: 0, outputTokens: 0, models: [] },
    { date: '2026-07-31', totalCost: 4, totalTokens: 40, inputTokens: 0, outputTokens: 0, models: [] },
    { date: '2026-08-05', totalCost: 8, totalTokens: 80, inputTokens: 0, outputTokens: 0, models: [] },
  ]
  const now = new Date('2026-08-14T12:00:00+03:00')

  it('spans the whole anchored month regardless of today', () => {
    const july = codexbarRowsForPeriod(rows, 'month', now, '2026-07')
    expect(july).toHaveLength(31)
    expect(july[0].date).toBe('2026-07-01')
    expect(july.at(-1)?.date).toBe('2026-07-31')
    expect(sumCostRows(july)).toBe(6)
  })

  it('uses the full previous calendar month as the anchored baseline', () => {
    const june = previousCodexbarRows(rows, 'month', now, '2026-07')
    expect(june).toHaveLength(30)
    expect(june[0].date).toBe('2026-06-01')
    expect(june.at(-1)?.date).toBe('2026-06-30')
    expect(sumCostRows(june)).toBe(1)
  })

  it('leaves the live month and the other periods untouched', () => {
    expect(codexbarRowsForPeriod(rows, 'month', now, '2026-08'))
      .toEqual(codexbarRowsForPeriod(rows, 'month', now))
    expect(codexbarRowsForPeriod(rows, '7d', now, '2026-07'))
      .toEqual(codexbarRowsForPeriod(rows, '7d', now))
    expect(previousCodexbarRows(rows, 'day', now, '2026-07'))
      .toEqual(previousCodexbarRows(rows, 'day', now))
  })

  it('names the previous month in anchored comparison labels', () => {
    expect(comparisonLabels('month', '2026-07', now)).toEqual({
      period: 'vs June 2026',
      daily: 'vs June 2026 avg',
    })
    expect(comparisonLabels('month', '2026-01', now)).toEqual({
      period: 'vs December 2025',
      daily: 'vs December 2025 avg',
    })
    expect(comparisonLabels('month', null, now)).toEqual({
      period: 'vs previous month',
      daily: 'vs previous month avg',
    })
    expect(comparisonLabels('month', '2026-08', now)).toEqual({
      period: 'vs previous month',
      daily: 'vs previous month avg',
    })
    expect(comparisonLabels('7d', '2026-07', now)).toEqual({
      period: 'vs previous 7 days',
      daily: 'vs previous 7d avg',
    })
  })

  it('reports a finished month as a total instead of a projection', () => {
    const complete = apiEquivalentMetricValues({
      periodCost: 310,
      previousPeriodCost: 300,
      dayCount: 31,
      previousDayCount: 30,
      reliability: 'estimated',
      previousReliability: 'estimated',
      completePeriod: true,
    })
    expect(complete.projectedMonthly).toBe(310)
    expect(complete.dailyAverage).toBeCloseTo(10)

    const live = apiEquivalentMetricValues({
      periodCost: 310,
      previousPeriodCost: 300,
      dayCount: 31,
      previousDayCount: 30,
      reliability: 'estimated',
      previousReliability: 'estimated',
    })
    expect(live.projectedMonthly).toBeCloseTo(300)
  })
})

describe('server-authoritative month classification', () => {
  // Browser is already in September while the server clock is still in August.
  const browserNow = new Date(2026, 8, 1, 0, 30)

  it('does not call the server current month a completed past month', () => {
    expect(isPastMonthAnchor('2026-08', browserNow)).toBe(true)
    expect(isPastMonthAnchor('2026-08', browserNow, '2026-08')).toBe(false)
  })

  it('still classifies genuinely older months as past', () => {
    expect(isPastMonthAnchor('2026-07', browserNow, '2026-08')).toBe(true)
  })

  it('treats the server month as current in the reverse skew', () => {
    // Browser still in August while the server has rolled into September.
    const laggingBrowser = new Date(2026, 7, 31, 23, 30)
    expect(isPastMonthAnchor('2026-08', laggingBrowser, '2026-09')).toBe(true)
    expect(isPastMonthAnchor('2026-09', laggingBrowser, '2026-09')).toBe(false)
  })

  it('stops the navigator at the server month, not the browser month', () => {
    const nav = monthNavigationState('2026-08', browserNow, 24, '2026-08')
    expect(nav.currentMonth).toBe('2026-08')
    expect(nav.canGoForward).toBe(false)
  })

  it('falls back to the browser clock before any payload arrives', () => {
    expect(currentMonthKey(browserNow, null)).toBe('2026-09')
    expect(currentMonthKey(browserNow, undefined)).toBe('2026-09')
    expect(currentMonthKey(browserNow, 'garbage')).toBe('2026-09')
  })
})
