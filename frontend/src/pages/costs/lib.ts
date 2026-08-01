// Pure helper functions and constants for the Costs page.
// No hooks, no JSX — safe to import from any context.

import type { TokenServiceData, CodexBarDailyEntry, TokenData, ChartDataRow, ChartSeriesItem } from './types'

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const integerFormatter = new Intl.NumberFormat('en-US')
const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

export function formatCurrency(value: number) {
  return currencyFormatter.format(Number.isFinite(value) ? value : 0)
}

export function formatPreciseCurrency(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0
  if (Math.abs(safeValue) > 0 && Math.abs(safeValue) < 0.01) return `$${safeValue.toFixed(6)}`
  return formatCurrency(safeValue)
}

export function formatTokens(value: number) {
  return integerFormatter.format(Math.round(Number.isFinite(value) ? value : 0))
}

export function formatCompactTokenValue(value: number) {
  const safeValue = Math.round(Number.isFinite(value) ? value : 0)
  return compactNumberFormatter.format(safeValue)
}

export function formatComparisonValue(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'No previous baseline'
    : formatCurrency(value)
}

export function parseMonthlyBudgetInput(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return { monthly: null, error: null }

  const monthly = Number(trimmed)
  if (!Number.isFinite(monthly) || monthly < 0) {
    return { monthly: null, error: 'Budget must be zero or positive.' }
  }

  return { monthly, error: null }
}

export function formatSessionName(key: string, displayName?: string): string {
  if (key.includes('#')) {
    const channelName = key.split('#')[1]
    return `#${channelName}`
  }
  if (key === 'agent:main:main') return 'Main Session'
  if (key.includes(':subagent:')) return 'Sub-Agent'
  if (displayName) return displayName
  return key.split(':').pop()?.substring(0, 12) || 'Unknown'
}

export function formatSessionTimestamp(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const DYNAMIC_COLORS = [
  '#4DA3FF', // blue
  '#FF9F43', // orange
  '#42D392', // green
  '#FF5D5D', // red
  '#B388FF', // purple
  '#2DD4BF', // teal
  '#FF78B5', // pink
  '#FACC15', // yellow
  '#818CF8', // indigo
  '#A3E635', // lime
  '#22D3EE', // cyan
  '#FB7185', // coral
]

export function modelColorKey(model: string): string {
  return model.trim().toLowerCase()
}

function overflowModelColor(index: number): string {
  const hue = Math.round((index * 137.508 + 24) % 360)
  const lightness = index % 2 === 0 ? 66 : 74
  return `hsl(${hue} 78% ${lightness}%)`
}

export function assignModelColors(
  activeModels: string[],
  previousAssignments: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const activeKeys = Array.from(new Set(activeModels.map(modelColorKey).filter(Boolean)))
  const assignments = new Map<string, string>()
  const reservedColors = new Set<string>()

  activeKeys.forEach(key => {
    const previousColor = previousAssignments.get(key)
    if (previousColor && !reservedColors.has(previousColor)) {
      assignments.set(key, previousColor)
      reservedColors.add(previousColor)
    }
  })

  activeKeys.forEach(key => {
    if (assignments.has(key)) return
    const availableColor = DYNAMIC_COLORS.find(color => !reservedColors.has(color))
    let overflowIndex = 0
    let generatedColor = overflowModelColor(overflowIndex)
    while (reservedColors.has(generatedColor)) {
      overflowIndex += 1
      generatedColor = overflowModelColor(overflowIndex)
    }
    const color = availableColor || generatedColor
    assignments.set(key, color)
    reservedColors.add(color)
  })

  return assignments
}

export function assignedModelColor(assignments: ReadonlyMap<string, string>, model: string): string {
  const key = modelColorKey(model)
  return assignments.get(key) || hashColor(key)
}

export function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return DYNAMIC_COLORS[Math.abs(hash) % DYNAMIC_COLORS.length]
}

