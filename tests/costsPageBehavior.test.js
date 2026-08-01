const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read Costs.tsx plus its helper modules so guards work regardless of which
// file the string lives in after the modular refactor.
const pagesDir = path.join(__dirname, '..', 'frontend', 'src', 'pages');
const costsDir = path.join(pagesDir, 'costs');
const filesToCheck = [
  path.join(pagesDir, 'Costs.tsx'),
  path.join(costsDir, 'AgentSplitCard.tsx'),
  path.join(costsDir, 'CostDriversSection.tsx'),
  path.join(costsDir, 'CostPulseHeader.tsx'),
  path.join(costsDir, 'DailySpendSection.tsx'),
  path.join(costsDir, 'MetricCards.tsx'),
  path.join(costsDir, 'lib.ts'),
  path.join(costsDir, 'types.ts'),
].filter(f => fs.existsSync(f));
const source = filesToCheck.map(f => fs.readFileSync(f, 'utf8')).join('\n');

assert.ok(
  source.includes("tokens?.source === 'sessions.fast_fallback'") && source.includes('tokens?.meta?.refreshing') && source.includes('tokens?.meta?.stale'),
  'Costs page should keep retrying while detailed cost data is fallback, refreshing, or stale',
);

assert.ok(
  source.includes("tokens?.source === 'anchored.pending'"),
  'a pending anchored month is empty by design and must keep polling like the live fast fallback',
);

assert.ok(
  source.includes('const viewingPastMonth = isPastMonthAnchor(activeMonthAnchor, calendarNow, serverMonth)') &&
  source.includes('serverMonth={serverMonth}'),
  'past-vs-current classification must follow the server calendar, not the browser time zone',
);

assert.ok(
  source.includes("const preservedFreshCache =\n        tokens?.source !== 'anchored.pending' &&"),
  'preserving an empty anchored.pending entry must not stop polling — the month would stay at zero even after the producers recover',
);

assert.ok(
  !source.includes("tokens?.meta?.refreshStartedAt || tokens?.meta?.updatedAt || 'unknown',"),
  'the retry deadline must not include per-attempt refresh metadata — it would reset on every failed attempt and poll (and rescan) forever',
);

assert.ok(
  source.includes('ACTIVE_REFRESH_RETRY_TIMEOUT_MS') &&
  source.includes('const budget = tokens?.meta?.refreshing\n        ? ACTIVE_REFRESH_RETRY_TIMEOUT_MS\n        : STALE_COSTS_RETRY_TIMEOUT_MS'),
  'a queued month may wait behind other scans, so polling must not expire while the server still reports work in flight for this key',
);

assert.ok(
  source.includes('const totalTokens = ledgerActive') &&
  source.includes('    : viewingPastMonth\n      ? codexbarPeriodDays.reduce((sum, day) => sum + (day.totalTokens || 0), 0)\n      : sessions.reduce('),
  'the Token Volume pill must never fall back to live session totals while an anchored past month is displayed',
);

assert.ok(
  source.includes('STALE_COSTS_RETRY_LIMIT = 60') && source.includes('STALE_COSTS_RETRY_TIMEOUT_MS') && source.includes('preservedPreviousOpenClaw') && source.includes('preservedPreviousClaudeCode') && source.includes('preservedPreviousUsage'),
  'Costs page stale retry polling should be capped and stop on fresh preserved cache responses',
);

assert.ok(
  source.includes('codexbarRowsForPeriod') && source.includes('previousCodexbarRows'),
  'Costs page should select sparse CodexBar rows with calendar-aware period helpers',
);

assert.ok(
  source.includes('setCalendarNow') &&
  source.includes('millisecondsUntilNextCalendarDay') &&
  source.includes("window.addEventListener('focus'") &&
  source.includes('calendarRefreshQueryKeys(period, monthAnchor)') &&
  source.includes('queryClient.invalidateQueries({ queryKey })') &&
  source.includes('codexbarRowsForPeriod(\n      codexbarDailyRows,\n      period,\n      calendarNow,'),
  'Costs page should refresh period bounds and both usage queries after local midnight or focus',
);

assert.ok(
  source.includes('codexbarRowsForPeriod(\n      codexbarDailyRows,\n      period,\n      calendarNow,\n      activeMonthAnchor,\n      serverMonth,'),
  'codexbar bounds must share the server-calendar authority with viewingPastMonth',
);

assert.ok(
  source.includes("return { period: 'vs previous month', daily: 'vs previous month avg' }"),
  'CodexBar month labels should describe the calendar-month baseline shared by Agent Split',
);

