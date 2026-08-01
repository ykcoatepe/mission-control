import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useApi, fetchJson } from '../lib/hooks'
import {
  AlertCircle,
  Cloud,
  Cpu,
  Target,
  TrendingUp,
} from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
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
  formatCurrency,
  formatTokens,
  formatCompactTokenValue,
  formatSessionName,
  assignModelColors,
  assignedModelColor,
  getServiceColor,
  canonicalModelName,
  isLocalModel,
  toChartKey,
  estimateCost,
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
} from './costs/lib'
import CostPulseHeader from './costs/CostPulseHeader'
import AgentSplitCard from './costs/AgentSplitCard'
import type { AgentSplitItem } from './costs/AgentSplitCard'
import MetricCards from './costs/MetricCards'
import BudgetCard from './costs/BudgetCard'
import DailySpendSection from './costs/DailySpendSection'
import type { SessionEstimateDay, BlendedCostItem } from './costs/DailySpendSection'
import CostDriversSection from './costs/CostDriversSection'

const STALE_COSTS_RETRY_INTERVAL_MS = 2500
const STALE_COSTS_RETRY_LIMIT = 60
const STALE_COSTS_RETRY_TIMEOUT_MS = STALE_COSTS_RETRY_INTERVAL_MS * STALE_COSTS_RETRY_LIMIT
// A queued month can wait behind other scans for longer than the normal budget.
// While the server still reports work in flight for this exact key, giving up
// would strand a refresh that does land — but the wait stays bounded.
const ACTIVE_REFRESH_RETRY_TIMEOUT_MS = 10 * 60 * 1000
// serverMonth is authoritative but only refreshes with a costs payload; the
// server can cross a month boundary long before browser midnight, so the
// calendar metadata is revalidated on a fixed cadence too (cache-served, cheap).
const CALENDAR_METADATA_REVALIDATE_MS = 30 * 60 * 1000

type CostsTokenData = TokenData & {
  meta?: TokenData['meta'] & {
    preservedPreviousOpenClaw?: boolean
    preservedPreviousClaudeCode?: boolean
    preservedPreviousHermes?: boolean
    preservedPreviousUsage?: boolean
    refreshStartedAt?: string
  }
}