export function getServiceColor(name: string) {
  const lowerName = name.toLowerCase()
  if (lowerName.includes('compute') || lowerName.includes('ec2') || lowerName.includes('lambda')) return '#007AFF'
  if (lowerName.includes('claude') || lowerName.includes('ai') || lowerName.includes('bedrock')) return '#BF5AF2'
  if (lowerName.includes('s3') || lowerName.includes('storage')) return '#32D74B'
  return '#8E8E93'
}

// ---------------------------------------------------------------------------
// Model name utilities
// ---------------------------------------------------------------------------

export function canonicalModelName(model: string) {
  const lower = model.toLowerCase()

  if (lower.includes('gpt-5.4-mini')) return 'GPT-5.4 Mini'
  if (lower.includes('gpt-5.4-nano')) return 'GPT-5.4 Nano'
  if (lower.includes('gpt-5.4')) return 'GPT-5.4'
  if (lower.includes('gpt-5.3-codex-spark')) return 'GPT-5.3 Codex Spark'
  if (lower.includes('gpt-5.3')) return 'GPT-5.3'
  if (lower.includes('claude-sonnet-4-6') || lower.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
  if (lower.includes('claude-sonnet') || lower.includes('sonnet')) return 'Claude Sonnet'
  if (lower.includes('claude-opus') || lower.includes('opus')) return 'Claude Opus'
  if (lower.includes('claude-haiku') || lower.includes('haiku')) return 'Claude Haiku'
  if (lower.includes('ollama/')) {
    return model
      .split('/')
      .pop()
      ?.split(':')[0]
      ?.replace(/[-_]/g, ' ')
      .replace(/\b\w/g, x => x.toUpperCase()) || 'Ollama Local'
  }
  if (lower.includes('openrouter/')) {
    return model
      .split('/')
      .slice(-1)[0]
      ?.split(':')[0]
      ?.replace(/[-_]/g, ' ')
      .replace(/\b\w/g, x => x.toUpperCase()) || 'OpenRouter'
  }

  return model || 'Unknown'
}

export function isLocalModel(model: string) {
  const lower = model.toLowerCase()
  return lower.includes('ollama/') || lower.includes('lmstudio') || lower.includes('localhost') || lower.includes('local/')
}

export function toChartKey(index: number) {
  return `model_${index}`
}

// ---------------------------------------------------------------------------
// Pricing / cost estimation
// ---------------------------------------------------------------------------

// Pricing per 1M output tokens
// Source: OpenRouter public API (https://openrouter.ai/api/v1/models, 2026-04)
// These are the actual OpenRouter provider prices, not retail.
const MODEL_PRICING: Record<string, number> = {
  // OpenAI Codex (direct, not OpenRouter)
  'gpt-5.4': 15,
  'gpt-5.4-mini': 4.5,
  'gpt-5.3-codex-spark': 14,
  'gpt-5.3': 14,
  // Anthropic (OpenRouter)
  'claude-opus-4-6': 25,
  'claude-opus': 25,
  'claude-sonnet-4-6': 15,
  'claude-sonnet': 15,
  'claude-haiku': 5,
  // NVIDIA OpenRouter
  'nemotron-super-49b-v1.5': 0.4,
  'nemotron-3-super-120b-a12b': 0.5,
  'nemotron-free': 0,
  // MiniMax OpenRouter (provider=minimax)
  'minimax-m2.7': 1.2,
  'minimax-m2.5': 1.25,
  'minimax-m2.1': 0.95,
  'minimax-m2': 1.0,
  'minimax-m2-her': 1.2,
  // Xiaomi OpenRouter
  'mimo-v2-omni': 2.0,
  'mimo-v2-pro': 3.0,
  'mimo-v2-flash': 0.29,
  // OpenRouter Mancer
  'weaver': 10,
  // Qwen free
  'qwen3-free': 0,
  'qwen3.6-free': 0,
  // __default for unknown cloud models
  '__default': 5,
}

export function estimateCost(tokens: number, model?: string): number {
  if (model && isLocalModel(model)) return 0
  if (!model) return 0

  const modelLower = model.toLowerCase()

  // Local Ollama detection
  if (modelLower.includes('ollama/') || modelLower.includes('localhost')) return 0

  // MiniMax via OpenRouter
  if (modelLower.includes('minimax-m2.7')) return (tokens / 1_000_000) * MODEL_PRICING['minimax-m2.7']
  if (modelLower.includes('minimax-m2.5')) return (tokens / 1_000_000) * MODEL_PRICING['minimax-m2.5']
  if (modelLower.includes('minimax-m2.1')) return (tokens / 1_000_000) * MODEL_PRICING['minimax-m2.1']
  if (modelLower.includes('minimax-m2-her')) return (tokens / 1_000_000) * MODEL_PRICING['minimax-m2-her']
  if (modelLower.includes('minimax-m2')) return (tokens / 1_000_000) * MODEL_PRICING['minimax-m2']

  // NVIDIA OpenRouter
  if (modelLower.includes('nemotron-super-49b') || modelLower.includes('llama-3.3-nemotron')) return (tokens / 1_000_000) * MODEL_PRICING['nemotron-super-49b-v1.5']
  if (modelLower.includes('nemotron')) return (tokens / 1_000_000) * MODEL_PRICING['nemotron-3-super-120b-a12b']

  // OpenAI Codex (direct)
  if (modelLower.includes('gpt-5.4-mini') || modelLower.includes('gpt-5.4-nano')) return (tokens / 1_000_000) * MODEL_PRICING['gpt-5.4-mini']
  if (modelLower.includes('gpt-5.4')) return (tokens / 1_000_000) * MODEL_PRICING['gpt-5.4']
  if (modelLower.includes('gpt-5.3-codex') || modelLower.includes('gpt-5.3')) return (tokens / 1_000_000) * MODEL_PRICING['gpt-5.3-codex-spark']

  // Anthropic
  if (modelLower.includes('opus-4.6') || (modelLower.includes('opus') && modelLower.includes('4'))) return (tokens / 1_000_000) * MODEL_PRICING['claude-opus-4-6']
  if (modelLower.includes('sonnet-4.6') || (modelLower.includes('sonnet') && modelLower.includes('4'))) return (tokens / 1_000_000) * MODEL_PRICING['claude-sonnet-4-6']
  if (modelLower.includes('haiku')) return (tokens / 1_000_000) * MODEL_PRICING['claude-haiku']

  // Xiaomi OpenRouter
  if (modelLower.includes('mimo-v2-omni')) return (tokens / 1_000_000) * MODEL_PRICING['mimo-v2-omni']
  if (modelLower.includes('mimo-v2-pro')) return (tokens / 1_000_000) * MODEL_PRICING['mimo-v2-pro']
  if (modelLower.includes('mimo')) return (tokens / 1_000_000) * MODEL_PRICING['mimo-v2-flash']

  // OpenRouter Mancer
  if (modelLower.includes('weaver') || modelLower.includes('mancer')) return (tokens / 1_000_000) * MODEL_PRICING['weaver']

  // OpenRouter/other cloud models → fallback
  if (modelLower.includes('openrouter')) return (tokens / 1_000_000) * MODEL_PRICING['__default']

  return 0
}

// ---------------------------------------------------------------------------
// Trend / comparison helpers
// ---------------------------------------------------------------------------

export function calculateTrend(current: number, previous: number | null | undefined) {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null
  if (!previous && !current) return null
  if (!previous || Math.abs(previous) < 0.01) {
    return current > 0
      ? { direction: 'up' as const, percentage: null, label: 'New baseline' }
      : null
  }
  const percentage = ((current - previous) / previous) * 100
  const absPercentage = Math.abs(percentage)
  const label = absPercentage > 999 ? `${(current / previous).toFixed(1)}×` : undefined
  return {
    direction: percentage >= 0 ? ('up' as const) : ('down' as const),
    percentage: absPercentage,
    label,
  }
}

export function costReliabilityLabel(item?: Pick<TokenServiceData, 'costSource' | 'costStatus' | 'billingModes'>) {
  const source = String(item?.costSource || '').toLowerCase()
  const status = String(item?.costStatus || '').toLowerCase()
  const modes = String(item?.billingModes || '').toLowerCase()
  if (source.includes('included') || status.includes('included') || modes.includes('included')) return 'Included'
  if (source.includes('unknown') || status.includes('unknown')) return 'Not tracked'
  if (source.includes('fallback')) return 'Estimated'
  if (source.includes('api')) return 'Metered'
  return 'Not tracked'
}

export interface TrackedSpendPresentation {
  isPartial: boolean
  valueQualifier: string | null
  coverageLabel: string | null
  projectionAvailable: boolean
}

export function trackedSpendPresentation({
  reliability,
  unknownSourceCount,
  selectedSourceIsComplete = false,
}: {
  reliability: string | undefined
  unknownSourceCount: number
  selectedSourceIsComplete?: boolean
}): TrackedSpendPresentation {
  const isPartial = !selectedSourceIsComplete && reliability === 'partial_unknown'
  const count = Math.max(0, Math.floor(Number(unknownSourceCount) || 0))

  return {
    isPartial,
    valueQualifier: isPartial ? 'Tracked spend from available billing data' : null,
    coverageLabel: isPartial
      ? count > 0
        ? count === 1
          ? '1 billing source unknown'
          : `${count} billing sources unknown`
        : 'Billing coverage partial'
      : null,
    projectionAvailable: !isPartial,
  }
}

export interface ApiEquivalentMetricValues {
  periodCost: number | null
  previousPeriodCost: number | null
  dailyAverage: number | null
  previousDailyAverage: number | null
  projectedMonthly: number | null
}

export function apiEquivalentPeriodValue({
  reliability,
  periodValue,
  fallbackValue,
}: {
  reliability: string
  periodValue: number | null | undefined
  fallbackValue: number | null | undefined
}) {
  if (reliability !== 'estimated' && reliability !== 'partial') return null
  const value = periodValue ?? fallbackValue
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? Number(value)
    : null
}

export function apiEquivalentMetricValues({
  periodCost,
  previousPeriodCost,
  dayCount,
  previousDayCount,
  reliability,
  previousReliability,
  completePeriod = false,
}: {
  periodCost: number | null
  previousPeriodCost: number | null
  dayCount: number
  previousDayCount: number
  reliability: string
  previousReliability: string
  /** A finished calendar month: the "projection" is simply the actual month total. */
  completePeriod?: boolean
}): ApiEquivalentMetricValues {
  const available = reliability === 'estimated' || reliability === 'partial'
  const current = periodCost !== null && Number.isFinite(periodCost) ? Number(periodCost) : null
  if (!available || current === null) {
    return {
      periodCost: null,
      previousPeriodCost: null,
      dailyAverage: null,
      previousDailyAverage: null,
      projectedMonthly: null,
    }
  }

  const days = Math.max(1, Math.floor(Number(dayCount) || 0))
  const previousAvailable = previousReliability === 'estimated' || previousReliability === 'partial'
  const previous = previousAvailable && previousPeriodCost !== null && Number.isFinite(previousPeriodCost)
    ? Number(previousPeriodCost)
    : null
  const dailyAverage = current / days
  const previousDays = Math.max(1, Math.floor(Number(previousDayCount) || 0))

  return {
    periodCost: current,
    previousPeriodCost: previous,
    dailyAverage,
    previousDailyAverage: previous === null ? null : previous / previousDays,
    projectedMonthly: completePeriod ? current : dailyAverage * 30,
  }
}

export function budgetSpendValue({
  hasAwsData,
  awsTotal,
  ledgerActive,
  ledgerMonthSpend,
  trackedSpendComplete,
}: {
  hasAwsData: boolean
  awsTotal: number | null
  ledgerActive: boolean
  ledgerMonthSpend: number | null
  trackedSpendComplete: boolean
}) {
  if (hasAwsData) {
    return awsTotal !== null && Number.isFinite(awsTotal) ? Number(awsTotal) : null
  }
  if (!ledgerActive || !trackedSpendComplete) return null
  return ledgerMonthSpend !== null && Number.isFinite(ledgerMonthSpend) ? Number(ledgerMonthSpend) : null
}

export function awsBillingDataAvailable(
  isAwsEnabled: boolean,
  awsCosts: { total: number } | null | undefined,
) {
  return isAwsEnabled && awsCosts !== null && awsCosts !== undefined && Number.isFinite(awsCosts.total)
}

export function awsIntegrationEnabled(config: {
  modules?: { aws?: boolean }
  aws?: { enabled?: boolean }
} | null | undefined) {
  return config?.modules?.aws === true && config?.aws?.enabled === true
}

export function summarizeCostReliability(items: TokenServiceData[] = []) {
  const activeItems = items.filter(item => Number(item.tokens || 0) > 0 || Number(item.cost || 0) > 0)
  const labeledItems = activeItems.map(item => ({ item, label: costReliabilityLabel(item) }))
  const labels = new Set(labeledItems.map(entry => entry.label))
  const label = labels.size === 0
    ? 'Not tracked'
    : labels.size === 1
      ? labels.values().next().value || 'Not tracked'
      : labels.has('Not tracked')
        ? 'Partial'
        : 'Mixed'

  return {
    label,
    meteredCost: labeledItems.reduce((sum, entry) => (
      entry.label === 'Metered' ? sum + Number(entry.item.cost || 0) : sum
    ), 0),
    estimatedCost: labeledItems.reduce((sum, entry) => (
      entry.label === 'Estimated' ? sum + Number(entry.item.cost || 0) : sum
    ), 0),
  }
}

export function aggregateCostReliabilityLabel(items: TokenServiceData[] = []) {
  return summarizeCostReliability(items).label
}

export function formatApiEquivalentValue(cost: number | null | undefined, available = true) {
  if (!available || cost === null || cost === undefined || !Number.isFinite(cost)) return 'N/A'
  return formatPreciseCurrency(cost)
}

// ---------------------------------------------------------------------------
// CodexBar period helpers
// ---------------------------------------------------------------------------

export function sumCostRows(rows: Array<{ totalCost?: number; cost?: number }> = []) {
  return rows.reduce((sum, row) => sum + Number(row.totalCost ?? row.cost ?? 0), 0)
}

export function millisecondsUntilNextCalendarDay(now = new Date()) {
  const nextDay = new Date(now)
  nextDay.setHours(24, 0, 0, 0)
  return Math.max(nextDay.getTime() - now.getTime(), 1)
}

export function costsQueryPath(period: 'day' | '7d' | 'month', monthAnchor: string | null = null) {
  return period === 'month' && monthAnchor
    ? `/api/costs?period=${period}&month=${monthAnchor}`
    : `/api/costs?period=${period}`
}

// The codexbar scan defaults to ~70 days; an anchored past month asks the
// endpoint to widen the window so codexbar-derived cells aren't zero-filled.
export function codexbarQueryPath(monthAnchor: string | null = null, now = new Date()) {
  return isPastMonthAnchor(monthAnchor, now)
    ? `/api/costs/codexbar?month=${monthAnchor}`
    : '/api/costs/codexbar'
}

export function calendarRefreshQueryKeys(
  period: 'day' | '7d' | 'month',
  monthAnchor: string | null = null,
  now = new Date(),
): ReadonlyArray<readonly string[]> {
  // A past month's TOTALS are immutable, but its payload also carries the
  // calendar metadata (serverMonth) that the navigator treats as authoritative.
  // Crossing a calendar day must refresh that metadata too — the server answers
  // an anchored refetch from cache, so this is cheap.
  return [
    // Month availability ages the same way the calendar metadata does: the
    // 30-minute cadence / midnight / focus refresh must revalidate it too.
    ['api', '/api/costs/months'],
    ['api', codexbarQueryPath(period === 'month' ? monthAnchor : null, now)],
    ['api', costsQueryPath(period, period === 'month' ? monthAnchor : null)],
  ]
}

// ---------------------------------------------------------------------------
// Month anchor helpers (`YYYY-MM`, local calendar)
// ---------------------------------------------------------------------------

export const MONTH_ANCHOR_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const monthLabelFormatter = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' })

export function isValidMonthKey(value: string | null | undefined): value is string {
  return MONTH_ANCHOR_PATTERN.test(String(value ?? ''))
}

// The SERVER decides which month is "current" — /api/costs normalizes an anchor
// against its own clock. With the browser in a different time zone, deriving it
// from the browser clock around a month boundary makes the two sides disagree:
// the UI can label a live month-to-date payload as a completed month total, or
// vice versa. `serverMonth` is that authority; the browser clock is the fallback
// for the first render, before any payload has arrived.
export function currentMonthKey(now = new Date(), serverMonth?: string | null) {
  if (isValidMonthKey(serverMonth)) return serverMonth as string
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonthKey(monthKey: string, delta: number) {
  const [year, month] = monthKey.split('-').map(Number)
  const shifted = new Date(year, month - 1 + delta, 1)
  return currentMonthKey(shifted)
}

export function previousMonthKey(monthKey: string) {
  return shiftMonthKey(monthKey, -1)
}

export function monthKeyLabel(monthKey: string) {
  if (!isValidMonthKey(monthKey)) return monthKey
  const [year, month] = monthKey.split('-').map(Number)
  return monthLabelFormatter.format(new Date(year, month - 1, 1))
}

export function daysInMonthKey(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month, 0).getDate()
}

/** True when the anchor names a calendar month that has already ended. */
export function isPastMonthAnchor(
  monthAnchor: string | null | undefined,
  now = new Date(),
  serverMonth?: string | null,
) {
  return isValidMonthKey(monthAnchor) && monthAnchor < currentMonthKey(now, serverMonth)
}

/** Oldest month the navigator will walk back to. */
export function monthAnchorFloor(now = new Date(), monthsBack = 24, serverMonth?: string | null) {
  return shiftMonthKey(currentMonthKey(now, serverMonth), -Math.abs(monthsBack))
}

export function monthNavigationState(
  monthAnchor: string | null,
  now = new Date(),
  monthsBack = 24,
  serverMonth?: string | null,
) {
  const current = currentMonthKey(now, serverMonth)
  const active = isValidMonthKey(monthAnchor) ? monthAnchor : current
  const floor = monthAnchorFloor(now, monthsBack, serverMonth)
  return {
    activeMonth: active,
    currentMonth: current,
    label: monthKeyLabel(active),
    isCurrentMonth: active === current,
    canGoBack: active > floor,
    canGoForward: active < current,
    previousMonth: previousMonthKey(active),
    nextMonth: shiftMonthKey(active, 1),
  }
}

/** Return the next selectable grid index, or keep focus where it is at an edge. */
export function nextSelectableIndex(
  months: Array<Pick<MonthPickerItem, 'selectable'>>,
  from: number,
  step: number,
) {
  for (let index = from + step; index >= 0 && index < months.length; index += step) {
    if (months[index].selectable) return index
  }
  return from
}

/** A server calendar advance makes an equal anchor a live, unanchored view. */
export function shouldClearMonthAnchor(monthAnchor: string | null, currentMonth: string) {
  return isValidMonthKey(monthAnchor) && monthAnchor === currentMonth
}

export interface MonthAvailability {
  month: string
  hasData: boolean
  sources: string[]
  /** The server did not inspect every source, so this month remains selectable. */
  unknown?: boolean
}

export interface MonthPickerItem {
  month: string
  label: string
  selectable: boolean
  unknown: boolean
  outsideRange: boolean
}

const shortMonthLabelFormatter = new Intl.DateTimeFormat('en-US', { month: 'short' })

export function monthPickerYearBounds(now = new Date(), monthsBack = 24, serverMonth?: string | null) {
  const floor = monthAnchorFloor(now, monthsBack, serverMonth)
  const current = currentMonthKey(now, serverMonth)
  return {
    floor,
    current,
    minimumYear: Number(floor.slice(0, 4)),
    maximumYear: Number(current.slice(0, 4)),
  }
}

/** Builds the picker grid without treating an unfetched availability response as no data. */
export function monthPickerGrid(
  year: number,
  availability: MonthAvailability[] = [],
  availabilityKnown = false,
  now = new Date(),
  monthsBack = 24,
  serverMonth?: string | null,
): MonthPickerItem[] {
  const { floor, current } = monthPickerYearBounds(now, monthsBack, serverMonth)
  const byMonth = new Map(availability.map(item => [item.month, item]))

  return Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, '0')}`
    const outsideRange = month < floor || month > current
    const source = byMonth.get(month)
    // Until availability loads (or when the server marks a source gap), keep the
    // month selectable. A missing response must never masquerade as confirmed zero usage.
    const unknown = !availabilityKnown || Boolean(source?.unknown)
    // The live month is always selectable so the picker can return to live view.
    return {
      month,
      label: shortMonthLabelFormatter.format(new Date(year, index, 1)),
      selectable: !outsideRange && (month === current || unknown || Boolean(source?.hasData)),
      unknown,
      outsideRange,
    }
  })
}

function codexbarDateKey(date: Date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  })
}

function codexbarPeriodBounds(
  period: 'day' | '7d' | 'month',
  now: Date,
  previous: boolean,
  monthAnchor: string | null = null,
  serverMonth: string | null = null,
) {
  // Anchored past month: the full calendar month, previous = the full month before it.
  // Mirrors the backend rangeForPeriod anchored window.
  // The server calendar decides past-vs-current, same as viewingPastMonth; the
  // browser clock is only the fallback before the first payload arrives.
  if (period === 'month' && isPastMonthAnchor(monthAnchor, now, serverMonth)) {
    const key = previous ? previousMonthKey(monthAnchor as string) : (monthAnchor as string)
    const [year, month] = key.split('-').map(Number)
    return {
      start: codexbarDateKey(new Date(year, month - 1, 1)),
      end: codexbarDateKey(new Date(year, month, 0)),
    }
  }

  if (period === 'month') {
    // The live month is the SERVER's current month; the browser clock is only
    // the pre-payload fallback. Bounds span the whole server month — days the
    // server has not reached yet simply have no rows, so the wide end is
    // harmless, while a narrow browser-based end can drop server-dated rows.
    const liveKey = currentMonthKey(now, serverMonth)
    const [liveYear, liveMonthNum] = liveKey.split('-').map(Number)
    if (previous) {
      const prevKey = previousMonthKey(liveKey)
      const [prevYear, prevMonthNum] = prevKey.split('-').map(Number)
      const prevEnd = new Date(prevYear, prevMonthNum, 0)
      prevEnd.setDate(Math.min(now.getDate(), prevEnd.getDate()))
      return {
        start: codexbarDateKey(new Date(prevYear, prevMonthNum - 1, 1)),
        end: codexbarDateKey(prevEnd),
      }
    }
    return {
      start: codexbarDateKey(new Date(liveYear, liveMonthNum - 1, 1)),
      end: codexbarDateKey(new Date(liveYear, liveMonthNum, 0)),
    }
  }

  const days = period === 'day' ? 1 : period === '7d' ? 7 : 30
  const end = new Date(now)
  end.setDate(end.getDate() - (previous ? days : 0))
  const start = new Date(end)
  start.setDate(start.getDate() - days + 1)
  return { start: codexbarDateKey(start), end: codexbarDateKey(end) }
}

function codexbarRowsInBounds(days: CodexBarDailyEntry[], start: string, end: string) {
  const rowsByDate = new Map(days.map(day => [day.date, day]))
  const rows: CodexBarDailyEntry[] = []
  const cursor = new Date(`${start}T12:00:00`)
  const finalDate = new Date(`${end}T12:00:00`)

  while (cursor <= finalDate) {
    const date = codexbarDateKey(cursor)
    rows.push(rowsByDate.get(date) || {
      date,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      models: [],
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  return rows
}

export function codexbarRowsForPeriod(
  days: CodexBarDailyEntry[] = [],
  period: 'day' | '7d' | 'month',
  now = new Date(),
  monthAnchor: string | null = null,
  serverMonth: string | null = null,
) {
  const bounds = codexbarPeriodBounds(period, now, false, monthAnchor, serverMonth)
  return codexbarRowsInBounds(days, bounds.start, bounds.end)
}

export function previousCodexbarRows(
  days: CodexBarDailyEntry[] = [],
  period: 'day' | '7d' | 'month',
  now = new Date(),
  monthAnchor: string | null = null,
  serverMonth: string | null = null,
) {
  const bounds = codexbarPeriodBounds(period, now, true, monthAnchor, serverMonth)
  return codexbarRowsInBounds(days, bounds.start, bounds.end)
}

export function buildCodexbarChartData(
  days: CodexBarDailyEntry[] = [],
  chartSeries: ChartSeriesItem[] = [],
): ChartDataRow[] {
  return days.map(day => {
    const row: Record<string, string | number> = {
      day: new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' }),
      fullDate: day.date,
      total: Number(day.totalCost || 0),
      totalTokens: Number(day.totalTokens || 0),
    }

    chartSeries.forEach(series => {
      const modelNames = series.rawModels?.length ? series.rawModels : [series.model]
      const matchingModels = (day.models || []).filter(model => modelNames.includes(model.model))
      row[series.key] = matchingModels.reduce((sum, model) => sum + Number(model.cost || 0), 0)
      row[`${series.key}__tokens`] = matchingModels.reduce((sum, model) => sum + Number(model.totalTokens || 0), 0)
    })

    return row as ChartDataRow
  })
}

export function comparisonLabels(
  period: 'day' | '7d' | 'month',
  monthAnchor: string | null = null,
  now = new Date(),
) {
  if (period === 'day') return { period: 'vs previous day', daily: 'vs previous day' }
  if (period === '7d') return { period: 'vs previous 7 days', daily: 'vs previous 7d avg' }
  if (isPastMonthAnchor(monthAnchor, now)) {
    const baseline = monthKeyLabel(previousMonthKey(monthAnchor as string))
    return { period: `vs ${baseline}`, daily: `vs ${baseline} avg` }
  }
  return { period: 'vs previous month', daily: 'vs previous month avg' }
}

// Generic period labels read naturally lowercased mid-sentence ("the loaded
// monthly period"); month-name labels like "July 2026" must keep their casing.
export function inlinePeriodLabel(label: string) {
  return label === 'Daily' || label === '7 Days' || label === 'Monthly' ? label.toLowerCase() : label
}

// ---------------------------------------------------------------------------
// Misc field helpers
// ---------------------------------------------------------------------------

export function readNumericField(row: Record<string, unknown>, key: string) {
  const value = row[key]
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

export function hasUsableAgentSplitData(data?: Pick<TokenData, 'agents' | 'period'> | null) {
  return !!data?.agents?.some(agent => {
    const summaryTokens = Number(agent.summary?.periodTokens ?? agent.summary?.thisMonthTokens ?? agent.summary?.totalTokens ?? 0)
    const summaryCost = Number(agent.summary?.periodUsd ?? agent.summary?.thisMonthUsd ?? agent.summary?.totalUsd ?? 0)
    const serviceUsage = (agent.byService || []).some(service => Number(service.tokens || 0) > 0 || Number(service.cost || 0) > 0)
    return summaryTokens > 0 || summaryCost > 0 || serviceUsage
  })
}
