const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildClaudeCodeUsageSummary,
  hasClaudeCodeAgent,
  mergeCodexBarReports,
  needsClaudeCodeCacheRefresh,
  needsCurrentPeriodRefresh,
  sumUsageSummaries,
} = require('../server/services/claudeCodeUsage');
const { cachedUsageAgent, sumPreviousApiEquivalentUsd } = require('../server/routes/costs');

test('stale source reconstruction preserves API-equivalent token classes', () => {
  const previous = {
    modelKeys: ['OpenClaw / openai/gpt-5.6-sol'],
    dailyByModel: [{
      date: '2026-07-13',
      'OpenClaw / openai/gpt-5.6-sol': 0,
      'OpenClaw / openai/gpt-5.6-sol_tokens': 1_100_000,
      'OpenClaw / openai/gpt-5.6-sol_input': 1_000_000,
      'OpenClaw / openai/gpt-5.6-sol_output': 100_000,
      'OpenClaw / openai/gpt-5.6-sol_reasoning': 25_000,
      'OpenClaw / openai/gpt-5.6-sol_cacheRead': 800_000,
      'OpenClaw / openai/gpt-5.6-sol_cacheWrite': 50_000,
      'OpenClaw / openai/gpt-5.6-sol_apiEquivalentUsd': 4.7125,
      'OpenClaw / openai/gpt-5.6-sol_apiEquivalentStatus': 'estimated',
      'OpenClaw / openai/gpt-5.6-sol_costSource': 'included',
    }],
    byService: [{ name: 'OpenClaw / openai/gpt-5.6-sol', agent: 'OpenClaw', apiEquivalentUsd: 4.7125 }],
  };

  const cached = cachedUsageAgent(previous, {
    key: 'openclaw',
    label: 'OpenClaw',
    source: 'openclaw.direct_sessions',
    summary: { periodUsd: 0 },
  });
  const row = cached.dailyByModel[0];

  assert.equal(row['openai/gpt-5.6-sol_input'], 1_000_000);
  assert.equal(row['openai/gpt-5.6-sol_cacheRead'], 800_000);
  assert.equal(row['openai/gpt-5.6-sol_reasoning'], 25_000);
  assert.equal(row['openai/gpt-5.6-sol_apiEquivalentUsd'], 4.7125);
  assert.equal(row['openai/gpt-5.6-sol_apiEquivalentStatus'], 'estimated');
  assert.equal(cached.daily[0].apiEquivalentCost, 4.7125);
});

test('builds a period-scoped Claude Code agent summary from CodexBar data', () => {
  const raw = [{
    provider: 'codex',
    daily: [{
      date: '2026-07-13',
      totalCost: 999,
      totalTokens: 999,
      modelBreakdowns: [{ modelName: 'gpt-ignored', totalTokens: 999, cost: 999 }],
    }],
  }, {
    provider: 'claude',
    source: 'local',
    billingMode: 'subscription_included',
    daily: [
      {
        date: '2026-07-06',
        totalCost: 1.25,
        totalTokens: 100,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheCreationTokens: 10,
        modelBreakdowns: [{ modelName: 'claude-sonnet-4-6', totalTokens: 100, cost: 1.25 }],
      },
      {
        date: '2026-07-12',
        totalCost: 2.5,
        totalTokens: 200,
        inputTokens: 20,
        outputTokens: 40,
        cacheReadTokens: 120,
        cacheCreationTokens: 20,
        modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 200, cost: 2.5 }],
      },
      {
        date: '2026-07-13',
        totalCost: 3.75,
        totalTokens: 300,
        inputTokens: 30,
        outputTokens: 60,
        cacheReadTokens: 180,
        cacheCreationTokens: 30,
        modelBreakdowns: [
          { modelName: 'claude-opus-4-6', totalTokens: 250, cost: 3.25 },
          { modelName: 'claude-haiku-4-5', totalTokens: 50, cost: 0.5 },
        ],
      },
    ],
  }];

  const summary = buildClaudeCodeUsageSummary(raw, '7d', new Date('2026-07-13T12:00:00+03:00'));

  assert.equal(summary.source, 'claude-code.codexbar');
  assert.deepEqual(summary.periodRange, { start: '2026-07-07', end: '2026-07-13' });
  assert.equal(summary.daily.length, 7);
  assert.equal(summary.summary.periodTokens, 500);
  assert.equal(summary.summary.periodUsd, 0);
  assert.equal(summary.summary.periodApiEquivalentUsd, 6.25);
  assert.equal(summary.summary.previousPeriodUsd, 0);
  assert.equal(summary.summary.previousPeriodApiEquivalentUsd, 1.25);
  assert.equal(summary.byService[0].name, 'claude-opus-4-6');
  assert.equal(summary.byService[0].tokens, 450);
  assert.equal(summary.byService[0].costSource, 'included');
  assert.equal(summary.byService[0].apiEquivalentUsd, 5.75);
  assert.equal(summary.dailyByModel.at(-1)['claude-haiku-4-5_tokens'], 50);
});

