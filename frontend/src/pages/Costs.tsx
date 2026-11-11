import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi, fetchJson } from '../lib/hooks'
import { ErrorState, Page, Skeleton, useToast } from '../components/ui'
import type { UiState } from '../lib/state'
import costsStyles from './costs/Costs.module.css'
import type {
  AWSSCostData,
  TokenData,
  CodexBarCostData,
  SessionData,
  ConfigData,
  ChartSeriesItem,
  ChartDataRow,
  AggregatedBreakdownItem,
} from './costs/types'
import {
  formatSessionName,
  canonicalModelName,
  isLocalModel,
  toChartKey,
  calculateTrend,
  summarizeCostReliability,
  sumCostRows,
  calendarRefreshQueryKeys,
  codexbarQueryPath,
  costsQueryPath,
  millisecondsUntilNextCalendarDay,
  codexbarRowsForPeriod,
  previousCodexbarRows,
  buildCodexbarChartData,
  comparisonLabels,
  daysInMonthKey,
  previousMonthKey,
  isPastMonthAnchor,
  monthKeyLabel,
  readNumericField,
  hasUsableAgentSplitData,
  parseMonthlyBudgetInput,
  trackedSpendPresentation,
  apiEquivalentMetricValues,
  apiEquivalentPeriodValue,
  budgetSpendValue,
  awsBillingDataAvailable,
  awsIntegrationEnabled,
  currentMonthKey,
  resolveActiveChartDate,
  shouldClearMonthAnchor,
  assignSeriesColors,
  SERIES_COLOR_COUNT,
  seriesColorToken,
  isModelColumnKey,
  isModelMetricKey,
  modelColorKey,
} from './costs/lib'
import type { DayUsageEntry } from './costs/lib'
import { nextStaleRetry } from './costs/staleRetry'
import type { CostsTokenData, StaleRetryState } from './costs/staleRetry'
import PeriodControls from './costs/PeriodControls'
import UsageSummary from './costs/UsageSummary'
import BudgetPanel from './costs/BudgetPanel'
import AwsCreditsPanel from './costs/AwsCreditsPanel'
import DailySpendSection from './costs/DailySpendSection'
import type { SessionEstimateDay } from './costs/DailySpendSection'
import CostDriversSection from './costs/CostDriversSection'
import type { AgentSplitItem, DriverTab } from './costs/CostDriversSection'

// serverMonth is authoritative but only refreshes with a costs payload; the
// server can cross a month boundary long before browser midnight, so the
// calendar metadata is revalidated on a fixed cadence too (cache-served, cheap).
const CALENDAR_METADATA_REVALIDATE_MS = 30 * 60 * 1000

type MonthAvailabilityResponse = {
  months: Array<{
    month: string
    hasData: boolean
    sources: string[]
    unknown?: boolean
  }>
  generatedAt: string
  partial: boolean
  sourceStatus: {
    hermes: 'ready' | 'no_usage' | 'unavailable' | 'not_configured'
    codexbar: 'ready' | 'no_usage' | 'unavailable' | 'not_configured'
    cached: 'ready' | 'no_usage'
  }
}


