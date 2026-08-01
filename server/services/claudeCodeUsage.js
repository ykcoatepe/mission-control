function dayKey(date) {
  return date.toLocaleDateString('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });
}

function dateKeys(start, end) {
  const keys = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const final = new Date(end);
  final.setHours(0, 0, 0, 0);
  while (cursor <= final) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

const MONTH_ANCHOR_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function isValidMonthAnchor(value) {
  return MONTH_ANCHOR_PATTERN.test(String(value ?? ''));
}

function monthAnchorBounds(anchor) {
  const [year, month] = String(anchor).split('-').map(Number);
  return {
    start: new Date(year, month - 1, 1, 0, 0, 0, 0),
    end: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

function shiftMonthAnchor(anchor, delta) {
  const [year, month] = String(anchor).split('-').map(Number);
  const shifted = new Date(year, month - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

// Anchored past months use the FULL calendar month plus the FULL preceding month —
// both windows are complete, so no day-of-month clipping applies.
// Mirrors server/routes/costs.js rangeForPeriod and scripts/openclaw-usage-summary.js.
function rangeForPeriod(period, now, monthAnchor = null) {
  if (period === 'month' && isValidMonthAnchor(monthAnchor) && String(monthAnchor) < dayKey(new Date(now)).slice(0, 7)) {
    const anchor = String(monthAnchor);
    const current = monthAnchorBounds(anchor);
    const previous = monthAnchorBounds(shiftMonthAnchor(anchor, -1));
    return {
      keys: dateKeys(current.start, current.end),
      previousKeys: dateKeys(previous.start, previous.end),
      anchor,
    };
  }

  const end = new Date(now);
  const start = new Date(now);
  const previousEnd = new Date(now);
  let previousStart = new Date(now);

  if (period === 'day') {
    start.setHours(0, 0, 0, 0);
    previousEnd.setDate(previousEnd.getDate() - 1);
    previousStart = new Date(previousEnd);
  } else if (period === '7d') {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    previousEnd.setTime(start.getTime());
    previousEnd.setDate(previousEnd.getDate() - 1);
    previousStart = new Date(previousEnd);
    previousStart.setDate(previousStart.getDate() - 6);
  } else {
    start.setHours(0, 0, 0, 0);
    start.setDate(1);
    previousEnd.setTime(start.getTime());
    previousEnd.setDate(0);
    previousStart = new Date(previousEnd);
    previousStart.setDate(1);
    previousEnd.setDate(Math.min(end.getDate(), previousEnd.getDate()));
  }

  return {
    keys: dateKeys(start, end),
    previousKeys: dateKeys(previousStart, previousEnd),
    anchor: null,
  };
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const USAGE_SUMMARY_FIELDS = [
  'periodUsd',
  'previousPeriodUsd',
  'previousPeriodApiEquivalentUsd',
  'todayUsd',
  'yesterdayUsd',
  'thisWeekUsd',
  'thisMonthUsd',
  'totalUsd',
  'periodTokens',
  'todayTokens',
  'thisWeekTokens',
  'thisMonthTokens',
  'totalTokens',
];

function sumUsageSummaries(agents = []) {
  return Object.fromEntries(
    USAGE_SUMMARY_FIELDS.map((field) => {
      const rawValues = agents.map((agent) => agent?.summary?.[field]);
      const values = rawValues.filter((value) => value !== null && value !== undefined);
      return [
        field,
        field.startsWith('previousPeriod') && values.length !== rawValues.length
          ? null
          : values.reduce((sum, value) => sum + numeric(value), 0),
      ];
    }),
  );
}

function normalizedModelBreakdowns(row) {
  const models = Array.isArray(row?.modelBreakdowns) ? row.modelBreakdowns : [];
  const missingIndexes = models
    .map((model, index) => {
      const hasTokens = model?.totalTokens !== undefined
        && model?.totalTokens !== null
        && Number.isFinite(Number(model.totalTokens));
      return hasTokens ? -1 : index;
    })
    .filter((index) => index >= 0);
  if (!missingIndexes.length) return models;

  const explicitTokens = models.reduce((sum, model, index) => (
    missingIndexes.includes(index) ? sum : sum + numeric(model?.totalTokens)
  ), 0);
  const remainingTokens = Math.max(numeric(row?.totalTokens) - explicitTokens, 0);
  const missingCost = missingIndexes.reduce((sum, index) => sum + Math.max(numeric(models[index]?.cost), 0), 0);
  const canUseCostWeights = missingCost > 0
    && missingIndexes.every((index) => numeric(models[index]?.cost) > 0);
  const fallbackTokens = new Map();
  let allocatedTokens = 0;

  missingIndexes.forEach((index, position) => {
    const isLast = position === missingIndexes.length - 1;
    const weight = canUseCostWeights
      ? Math.max(numeric(models[index]?.cost), 0) / missingCost
      : 1 / missingIndexes.length;
    const tokens = isLast ? remainingTokens - allocatedTokens : remainingTokens * weight;
    fallbackTokens.set(index, tokens);
    allocatedTokens += tokens;
  });

  return models.map((model, index) => ({
    ...model,
    totalTokens: fallbackTokens.has(index) ? fallbackTokens.get(index) : numeric(model?.totalTokens),
  }));
}

function needsClaudeCodeCacheRefresh(value) {
  return !Object.prototype.hasOwnProperty.call(value?.meta || {}, 'claudeCodeStatus');
}

// A cached result whose `period.anchor` names a month that has already ended is
// immutable: its `period.end` can never equal today, so the plain end-of-day check
// would mark it stale forever and re-refresh on every single request. Anchored past
// months fall back to the normal cache TTL instead.
function isAnchoredPastMonth(value, now = new Date()) {
  const anchor = String(value?.period?.anchor || '');
  return MONTH_ANCHOR_PATTERN.test(anchor) && anchor < dayKey(now).slice(0, 7);
}

function needsCurrentPeriodRefresh(value, now = new Date()) {
  if (isAnchoredPastMonth(value, now)) return false;
  return String(value?.period?.end || '') !== dayKey(now);
}

function hasClaudeCodeAgent(value) {
  return Boolean(value?.agents?.some((agent) => {
    const key = String(agent?.key || '').toLowerCase();
    const source = String(agent?.source || '').toLowerCase();
    return key === 'claude_code' || source.startsWith('claude-code.');
  }));
}

function normalizedDailyRow(row, date) {
  return {
    date,
    cost: numeric(row?.totalCost),
    totalCost: numeric(row?.totalCost),
    tokens: numeric(row?.totalTokens),
    totalTokens: numeric(row?.totalTokens),
    input: numeric(row?.inputTokens),
    output: numeric(row?.outputTokens),
    cacheRead: numeric(row?.cacheReadTokens),
    cacheWrite: numeric(row?.cacheCreationTokens),
    reasoning: 0,
    modelBreakdowns: normalizedModelBreakdowns(row),
  };
}

function claudeCodeBillingState(payload = {}) {
  const evidence = [
    payload.billingMode,
    payload.billing_mode,
    payload.costSource,
    payload.costStatus,
  ].filter(Boolean).join(' ').toLowerCase();
  if (evidence.includes('subscription') || evidence.includes('included')) return 'included';
  if (evidence.includes('metered') || evidence.includes('api')) return 'metered';
  return 'unknown';
}

function buildClaudeCodeUsageSummary(raw, period = 'month', now = new Date(), monthAnchor = null) {
  const payload = Array.isArray(raw)
    ? raw.find((item) => String(item?.provider || '').toLowerCase() === 'claude')
    : raw;
  if (!payload || typeof payload !== 'object') return null;

  const billingState = claudeCodeBillingState(payload);
  const trackedCost = (cost) => billingState === 'metered' ? numeric(cost) : 0;
  const costSource = billingState === 'metered' ? 'api' : billingState;
  const costStatus = billingState === 'metered' ? 'metered' : billingState;
  const billingModes = billingState === 'metered' ? 'api_metered' : billingState === 'included' ? 'subscription_included' : 'unknown';
  const range = rangeForPeriod(period, now, monthAnchor);
  const rowsByDate = new Map(
    (Array.isArray(payload.daily) ? payload.daily : [])
      .filter((row) => row?.date)
      .map((row) => [String(row.date), row]),
  );
  const daily = range.keys.map((date) => normalizedDailyRow(rowsByDate.get(date), date));
  const modelTotals = new Map();

  for (const day of daily) {
    for (const model of day.modelBreakdowns) {
      const name = String(model?.modelName || 'unknown');
      const current = modelTotals.get(name) || { name, cost: 0, tokens: 0 };
      current.cost += numeric(model?.cost);
      current.tokens += numeric(model?.totalTokens);
      modelTotals.set(name, current);
    }
  }

  const byService = Array.from(modelTotals.values())
    .filter((item) => item.cost > 0 || item.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
    .map((item) => ({
      ...item,
      cost: trackedCost(item.cost),
      apiEquivalentUsd: item.cost,
      apiEquivalentStatus: 'estimated',
      apiEquivalentSource: 'codexbar',
      sessions: 0,
      percentage: 0,
      costSource,
      costStatus,
      billingModes,
      costNote: billingState === 'included'
        ? 'Subscription-included usage; CodexBar estimate is reported separately as API equivalent'
        : billingState === 'metered'
          ? 'API-metered Claude Code usage; CodexBar cost is tracked and also shown as API equivalent'
          : 'Billing mode is not available from CodexBar; estimate is reported only as API equivalent',
    }));
  const periodTokens = daily.reduce((sum, row) => sum + row.tokens, 0);
  byService.forEach((item) => {
    item.percentage = periodTokens > 0 ? Math.round((item.tokens / periodTokens) * 100) : 0;
  });

  const modelKeys = byService.map((item) => item.name);
  const dailyByModel = daily.map((day) => {
    const out = { date: day.date, totalCost: trackedCost(day.cost), apiEquivalentCost: day.cost, totalTokens: day.tokens };
    const models = new Map(day.modelBreakdowns.map((model) => [String(model?.modelName || 'unknown'), model]));
    for (const name of modelKeys) {
      const model = models.get(name);
      out[name] = trackedCost(model?.cost);
      out[`${name}_tokens`] = numeric(model?.totalTokens);
      out[`${name}_apiEquivalentUsd`] = numeric(model?.cost);
      out[`${name}_apiEquivalentStatus`] = 'estimated';
      out[`${name}_costSource`] = costSource;
    }
    return out;
  });

  const allRows = Array.from(rowsByDate.entries()).map(([date, row]) => normalizedDailyRow(row, date));
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);
  // "this month" follows the anchored month so thisMonthUsd/thisMonthTokens stay the
  // budget-relevant totals for the month actually being viewed.
  const monthPrefix = range.anchor || today.slice(0, 7);
  // An anchored past month has no live "today"/"yesterday"/trailing week: those
  // wall-clock fields are scoped to the anchored window so a past-month view never
  // reports live-day numbers. The OpenClaw and Hermes producers behave the same way
  // (they read those rows out of the window-restricted daily series).
  const wallClockRows = range.anchor ? daily : allRows;
  const lastSevenKeys = range.anchor
    ? new Set(range.keys.slice(-7))
    : new Set(rangeForPeriod('7d', now).keys);
  const costForKeys = (keys) => {
    const set = keys instanceof Set ? keys : new Set(keys);
    return allRows.filter((row) => set.has(row.date)).reduce((sum, row) => sum + row.cost, 0);
  };
  const tokensForKeys = (keys) => {
    const set = keys instanceof Set ? keys : new Set(keys);
    return allRows.filter((row) => set.has(row.date)).reduce((sum, row) => sum + row.tokens, 0);
  };
  const periodApiEquivalentUsd = daily.reduce((sum, row) => sum + row.cost, 0);
  const periodUsd = trackedCost(periodApiEquivalentUsd);
  const todayRow = wallClockRows.find((row) => row.date === today) || normalizedDailyRow(null, today);
  const yesterdayRow = wallClockRows.find((row) => row.date === yesterday) || normalizedDailyRow(null, yesterday);
  const monthRows = allRows.filter((row) => row.date.startsWith(monthPrefix));

  return {
    source: 'claude-code.codexbar',
    period,
    periodAnchor: range.anchor || null,
    periodRange: { start: range.keys[0] || null, end: range.keys.at(-1) || null },
    summary: {
      periodUsd,
      previousPeriodUsd: billingState === 'unknown' ? null : trackedCost(costForKeys(range.previousKeys)),
      periodApiEquivalentUsd,
      previousPeriodApiEquivalentUsd: costForKeys(range.previousKeys),
      previousPeriodApiEquivalentReliability: tokensForKeys(range.previousKeys) > 0 ? 'estimated' : 'no_usage',
      periodTokens,
      todayUsd: trackedCost(todayRow.cost),
      yesterdayUsd: trackedCost(yesterdayRow.cost),
      thisWeekUsd: trackedCost(costForKeys(lastSevenKeys)),
      thisMonthUsd: trackedCost(monthRows.reduce((sum, row) => sum + row.cost, 0)),
      totalUsd: periodUsd,
      todayTokens: todayRow.tokens,
      thisWeekTokens: tokensForKeys(lastSevenKeys),
      thisMonthTokens: monthRows.reduce((sum, row) => sum + row.tokens, 0),
      totalTokens: periodTokens,
      note: billingState === 'unknown'
        ? 'Source: CodexBar local Claude Code log scan; billing mode is unknown, so costs are shown only as API-equivalent estimates'
        : 'Source: CodexBar local Claude Code log scan; tracked spend follows explicit billing metadata and API equivalent remains a comparison estimate',
    },
    daily: daily.map(({ modelBreakdowns: _modelBreakdowns, cost: apiEquivalentCost, totalCost: _totalCost, ...row }) => ({
      ...row,
      cost: trackedCost(apiEquivalentCost),
      totalCost: trackedCost(apiEquivalentCost),
      apiEquivalentCost,
    })),
    dailyByModel,
    modelKeys,
    byService,
  };
}

function mergeCodexBarReports(raw) {
  const reports = (Array.isArray(raw) ? raw : [raw]).filter((item) => item && typeof item === 'object');
  if (!reports.length) return null;

  const mergedDays = new Map();
  for (const report of reports) {
    for (const day of Array.isArray(report.daily) ? report.daily : []) {
      if (!day?.date) continue;
      const date = String(day.date);
      const merged = mergedDays.get(date) || {
        date,
        totalCost: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        models: new Map(),
      };
      merged.totalCost += numeric(day.totalCost);
      merged.totalTokens += numeric(day.totalTokens);
      merged.inputTokens += numeric(day.inputTokens);
      merged.outputTokens += numeric(day.outputTokens);
      merged.cacheReadTokens += numeric(day.cacheReadTokens);
      merged.cacheCreationTokens += numeric(day.cacheCreationTokens);
      for (const model of normalizedModelBreakdowns(day)) {
        const name = String(model?.modelName || 'unknown');
        const modelTotal = merged.models.get(name) || { modelName: name, totalTokens: 0, cost: 0 };
        modelTotal.totalTokens += numeric(model?.totalTokens);
        modelTotal.cost += numeric(model?.cost);
        merged.models.set(name, modelTotal);
      }
      mergedDays.set(date, merged);
    }
  }

  const sum = (field) => reports.reduce((total, report) => total + numeric(report?.[field]), 0);
  const sumTotal = (field) => reports.reduce((total, report) => total + numeric(report?.totals?.[field]), 0);
  const updatedAt = reports
    .map((report) => report.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    source: 'local',
    provider: reports.length > 1 ? 'both' : String(reports[0].provider || 'unknown'),
    updatedAt,
    last30DaysCostUSD: sum('last30DaysCostUSD'),
    last30DaysTokens: sum('last30DaysTokens'),
    sessionCostUSD: sum('sessionCostUSD'),
    sessionTokens: sum('sessionTokens'),
    totals: {
      totalCost: sumTotal('totalCost'),
      totalTokens: sumTotal('totalTokens'),
      inputTokens: sumTotal('inputTokens'),
      outputTokens: sumTotal('outputTokens'),
      cacheReadTokens: sumTotal('cacheReadTokens'),
      cacheCreationTokens: sumTotal('cacheCreationTokens'),
    },
    daily: Array.from(mergedDays.values())
      .sort((left, right) => left.date.localeCompare(right.date))
      .map(({ models, ...day }) => ({
        ...day,
        modelBreakdowns: Array.from(models.values()).sort((left, right) => left.modelName.localeCompare(right.modelName)),
      })),
  };
}

module.exports = {
  buildClaudeCodeUsageSummary,
  hasClaudeCodeAgent,
  isAnchoredPastMonth,
  mergeCodexBarReports,
  needsClaudeCodeCacheRefresh,
  needsCurrentPeriodRefresh,
  rangeForPeriod,
  sumUsageSummaries,
};