test('keeps Claude Code tracked spend unknown when CodexBar has no billing evidence', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    daily: [{
      date: '2026-07-13',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 400, cost: 4 }],
    }],
  }], 'day', new Date('2026-07-13T12:00:00+03:00'));

  assert.equal(summary.summary.periodUsd, 0);
  assert.equal(summary.summary.periodApiEquivalentUsd, 4);
  assert.equal(summary.summary.previousPeriodUsd, null);
  assert.equal(summary.byService[0].cost, 0);
  assert.equal(summary.byService[0].costSource, 'unknown');
  assert.equal(summary.byService[0].costStatus, 'unknown');
  assert.equal(summary.dailyByModel[0]['claude-opus-4-6'], 0);
});

test('preserves Claude Code tracked spend when CodexBar explicitly marks API billing', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    billingMode: 'api_metered',
    daily: [{
      date: '2026-07-13',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 400, cost: 4 }],
    }],
  }], 'day', new Date('2026-07-13T12:00:00+03:00'));

  assert.equal(summary.summary.periodUsd, 4);
  assert.equal(summary.summary.periodApiEquivalentUsd, 4);
  assert.equal(summary.byService[0].cost, 4);
  assert.equal(summary.byService[0].costSource, 'api');
  assert.equal(summary.byService[0].costStatus, 'metered');
  assert.equal(summary.dailyByModel[0]['claude-opus-4-6'], 4);
});

test('keeps the previous seven-day baseline correct across a month boundary', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    daily: [{
      date: '2026-06-20',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 400, cost: 4 }],
    }],
  }], '7d', new Date('2026-07-03T12:00:00+03:00'));

  assert.equal(summary.periodRange.start, '2026-06-27');
  assert.equal(summary.summary.previousPeriodUsd, null);
  assert.equal(summary.summary.previousPeriodApiEquivalentUsd, 4);
});

test('compares month-to-date API equivalent with the same calendar span of the previous month', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    daily: [
      { date: '2026-06-01', totalCost: 1, totalTokens: 10, modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 10, cost: 1 }] },
      { date: '2026-06-16', totalCost: 2, totalTokens: 20, modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 20, cost: 2 }] },
      { date: '2026-06-30', totalCost: 30, totalTokens: 300, modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 300, cost: 30 }] },
    ],
  }], 'month', new Date('2026-07-16T12:00:00+03:00'));

  assert.equal(summary.summary.previousPeriodApiEquivalentUsd, 3);
});

test('allocates daily tokens when CodexBar model breakdowns omit token counts', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    daily: [{
      date: '2026-07-13',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [
        { modelName: 'claude-opus-4-6', cost: 3 },
        { modelName: 'claude-haiku-4-5', cost: 1 },
      ],
    }],
  }], 'day', new Date('2026-07-13T12:00:00+03:00'));

  assert.equal(summary.summary.periodTokens, 400);
  assert.equal(summary.byService.find((item) => item.name === 'claude-opus-4-6').tokens, 300);
  assert.equal(summary.byService.find((item) => item.name === 'claude-haiku-4-5').tokens, 100);
  assert.equal(summary.dailyByModel[0]['claude-opus-4-6_tokens'], 300);
  assert.equal(summary.dailyByModel[0]['claude-haiku-4-5_tokens'], 100);
});

test('keeps zero-cost and mixed explicit model usage visible during token allocation', () => {
  const summary = buildClaudeCodeUsageSummary([{
    provider: 'claude',
    daily: [{
      date: '2026-07-13',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [
        { modelName: 'claude-explicit', cost: 1, totalTokens: 100 },
        { modelName: 'claude-paid-missing', cost: 3 },
        { modelName: 'claude-zero-cost-missing', cost: 0 },
      ],
    }],
  }], 'day', new Date('2026-07-13T12:00:00+03:00'));

  const tokensByModel = Object.fromEntries(summary.byService.map((item) => [item.name, item.tokens]));
  assert.deepEqual(tokensByModel, {
    'claude-explicit': 100,
    'claude-paid-missing': 150,
    'claude-zero-cost-missing': 150,
  });
  assert.equal(Object.values(tokensByModel).reduce((sum, tokens) => sum + tokens, 0), 400);
});