export default function Costs() {
  const m = useIsMobile()
  const queryClient = useQueryClient()
  const [period, setPeriod] = useState<'day' | '7d' | 'month'>('month')
  // `null` = the live current month. The anchor survives a trip through the Daily /
  // 7 Days tabs (it is simply not sent while those periods are active) and is
  // restored the moment Monthly comes back.
  const [monthAnchor, setMonthAnchor] = useState<string | null>(null)
  const [activeChartDate, setActiveChartDate] = useState<string | null>(null)
  const [driverView, setDriverView] = useState<'models' | 'sessions' | 'codexbar' | 'notes'>('models')
  const [fallbackSessionTimestamp] = useState(() => Date.now() / 1000)
  const [calendarNow, setCalendarNow] = useState(() => new Date())
  const staleCostsRetry = useRef<{ key: string; startedAt: number; settleResets: number } | null>(null)

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

  const config: ConfigData = configRaw ?? { modules: {} }
  const sessions: SessionData[] = useMemo(() => sessionsRaw?.sessions ?? [], [sessionsRaw])
  const codexbarCosts: CodexBarCostData | null =
    codexbarRaw && !codexbarRaw.error ? (codexbarRaw as CodexBarCostData) : null

  // ---- Costs query with stale-retry ----
  const costsQuery = useQuery<TokenData, Error>({
    queryKey: ['api', costsPath],
    queryFn: () => fetchJson<TokenData>(costsPath),
    refetchInterval: (query) => {
      const tokens = query.state.data as CostsTokenData | undefined
      const stale =
        tokens?.source === 'sessions.fast_fallback' ||
        // A pending anchored month: empty by design until the detailed
        // producers answer, so it must keep polling like the live fallback.
        tokens?.source === 'anchored.pending' ||
        tokens?.meta?.refreshing ||
        tokens?.meta?.stale
      if (!stale) {
        staleCostsRetry.current = null
        return false
      }

      // A preserved cache entry is worth settling on only when it actually holds
      // data. `anchored.pending` is empty by construction, so preserving it (all
      // producers failed on the first refresh) must NOT stop the polling —
      // otherwise the month stays at zero for the whole mounted session even
      // after the producers recover.
      // A configured producer that is still unavailable means the answer is not
      // final, no matter that some other slice was preserved. 'not_configured'
      // does NOT count — an absent optional integration will never recover.
      const producerStillUnavailable = [
        tokens?.meta?.openclawStatus,
        tokens?.meta?.hermesStatus,
        tokens?.meta?.claudeCodeStatus,
      ].includes('unavailable')
      const preservedFreshCache =
        tokens?.source !== 'anchored.pending' &&
        tokens?.meta?.stale &&
        !tokens.meta.refreshing &&
        !producerStillUnavailable &&
        (tokens.meta.preservedPreviousOpenClaw || tokens.meta.preservedPreviousClaudeCode || tokens.meta.preservedPreviousHermes || tokens.meta.preservedPreviousUsage)
      if (preservedFreshCache) {
        staleCostsRetry.current = null
        return false
      }

      // Keyed by the SELECTION, never by per-attempt refresh metadata: each
      // failed retry rewrites refreshStartedAt, which would reset the deadline
      // every time and let a permanently failing month poll — and relaunch the
      // expensive scans — forever. A changing source is real progress and does
      // legitimately restart the budget.
      const retryKey = [
        period,
        activeMonthAnchor || 'live',
        tokens?.source || 'unknown',
      ].join(':')
      const now = Date.now()
      if (staleCostsRetry.current?.key !== retryKey) {
        staleCostsRetry.current = { key: retryKey, startedAt: now, settleResets: 0 }
      }

      // `meta.refreshing` stays true while the refresh for this key is queued or
      // running, so the longer budget only applies while the server is actually
      // still working on it.
      const refreshing = tokens?.meta?.refreshing === true
      // A refresh that ran longer than the idle budget and then settled into a
      // partial result would otherwise flip to an ALREADY-EXPIRED deadline and
      // stop polling instantly. Grant the settled result one fresh idle window
      // — once per selection, so a permanently failing month cannot re-arm
      // itself forever (that eternal loop was fixed in an earlier round).
      if (!refreshing
        && staleCostsRetry.current.settleResets === 0
        && now - staleCostsRetry.current.startedAt >= STALE_COSTS_RETRY_TIMEOUT_MS) {
        staleCostsRetry.current = { key: retryKey, startedAt: now, settleResets: 1 }
      }
      const budget = refreshing
        ? ACTIVE_REFRESH_RETRY_TIMEOUT_MS
        : STALE_COSTS_RETRY_TIMEOUT_MS
      return now - staleCostsRetry.current.startedAt < budget
        ? STALE_COSTS_RETRY_INTERVAL_MS
        : false
    },
    refetchOnWindowFocus: false,
  })

  const tokenData: TokenData | null = costsQuery.data ?? null
  // The server's own calendar month: it normalizes anchors against its clock, so
  // past-vs-current classification must follow it, not the browser's time zone.
  const serverMonth = (costsQuery.data as (TokenData & { serverMonth?: string }) | undefined)?.serverMonth ?? null
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
  const labels = {
    thisMonth: viewingPastMonth && anchoredMonthLabel ? (m ? 'Month' : anchoredMonthLabel) : (m ? 'Month' : 'This Month'),
    creditsLeft: m ? 'Credits' : 'Credits Left',
    dailyAvg: m ? 'Tracked Avg' : 'Tracked Daily Average',
    projected: viewingPastMonth
      ? (m ? 'Tracked Total' : 'Tracked Month Total')
      : (m ? 'Tracked Proj.' : 'Projected Tracked Spend'),
  }

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
  const codexbarLatest = useMemo(() => {
    for (let index = codexbarPeriodDays.length - 1; index >= 0; index -= 1) {
      const row = codexbarPeriodDays[index]
      if ((row.models || []).length > 0 || Number(row.totalTokens || 0) > 0) return row
    }
    return null
  }, [codexbarPeriodDays])
  const codexbarPreviousPeriodDays = useMemo(() => {
    return previousCodexbarRows(codexbarCosts?.daily || [], period, calendarNow, activeMonthAnchor, serverMonth)
  }, [activeMonthAnchor, calendarNow, codexbarCosts?.daily, period, serverMonth])

  const activeModelNames = useMemo(() => {
    const names: string[] = []

    ;(tokenData?.dailyByModel || []).forEach(day => {
      Object.keys(day).forEach(key => {
        if (key === 'date' || key === 'models' || key === 'totalCost' || key === 'apiEquivalentCost' || key === 'totalTokens' || /_(tokens|input|output|reasoning|cacheRead|cacheWrite|costSource|apiEquivalentUsd|apiEquivalentStatus)$/.test(key)) return
        names.push(key)
      })
    })
    ;(tokenData?.byService || []).forEach(item => names.push(item.name))
    codexbarPeriodDays.forEach(day => {
      ;(day.models || []).forEach(model => names.push(model.model || 'Unknown model'))
    })
    sessions.forEach(session => names.push(session.model || session.displayName || 'Unknown'))

    return names
  }, [codexbarPeriodDays, sessions, tokenData])

  const activeModelKey = JSON.stringify(
    Array.from(new Set(activeModelNames.map(model => model.trim().toLowerCase()).filter(Boolean))).sort(),
  )
  const [modelColorState, setModelColorState] = useState<{
    activeKey: string
    assignments: ReadonlyMap<string, string>
  }>(() => ({ activeKey: '[]', assignments: new Map() }))
  let modelColors = modelColorState.assignments
  const modelColorsRefreshing =
    costsQuery.isPending ||
    tokenData?.source === 'sessions.fast_fallback' ||
    !!tokenData?.meta?.refreshing
  if (!modelColorsRefreshing && modelColorState.activeKey !== activeModelKey) {
    modelColors = assignModelColors(activeModelNames, modelColorState.assignments)
    setModelColorState({ activeKey: activeModelKey, assignments: modelColors })
  }

  const chartSeries = useMemo<ChartSeriesItem[]>(() => {
    const totals = new Map<string, { totalCost: number; totalTokens: number }>()

    if (ledgerActive && tokenData?.dailyByModel?.length) {
      tokenData.dailyByModel.forEach(day => {
        Object.keys(day).forEach(key => {
          if (key === 'date' || key === 'models' || key === 'totalCost' || key === 'apiEquivalentCost' || key === 'totalTokens' || /_(tokens|input|output|reasoning|cacheRead|cacheWrite|costSource|apiEquivalentUsd|apiEquivalentStatus)$/.test(key)) return
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
        color: assignedModelColor(modelColors, model),
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
            color: '#8E8E93',
            totalCost: omitted.reduce((sum, item) => sum + item.totalCost, 0),
            totalTokens: omitted.reduce((sum, item) => sum + item.totalTokens, 0),
            rawModels: omitted.map(item => item.model),
          },
        ]
      : visible

    return withOther.map((item, index) => ({ ...item, key: toChartKey(index) }))
  }, [codexbarActive, codexbarPeriodDays, ledgerActive, modelColors, tokenData])

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
  const useMobileDailyChart = m && hasChartBars

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

      setActiveChartDate(current => {
        if (current && nextPool.some(day => day.fullDate === current)) return current
        return nextPool[nextPool.length - 1]?.fullDate || null
      })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [chartData, sessionEstimateData])

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
        color: assignedModelColor(modelColors, rawName || name),
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
      sessions.forEach(session => {
        addBucket(
          session.model || session.displayName || 'Unknown',
          session.totalTokens || 0,
          estimateCost(session.totalTokens || 0, session.model),
          estimateCost(session.totalTokens || 0, session.model),
          !isLocalModel(session.model || ''),
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
      color: item.color,
      share: 0,
    }))

    const total = items.reduce((sum, item) => sum + item.tokens, 0)
    return items
      .map(item => ({
        ...item,
        share: total > 0 ? (item.tokens / total) * 100 : 0,
      }))
      .sort((a, b) => b.tokens - a.tokens)
  }, [codexbarPeriodDays, ledgerActive, modelColors, sessions, viewingPastMonth, tokenData])
  const tokenBreakdown = allTokenBreakdown.slice(0, 8)

  if (loading) {
    return (
      <PageTransition>
        <div className={costsStyles.loadingWrap}>
          <div className={costsStyles.spinner} />
        </div>
      </PageTransition>
    )
  }

  if (error || (!awsCosts && !tokenData)) {
    return (
      <PageTransition>
        <div className={costsStyles.errorWrap}>
          <AlertCircle size={48} className={costsStyles.errorIcon} />
          <p className={costsStyles.errorText}>Failed to load cost data</p>
        </div>
      </PageTransition>
    )
  }

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
  // Live sessions are the fallback ONLY for the live view. On an anchored month
  // (including while the ledger is still pending) the anchored codexbar rows are
  // the only valid source — otherwise the Token Volume pill reports today's
  // usage under a historical label.
  const totalTokens = ledgerActive
    ? tokenData?.summary?.periodTokens ?? tokenData?.summary?.thisMonthTokens ?? tokenData?.summary?.totalTokens ?? 0
    : viewingPastMonth
      ? codexbarPeriodDays.reduce((sum, day) => sum + (day.totalTokens || 0), 0)
      : sessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0)

  const periodLabels = { day: 'Daily', '7d': '7 Days', month: 'Monthly' } as const
  // On an anchored past month the badge/subtitle names the month itself ("July 2026")
  // instead of the generic "Monthly".
  const activePeriodLabel = viewingPastMonth && anchoredMonthLabel ? anchoredMonthLabel : periodLabels[period]
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
  const agentSplitPeriodLabel = isPastMonthAnchor(loadedCostsAnchor, calendarNow)
    ? monthKeyLabel(loadedCostsAnchor as string)
    : loadedCostsPeriodKey && loadedCostsPeriodKey in periodLabels
      ? periodLabels[loadedCostsPeriodKey as keyof typeof periodLabels]
      : activePeriodLabel
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
  const apiEquivalentDailyAvg = apiEquivalentMetrics.dailyAverage

  const previousPeriodCost = hasAwsData ? null : tokenData?.summary?.previousPeriodUsd ?? null
  const previousDailyAvg = hasAwsData ? null : tokenData?.summary?.yesterdayUsd ?? null
  const compareLabel = comparisonLabels(period, activeMonthAnchor, calendarNow)

  // For a finished month the "projection" IS the month total — never extrapolate it.
  const projectedMonthly = viewingPastMonth ? currentPeriodCost : dailyAvg * 30
  const apiEquivalentProjectedMonthly = apiEquivalentMetrics.projectedMonthly
  const metricMode = hasAwsData ? 'tracked' : 'api-equivalent'
  const metricPeriodCost = hasAwsData ? currentPeriodCost : apiEquivalentMetrics.periodCost
  const metricDailyAverage = hasAwsData ? dailyAvg : apiEquivalentMetrics.dailyAverage
  const metricProjectedMonthly = hasAwsData ? projectedMonthly : apiEquivalentMetrics.projectedMonthly
  const metricPreviousPeriodCost = hasAwsData ? previousPeriodCost : apiEquivalentMetrics.previousPeriodCost
  const metricPreviousDailyAverage = hasAwsData ? previousDailyAvg : apiEquivalentMetrics.previousDailyAverage
  const metricPeriodTrend = metricPeriodCost !== null && metricPreviousPeriodCost !== null
    ? calculateTrend(metricPeriodCost, metricPreviousPeriodCost)
    : null
  const metricDailyTrend = metricDailyAverage !== null && metricPreviousDailyAverage !== null
    ? calculateTrend(metricDailyAverage, metricPreviousDailyAverage)
    : null
  const apiEquivalentDisplayReliability = apiEquivalentReliability === 'partial' || previousApiEquivalentReliability === 'partial'
    ? 'partial'
    : apiEquivalentReliability
  const costSourceLabel = hasAwsData
    ? 'AWS live billing'
    : ledgerActive
        ? (tokenData.source === 'combined.agent_usage' ? 'OpenClaw + Hermes + Claude Code Usage' : tokenData.source === 'openclaw.usage' ? 'OpenClaw Usage' : 'Token ledger')
      : codexbarActive
        ? 'CodexBar local estimate'
        : 'No tracked billing source'
  const chartDayCount = chartData.length || apiEquivalentDays.length
  const apiEquivalentTokenVolume = ledgerActive ? totalTokens : codexbarPeriodTokens
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
  const budgetBadgeClass = budget <= 0
    ? 'macos-badge'
    : budgetUsage === null
      ? 'macos-badge-orange'
      : budgetUsage > 0.9
        ? 'macos-badge-red'
        : budgetUsage > 0.7
          ? 'macos-badge-orange'
          : 'macos-badge-green'

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
      cost: estimateCost(s.totalTokens, s.model),
      timestamp: s.updatedAt ? new Date(s.updatedAt).getTime() / 1000 : fallbackSessionTimestamp,
      color: assignedModelColor(modelColors, s.model || s.displayName || 'Unknown'),
      channel: s.key.split(':')[0] || 'session',
    }))

  const dominantModel = tokenBreakdown[0] || null
  const localTokenShare = allTokenBreakdown
    .filter(item => item.local)
    .reduce((sum, item) => sum + item.share, 0)
  const sessionPressureMax = Math.max(...topSessions.map(session => session.tokens), 1)
  const apiEquivalentBreakdownTotal = allTokenBreakdown.reduce((sum, item) => sum + (item.apiEquivalentAvailable ? item.apiEquivalentCost : 0), 0)
  const blendedCostBreakdown = hasAwsData && awsCosts
      ? awsCosts.services.slice(0, m ? 5 : 8).map(service => ({
        name: service.name,
        amount: service.cost,
        share: awsCosts.total > 0 ? (service.cost / awsCosts.total) * 100 : 0,
        color: getServiceColor(service.name),
        secondary: formatCurrency(service.cost),
      }))
      : allTokenBreakdown
        .slice()
        .sort((a, b) => b.apiEquivalentCost - a.apiEquivalentCost || b.tokens - a.tokens)
        .map(item => ({
        name: item.name,
        amount: item.apiEquivalentAvailable ? item.apiEquivalentCost : 0,
        share: item.apiEquivalentAvailable && apiEquivalentBreakdownTotal > 0 ? (item.apiEquivalentCost / apiEquivalentBreakdownTotal) * 100 : 0,
        color: item.color,
        secondary: `${formatTokens(item.tokens)} tokens`,
        local: item.local,
        }))

  const periodPhrase = viewingPastMonth && anchoredMonthLabel
    ? `in ${anchoredMonthLabel}`
    : `this ${activePeriodLabel.toLowerCase()}`

  const costSignals = [
    dominantModel
      ? {
          title: 'Dominant model',
          body: `${dominantModel.name} is carrying ${dominantModel.share.toFixed(1)}% of the token load ${periodPhrase}.`,
          accent: dominantModel.color,
          icon: Cpu,
        }
      : null,
    topSessions[0]
      ? {
          // Session rows are live-only; on a historical page the signal says so
          // rather than implying the anchored month produced them.
          title: viewingPastMonth ? 'Session pressure (live)' : 'Session pressure',
          body: `${topSessions[0].sessionName} is the heaviest session at ${formatTokens(topSessions[0].tokens)} tokens${viewingPastMonth ? ' right now — session history is not scoped to the selected month' : ''}.`,
          accent: topSessions[0].color,
          icon: TrendingUp,
        }
      : null,
    {
      title: 'Spend posture',
      body: budget > 0
        ? budgetUsagePct === null || budgetRemaining === null
          ? 'Monthly budget progress is unavailable while tracked billing coverage is incomplete.'
          : `${budgetUsagePct}% of the monthly cap is already used. ${formatCurrency(Math.max(budgetRemaining, 0))} remains.`
        : trackedSpend.projectionAvailable && trackedValueAvailable
          ? viewingPastMonth && anchoredMonthLabel
            ? `No budget cap set. ${anchoredMonthLabel} finished at ${formatCurrency(projectedMonthly)}.`
            : `No budget cap set. Current projected month is ${formatCurrency(projectedMonthly)}.`
          : 'No budget cap set. Tracked spend projection is unavailable while billing coverage is partial.',
      accent: budget > 0 && budgetUsage !== null && budgetUsage > 0.9 ? '#FF453A' : '#32D74B',
      icon: Target,
    },
    {
      title: 'Routing mix',
      body: localTokenShare > 0
        ? `${localTokenShare.toFixed(1)}% of tokens came from local models, which is helping cap cloud spend.`
        : 'Traffic is almost entirely cloud-routed right now; local models are not materially offsetting spend.',
      accent: localTokenShare > 15 ? '#32D74B' : '#007AFF',
      icon: Cloud,
    },
  ].filter(Boolean) as Array<{ title: string; body: string; accent: string; icon: typeof Cpu }>

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
        if (!key.startsWith(prefix) || /_(tokens|input|output|reasoning|cacheRead|cacheWrite|costSource|apiEquivalentUsd|apiEquivalentStatus)$/.test(key)) return
        const rawTokens = Number(day[`${key}_tokens`] || 0)
        const rawCost = Number(day[key] || 0)
        const rawApiEquivalent = day[`${key}_apiEquivalentUsd`]
        const rawApiEquivalentStatus = String(day[`${key}_apiEquivalentStatus`] || '')
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
        if (rawApiEquivalentStatus === 'estimated' && rawApiEquivalent !== null && rawApiEquivalent !== undefined && Number.isFinite(Number(rawApiEquivalent))) {
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
        : (agent.byService || []).some(service => service.apiEquivalentStatus === 'estimated'),
      topModel: topModel?.name
        ?.replace(/^OpenClaw \/ /, '')
        .replace(/^Hermes \/ /, '')
        .replace(/^Claude Code \/ /, '') || 'No model data',
    }
  })
  const totalAgentTokens = agentSplit.reduce((sum, agent) => sum + agent.tokens, 0)

  const overviewPills = [
    {
      label: 'Tracking Mode',
      value: ledgerActive ? 'Combined usage' : codexbarActive ? 'CodexBar' : costSourceLabel,
      accent: ledgerActive ? '#5E5CE6' : codexbarActive ? '#FF9500' : hasAwsData ? '#32D74B' : '#FF9F0A',
    },
    {
      label: 'CodexBar API Eq.',
      value: formatCurrency(codexbarPeriodCost),
      title: `${activePeriodLabel} CodexBar-scanned API-equivalent estimate`,
      accent: codexbarActive ? '#FF9500' : '#8E8E93',
    },
    {
      label: 'Tracked Days',
      value: `${chartDayCount || 0} days`,
      accent: '#007AFF',
    },
    {
      label: 'Token Volume',
      value: formatCompactTokenValue(totalTokens),
      title: `${formatTokens(totalTokens)} tokens`,
      accent: '#BF5AF2',
    },
    {
      label: budget > 0 ? 'Budget Left' : 'Budget State',
      value: budget > 0 ? budgetRemaining === null ? 'Unavailable' : formatCurrency(Math.max(budgetRemaining, 0)) : 'No cap',
      accent: budget > 0 && budgetRemaining !== null && budgetRemaining < budget * 0.2 ? '#FF453A' : '#32D74B',
    },
  ]

  return (
    <PageTransition>
      <div className={m ? `${costsStyles.page} ${costsStyles.pageMobile}` : costsStyles.page}>
        <CostPulseHeader
          m={m}
          period={period}
          setPeriod={setPeriod}
          monthAnchor={monthAnchor}
          setMonthAnchor={setMonthAnchor}
          calendarNow={calendarNow}
          serverMonth={serverMonth}
          viewingPastMonth={viewingPastMonth}
          anchoredMonthLabel={anchoredMonthLabel}
          activePeriodLabel={activePeriodLabel}
          hasAwsData={hasAwsData}
          ledgerActive={ledgerActive}
          costSourceLabel={costSourceLabel}
          overviewPills={overviewPills}
          codexbarActive={codexbarActive}
          codexbarCosts={codexbarCosts}
          codexbarPeriodTokens={apiEquivalentTokenVolume}
          currentPeriodCost={currentPeriodCost}
          dailyAvg={dailyAvg}
          projectedMonthly={projectedMonthly}
          apiEquivalentPeriodCost={apiEquivalentPeriodCost}
          apiEquivalentDailyAvg={apiEquivalentDailyAvg}
          apiEquivalentProjectedMonthly={apiEquivalentProjectedMonthly}
          apiEquivalentReliability={apiEquivalentDisplayReliability}
          trackedSpend={trackedSpend}
          trackedValueAvailable={trackedValueAvailable}
        />

        {(agentSplit.length > 0 || agentSplitPending) && (
          <AgentSplitCard
            m={m}
            agentSplit={agentSplit as AgentSplitItem[]}
            agentSplitPending={agentSplitPending}
            activePeriodLabel={activePeriodLabel}
            agentSplitPeriodLabel={agentSplitPeriodLabel}
            totalAgentTokens={totalAgentTokens}
            tokenDataRefreshing={!!(tokenData?.meta?.refreshing)}
            tokenDataStale={!!(tokenData?.meta?.stale)}
          />
        )}

        {budget > 0 && monthlyBudgetBase !== null && monthlyBudgetBase > 0 && monthlyBudgetBase / budget > 0.8 && (
          <div className={m ? `${costsStyles.budgetAlert} ${costsStyles.budgetAlertMobile}` : `${costsStyles.budgetAlert} ${costsStyles.budgetAlertDesktop}`}>
            <AlertCircle size={20} className={costsStyles.budgetAlertIcon} />
            <div>
              <div className={m ? `${costsStyles.budgetAlertTitle} ${costsStyles.budgetAlertTitleMobile}` : costsStyles.budgetAlertTitle}>
                Budget alert
              </div>
              <div className={m ? `${costsStyles.budgetAlertBody} ${costsStyles.budgetAlertBodyMobile}` : costsStyles.budgetAlertBody}>
                {viewingPastMonth && anchoredMonthLabel
                  ? `${anchoredMonthLabel} used ${budgetUsagePct ?? 0}% of the ${formatCurrency(budget)} monthly target.`
                  : `You have used ${budgetUsagePct ?? 0}% of the ${formatCurrency(budget)} monthly target.`}
              </div>
            </div>
          </div>
        )}

        <MetricCards
          m={m}
          isAwsEnabled={isAwsEnabled}
          hasAwsData={hasAwsData}
          awsCosts={awsCosts ?? null}
          metricMode={metricMode}
          currentPeriodCost={metricPeriodCost}
          dailyAvg={metricDailyAverage}
          projectedMonthly={metricProjectedMonthly}
          previousPeriodCost={metricPreviousPeriodCost}
          previousDailyAvg={metricPreviousDailyAverage}
          monthlyTrend={metricPeriodTrend}
          dailyTrend={metricDailyTrend}
          compareLabel={compareLabel}
          period={period}
          labels={labels}
          activePeriodLabel={activePeriodLabel}
          apiEquivalentReliability={apiEquivalentDisplayReliability}
          completePeriod={viewingPastMonth}
        />

        <BudgetCard
          m={m}
          budget={budget}
          budgetInput={budgetInput}
          setBudgetInput={setBudgetInput}
          saveBudget={saveBudget}
          savingBudget={savingBudget}
          canSaveBudget={canSaveBudget}
          budgetError={budgetError}
          budgetUsagePct={budgetUsagePct}
          budgetUsage={budgetUsage}
          budgetRemaining={budgetRemaining}
          budgetBadgeClass={budgetBadgeClass}
          monthlyBudgetBase={monthlyBudgetBase}
          spendLabel={viewingPastMonth && anchoredMonthLabel ? `${anchoredMonthLabel} spend vs budget` : 'Current spend vs budget'}
        />

        <DailySpendSection
          m={m}
          chartData={chartData}
          chartSeries={chartSeries}
          hasChartBars={hasChartBars}
          useMobileDailyChart={useMobileDailyChart}
          activeChartDate={activeChartDate}
          setActiveChartDate={setActiveChartDate}
          chartDayCount={chartDayCount}
          codexbarActive={codexbarActive}
          ledgerActive={ledgerActive}
          hasAwsData={hasAwsData}
          awsCosts={awsCosts ?? null}
          hasSessionEstimateChart={hasSessionEstimateChart}
          sessionEstimateData={sessionEstimateData as SessionEstimateDay[]}
          totalTokens={totalTokens}
          tokenBasedCost={null}
          blendedCostBreakdown={blendedCostBreakdown as BlendedCostItem[]}
          apiEquivalentReliability={apiEquivalentReliability}
        />

        <CostDriversSection
          m={m}
          isAwsEnabled={isAwsEnabled}
          hasAwsData={hasAwsData}
          awsCosts={awsCosts ?? null}
          codexbarActive={codexbarActive}
          codexbarCosts={codexbarCosts}
          codexbarLatest={codexbarLatest}
          codexbarPeriodLabel={period === 'day' ? 'Today' : period === '7d' ? 'Last 7 Days' : viewingPastMonth && anchoredMonthLabel ? anchoredMonthLabel : 'This Month'}
          codexbarPeriodCost={codexbarPeriodCost}
          codexbarPeriodTokens={codexbarPeriodTokens}
          codexbarPeriodDaysList={codexbarPeriodDays}
          sessionsLiveOnlyNotice={viewingPastMonth && anchoredMonthLabel ? `Live session pressure — not scoped to ${anchoredMonthLabel}` : null}
          driverView={driverView}
          setDriverView={setDriverView}
          tokenBreakdown={tokenBreakdown}
          topSessions={topSessions}
          sessionPressureMax={sessionPressureMax}
          costSignals={costSignals}
          creditsUsed={creditsUsed}
          burnRate={burnRate}
          dailyAvg={dailyAvg}
          ledgerActive={ledgerActive}
          tokenDataSource={tokenData?.source}
        />
      </div>
    </PageTransition>
  )
}