export default function Costs() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [period, setPeriod] = useState<'day' | '7d' | 'month'>('month')
  // `null` = the live current month. The anchor survives a trip through the Daily /
  // 7 Days tabs (it is simply not sent while those periods are active) and is
  // restored the moment Monthly comes back.
  const [monthAnchor, setMonthAnchor] = useState<string | null>(null)
  const [activeChartDate, setActiveChartDate] = useState<string | null>(null)
  // A calendar-day click that may point at a month whose rows are still loading;
  // consumed (and scrolled to) once the day exists in the chart pool.
  const [requestedChartDate, setRequestedChartDate] = useState<string | null>(null)
  const dailySpendRef = useRef<HTMLDivElement | null>(null)
  // null = the default tab for the data in view (AWS services while AWS billing is the source).
  const [driverTab, setDriverTab] = useState<DriverTab | null>(null)
  const [calendarNow, setCalendarNow] = useState(() => new Date())
  const staleCostsRetry = useRef<StaleRetryState | null>(null)
  // React Compiler rejects reading/writing a useRef during render here, so keep
  // the same render-phase sentinel semantics as the budget initialization below.
  const [lastServerMonth, setLastServerMonth] = useState<string | null>(null)

  // Only Monthly honours the anchor; Daily / 7 Days always query the live window.
  const activeMonthAnchor = period === 'month' ? monthAnchor : null
  const costsPath = costsQueryPath(period, activeMonthAnchor)

  useEffect(() => {
    let timerId = 0
    const refreshCalendarNow = () => {
      const next = new Date()
      setCalendarNow(current => current.toDateString() === next.toDateString() ? current : next)
      calendarRefreshQueryKeys(period, monthAnchor).forEach(queryKey => {
        void queryClient.invalidateQueries({ queryKey })
      })
    }
    const scheduleNextCalendarRefresh = () => {
      timerId = window.setTimeout(() => {
        refreshCalendarNow()
        scheduleNextCalendarRefresh()
      }, millisecondsUntilNextCalendarDay())
    }

    scheduleNextCalendarRefresh()
    const revalidateId = window.setInterval(refreshCalendarNow, CALENDAR_METADATA_REVALIDATE_MS)
    window.addEventListener('focus', refreshCalendarNow)
    return () => {
      window.clearTimeout(timerId)
      window.clearInterval(revalidateId)
      window.removeEventListener('focus', refreshCalendarNow)
    }
  }, [monthAnchor, period, queryClient])

  // ---- Period-independent fetches (codexbar additionally follows the month anchor) ----
  const { data: awsCosts } = useApi<AWSSCostData>('/api/aws/costs')
  const { data: configRaw } = useApi<ConfigData>('/api/config')
  const { data: sessionsRaw } = useApi<{ sessions: SessionData[] }>('/api/sessions')
  const { data: codexbarRaw } = useApi<CodexBarCostData & { error?: string }>(codexbarQueryPath(activeMonthAnchor, calendarNow))
  const { data: monthAvailability } = useApi<MonthAvailabilityResponse>('/api/costs/months')

  const config: ConfigData = configRaw ?? { modules: {} }
  const sessions: SessionData[] = useMemo(() => sessionsRaw?.sessions ?? [], [sessionsRaw])
  const codexbarCosts: CodexBarCostData | null =
    codexbarRaw && !codexbarRaw.error ? (codexbarRaw as CodexBarCostData) : null

  // ---- Costs query with stale-retry ----
  const costsQuery = useQuery<TokenData, Error>({
    queryKey: ['api', costsPath],
    queryFn: () => fetchJson<TokenData>(costsPath),
    refetchInterval: (query) => {
      const decision = nextStaleRetry(
        query.state.data as CostsTokenData | undefined,
        { period, anchor: activeMonthAnchor },
        staleCostsRetry.current,
        Date.now(),
      )
      staleCostsRetry.current = decision.state
      return decision.interval
    },
    refetchOnWindowFocus: false,
  })

  const tokenData: TokenData | null = costsQuery.data ?? null
  // The server's own calendar month: it normalizes anchors against its clock, so
  // past-vs-current classification must follow it, not the browser's time zone.
  const payloadServerMonth = (costsQuery.data as (TokenData & { serverMonth?: string }) | undefined)?.serverMonth ?? null
  // A query-key transition (uncached anchored month) momentarily has no data;
  // collapsing to the browser clock here lets the anchor-clearing effect wipe
  // a just-selected month at a timezone boundary. Retain the last known server
  // month across transitions (render-phase sentinel, same style as
  // the budget init below).
  if (payloadServerMonth && payloadServerMonth !== lastServerMonth) {
    setLastServerMonth(payloadServerMonth)
  }
  const serverMonth = payloadServerMonth ?? lastServerMonth
  const currentServerMonth = currentMonthKey(calendarNow, serverMonth)

  // A server-calendar rollover can turn a formerly anchored month into the
  // live view. Clear it so React Query resumes using the unanchored cache key.
  useEffect(() => {
    if (!shouldClearMonthAnchor(monthAnchor, currentServerMonth)) return undefined
    const clearAnchorTimer = window.setTimeout(() => setMonthAnchor(null), 0)
    return () => window.clearTimeout(clearAnchorTimer)
  }, [currentServerMonth, monthAnchor])
  // Classified by the SERVER's month, so a browser in another time zone cannot
  // label a live month-to-date payload as a completed month (or the reverse).
  // Falls back to the browser clock only before the first payload arrives.
  const viewingPastMonth = isPastMonthAnchor(activeMonthAnchor, calendarNow, serverMonth)
  const loading = costsQuery.isLoading
  const error: string | null = costsQuery.error ? String(costsQuery.error.message || 'Unknown error') : null

  // ---- budget / budgetInput — initialized once when tokenData first arrives ----
  // Using render-phase sentinel pattern (same as Calendar.tsx formKey) to avoid
  // setState-in-effect which is an ESLint error in this repo.
  const [budgetSeenKey, setBudgetSeenKey] = useState<string | undefined>(undefined)
  const [budget, setBudget] = useState<number>(0)
  const [budgetInput, setBudgetInput] = useState<string>('')

  const budgetFromData = tokenData?.budget?.monthly ?? 0
  // Derive a stable key from whether we have data yet
  const budgetDataKey = tokenData ? 'loaded' : undefined
  if (budgetDataKey !== undefined && budgetDataKey !== budgetSeenKey) {
    setBudgetSeenKey(budgetDataKey)
    setBudget(budgetFromData)
    setBudgetInput(budgetFromData.toString())
  }

  // ---- saveBudget mutation ----
  const saveBudgetMutation = useMutation({
    mutationFn: (monthly: number) =>
      fetchJson('/api/settings/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly }),
      }),
    onSuccess: (_data, monthly) => {
      setBudget(monthly)
      void queryClient.invalidateQueries({ queryKey: ['api', costsPath] })
      toast.show('success', 'Budget saved')
    },
    onError: () => {
      toast.show('error', 'Budget could not be saved')
    },
  })

  const savingBudget = saveBudgetMutation.isPending
  const budgetValidation = parseMonthlyBudgetInput(budgetInput)
  const budgetError = budgetValidation.error
  const canSaveBudget = !savingBudget && !!budgetInput.trim() && !budgetError

  const saveBudget = () => {
    if (budgetValidation.monthly === null) return
    saveBudgetMutation.mutate(budgetValidation.monthly)
  }

  // A finished month is not projected — it is simply totalled.
  const anchoredMonthLabel = activeMonthAnchor ? monthKeyLabel(activeMonthAnchor) : null

  const ledgerActive = !!(tokenData && ['token-usage.csv', 'openclaw.usage', 'combined.agent_usage'].includes(tokenData.source || '') && tokenData.summary)
  const unknownBillingSourceCount = (tokenData?.byService || []).filter(item => (
    Number(item.tokens || 0) > 0 && String(item.costSource || '').toLowerCase() === 'unknown'
  )).length
  const codexbarDailyRows = codexbarCosts?.daily
  const codexbarPeriodDays = useMemo(() => {
    if (!codexbarDailyRows?.length) return []
    return codexbarRowsForPeriod(
      codexbarDailyRows,
      period,
      calendarNow,
      activeMonthAnchor,
      serverMonth,
    )
  }, [activeMonthAnchor, calendarNow, codexbarDailyRows, period, serverMonth])
  // A live 30-day summary of $0 must not suppress an anchored month that has
  // usage: codexbar activity follows the selected period's rows too.
  const codexbarActive = !!(codexbarCosts && (
    codexbarCosts.last30DaysCostUSD > 0 ||
    codexbarPeriodDays.some(day => Number(day.totalCost || 0) > 0 || Number(day.totalTokens || 0) > 0)
  ))
  const codexbarPreviousPeriodDays = useMemo(() => {
    return previousCodexbarRows(codexbarCosts?.daily || [], period, calendarNow, activeMonthAnchor, serverMonth)
  }, [activeMonthAnchor, calendarNow, codexbarCosts?.daily, period, serverMonth])

  const rankedSeries = useMemo<ChartSeriesItem[]>(() => {
    const totals = new Map<string, { totalCost: number; totalTokens: number }>()

    if (ledgerActive && tokenData?.dailyByModel?.length) {
      tokenData.dailyByModel.forEach(day => {
        Object.keys(day).forEach(key => {
          if (!isModelColumnKey(key)) return
          const cost = readNumericField(day, `${key}_apiEquivalentUsd`)
          const tokens = readNumericField(day, `${key}_tokens`)
          const current = totals.get(key) || { totalCost: 0, totalTokens: 0 }
          current.totalCost += cost
          current.totalTokens += tokens
          totals.set(key, current)
        })
      })
    } else if (codexbarActive && codexbarPeriodDays.length) {
      codexbarPeriodDays.forEach(day => {
        ;(day.models || []).forEach(model => {
          const name = model.model || 'Unknown model'
          const current = totals.get(name) || { totalCost: 0, totalTokens: 0 }
          current.totalCost += Number(model.cost || 0)
          current.totalTokens += Number(model.totalTokens || 0)
          totals.set(name, current)
        })
      })
    } else {
      return []
    }

    const sorted = Array.from(totals.entries())
      .map(([model, values], index) => ({
        model,
        key: toChartKey(index),
        color: '',
        totalCost: values.totalCost,
        totalTokens: values.totalTokens,
      }))
      .filter(item => item.totalCost > 0 || item.totalTokens > 0)
      .sort((a, b) => b.totalCost - a.totalCost || b.totalTokens - a.totalTokens)

    const visible = sorted.length > 6 ? sorted.slice(0, 5) : sorted
    const omitted = sorted.length > 6 ? sorted.slice(5) : []
    const withOther = omitted.length
      ? [
          ...visible,
          {
            model: 'Other models',
            key: toChartKey(visible.length),
            color: '',
            totalCost: omitted.reduce((sum, item) => sum + item.totalCost, 0),
            totalTokens: omitted.reduce((sum, item) => sum + item.totalTokens, 0),
            rawModels: omitted.map(item => item.model),
          },
        ]
      : visible

    return withOther.map((item, index) => ({ ...item, key: toChartKey(index) }))
  }, [codexbarActive, codexbarPeriodDays, ledgerActive, tokenData])

  // Models keep their `--series-*` token while they stay active: period changes
  // and replacement data that is still loading must not reshuffle the colours.
  // The sixth token is reserved for "Other models" whenever that bucket exists.
  const seriesColorSlots = rankedSeries.some(item => item.rawModels) ? SERIES_COLOR_COUNT - 1 : SERIES_COLOR_COUNT
  const seriesColorKey = JSON.stringify([
    seriesColorSlots,
    Array.from(new Set(rankedSeries.filter(item => !item.rawModels).map(item => modelColorKey(item.model)).filter(Boolean))).sort(),
  ])
  const [seriesColorState, setSeriesColorState] = useState<{
    activeKey: string
    assignments: ReadonlyMap<string, string>
  }>(() => ({ activeKey: '', assignments: new Map() }))
  const seriesColors = useMemo(() => (
    seriesColorState.activeKey === seriesColorKey
      ? seriesColorState.assignments
      : assignSeriesColors(
          rankedSeries.filter(item => !item.rawModels).map(item => item.model),
          seriesColorState.assignments,
          seriesColorSlots,
        )
  ), [rankedSeries, seriesColorKey, seriesColorSlots, seriesColorState])
  const seriesColorsRefreshing =
    costsQuery.isPending ||
    tokenData?.source === 'sessions.fast_fallback' ||
    !!tokenData?.meta?.refreshing
  // Provisional data (loading, fast fallback, refresh in flight) is coloured
  // but not remembered, so the settled data finds the earlier assignments.
  if (!seriesColorsRefreshing && seriesColorState.activeKey !== seriesColorKey) {
    setSeriesColorState({ activeKey: seriesColorKey, assignments: seriesColors })
  }

  const chartSeries = useMemo<ChartSeriesItem[]>(() => rankedSeries.map(item => ({
    ...item,
    color: item.rawModels
      ? seriesColorToken(SERIES_COLOR_COUNT - 1)
      : seriesColors.get(modelColorKey(item.model)) ?? seriesColorToken(0),
  })), [rankedSeries, seriesColors])

  const chartData = useMemo<ChartDataRow[]>(() => {
    if (!chartSeries.length) return []

    if (!ledgerActive || !tokenData?.dailyByModel?.length) {
      return codexbarActive && codexbarPeriodDays.length
        ? buildCodexbarChartData(codexbarPeriodDays, chartSeries)
        : []
    }

    const rows = tokenData.dailyByModel.map(day => {
      const row: Record<string, string | number> = {
        day: new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' }),
        fullDate: day.date,
        total: Number(day.apiEquivalentCost || 0),
        totalTokens: Number(day.totalTokens || 0),
      }

      chartSeries.forEach(series => {
        const modelNames = series.rawModels?.length ? series.rawModels : [series.model]
        const value = modelNames.reduce((sum, model) => sum + readNumericField(day, `${model}_apiEquivalentUsd`), 0)
        const tokens = modelNames.reduce((sum, model) => sum + readNumericField(day, `${model}_tokens`), 0)
        row[series.key] = value
        row[`${series.key}__tokens`] = tokens
      })

      return row as ChartDataRow
    })

    return rows
  }, [chartSeries, codexbarActive, codexbarPeriodDays, ledgerActive, tokenData])

  const hasChartBars = chartData.some(row => Number(row.total || 0) > 0)

  const sessionEstimateData = useMemo(() => {
    if (tokenData?.source !== 'sessions.fallback' || !tokenData.daily?.length) return []

    const mapped = tokenData.daily.map(day => ({
      day: new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' }),
      fullDate: day.date,
      tokens: Number(day.tokens || 0),
      estimatedCost: null,
      intensity: 0,
    }))

    const maxTokens = Math.max(...mapped.map(day => day.tokens), 1)
    return mapped.map(day => ({
      ...day,
      intensity: maxTokens > 0 ? day.tokens / maxTokens : 0,
    }))
  }, [tokenData])

  const hasSessionEstimateChart = sessionEstimateData.some(day => day.tokens > 0)

  useEffect(() => {
    let cancelled = false
    const nextPool = chartData.length > 0 ? chartData : sessionEstimateData
    const timer = window.setTimeout(() => {
      if (cancelled) return
      if (!nextPool.length) {
        setActiveChartDate(null)
        return
      }

      setActiveChartDate(current => resolveActiveChartDate(nextPool, current, requestedChartDate).date)
      if (requestedChartDate && nextPool.some(day => day.fullDate === requestedChartDate)) {
        setRequestedChartDate(null)
        // The clicked day is now live in the chart — bring it into view.
        dailySpendRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [chartData, requestedChartDate, sessionEstimateData])

  // Per-day usage of the month in view, for the calendar day grid's heat scale.
  // Mirrors the chart's own source order: ledger rows, then codexbar, then the
  // session-token fallback (tokens only — no priced cost exists there).
  const dayUsage = useMemo<DayUsageEntry[]>(() => {
    if (chartData.length > 0) {
      return chartData.map(row => ({
        date: String(row.fullDate),
        cost: Number(row.total || 0),
        tokens: Number(row.totalTokens || 0),
      }))
    }
    if (codexbarActive && codexbarPeriodDays.length > 0) {
      return codexbarPeriodDays.map(day => ({
        date: day.date,
        cost: Number(day.totalCost || 0),
        tokens: Number(day.totalTokens || 0),
      }))
    }
    return sessionEstimateData.map(day => ({ date: day.fullDate, cost: 0, tokens: day.tokens }))
  }, [chartData, codexbarActive, codexbarPeriodDays, sessionEstimateData])

  // Direct chart interaction supersedes any still-pending calendar request.
  const selectChartDate = (date: string) => {
    setRequestedChartDate(null)
    setActiveChartDate(date)
  }

  const handlePickDay = (date: string) => {
    const monthKey = date.slice(0, 7)
    setMonthAnchor(monthKey === currentServerMonth ? null : monthKey)
    setRequestedChartDate(date)
  }

  // Navigation NOT initiated by a calendar-day click abandons any pending day
  // request — otherwise a request whose month loaded empty would linger and
  // hijack the selection on a later visit to that month.
  const navigateMonthAnchor = (anchor: string | null) => {
    setRequestedChartDate(null)
    setMonthAnchor(anchor)
  }
  const navigatePeriod = (next: 'day' | '7d' | 'month') => {
    setRequestedChartDate(null)
    setPeriod(next)
  }

  const allTokenBreakdown = useMemo<AggregatedBreakdownItem[]>(() => {
    const buckets = new Map<string, Omit<AggregatedBreakdownItem, 'share'> & { rawNamesSet: Set<string> }>()

    const addBucket = (
      rawName: string,
      tokens: number,
      cost: number,
      apiEquivalentCost: number | null | undefined,
      apiEquivalentAvailable: boolean,
    ) => {
      if (tokens <= 0 && cost <= 0) return
      const name = canonicalModelName(rawName)
      const current = buckets.get(name) || {
        name,
        rawNames: [],
        rawNamesSet: new Set<string>(),
        tokens: 0,
        cost: 0,
        apiEquivalentCost: 0,
        apiEquivalentAvailable: false,
        local: false,
      }

      current.tokens += Number.isFinite(tokens) ? tokens : 0
      current.cost += Number.isFinite(cost) ? cost : 0
      if (apiEquivalentAvailable && apiEquivalentCost !== null && apiEquivalentCost !== undefined && Number.isFinite(apiEquivalentCost)) {
        current.apiEquivalentCost += apiEquivalentCost
        current.apiEquivalentAvailable = true
      }
      current.local = current.local || isLocalModel(rawName)
      if (rawName) current.rawNamesSet.add(rawName)
      buckets.set(name, current)
    }

    if (ledgerActive && tokenData?.byService?.length) {
      tokenData.byService.forEach(item => {
        addBucket(
          item.name,
          item.tokens || 0,
          item.cost || 0,
          item.apiEquivalentUsd,
          item.apiEquivalentStatus !== 'unavailable' && item.apiEquivalentStatus !== 'not_applicable',
        )
      })
    } else if (viewingPastMonth) {
      // The anchored ledger has not landed yet (fast fallback / refresh). Live
      // sessions are NOT that month's models — the anchored codexbar rows are
      // the only historical source; an empty result is the honest answer.
      codexbarPeriodDays.forEach(day => {
        ;(day.models || []).forEach(model => {
          addBucket(
            model.model || 'Unknown',
            model.totalTokens || 0,
            model.cost || 0,
            model.cost || 0,
            !isLocalModel(model.model || ''),
          )
        })
      })
    } else {
      // Live sessions carry tokens only: no price is invented for them, so the
      // model table shows "—" instead of a spend figure.
      sessions.forEach(session => {
        addBucket(
          session.model || session.displayName || 'Unknown',
          session.totalTokens || 0,
          0,
          null,
          false,
        )
      })
    }

    const items = Array.from(buckets.values()).map(item => ({
      name: item.name,
      rawNames: Array.from(item.rawNamesSet),
      tokens: item.tokens,
      cost: item.cost,
      apiEquivalentCost: item.apiEquivalentCost,
      apiEquivalentAvailable: item.apiEquivalentAvailable,
      local: item.local,
      share: 0,
    }))

    const total = items.reduce((sum, item) => sum + item.tokens, 0)
    return items
      .map(item => ({
        ...item,
        share: total > 0 ? (item.tokens / total) * 100 : 0,
      }))
      .sort((a, b) => (
        (b.apiEquivalentAvailable ? b.apiEquivalentCost : 0) - (a.apiEquivalentAvailable ? a.apiEquivalentCost : 0)
        || b.tokens - a.tokens
      ))
  }, [codexbarPeriodDays, ledgerActive, sessions, viewingPastMonth, tokenData])

  // Live sessions are the fallback ONLY for the live view. On an anchored month
  // (including while the ledger is still pending) the anchored codexbar rows are
  // the only valid source — otherwise the token count reports today's usage
  // under a historical label.
  const totalTokens = ledgerActive
    ? tokenData?.summary?.periodTokens ?? tokenData?.summary?.thisMonthTokens ?? tokenData?.summary?.totalTokens ?? 0
    : viewingPastMonth
      ? codexbarPeriodDays.reduce((sum, day) => sum + (day.totalTokens || 0), 0)
      : sessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0)

  const isAwsEnabled = awsIntegrationEnabled(config)
  // /api/aws/costs always reports the CURRENT month; while an anchored past
  // month is displayed, AWS live billing must not be relabeled as that month —
  // the anchored ledger sources drive every metric instead.
  const hasAwsData = awsBillingDataAvailable(isAwsEnabled, awsCosts) && !viewingPastMonth
  const trackedSpend = trackedSpendPresentation({
    reliability: ledgerActive ? tokenData?.costReliability : undefined,
    unknownSourceCount: unknownBillingSourceCount,
    selectedSourceIsComplete: hasAwsData,
  })

  const periodName = viewingPastMonth && anchoredMonthLabel
    ? anchoredMonthLabel
    : period === 'day'
      ? 'Today'
      : period === '7d'
        ? 'Last 7 days'
        : 'This month'
  const loadedCostsPeriodKey = tokenData?.period?.key
  const loadedCostsAnchor = tokenData?.period?.anchor || null
  // A payload for a different month is just as pending as one for a different period —
  // otherwise the previous month's agent split lingers while the new one loads.
  const costsPeriodPending = !!loadedCostsPeriodKey && (
    loadedCostsPeriodKey !== period
    || (period === 'month' && loadedCostsAnchor !== activeMonthAnchor)
  )
  const hasUsableAgentSplit = !costsPeriodPending && hasUsableAgentSplitData(tokenData)
  const agentSplitRefreshing = !!tokenData?.meta?.refreshing && !hasUsableAgentSplit
  const agentSplitPending = costsPeriodPending || agentSplitRefreshing
  const codexbarPeriodCost = sumCostRows(codexbarPeriodDays)
  const codexbarPeriodTokens = codexbarPeriodDays.reduce((sum, day) => sum + (day.totalTokens || 0), 0)

  const currentPeriodCost = hasAwsData
      ? awsCosts?.total || 0
      : ledgerActive
        ? (tokenData?.summary?.periodUsd ?? tokenData?.summary?.thisMonthUsd) || 0
        : 0
  const trackedValueAvailable = hasAwsData || ledgerActive

  const apiEquivalentReliability = ledgerActive
    ? tokenData?.apiEquivalentReliability || 'unavailable'
    : codexbarActive
      ? 'estimated'
      : 'unavailable'
  const previousApiEquivalentReliability = ledgerActive
    ? tokenData?.summary?.previousPeriodApiEquivalentReliability || 'unavailable'
    : codexbarActive
      ? 'estimated'
      : 'unavailable'
  const apiEquivalentPeriodCost = ledgerActive
    ? apiEquivalentPeriodValue({
      reliability: apiEquivalentReliability,
      periodValue: tokenData?.summary?.periodApiEquivalentUsd,
      fallbackValue: tokenData?.summary?.apiEquivalentUsd,
    })
    : codexbarActive
      ? codexbarPeriodCost
      : null
  const previousApiEquivalentPeriodCost = ledgerActive
    ? tokenData?.summary?.previousPeriodApiEquivalentUsd ?? null
    : codexbarActive
      ? sumCostRows(codexbarPreviousPeriodDays)
      : null

  const trackedDays = hasAwsData ? awsCosts?.daily || [] : tokenData?.daily || []
  const apiEquivalentDays = ledgerActive
    ? tokenData?.daily || []
    : codexbarActive
      ? codexbarPeriodDays
      : trackedDays
  // A complete past month always divides by its real length, even if a fast fallback
  // payload briefly delivers fewer rows than the month has days.
  const trackedDayCount = viewingPastMonth && activeMonthAnchor
    ? daysInMonthKey(activeMonthAnchor)
    : Math.max(trackedDays.length, 1)
  const dailyAvg = hasAwsData
      ? (awsCosts?.daily || []).reduce((sum, d) => sum + (d.cost || 0), 0) / Math.max(awsCosts?.daily?.length || 0, 1)
      : ledgerActive
        ? currentPeriodCost / Math.max(trackedDayCount, 1)
        : 0

  const apiEquivalentMetrics = apiEquivalentMetricValues({
    periodCost: apiEquivalentPeriodCost,
    previousPeriodCost: previousApiEquivalentPeriodCost,
    dayCount: viewingPastMonth && activeMonthAnchor ? daysInMonthKey(activeMonthAnchor) : apiEquivalentDays.length,
    // The anchored baseline is the FULL previous calendar month; codexbar rows
    // may be absent (codexbar inactive) while the ledger still supplies the
    // baseline total — an empty row set must not collapse the divisor to 1 day.
    previousDayCount: viewingPastMonth && activeMonthAnchor
      ? daysInMonthKey(previousMonthKey(activeMonthAnchor))
      : codexbarPreviousPeriodDays.length,
    reliability: apiEquivalentReliability,
    previousReliability: previousApiEquivalentReliability,
    completePeriod: viewingPastMonth,
  })

  const compareLabel = comparisonLabels(period, activeMonthAnchor, calendarNow)

  // For a finished month the "projection" IS the month total — never extrapolate it.
  const projectedMonthly = viewingPastMonth ? currentPeriodCost : dailyAvg * 30
  const metricMode = hasAwsData ? 'tracked' : 'api-equivalent'
  const metricPeriodCost = hasAwsData ? currentPeriodCost : apiEquivalentMetrics.periodCost
  const metricDailyAverage = hasAwsData ? dailyAvg : apiEquivalentMetrics.dailyAverage
  const metricProjectedMonthly = hasAwsData ? projectedMonthly : apiEquivalentMetrics.projectedMonthly
  const metricPreviousPeriodCost = hasAwsData ? null : apiEquivalentMetrics.previousPeriodCost
  const metricPeriodTrend = metricPeriodCost !== null && metricPreviousPeriodCost !== null
    ? calculateTrend(metricPeriodCost, metricPreviousPeriodCost)
    : null
  const apiEquivalentDisplayReliability = apiEquivalentReliability === 'partial' || previousApiEquivalentReliability === 'partial'
    ? 'partial'
    : apiEquivalentReliability
  const chartDayCount = chartData.length || apiEquivalentDays.length
  const periodTokens = ledgerActive ? totalTokens : codexbarPeriodTokens
  const monthlyBudgetBase = budgetSpendValue({
    hasAwsData,
    awsTotal: awsCosts?.total ?? null,
    ledgerActive,
    ledgerMonthSpend: tokenData?.summary?.thisMonthUsd ?? null,
    trackedSpendComplete: trackedSpend.projectionAvailable && trackedValueAvailable,
  })
  const budgetUsage = budget > 0 && monthlyBudgetBase !== null ? monthlyBudgetBase / budget : null
  const budgetUsagePct = budgetUsage === null ? null : Math.round(budgetUsage * 100)
  const budgetRemaining = budget > 0 && monthlyBudgetBase !== null ? budget - monthlyBudgetBase : null

  const creditsUsed = hasAwsData && awsCosts ? awsCosts.credits - awsCosts.remaining : 0
  const burnRate = hasAwsData && awsCosts && creditsUsed > 0
    ? awsCosts.remaining / (creditsUsed / Math.max(awsCosts.daily.length, 1))
    : Infinity

  const topSessions = sessions
    .filter(s => s.totalTokens > 0)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5)
    .map(s => ({
      sessionId: s.key,
      sessionName: formatSessionName(s.key, s.displayName),
      model: canonicalModelName(s.model || s.displayName || 'Unknown'),
      tokens: s.totalTokens,
      timestamp: s.updatedAt ? new Date(s.updatedAt).getTime() / 1000 : null,
      channel: s.key.split(':')[0] || 'session',
    }))

  const apiEquivalentBreakdownTotal = allTokenBreakdown.reduce((sum, item) => sum + (item.apiEquivalentAvailable ? item.apiEquivalentCost : 0), 0)
  const awsServices = hasAwsData && awsCosts
    ? awsCosts.services.map(service => ({
        name: service.name,
        cost: service.cost,
        share: awsCosts.total > 0 ? (service.cost / awsCosts.total) * 100 : 0,
      }))
    : null

  const agentSplit = agentSplitPending ? [] : (tokenData?.agents || []).map(agent => {
    const prefix = `${agent.label} / `
    const modelTotals = new Map<string, {
      name: string
      tokens: number
      cost: number
      apiEquivalentCost: number
      apiEquivalentAvailable: boolean
      costSource?: string
    }>()

    ;(tokenData?.dailyByModel || []).forEach(day => {
      Object.keys(day).forEach(key => {
        if (!key.startsWith(prefix) || isModelMetricKey(key)) return
        const rawTokens = Number(day[`${key}_tokens`] || 0)
        const rawCost = Number(day[key] || 0)
        const rawApiEquivalent = day[`${key}_apiEquivalentUsd`]
        const rawApiEquivalentStatus = String(day[`${key}_apiEquivalentStatus`] || '')
        // 'partial' rows are priced too (default-tier / blended estimates for
        // models without an exact rate card), so they count toward the agent's
        // API-equivalent total instead of hiding it behind N/A.
        const apiEquivalentPriced = rawApiEquivalentStatus === 'estimated' || rawApiEquivalentStatus === 'partial'
        const current = modelTotals.get(key) || {
          name: key,
          tokens: 0,
          cost: 0,
          apiEquivalentCost: 0,
          apiEquivalentAvailable: false,
          costSource: String(day[`${key}_costSource`] || ''),
        }
        current.tokens += Number.isFinite(rawTokens) ? rawTokens : 0
        current.cost += Number.isFinite(rawCost) ? rawCost : 0
        if (apiEquivalentPriced && rawApiEquivalent !== null && rawApiEquivalent !== undefined && Number.isFinite(Number(rawApiEquivalent))) {
          current.apiEquivalentCost += Number(rawApiEquivalent)
          current.apiEquivalentAvailable = true
        }
        current.costSource = current.costSource || String(day[`${key}_costSource`] || '')
        modelTotals.set(key, current)
      })
    })

    const periodModels = Array.from(modelTotals.values()).filter(model => model.tokens > 0 || model.cost > 0)
    const periodTokens = periodModels.reduce((sum, model) => sum + model.tokens, 0)
    const periodCost = periodModels.reduce((sum, model) => sum + model.cost, 0)
    const periodApiEquivalentCost = periodModels.reduce((sum, model) => sum + model.apiEquivalentCost, 0)
    const periodApiEquivalentAvailable = periodModels.some(model => model.apiEquivalentAvailable)
    const tokens = periodModels.length > 0
      ? periodTokens
      : Number(agent.summary?.periodTokens ?? agent.summary?.thisMonthTokens ?? agent.summary?.totalTokens ?? 0)
    const cost = periodModels.length > 0
      ? periodCost
      : Number(agent.summary?.periodUsd ?? agent.summary?.thisMonthUsd ?? agent.summary?.totalUsd ?? 0)
    const topModel = periodModels
      .slice()
      .sort((a, b) => Number(b.tokens || 0) - Number(a.tokens || 0))[0]
      || (agent.byService || []).slice().sort((a, b) => Number(b.tokens || 0) - Number(a.tokens || 0))[0]
    const billingSummary = summarizeCostReliability(
      periodModels.length > 0 ? periodModels : (agent.byService || []),
    )

    return {
      ...agent,
      tokens,
      cost,
      costLabel: billingSummary.label,
      meteredCost: billingSummary.meteredCost,
      estimatedCost: billingSummary.estimatedCost,
      apiEquivalentCost: periodModels.length > 0
        ? periodApiEquivalentCost
        : Number(agent.summary?.periodApiEquivalentUsd ?? agent.summary?.apiEquivalentUsd ?? 0),
      apiEquivalentAvailable: periodModels.length > 0
        ? periodApiEquivalentAvailable
        : (agent.byService || []).some(service =>
            service.apiEquivalentStatus === 'estimated' || service.apiEquivalentStatus === 'partial'),
      topModel: topModel?.name
        ?.replace(/^OpenClaw \/ /, '')
        .replace(/^Codex App Sessions \/ /, '')
        .replace(/^Codex CLI \/ /, '')
        .replace(/^Hermes \/ /, '')
        .replace(/^Claude Code \/ /, '') || 'No model data',
    }
  })
  const totalAgentTokens = agentSplit.reduce((sum, agent) => sum + agent.tokens, 0)

  // One note for every source that is missing, old or still loading.
  const unavailableSources = ([
    ['OpenClaw', tokenData?.meta?.openclawStatus],
    ['Hermes', tokenData?.meta?.hermesStatus],
    ['Claude Code', tokenData?.meta?.claudeCodeStatus],
  ] as const).filter(([, status]) => status === 'unavailable').map(([name]) => name)
  const sourceIssues: string[] = []
  if (unavailableSources.length > 0) {
    sourceIssues.push(`${unavailableSources.join(', ')} could not be read, so totals may be low.`)
  }
  if (tokenData?.meta?.stale) {
    sourceIssues.push('Showing the last good reading; the latest scan did not complete.')
  }
  if (codexbarCosts?.stale) {
    sourceIssues.push(`The CodexBar estimate comes from a scan ${Math.round((codexbarCosts.staleAgeMs || 0) / 60000)} min old because a fresh scan failed.`)
  }
  const sourceIssuesAreWarnings = sourceIssues.length > 0
  if (tokenData?.meta?.refreshing) sourceIssues.push('Still refreshing; figures may change.')
  const sourceIssueTone: UiState | 'info' = sourceIssuesAreWarnings ? 'warning' : 'info'

  const trackedNote = trackedSpend.coverageLabel
    ? `Partial · ${trackedSpend.coverageLabel}`
    : trackedSpend.valueQualifier

  const controls = (
    <PeriodControls
      period={period}
      setPeriod={navigatePeriod}
      monthAnchor={monthAnchor}
      setMonthAnchor={navigateMonthAnchor}
      calendarNow={calendarNow}
      serverMonth={serverMonth}
      monthAvailability={monthAvailability?.months ?? []}
      monthAvailabilityKnown={Boolean(monthAvailability)}
      dayUsage={dayUsage}
      activeChartDate={activeChartDate}
      onSelectDay={handlePickDay}
    />
  )

  let content
  if (loading) {
    content = (
      <>
        <Skeleton variant="block" label="Loading usage" />
        <Skeleton variant="block" size="lg" label="Loading daily usage" />
      </>
    )
  } else if (error || (!awsCosts && !tokenData)) {
    content = (
      <ErrorState
        title="Usage could not be read"
        message={error ?? 'No usage data was returned.'}
        onRetry={() => { void costsQuery.refetch() }}
      />
    )
  } else {
    content = (
      <>
        <UsageSummary
          mode={metricMode}
          periodName={periodName}
          periodCost={metricPeriodCost}
          previousPeriodCost={metricPreviousPeriodCost}
          trend={metricPeriodTrend}
          compareLabel={compareLabel.period}
          dailyPace={metricDailyAverage}
          projection={metricProjectedMonthly}
          completePeriod={viewingPastMonth}
          trackedSpend={trackedValueAvailable ? currentPeriodCost : null}
          trackedNote={trackedNote}
          periodTokens={periodTokens}
          reliability={apiEquivalentDisplayReliability}
          sourceIssues={sourceIssues}
          sourceIssueTone={sourceIssueTone}
        />

        <div className={costsStyles.split}>
          <div ref={dailySpendRef} className={costsStyles.main}>
            <DailySpendSection
              chartData={chartData}
              chartSeries={chartSeries}
              hasChartBars={hasChartBars}
              activeChartDate={activeChartDate}
              setActiveChartDate={selectChartDate}
              chartDayCount={chartDayCount}
              codexbarActive={codexbarActive}
              ledgerActive={ledgerActive}
              hasAwsData={hasAwsData}
              awsCosts={awsCosts ?? null}
              hasSessionEstimateChart={hasSessionEstimateChart}
              sessionEstimateData={sessionEstimateData as SessionEstimateDay[]}
              totalTokens={totalTokens}
              apiEquivalentReliability={apiEquivalentReliability}
            />
          </div>
          <div className={costsStyles.side}>
            <BudgetPanel
              budget={budget}
              budgetInput={budgetInput}
              setBudgetInput={setBudgetInput}
              saveBudget={saveBudget}
              savingBudget={savingBudget}
              canSaveBudget={canSaveBudget}
              budgetError={budgetError}
              budgetUsage={budgetUsage}
              budgetUsagePct={budgetUsagePct}
              budgetRemaining={budgetRemaining}
              monthlyBudgetBase={monthlyBudgetBase}
              spendLabel={viewingPastMonth && anchoredMonthLabel ? `${anchoredMonthLabel} tracked spend` : 'Tracked spend this month'}
            />
            {isAwsEnabled && hasAwsData && awsCosts && (
              <AwsCreditsPanel
                awsCosts={awsCosts}
                creditsUsed={creditsUsed}
                burnRate={burnRate}
                dailyAvg={dailyAvg}
              />
            )}
          </div>
        </div>

        <CostDriversSection
          tab={driverTab}
          setTab={setDriverTab}
          models={allTokenBreakdown}
          modelApiEquivalentTotal={apiEquivalentBreakdownTotal}
          sources={agentSplit as AgentSplitItem[]}
          sourcesPending={agentSplitPending}
          totalSourceTokens={totalAgentTokens}
          sessions={topSessions}
          sessionsLiveOnlyNotice={viewingPastMonth && anchoredMonthLabel ? `Live sessions only: not scoped to ${anchoredMonthLabel}.` : null}
          awsServices={awsServices}
        />
      </>
    )
  }

  return (
    <Page title="Usage" description="What you spent and whether you are on track." actions={controls}>
      {content}
    </Page>
  )
}