test('merges Codex and Claude CodexBar reports for headline spend and model mix', () => {
  const merged = mergeCodexBarReports([
    {
      provider: 'codex',
      updatedAt: '2026-07-13T09:00:00Z',
      last30DaysCostUSD: 10,
      last30DaysTokens: 1000,
      sessionCostUSD: 10,
      sessionTokens: 1000,
      totals: { totalCost: 10, totalTokens: 1000, inputTokens: 100, outputTokens: 50 },
      daily: [{
        date: '2026-07-13',
        totalCost: 10,
        totalTokens: 1000,
        inputTokens: 100,
        outputTokens: 50,
        modelBreakdowns: [{ modelName: 'gpt-5.6-sol', totalTokens: 1000, cost: 10 }],
      }],
    },
    {
      provider: 'claude',
      updatedAt: '2026-07-13T10:00:00Z',
      last30DaysCostUSD: 6,
      last30DaysTokens: 600,
      sessionCostUSD: 6,
      sessionTokens: 600,
      totals: { totalCost: 6, totalTokens: 600, inputTokens: 60, outputTokens: 30 },
      daily: [{
        date: '2026-07-13',
        totalCost: 6,
        totalTokens: 600,
        inputTokens: 60,
        outputTokens: 30,
        modelBreakdowns: [{ modelName: 'claude-opus-4-6', totalTokens: 600, cost: 6 }],
      }],
    },
  ]);

  assert.equal(merged.provider, 'both');
  assert.equal(merged.last30DaysCostUSD, 16);
  assert.equal(merged.last30DaysTokens, 1600);
  assert.equal(merged.updatedAt, '2026-07-13T10:00:00Z');
  assert.equal(merged.daily[0].totalCost, 16);
  assert.equal('projects' in merged, false);
  assert.deepEqual(
    merged.daily[0].modelBreakdowns.map((model) => model.modelName),
    ['claude-opus-4-6', 'gpt-5.6-sol'],
  );
});

test('preserves daily model token totals when merged CodexBar reports omit them', () => {
  const merged = mergeCodexBarReports([{
    provider: 'claude',
    daily: [{
      date: '2026-07-13',
      totalCost: 4,
      totalTokens: 400,
      modelBreakdowns: [
        { modelName: 'claude-opus-4-6', cost: 3 },
        { modelName: 'claude-haiku-4-5', cost: 1 },
      ],
    }],
  }]);

  assert.deepEqual(
    merged.daily[0].modelBreakdowns.map((model) => [model.modelName, model.totalTokens]),
    [
      ['claude-haiku-4-5', 100],
      ['claude-opus-4-6', 300],
    ],
  );
});

