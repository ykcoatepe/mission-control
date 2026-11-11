// All shared type declarations for the Costs page and its sub-components.

export interface AWSSCostData {
  period: { start: string; end: string }
  total: number
  daily: Array<{ date: string; cost: number }>
  services: Array<{ name: string; cost: number }>
  credits: number
  remaining: number
}

export interface TokenDailyEntry {
  date: string
  cost?: number
  tokens?: number
}

export interface ModelDailyEntry {
  date: string
  totalCost?: number
  totalTokens?: number
  models?: Record<string, { cost?: number; tokens?: number }>
  [key: string]: unknown
}

export interface TokenServiceData {
  name: string
  cost?: number
  tokens?: number
  percentage?: number
  costSource?: string
  costStatus?: string
  billingModes?: string
  costNote?: string
  apiEquivalentUsd?: number | null
  apiEquivalentStatus?: 'estimated' | 'not_applicable' | 'unavailable' | string
  apiEquivalentSource?: string
}

export interface AgentUsageData {
  key: 'openclaw' | 'hermes' | string
  label: string
  accent?: string
  source?: string
  status?: 'ready' | 'refreshing' | 'unavailable' | string
  summary: {
    periodUsd?: number
    periodTokens?: number
    todayUsd?: number
    todayTokens?: number
    thisWeekUsd?: number
    thisWeekTokens?: number
    thisMonthUsd?: number
    thisMonthTokens?: number
    totalUsd?: number
    totalTokens?: number
    periodApiEquivalentUsd?: number | null
      previousPeriodApiEquivalentUsd?: number | null
      previousPeriodApiEquivalentReliability?: string
    apiEquivalentUsd?: number | null
    apiEquivalentStatus?: 'estimated' | 'partial' | 'not_applicable' | 'unavailable' | 'no_usage' | string
  }
  byService?: TokenServiceData[]
}

/**
 * One platform's reading from the usage provider registry. A provider that
 * could not be read has `state: 'unavailable'` and null figures: those are
 * "not read", never zero.
 */
export interface UsageProvider {
  id: string
  label: string
  state: 'ready' | 'stale' | 'unavailable' | string
  /** ISO time of the provider's last reading; null when never observed. */
  observedAt: string | null
  coverage: 'complete' | 'partial' | string
  /** Tokens in the selected period; null when the provider was not read. */
  tokens: number | null
  apiEquivalentUsd: number | null
  billedUsd: number | null
  note?: string | null
}

/**
 * A platform that makes the period's total partial for a reason beyond "not
 * read" (GET /api/costs `missingProviders`). Reasons the server uses:
 * `usage_unavailable`, `window_not_observed`, `ownership_overlap_unresolved`,
 * `api_equivalent_unavailable`, `partially_priced_usage`.
 */
export interface UsageMissingProvider {
  id: string
  label: string
  reason: string
}

export interface TokenData {
  source?: string
  /** `anchor` is the `YYYY-MM` month this payload was anchored to, or null for the live period. */
  period?: { key?: 'day' | '7d' | 'month'; anchor?: string | null; start?: string; end?: string }
  daily: TokenDailyEntry[]
  /** Every platform the backend has a provider for. The page lists exactly these. */
  providers?: UsageProvider[]
  /** True when this period's total is partial: a provider is unread, stale or incomplete. Per window. */
  partial?: boolean
  /** Platforms behind a partial window, with the reason. Empty when the only issue is a standing partial record. */
  missingProviders?: UsageMissingProvider[]
  dailyByModel?: ModelDailyEntry[]
  modelKeys?: string[]
  agents?: AgentUsageData[]
  summary: {
    periodUsd?: number
    previousPeriodUsd?: number
    /** Null when no provider could be read for the period. */
    periodTokens?: number | null
    todayUsd?: number
    yesterdayUsd?: number
    thisWeekUsd?: number
    thisMonthUsd?: number
    totalUsd?: number
    todayTokens?: number
    thisWeekTokens?: number
    thisMonthTokens?: number
    totalTokens?: number
    periodApiEquivalentUsd?: number | null
    previousPeriodApiEquivalentUsd?: number | null
    previousPeriodApiEquivalentReliability?: string
    apiEquivalentUsd?: number | null
    note?: string
    budget?: { monthly: number | null; warning?: number }
  }
  byService: TokenServiceData[]
  costReliability?: 'normalized' | 'partial_unknown' | string
  apiEquivalentReliability?: 'estimated' | 'partial' | 'not_applicable' | 'unavailable' | 'no_usage' | string
  budget?: { monthly: number | null }
  meta?: {
    updatedAt?: string
    refreshing?: boolean
    stale?: boolean
    ageMs?: number
    openclawStatus?: 'ready' | 'refreshing' | 'unavailable' | string
    hermesStatus?: 'ready' | 'refreshing' | 'unavailable' | string
    claudeCodeStatus?: 'ready' | 'refreshing' | 'unavailable' | string
    preservedPreviousClaudeCode?: boolean
  }
}

export interface CodexBarDailyEntry {
  date: string
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  models: Array<{ model: string; cost: number; totalTokens: number }>
}

export interface CodexBarCostData {
  source: string
  /** Server served its last good scan because a fresh re-scan failed. */
  stale?: boolean
  staleAgeMs?: number
  staleReason?: string
  provider: 'codex' | 'claude' | 'both' | string
  updatedAt: string | null
  last30DaysCostUSD: number
  last30DaysTokens: number
  sessionCostUSD: number
  sessionTokens: number
  totals: {
    totalCost: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
  }
  daily: CodexBarDailyEntry[]
}

export interface SessionData {
  key: string
  model: string
  totalTokens: number
  updatedAt: string | null
  displayName?: string
}

/** The only parts of GET /api/config the Usage page reads (`modules.aws`, `aws.enabled`). */
export interface ConfigData {
  modules?: Record<string, boolean | undefined>
  aws?: {
    enabled?: boolean
  }
}

export interface ChartSeriesItem {
  model: string
  key: string
  color: string
  totalCost: number
  totalTokens: number
  rawModels?: string[]
}

export interface ChartDataRow {
  day: string
  fullDate: string
  total: number
  totalTokens: number
  [key: string]: string | number
}

export interface AggregatedBreakdownItem {
  name: string
  rawNames: string[]
  tokens: number
  cost: number
  apiEquivalentCost: number
  apiEquivalentAvailable: boolean
  share: number
  local: boolean
}

export interface ChartTooltipPayloadItem {
  value?: string | number
  name?: string
  dataKey?: string | number
  color?: string
  payload?: Record<string, string | number | undefined>
}
