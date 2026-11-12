// Pure helper functions and constants for the Costs page.
// No hooks, no JSX — safe to import from any context.

import type {
  TokenServiceData, CodexBarDailyEntry, TokenData, ChartDataRow, ChartSeriesItem, UsageMissingProvider, UsageProvider } from './types'
import type { UiState } from '../../lib/state'

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

/** What every money and token formatter shows for a value that was not read. Never 0. */
export const NOT_READ = '—'

function isReading(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The one phrase for billing that was not read, in the headline, the tabs and every table. */
export const BILLING_NOT_READ = 'Billing not read'

/** Money, or a dash when the value is null, undefined or not a finite number. */
export function formatCurrency(value: number | null | undefined) {
  return isReading(value) ? currencyFormatter.format(value) : NOT_READ
}

export function formatPreciseCurrency(value: number | null | undefined) {
  if (!isReading(value)) return NOT_READ
  if (Math.abs(value) > 0 && Math.abs(value) < 0.01) return `$${value.toFixed(6)}`
  return formatCurrency(value)
}

/** A token count, or a dash when the value was not read. */
export function formatTokens(value: number | null | undefined) {
  return isReading(value) ? integerFormatter.format(Math.round(value)) : NOT_READ
}

export function formatCompactTokenValue(value: number | null | undefined) {
  return isReading(value) ? compactNumberFormatter.format(Math.round(value)) : NOT_READ
}

/** "1,234 tokens", or a dash when the count was not read (never "— tokens"). */
export function formatTokenPhrase(value: number | null | undefined, suffix = 'tokens') {
  return isReading(value) ? `${formatTokens(value)} ${suffix}` : NOT_READ
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

/**
 * What the budget form would send. The server accepts a finite number that is
 * zero or positive, or `null` for "no budget" (POST /api/settings/budget). The
 * form never sends 0 or an empty string to mean "none": that is the explicit
 * "No monthly budget" choice, which sends `null`.
 *
 * `ok: false` with `error: null` means there is nothing to save yet (blank input).
 */
export type BudgetDraft = { ok: true; monthly: number | null } | { ok: false; error: string | null }

export function parseBudgetDraft(input: string, noBudget: boolean): BudgetDraft {
  if (noBudget) return { ok: true, monthly: null }
  const parsed = parseMonthlyBudgetInput(input)
  if (parsed.error) return { ok: false, error: parsed.error }
  if (parsed.monthly === null) return { ok: false, error: null }
  return { ok: true, monthly: parsed.monthly }
}

/** A saved budget is a positive number; null, 0, or anything else means no cap is in force. */
export function savedBudgetCap(monthly: unknown): number | null {
  return typeof monthly === 'number' && Number.isFinite(monthly) && monthly > 0 ? monthly : null
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

const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  imessage: 'iMessage',
  cron: 'Scheduled job',
  subagent: 'Sub-agent',
}

/**
 * A readable name and one detail line for a session. The raw key is an address
 * ("agent:main:telegram:direct:<chat id>"): it carries chat ids, so it is never shown.
 * The detail line names the agent and the channel instead.
 */
export function describeSession(
  session: { key: string; displayName?: string; label?: string | null; agentId?: string | null },
): { name: string; detail: string } {
  const { key } = session
  const parts = key.split(':')
  const agentId = session.agentId || (parts[0] === 'agent' && parts[1] ? parts[1] : null)
  const channelWord = parts[0] === 'agent' ? parts[2] : parts[0]
  const channel = channelWord && channelWord !== 'main' ? (CHANNEL_NAMES[channelWord] ?? channelWord) : null
  const detail = [agentId ? `Agent ${agentId}` : null, channel].filter(Boolean).join(' · ') || 'Session'

  const label = session.label?.trim()
  if (label) return { name: label, detail }
  const display = session.displayName?.trim()
  if (display && display !== key) return { name: formatSessionName(key, display), detail }
  if (key.includes('#') || key === 'agent:main:main' || key.includes(':subagent:')) return { name: formatSessionName(key), detail }
  if (parts[0] === 'agent' && parts[2] && parts[2] !== 'main') {
    const channelName = CHANNEL_NAMES[parts[2]] ?? parts[2]
    const kind = parts[3]
    return { name: kind === 'direct' ? `${channelName} direct chat` : kind ? `${channelName} ${kind}` : `${channelName} session`, detail }
  }
  return { name: agentId ? `${agentId} main session` : 'Session', detail }
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

export function modelColorKey(model: string): string {
  return model.trim().toLowerCase()
}

/** Number of chart colours the design system defines (`--chart-1..6`: muted categories that never reuse the Brain line colours, the accent or a state colour). */
export const SERIES_COLOR_COUNT = 6

export function seriesColorToken(slot: number): string {
  return `var(--chart-${(slot % SERIES_COLOR_COUNT) + 1})`
}

/**
 * Pooled model -> series-token assignment. A model keeps its colour for as long
 * as it stays active (across period changes and while replacement data loads);
 * colours of models that dropped out return to the pool and go to newcomers.
 * `slots` limits the pool (e.g. 5 when the sixth token is reserved for the
 * "Other models" bucket). Keys are case-insensitive, like the other series helpers.
 */
export function assignSeriesColors(
  activeModels: string[],
  previousAssignments: ReadonlyMap<string, string> = new Map(),
  slots: number = SERIES_COLOR_COUNT,
  /** Colours held by models that are not active now: newcomers take any other free colour first. */
  avoid: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const pool = Array.from({ length: Math.max(1, Math.min(slots, SERIES_COLOR_COUNT)) }, (_, slot) => seriesColorToken(slot))
  const activeKeys = Array.from(new Set(activeModels.map(modelColorKey).filter(Boolean)))
  const assignments = new Map<string, string>()
  const reserved = new Set<string>()

  activeKeys.forEach(key => {
    const previous = previousAssignments.get(key)
    if (previous && pool.includes(previous) && !reserved.has(previous)) {
      assignments.set(key, previous)
      reserved.add(previous)
    }
  })

  let overflow = 0
  activeKeys.forEach(key => {
    if (assignments.has(key)) return
    const free = pool.find(color => !reserved.has(color) && !avoid.has(color))
      ?? pool.find(color => !reserved.has(color))
    if (free) {
      assignments.set(key, free)
      reserved.add(free)
    } else {
      // More active models than tokens: reuse deterministically instead of inventing a colour.
      assignments.set(key, pool[overflow % pool.length])
      overflow += 1
    }
  })

  return assignments
}

/**
 * A model keeps the same colour in every view (Day, 7 days, Month and any month),
 * not only while it stays in the list. `memory` is every assignment made so far in
 * this session; a model that was not shown for a while still owns its colour, so a
 * newcomer is given a colour nobody remembers before one is taken over.
 * Returns the colours for the active models and the updated memory.
 */
export function assignStableSeriesColors(
  activeModels: string[],
  memory: ReadonlyMap<string, string> = new Map(),
  slots: number = SERIES_COLOR_COUNT,
): { assignments: Map<string, string>; memory: Map<string, string> } {
  const activeKeys = new Set(activeModels.map(modelColorKey).filter(Boolean))
  const avoid = new Set<string>()
  memory.forEach((color, key) => {
    if (!activeKeys.has(key)) avoid.add(color)
  })
  const assignments = assignSeriesColors(activeModels, memory, slots, avoid)
  return { assignments, memory: new Map([...memory, ...assignments]) }
}

const MODEL_METRIC_SUFFIX = /_(tokens|input|output|reasoning|cacheRead|cacheWrite|costSource|apiEquivalentUsd|apiEquivalentStatus)$/
const DAILY_TOTAL_KEYS = new Set(['date', 'models', 'totalCost', 'apiEquivalentCost', 'totalTokens'])

/** True for a per-model metric column such as `gpt_reasoning` — never a model of its own. */
export function isModelMetricKey(key: string): boolean {
  return MODEL_METRIC_SUFFIX.test(key)
}

/** True when a `dailyByModel` column names a model (not a total or a per-model metric). */
export function isModelColumnKey(key: string): boolean {
  return !DAILY_TOTAL_KEYS.has(key) && !isModelMetricKey(key)
}

// ---------------------------------------------------------------------------
// Model name utilities
// ---------------------------------------------------------------------------

/** A usage key is "<platform> / <model>"; every other string is a bare model. Platform and model are two fields. */
export function splitModelKey(raw: string): { platform: string | null; model: string } {
  const text = String(raw ?? '').trim()
  const at = text.indexOf(' / ')
  if (at <= 0) return { platform: null, model: text }
  return { platform: text.slice(0, at).trim() || null, model: text.slice(at + 3).trim() }
}

const GPT_MODEL = /^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/
const CLAUDE_MODEL = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[-.](\d{1,2}))?$/

function titleWords(text: string) {
  return text.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * The model id with routing noise removed: the platform prefix, the provider path
 * ("openai-codex/", "anthropic/", "claude-subscription-directsdk-experimental/"),
 * a context-window tag ("[1m]") and a snapshot date. Two strings that name the same
 * model give the same id; two different models never do.
 */
export function normalizedModelId(raw: string): string {
  const { model } = splitModelKey(raw)
  let id = (model.split('/').pop() ?? '').trim()
  id = id.replace(/\[[^\]]*\]$/, '').trim()
  const lower = id.toLowerCase()
  const claude = lower.replace(/-\d{8}$/, '')
  if (CLAUDE_MODEL.test(claude)) return claude.replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, '$1-$2')
  const gpt = lower.replace(/-\d{8}$/, '')
  if (GPT_MODEL.test(gpt)) return gpt
  return id
}

export function canonicalModelName(model: string) {
  const lower = String(model ?? '').toLowerCase()

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

  const id = normalizedModelId(model)
  const idLower = id.toLowerCase()
  const claude = CLAUDE_MODEL.exec(idLower)
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1)
    return `Claude ${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  }
  const gpt = GPT_MODEL.exec(idLower)
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${titleWords(gpt[2])}` : ''}`
  if (idLower.includes('claude-sonnet') || idLower.includes('sonnet')) return 'Claude Sonnet'
  if (idLower.includes('claude-opus') || idLower.includes('opus')) return 'Claude Opus'
  if (idLower.includes('claude-haiku') || idLower.includes('haiku')) return 'Claude Haiku'

  return id || 'Unknown'
}

export interface ModelIdentity {
  /** Stable key: colours and rows are keyed by it. */
  id: string
  /** The platform the usage key named, or null for a bare model. */
  platform: string | null
  /** Display name before collisions are resolved. */
  name: string
}

export function modelIdentity(raw: string): ModelIdentity {
  return { id: normalizedModelId(raw).toLowerCase() || 'unknown', platform: splitModelKey(raw).platform, name: canonicalModelName(raw) }
}

/**
 * One display name per model id. Two different models never share a name: when the
 * naming rule gives the same name to different ids, the id is appended to each of them.
 */
export function uniqueModelNames(identities: ReadonlyArray<Pick<ModelIdentity, 'id' | 'name'>>): Map<string, string> {
  const idsByName = new Map<string, Set<string>>()
  identities.forEach(item => {
    const ids = idsByName.get(item.name) ?? new Set<string>()
    ids.add(item.id)
    idsByName.set(item.name, ids)
  })
  const names = new Map<string, string>()
  identities.forEach(item => {
    names.set(item.id, (idsByName.get(item.name)?.size ?? 0) > 1 ? `${item.name} (${item.id})` : item.name)
  })
  return names
}

export function toChartKey(index: number) {
  return `model_${index}`
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
          ? '1 billing source not read'
          : `${count} billing sources not read`
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

// ---------------------------------------------------------------------------
// Day picker (`YYYY-MM-DD`, local calendar)
// ---------------------------------------------------------------------------

export interface DayUsageEntry {
  date: string
  cost: number
  tokens: number
}

export interface DayPickerCell {
  date: string
  dayOfMonth: number
  selectable: boolean
  isToday: boolean
  /** 0..1 heat relative to the month's busiest day; 0 = no recorded usage. */
  intensity: number
  hasUsage: boolean
  cost: number
  tokens: number
}

export interface DayPickerMonth {
  /** Empty grid slots before day 1 so columns align to Sunday-first weekdays. */
  leadingBlanks: number
  cells: DayPickerCell[]
}

export function dayKeyOf(now: Date) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

// A day whose only activity is local models has no priced cost; the floor keeps
// it visible on a cost-driven heat scale instead of rendering as an idle day.
const LOCAL_ONLY_DAY_INTENSITY = 0.3
// Any recorded usage stays visibly warm even next to a month-dominating spike.
const MIN_VISIBLE_INTENSITY = 0.12

export function dayPickerGrid(
  monthKey: string,
  usage: DayUsageEntry[] = [],
  now = new Date(),
  monthsBack = 24,
  serverMonth?: string | null,
): DayPickerMonth {
  const [year, month] = monthKey.split('-').map(Number)
  const floor = monthAnchorFloor(now, monthsBack, serverMonth)
  const current = currentMonthKey(now, serverMonth)
  const monthInRange = monthKey >= floor && monthKey <= current
  const today = dayKeyOf(now)
  const byDate = new Map(usage.map(entry => [entry.date, entry]))
  const maxCost = usage.reduce((max, entry) => Math.max(max, Number(entry.cost) || 0), 0)
  const maxTokens = usage.reduce((max, entry) => Math.max(max, Number(entry.tokens) || 0), 0)

  const cells = Array.from({ length: daysInMonthKey(monthKey) }, (_, index) => {
    const date = `${monthKey}-${String(index + 1).padStart(2, '0')}`
    const entry = byDate.get(date)
    const cost = Number(entry?.cost) || 0
    const tokens = Number(entry?.tokens) || 0
    const hasUsage = cost > 0 || tokens > 0
    // Cost drives the scale; a month with only unpriced (local) usage falls back
    // to tokens so its rhythm still reads instead of flattening to zero heat.
    const intensity = !hasUsage
      ? 0
      : maxCost > 0
        ? cost > 0 ? Math.max(cost / maxCost, MIN_VISIBLE_INTENSITY) : LOCAL_ONLY_DAY_INTENSITY
        : Math.max(tokens / maxTokens, MIN_VISIBLE_INTENSITY)
    // A usage-bearing day is never "future": the server clock can run ahead of
    // the browser's around midnight, and its rows are the stronger evidence.
    const selectable = monthInRange && (hasUsage || date <= today)
    return { date, dayOfMonth: index + 1, selectable, isToday: date === today, intensity, hasUsage, cost, tokens }
  })

  return { leadingBlanks: new Date(year, month - 1, 1).getDay(), cells }
}

/**
 * Which day the daily chart should highlight. A `requested` date (a calendar
 * day click) wins as soon as its row exists in the loaded pool — it may lag a
 * render cycle behind while an anchored month is still fetching.
 */
export function resolveActiveChartDate(
  pool: Array<{ fullDate: string }>,
  current: string | null,
  requested: string | null = null,
): { date: string | null; consumedRequest: boolean } {
  if (!pool.length) return { date: null, consumedRequest: false }
  if (requested && pool.some(day => day.fullDate === requested)) {
    return { date: requested, consumedRequest: true }
  }
  if (current && pool.some(day => day.fullDate === current)) {
    return { date: current, consumedRequest: false }
  }
  return { date: pool[pool.length - 1]?.fullDate || null, consumedRequest: false }
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

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** The comparison window as the server reports it (`period.previousStart/previousEnd/previousIsPartial`). */
export type ComparisonWindow = Pick<
  NonNullable<TokenData['period']>,
  'anchor' | 'previousStart' | 'previousEnd' | 'previousIsPartial'
>

function parsedWindow(window: ComparisonWindow | null | undefined) {
  const start = window?.previousStart
  const end = window?.previousEnd
  if (!start || !end || !DATE_KEY.test(start) || !DATE_KEY.test(end) || start > end) return null
  return { start, end }
}

/** Inclusive number of days in the server's comparison window; null when the payload sent none. */
export function previousWindowDays(window: ComparisonWindow | null | undefined): number | null {
  const parsed = parsedWindow(window)
  if (!parsed) return null
  const day = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))
  return Math.round((day(parsed.end) - day(parsed.start)) / 86_400_000) + 1
}

/**
 * Labels for the previous-period comparison, built from the dates the server
 * actually compared (`period.previousStart` and `previousEnd`), never from the
 * current window. A month window that is cut short names its days ("the first
 * 11 days of October"); a complete one names the month. `previousIsPartial` on a
 * complete window means the evidence behind it is incomplete, and the label
 * says so. Without the server's dates the label is generic.
 */
export function comparisonLabels(period: 'day' | '7d' | 'month', window: ComparisonWindow | null = null) {
  const incomplete = window?.previousIsPartial === true
  const note = (label: string) => (incomplete ? `${label} (incomplete data)` : label)
  if (period === 'day') return { period: note('vs previous day'), daily: 'vs previous day' }
  if (period === '7d') return { period: note('vs previous 7 days'), daily: 'vs previous 7d avg' }
  const parsed = parsedWindow(window)
  if (!parsed || parsed.start.slice(0, 7) !== parsed.end.slice(0, 7)) {
    return { period: note('vs the previous month'), daily: 'vs previous month avg' }
  }
  const key = parsed.start.slice(0, 7)
  const startDay = Number(parsed.start.slice(8))
  const endDay = Number(parsed.end.slice(8))
  // A past month (anchored view) carries its year; the live month does not.
  const monthName = window?.anchor ? monthKeyLabel(key) : monthKeyLabel(key).split(' ')[0]
  if (startDay === 1 && endDay >= daysInMonthKey(key)) {
    return { period: note(`vs ${monthName}`), daily: `vs ${monthName} avg` }
  }
  const days = endDay - startDay + 1
  const span = startDay !== 1
    ? `${startDay}–${endDay} ${monthName}`
    : days === 1 ? `1 ${monthName}` : `the first ${days} days of ${monthName}`
  // A cut-short month already says it is partial in words; the flag adds nothing to it.
  return { period: `vs ${span}`, daily: `vs ${span} avg` }
}

/** A projection needs this share of the month to have passed; before that one busy day swings it. */
export const MIN_PROJECTION_SHARE = 0.25

export interface PeriodReading {
  /** The current period is still running (today is part-way through). */
  inProgress: boolean
  /**
   * The current and previous totals cover the same length of time, so a percentage change means
   * something. A part-way day against a whole previous day is not: it is shown as "so far", with no percentage.
   */
  likeForLike: boolean
  /** Null when a projection is allowed; otherwise why it is withheld, in one sentence. */
  projectionWithheld: string | null
}

/**
 * What the headline may claim for a period. Never projects a month from part of a day or from the
 * first days of a month, and never compares a part-way day with a whole one. A finished month is a
 * total: nothing is in progress, nothing is projected (the projection stat is not shown for it).
 */
export function periodReading(
  period: 'day' | '7d' | 'month',
  window: { end?: string | null } | null,
  finishedMonth: boolean,
  now = new Date(),
): PeriodReading {
  if (finishedMonth) return { inProgress: false, likeForLike: true, projectionWithheld: null }
  if (period === 'day') {
    return {
      inProgress: true,
      likeForLike: false,
      projectionWithheld: 'Today is not over, so there is no month projection from it.',
    }
  }
  if (period === '7d') return { inProgress: true, likeForLike: true, projectionWithheld: null }
  const end = window?.end && DATE_KEY.test(window.end) ? window.end : dayKeyOf(now)
  const monthKey = end.slice(0, 7)
  const total = daysInMonthKey(monthKey)
  const passed = Math.min(Number(end.slice(8)), total)
  const withheld = passed / total < MIN_PROJECTION_SHARE
    ? `Too early to project the month: ${passed} of ${total} days have passed.`
    : null
  return { inProgress: true, likeForLike: true, projectionWithheld: withheld }
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

// ---------------------------------------------------------------------------
// Platforms (usage providers)
// ---------------------------------------------------------------------------

export type CoverageReason = 'standing_gaps' | 'scan_failed' | 'unresolved_overlap' | 'unread' | 'none'

const COVERAGE_REASONS: readonly CoverageReason[] = ['standing_gaps', 'scan_failed', 'unresolved_overlap', 'unread', 'none']

export interface ProviderRow {
  id: string
  label: string
  /** False when the platform could not be read for the period: its figures are null, not zero. */
  read: boolean
  uiState: UiState
  /** The word beside the state dot: Ready, Stale, Partial, No usage recorded or Not read. */
  stateWord: 'Ready' | 'Stale' | 'Partial' | 'No usage recorded' | 'Not read'
  /** Server verdict for `Freshness`; undefined lets the age decide. Null for unread rows (no age to show). */
  freshness: 'stale' | null | undefined
  observedAt: string | null
  /** From the server's `coverageReason`: complete (none), partial (any gap) or unknown (not sent or not understood). */
  coverage: 'complete' | 'partial' | 'unknown'
  /** The server's own classification; null when it was not sent or is a word the page does not know. */
  coverageReason: CoverageReason | null
  /** Partial because of a standing gap (`standing_gaps`): a condition, not a fault. Failed scans and overlaps are not standing. */
  standing: boolean
  /** Server counters of lines the producer could not read; null when it did not supply them. */
  skippedLines: number | null
  oversizedLines: number | null
  /** Why the coverage is what it is, as a plain sentence (reason and line counters); null when the records are complete. */
  coverageDetail: string | null
  /** The platform has no usage rows in the period (the server's `hasRecords` is false). Unknown (flag absent) is not "no records". */
  noRecords: boolean
  tokens: number | null
  apiEquivalentUsd: number | null
  billedUsd: number | null
  note: string | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const LINE_NUMBER = (value: number) => value.toLocaleString('en-US')

/**
 * A plain sentence for why a platform's figure may be low, built from the server's
 * `coverageReason` and its skipped / oversized line counters. Never the provider's
 * own note, which is written for logs. Null when the records are complete.
 */
function coverageDetailOf(reason: CoverageReason | null, skipped: number | null, oversized: number | null): string | null {
  if (reason === 'none') return null
  if (reason === 'scan_failed') return 'The latest scan failed, so this shows the last good scan.'
  if (reason === 'unresolved_overlap') return 'Some of this usage may also belong to another platform. That is not settled yet.'
  if (reason === 'standing_gaps') {
    const lines = skipped !== null && skipped > 0 ? skipped : null
    if (lines === null) return 'Its records are known to be incomplete, so this figure may be low.'
    const noun = lines === 1 ? 'log line' : 'log lines'
    if (oversized !== null && oversized >= lines) {
      return `${LINE_NUMBER(lines)} ${noun} ${lines === 1 ? 'was' : 'were'} too large to read, so this figure may be low.`
    }
    const large = oversized !== null && oversized > 0 ? ` (${LINE_NUMBER(oversized)} too large)` : ''
    return `${LINE_NUMBER(lines)} ${noun} could not be read${large}, so this figure may be low.`
  }
  return 'The platform did not say how complete its records are, so this figure may be low.'
}

/**
 * One row per platform the payload lists, in payload order, and nothing else.
 * A platform is unread when the server says so (`unavailable`, `coverageReason:
 * unread`, or any state it does not know) or when it gave no token reading:
 * unread rows carry null figures even if the payload sent numbers, so no caller
 * can render them as 0. Every other treatment comes from the server's own
 * fields: `hasRecords` (no rows in the window), `billingKnown` (a recorded bill),
 * `coverageReason` (why the records are incomplete).
 */
export function providerRows(providers: UsageProvider[] | null | undefined): ProviderRow[] {
  if (!Array.isArray(providers)) return []
  return providers.map(provider => {
    const state = String(provider.state ?? '').toLowerCase()
    const tokens = finiteOrNull(provider.tokens)
    const apiEquivalentUsd = finiteOrNull(provider.apiEquivalentUsd)
    const coverageReason = COVERAGE_REASONS.find(reason => reason === provider.coverageReason) ?? null
    const read = (state === 'ready' || state === 'stale') && tokens !== null && coverageReason !== 'unread'
    const stale = read && state === 'stale'
    // Complete only when the server says `none`; a reason it did not send is unknown, never green.
    const coverage = coverageReason === 'none'
      ? 'complete'
      : coverageReason === 'standing_gaps' || coverageReason === 'scan_failed' || coverageReason === 'unresolved_overlap'
        ? 'partial'
        : 'unknown'
    const standing = coverage === 'partial' && coverageReason === 'standing_gaps'
    // A platform that was read but has no usage rows has nothing to show: all of its
    // figures are dashes and its state is the quiet "No usage recorded", not "Ready".
    const noRecords = read && provider.hasRecords === false
    // THE PARTIAL-PLATFORM RULE (stated once, tested in providers.test.ts): a partial platform is a
    // warning only when the server says a scan failed (`scan_failed`) or an overlap is unresolved
    // (`unresolved_overlap`), or when the coverage was not reported at all. A standing gap
    // (`standing_gaps`: skipped or oversized log lines that are always there) is a condition, not a
    // fault: calm neutral, never green, with the plain-sentence detail beside it. A stale reading
    // is always a warning.
    const partial = read && coverage !== 'complete'
    const standingPartial = partial && standing
    // Billing is known only when the server says so (`billingKnown`); a bare 0 is not that.
    const billed = finiteOrNull(provider.billedUsd)
    const billedKnown = provider.billingKnown === true
    const note = typeof provider.note === 'string' && provider.note.trim() ? provider.note.trim() : null
    const skippedLines = countOrNull(provider.skippedLines)
    const oversizedLines = countOrNull(provider.oversizedLines)
    return {
      id: String(provider.id),
      label: provider.label || String(provider.id),
      read,
      uiState: !read
        ? 'unavailable'
        : stale || (partial && !standingPartial)
          ? 'warning'
          : standingPartial || noRecords
            ? 'inactive'
            : 'healthy',
      stateWord: !read ? 'Not read' : stale ? 'Stale' : partial ? 'Partial' : noRecords ? 'No usage recorded' : 'Ready',
      freshness: !read ? null : stale ? 'stale' : undefined,
      observedAt: provider.observedAt ?? null,
      coverage,
      coverageReason,
      standing,
      skippedLines,
      oversizedLines,
      coverageDetail: read ? coverageDetailOf(coverageReason, skippedLines, oversizedLines) : 'Could not be read, so it is left out of the totals.',
      noRecords,
      tokens: read ? tokens : null,
      apiEquivalentUsd: read ? apiEquivalentUsd : null,
      billedUsd: read && !noRecords && billedKnown ? billed : null,
      note,
    }
  })
}

export interface ProviderCoverage {
  /** Platforms that could not be read: left out of every total. */
  unread: string[]
  /** Read, but the platform says its records are incomplete: its figure may be low. A standing condition. */
  partial: string[]
  /** Read from a last good scan because the latest one failed. */
  stale: string[]
  /** Sentences for window problems the payload names beyond a platform being unread (overlap, unpriced usage). */
  gaps: string[]
  /** The backend marks the payload partial although no platform explains it. */
  unexplained: boolean
  /** True when any total on the page is partial. */
  hasIssues: boolean
  /** Partial records are the only issue: calm, nothing to act on. Any other cause is a warning. */
  standingOnly: boolean
}

export const NO_PROVIDER_ISSUES: ProviderCoverage = {
  unread: [],
  partial: [],
  stale: [],
  gaps: [],
  unexplained: false,
  hasIssues: false,
  standingOnly: false,
}

/** Why a platform is listed in a costs payload's `missingProviders` (server/sources/usage/index.js). */
const MISSING_REASON_SENTENCE: Record<string, (label: string) => string> = {
  ownership_overlap_unresolved: label => `${label} overlaps another platform and could not be attributed with certainty.`,
  api_equivalent_unavailable: label => `${label} has no public price for its models, so it adds nothing to the API equivalent.`,
  partially_priced_usage: label => `Some ${label} usage has no public price and is not in the API equivalent.`,
}

export function summarizeProviderCoverage(
  rows: ProviderRow[],
  payloadPartial = false,
  missing: readonly UsageMissingProvider[] = [],
): ProviderCoverage {
  const unread = rows.filter(row => !row.read).map(row => row.label)
  const stale = rows.filter(row => row.read && row.stateWord === 'Stale').map(row => row.label)
  const partial = rows.filter(row => row.read && row.coverage !== 'complete' && row.stateWord !== 'Stale').map(row => row.label)
  // `usage_unavailable` and `window_not_observed` are an unread platform: the Platforms rows already say so.
  const gaps = missing.flatMap(item => {
    const label = item.label || item.id
    const sentence = MISSING_REASON_SENTENCE[item.reason]
    if (sentence) return [sentence(label)]
    if (item.reason === 'usage_unavailable' || item.reason === 'window_not_observed') {
      if (!unread.includes(label)) unread.push(label)
      return []
    }
    return []
  })
  const explained = unread.length + stale.length + partial.length + gaps.length > 0
  const unexplained = payloadPartial && !explained
  const hasIssues = explained || unexplained
  // Standing only when every incomplete platform is a standing gap (not a failed scan or an overlap).
  const partialRows = rows.filter(row => row.read && row.coverage !== 'complete' && row.stateWord !== 'Stale')
  const standingOnly = partial.length > 0 && partialRows.every(row => row.standing)
    && unread.length + stale.length + gaps.length === 0 && !unexplained
  return { unread, partial, stale, gaps, unexplained, hasIssues, standingOnly }
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The sentences that make a partial total explicit; empty when every platform was read in full. */
export function providerCoverageSentences(coverage: ProviderCoverage): string[] {
  if (!coverage.hasIssues) return []
  const verb = (names: string[], one: string, many: string) => (names.length === 1 ? one : many)
  const sentences = ['This total is partial.']
  if (coverage.unread.length) {
    sentences.push(`${joinNames(coverage.unread)} could not be read and ${verb(coverage.unread, 'is', 'are')} not counted.`)
  }
  if (coverage.partial.length) {
    sentences.push(`${joinNames(coverage.partial)} ${verb(coverage.partial, 'has', 'have')} incomplete records, so ${verb(coverage.partial, 'its figure', 'their figures')} may be low.`)
  }
  if (coverage.stale.length) {
    sentences.push(`${joinNames(coverage.stale)} ${verb(coverage.stale, 'shows', 'show')} the last good reading.`)
  }
  sentences.push(...coverage.gaps)
  if (coverage.unexplained) sentences.push('The backend marks some usage as missing.')
  // Partial records alone are a standing condition: say where the detail is.
  if (coverage.standingOnly) sentences.push('The Platforms table above says why, platform by platform.')
  return sentences
}

/**
 * The period's token total from the ledger summary. A `periodTokens` the server
 * sent as null means no platform could be read: that is "not read" (null), and
 * must not fall through to a month or lifetime figure. Only a payload that
 * predates `periodTokens` falls back to the older fields.
 */
export function ledgerTokenReading(summary: Pick<NonNullable<TokenData['summary']>, 'periodTokens' | 'thisMonthTokens' | 'totalTokens'> | null | undefined): number | null {
  if (!summary) return null
  if (summary.periodTokens !== undefined) return finiteOrNull(summary.periodTokens)
  return finiteOrNull(summary.thisMonthTokens) ?? finiteOrNull(summary.totalTokens)
}

/** One sentence for assistive technology: the span, the total and the busiest day. */
export function chartSummary(rows: ChartDataRow[]): string {
  if (rows.length === 0) return 'Daily spend chart, no days'
  const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0)
  const busiest = rows.reduce((best, row) => (Number(row.total || 0) > Number(best.total || 0) ? row : best), rows[0])
  return `Daily spend, ${rows.length === 1 ? '1 day' : `${rows.length} days`}, ${formatCurrency(total)} in total. Busiest day ${busiest.fullDate}, ${formatCurrency(Number(busiest.total || 0))}.`
}

