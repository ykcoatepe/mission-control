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

function rangeForPeriod(period, now) {
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
  }

  return {
    keys: dateKeys(start, end),
    previousKeys: dateKeys(previousStart, previousEnd),
  };
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const USAGE_SUMMARY_FIELDS = [
  'periodUsd',
  'previousPeriodUsd',
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
    USAGE_SUMMARY_FIELDS.map((field) => [
      field,
      agents.reduce((sum, agent) => sum + numeric(agent?.summary?.[field]), 0),
    ]),
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
  const fallbackTokens = new Map();
  let allocatedTokens = 0;

  missingIndexes.forEach((index, position) => {
    const isLast = position === missingIndexes.length - 1;
    const weight = missingCost > 0
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

function buildClaudeCodeUsageSummary(raw, period = 'month', now = new Date()) {
  const payload = Array.isArray(raw)
    ? raw.find((item) => String(item?.provider || '').toLowerCase() === 'claude')
    : raw;
  if (!payload || typeof payload !== 'object') return null;

  const range = rangeForPeriod(period, now);
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
      sessions: 0,
      percentage: 0,
      costSource: 'fallback_estimate',
      costStatus: 'estimated',
      billingModes: 'subscription_estimate',
      costNote: 'CodexBar API-equivalent estimate from local Claude Code logs; not a subscription invoice',
    }));
  const periodTokens = daily.reduce((sum, row) => sum + row.tokens, 0);
  byService.forEach((item) => {
    item.percentage = periodTokens > 0 ? Math.round((item.tokens / periodTokens) * 100) : 0;
  });

  const modelKeys = byService.map((item) => item.name);
  const dailyByModel = daily.map((day) => {
    const out = { date: day.date, totalCost: day.cost, totalTokens: day.tokens };
    const models = new Map(day.modelBreakdowns.map((model) => [String(model?.modelName || 'unknown'), model]));
    for (const name of modelKeys) {
      const model = models.get(name);
      out[name] = numeric(model?.cost);
      out[`${name}_tokens`] = numeric(model?.totalTokens);
      out[`${name}_costSource`] = 'fallback_estimate';
    }
    return out;
  });

  const allRows = Array.from(rowsByDate.entries()).map(([date, row]) => normalizedDailyRow(row, date));
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate);
  const monthPrefix = today.slice(0, 7);
  const lastSevenKeys = new Set(rangeForPeriod('7d', now).keys);
  const costForKeys = (keys) => {
    const set = keys instanceof Set ? keys : new Set(keys);
    return allRows.filter((row) => set.has(row.date)).reduce((sum, row) => sum + row.cost, 0);
  };
  const tokensForKeys = (keys) => {
    const set = keys instanceof Set ? keys : new Set(keys);
    return allRows.filter((row) => set.has(row.date)).reduce((sum, row) => sum + row.tokens, 0);
  };
  const periodUsd = daily.reduce((sum, row) => sum + row.cost, 0);
  const todayRow = allRows.find((row) => row.date === today) || normalizedDailyRow(null, today);
  const yesterdayRow = allRows.find((row) => row.date === yesterday) || normalizedDailyRow(null, yesterday);
  const monthRows = allRows.filter((row) => row.date.startsWith(monthPrefix));

  return {
    source: 'claude-code.codexbar',
    period,
    periodRange: { start: range.keys[0] || null, end: range.keys.at(-1) || null },
    summary: {
      periodUsd,
      previousPeriodUsd: costForKeys(range.previousKeys),
      periodTokens,
      todayUsd: todayRow.cost,
      yesterdayUsd: yesterdayRow.cost,
      thisWeekUsd: costForKeys(lastSevenKeys),
      thisMonthUsd: monthRows.reduce((sum, row) => sum + row.cost, 0),
      totalUsd: periodUsd,
      todayTokens: todayRow.tokens,
      thisWeekTokens: tokensForKeys(lastSevenKeys),
      thisMonthTokens: monthRows.reduce((sum, row) => sum + row.tokens, 0),
      totalTokens: periodTokens,
      note: 'Source: CodexBar local Claude Code log scan; costs are API-equivalent estimates, not subscription invoices',
    },
    daily: daily.map(({ modelBreakdowns: _modelBreakdowns, ...row }) => row),
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
      for (const model of Array.isArray(day.modelBreakdowns) ? day.modelBreakdowns : []) {
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
  mergeCodexBarReports,
  needsClaudeCodeCacheRefresh,
  sumUsageSummaries,
};