assert.ok(
  source.includes('OpenClaw is direct native usage; Codex App Sessions are nested app-launched runs; Claude Code comes from local CodexBar logs.') &&
  source.includes('Direct OpenClaw native sessions only. Nested app-launched Codex runs are counted in Codex App Sessions.') &&
  source.includes('agent/codex-home/sessions runs launched from the Codex app') &&
  source.includes('Claude Code usage from local logs via CodexBar. Cost is an API-equivalent estimate, not a subscription invoice.'),
  'Agent Split should explain direct OpenClaw, nested Codex App, and local Claude Code usage',
);

assert.ok(
  source.includes("agent.status === 'stale'") && source.includes('Stale source'),
  'Agent Split should visibly mark preserved Claude Code data as stale',
);

assert.ok(
  source.includes('API equivalent') &&
  source.includes('apiEquivalentCost') &&
  source.includes('apiEquivalentUsd'),
  'Agent and model cost views should show API-equivalent cost separately from tracked spend',
);

assert.ok(
  source.includes('const currentPeriodCost = hasAwsData') &&
  source.includes('apiEquivalentPeriodCost') &&
  source.includes('All-source API Equivalent') &&
  source.includes('Public-list-price estimate; not tracked subscription spend'),
  'Headline and metric cards should keep tracked spend separate from all-source API equivalent',
);

assert.ok(
  source.includes('periodTokens ?? tokenData?.summary?.thisMonthTokens ?? tokenData?.summary?.totalTokens ?? 0'),
  'Selected-period zero tokens must not fall back to month or all-time token volume',
);

assert.ok(
  source.includes('const allTokenBreakdown = useMemo') &&
  source.includes('.sort((a, b) => b.apiEquivalentCost - a.apiEquivalentCost') &&
  source.includes("hasAwsData ? 'Ranked from live AWS billing") &&
  source.includes('tokens|input|output|reasoning|cacheRead|cacheWrite'),
  'Spend composition should rank the complete model set by API equivalent and label AWS billing accurately',
);

assert.ok(
  source.includes('apiEquivalentReliability') &&
  source.includes('PARTIAL ESTIMATE') &&
  source.includes('UNAVAILABLE') &&
  source.includes('NOT APPLICABLE') &&
  source.includes('NO USAGE') &&
  source.includes('API equivalent unavailable'),
  'API-equivalent headline should expose partial and unavailable estimates instead of presenting them as complete zero spend',
);

assert.ok(
  source.includes('trackedSpendPresentation') &&
  source.includes('costReliability') &&
  source.includes('selectedSourceIsComplete: hasAwsData') &&
  source.includes('Tracked spend from available billing data') &&
  source.includes('billing sources unknown') &&
  source.includes('API-Equivalent Daily Average') &&
  source.includes('Projected API Equivalent') &&
  source.includes('previousPeriodApiEquivalentUsd') &&
  source.includes('apiEquivalentMetricValues') &&
  source.includes('Public API prices; not your invoice') &&
  source.includes('Tracked spend projection is unavailable') &&
  !source.includes('Metered spend projection is unavailable') &&
  !source.includes('Cannot project while billing coverage is partial'),
  'Metric cards should show API-equivalent estimates and trends while tracked billing truth remains separate',
);

assert.ok(
  source.includes("codexbarActive\n      ? 'estimated'\n      : 'unavailable'") &&
  !source.includes("codexbarActive\n      ? codexbarPeriodCost\n      : tokenBasedCost") &&
  !source.includes("const tokenBasedCost = estimateCost(totalTokens, 'sonnet')") &&
  !source.includes("estimateCost(Number(day.tokens || 0), 'sonnet')") &&
  !source.includes("estimateCost(totalTokens, 'sonnet')") &&
  source.includes('trackedValueAvailable') &&
  source.includes("trackedValueAvailable ? formatCurrency(currentPeriodCost) : 'Unavailable'") &&
  source.includes('Session activity only') &&
  source.includes('Cost Coverage') &&
  !source.includes('Monthly Estimate') &&
  !source.includes('Estimated Spend'),
  'sessions without a priced model ledger must not be fabricated as API-equivalent or tracked Sonnet spend',
);

assert.ok(
  source.includes('budgetSpendValue({') && source.includes('hasAwsData'),
  'budget math should use the same selected tracked source as the cards and withhold incomplete coverage',
);

// --- Historical month navigation (month=YYYY-MM anchor) ---------------------

assert.ok(
  source.includes("const [monthAnchor, setMonthAnchor] = useState<string | null>(null)") &&
  source.includes("const activeMonthAnchor = period === 'month' ? monthAnchor : null") &&
  source.includes('const costsPath = costsQueryPath(period, activeMonthAnchor)') &&
  source.includes("queryKey: ['api', costsPath]") &&
  source.includes('queryFn: () => fetchJson<TokenData>(costsPath)'),
  'Costs page should anchor the Monthly view through one query path that is also the react-query key',
);