test('cost routes use fixed local Claude and combined provider commands', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  // The Claude scan window is widened for anchored past months, but the value is
  // always derived server-side by claudeCodeScanDays (bounded 70..400) — never
  // interpolated from the request.
  assert.match(routeSource, /codexbar cost --format json --provider claude --days \$\{days\}/);
  assert.match(routeSource, /const days = claudeCodeScanDays\(monthAnchor\);/);
  assert.doesNotMatch(routeSource, /req\.query[^\n]*days/);
  // The combined-provider scan window is anchor-aware too, but the day count
  // is always derived server-side from the validated anchor — never from the
  // raw request.
  assert.match(routeSource, /codexbar cost --format json --provider both --days \$\{scanDays\}/);
  assert.match(routeSource, /const scanDays = claudeCodeScanDays\(parsedAnchor\.anchor\);/);
  assert.match(
    routeSource,
    /codexbar cost --format json --provider both --days \$\{scanDays\}`, \{\s*timeout: 30000,\s*maxBuffer: 20 \* 1024 \* 1024,\s*env: process\.env,\s*\}/,
  );
  assert.doesNotMatch(routeSource, /req\.query[^\n]*provider/);
  assert.match(routeSource, /existing\.reasoning \+= Number\(row\.reasoning \|\| 0\)/);
  assert.match(routeSource, /dayModel\.reasoning \+= Number\(row\.reasoning \|\| 0\)/);
  assert.match(routeSource, /out\[`\$\{svc\.name\}_reasoning`\] = b\.reasoning \|\| 0/);
  assert.match(routeSource, /out\[`\$\{key\}_reasoning`\] = Number\(row\[`\$\{key\}_reasoning`\] \|\| 0\)/);
  assert.doesNotMatch(routeSource, /cache_write_tokens, 0\) \+ COALESCE\(reasoning_tokens, 0\)\) AS tokens/);
  assert.doesNotMatch(routeSource, /row\[`\$\{svc\.name\}_apiEquivalentUsd`\] \?\? svc\.apiEquivalentUsd/);
  assert.doesNotMatch(routeSource, /row\[`\$\{svc\.name\}_apiEquivalentStatus`\] \|\| svc\.apiEquivalentStatus/);
});

test('preserved source summaries keep every cost and token aggregate', () => {
  const summary = sumUsageSummaries([
    { summary: { periodUsd: 3, previousPeriodUsd: 2, previousPeriodApiEquivalentUsd: 12, todayUsd: 1, yesterdayUsd: 0.5, thisWeekUsd: 4, thisMonthUsd: 5, totalUsd: 6, periodTokens: 30, todayTokens: 10, thisWeekTokens: 40, thisMonthTokens: 50, totalTokens: 60 } },
    { summary: { periodUsd: 7, previousPeriodUsd: 8, previousPeriodApiEquivalentUsd: 18, todayUsd: 9, yesterdayUsd: 1.5, thisWeekUsd: 6, thisMonthUsd: 5, totalUsd: 4, periodTokens: 70, todayTokens: 90, thisWeekTokens: 60, thisMonthTokens: 50, totalTokens: 40 } },
  ]);

  assert.deepEqual(summary, {
    periodUsd: 10,
    previousPeriodUsd: 10,
    previousPeriodApiEquivalentUsd: 30,
    todayUsd: 10,
    yesterdayUsd: 2,
    thisWeekUsd: 10,
    thisMonthUsd: 10,
    totalUsd: 10,
    periodTokens: 100,
    todayTokens: 100,
    thisWeekTokens: 100,
    thisMonthTokens: 100,
    totalTokens: 100,
  });
});

test('preserves an unavailable previous tracked-spend baseline as null', () => {
  const summary = sumUsageSummaries([
    { summary: { periodUsd: 0, previousPeriodUsd: null } },
    { summary: { periodUsd: 0 } },
  ]);

  assert.equal(summary.previousPeriodUsd, null);
});

test('keeps a combined previous tracked-spend baseline unavailable when any source is missing it', () => {
  const summary = sumUsageSummaries([
    { summary: { periodUsd: 0, previousPeriodUsd: null } },
    { summary: { periodUsd: 4, previousPeriodUsd: 4 } },
  ]);

  assert.equal(summary.previousPeriodUsd, null);
});

test('keeps a combined previous API-equivalent baseline unavailable when any source is missing it', () => {
  const summary = sumUsageSummaries([
    { summary: { previousPeriodApiEquivalentUsd: 4 } },
    { summary: {} },
  ]);

  assert.equal(summary.previousPeriodApiEquivalentUsd, null);
});

test('combines previous API-equivalent baselines without letting idle ready sources erase them', () => {
  assert.equal(sumPreviousApiEquivalentUsd([
    { summary: { previousPeriodApiEquivalentUsd: 4, previousPeriodApiEquivalentReliability: 'estimated' } },
    { summary: { previousPeriodApiEquivalentUsd: null, previousPeriodApiEquivalentReliability: 'no_usage' } },
    { summary: { previousPeriodApiEquivalentUsd: null, previousPeriodApiEquivalentReliability: 'not_applicable' } },
  ]), 4);

  assert.equal(sumPreviousApiEquivalentUsd([
    { summary: { previousPeriodApiEquivalentUsd: 4, previousPeriodApiEquivalentReliability: 'estimated' } },
    { summary: { previousPeriodApiEquivalentUsd: null, previousPeriodApiEquivalentReliability: 'unavailable' } },
  ]), null);

  assert.equal(sumPreviousApiEquivalentUsd([
    { summary: { previousPeriodApiEquivalentUsd: 4, previousPeriodApiEquivalentReliability: 'estimated' } },
    { summary: { previousPeriodApiEquivalentUsd: 99, previousPeriodApiEquivalentReliability: 'unavailable' } },
  ]), null);

  assert.equal(sumPreviousApiEquivalentUsd([
    { summary: { previousPeriodApiEquivalentUsd: 4, previousPeriodApiEquivalentReliability: 'estimated' } },
    { summary: { previousPeriodApiEquivalentUsd: 2 } },
  ]), null);
});

test('refreshes legacy disk caches that predate the Claude Code source', () => {
  assert.equal(needsClaudeCodeCacheRefresh({ meta: { openclawStatus: 'ready' } }), true);
  assert.equal(needsClaudeCodeCacheRefresh({ meta: { claudeCodeStatus: 'ready' } }), false);
  assert.equal(needsClaudeCodeCacheRefresh({ meta: { claudeCodeStatus: 'unavailable' } }), false);
});

test('refreshes a cache whose period ended before the current local day', () => {
  const now = new Date(2026, 6, 14, 0, 0, 1);
  assert.equal(needsCurrentPeriodRefresh({ period: { end: '2026-07-13' } }, now), true);
  assert.equal(needsCurrentPeriodRefresh({ period: { end: '2026-07-14' } }, now), false);
});

test('recognizes a zero-usage Claude agent as preservable cached source data', () => {
  assert.equal(hasClaudeCodeAgent({
    agents: [{ key: 'claude_code', source: 'claude-code.codexbar', summary: { periodTokens: 0, periodUsd: 0 } }],
  }), true);
  assert.equal(hasClaudeCodeAgent({ agents: [] }), false);
});