assert.ok(
  source.includes("return period === 'month' && monthAnchor\n    ? `/api/costs?period=${period}&month=${monthAnchor}`\n    : `/api/costs?period=${period}`"),
  'the month anchor must only reach the API on the Monthly period',
);

assert.ok(
  !source.includes("if (period === 'month' && monthAnchor) return []") &&
  source.includes("codexbarQueryPath(period === 'month' ? monthAnchor : null, now)"),
  'anchored views must keep refreshing serverMonth or the navigator strands the user in the old month',
);

assert.ok(
  source.includes('previousDayCount: viewingPastMonth && activeMonthAnchor') &&
  source.includes('daysInMonthKey(previousMonthKey(activeMonthAnchor))'),
  'an anchored baseline divides by its real calendar length even when codexbar rows are absent',
);

assert.ok(
  source.includes('const monthNav = monthNavigationState(monthAnchor, calendarNow, MONTH_ANCHOR_HISTORY_MONTHS, serverMonth)') &&
  source.includes('disabled={!monthNav.canGoForward}') &&
  source.includes('disabled={!monthNav.canGoBack}') &&
  source.includes('canGoForward: active < current') &&
  source.includes('canGoBack: active > floor'),
  'the month navigator should stop at the current month going forward and at the history floor going back',
);

assert.ok(
  source.includes('const goToMonth = (next: string) => setMonthAnchor(next === monthNav.currentMonth ? null : next)'),
  'stepping back onto the current month must clear the anchor so the live cache entry is reused',
);

assert.ok(
  source.includes('const projectedMonthly = viewingPastMonth ? currentPeriodCost : dailyAvg * 30') &&
  source.includes("{viewingPastMonth ? 'Month Total' : 'Projection'}") &&
  source.includes("completePeriod ? current : dailyAverage * 30") &&
  source.includes("? `${anchoredMonthLabel} tracked spend`"),
  'a finished month must be reported as a total with its own name, never extrapolated as a projection',
);

assert.ok(
  source.includes('const baseline = monthKeyLabel(previousMonthKey(monthAnchor as string))') &&
  source.includes('return { period: `vs ${baseline}`, daily: `vs ${baseline} avg` }'),
  'an anchored month should compare against the named previous month',
);

assert.ok(
  source.includes('awsBillingDataAvailable(isAwsEnabled, awsCosts) && !viewingPastMonth'),
  'AWS live billing always reports the current month, so it must never be preferred while an anchored past month is displayed',
);

assert.ok(
  source.includes('codexbarQueryPath(activeMonthAnchor, calendarNow)'),
  'the codexbar fetch must follow the month anchor so past-month codexbar cells are not zero-filled by the default 70-day scan',
);

assert.ok(
  !source.includes('if (!codexbarActive) return []') &&
  source.includes('codexbarPeriodDays.some(') &&
  source.includes('last30DaysCostUSD > 0 ||'),
  'codexbar activity must be derived from the selected period rows too — a live last30DaysCostUSD of 0 must not suppress an anchored month that has usage',
);

assert.ok(
  !source.includes('codexbarCosts.daily.slice().reverse()') &&
  !source.includes('formatTokens(codexbarCosts.totals.inputTokens)') &&
  !source.includes('formatTokens(codexbarCosts.totals.outputTokens)') &&
  source.includes('codexbarPeriodDaysList'),
  'the Cost Drivers codexbar panel must render the selected period rows and totals, never the full widened scan payload',
);

assert.ok(
  source.includes('if (viewingPastMonth) {') &&
  source.includes('codexbarPeriodDays.forEach(day => {') &&
  source.includes('viewingPastMonth, tokenData]'),
  'the model breakdown must never fall back to live /api/sessions data while an anchored past month is displayed — anchored codexbar rows are the only valid historical source',
);

assert.ok(
  source.includes("viewingPastMonth ? 'Session pressure (live)' : 'Session pressure'") &&
  source.includes('session history is not scoped to the selected month'),
  'the session-pressure signal is live data: on a historical page it must say so instead of reading as that month\'s pressure',
);

assert.ok(
  source.includes('sessionsLiveOnlyNotice') &&
  source.includes("sessionsLiveOnlyNotice={viewingPastMonth && anchoredMonthLabel ? `Live session pressure — not scoped to ${anchoredMonthLabel}` : null}"),
  'the By session view is live-only data: an anchored past month must carry an explicit notice so current sessions are not read as that month\'s drivers',
);

assert.ok(
  source.includes('const producerStillUnavailable = [') &&
  source.includes('!producerStillUnavailable &&'),
  'a preserved slice must not settle polling while another configured producer is still unavailable',
);

console.log('costs page behavior guards passed');
