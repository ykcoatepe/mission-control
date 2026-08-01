const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  claudeCodeScanDays,
  costsCacheKey,
  parseMonthAnchor,
  rangeForPeriod: routeRangeForPeriod,
} = require('../server/routes/costs');
const {
  buildClaudeCodeUsageSummary,
  isAnchoredPastMonth,
  needsCurrentPeriodRefresh,
  rangeForPeriod: claudeCodeRangeForPeriod,
} = require('../server/services/claudeCodeUsage');
const { rangeForPeriod: openclawRangeForPeriod } = require('../scripts/openclaw-usage-summary');

const NOW = new Date(2026, 7, 1, 14, 30, 0); // 2026-08-01, local time

// ---------------------------------------------------------------------------
// Anchored window semantics
// ---------------------------------------------------------------------------

test('anchored month window is the full calendar month with a full previous month', () => {
  const range = routeRangeForPeriod('month', '2026-07', NOW);

  assert.equal(range.anchor, '2026-07');
  assert.equal(range.startKey, '2026-07-01');
  assert.equal(range.endKey, '2026-07-31');
  assert.equal(range.keys.length, 31);
  assert.equal(range.keys[0], '2026-07-01');
  assert.equal(range.keys.at(-1), '2026-07-31');

  // Both months are complete, so the previous window is NOT clipped to the
  // current day-of-month the way the live current-month view is.
  assert.equal(range.previousKeys.length, 30);
  assert.equal(range.previousKeys[0], '2026-06-01');
  assert.equal(range.previousKeys.at(-1), '2026-06-30');

  assert.equal(new Date(range.startSec * 1000).getDate(), 1);
  assert.equal(new Date(range.endSec * 1000).getDate(), 31);
  assert.ok(range.previousEndSec < range.startSec, 'previous window must end before the anchored month starts');
});

test('January anchor rolls the previous window back into December of the prior year', () => {
  const range = routeRangeForPeriod('month', '2026-01', NOW);

  assert.equal(range.startKey, '2026-01-01');
  assert.equal(range.endKey, '2026-01-31');
  assert.equal(range.previousKeys[0], '2025-12-01');
  assert.equal(range.previousKeys.at(-1), '2025-12-31');
  assert.equal(range.previousKeys.length, 31);
});

test('February anchor respects leap-year length', () => {
  const leap = routeRangeForPeriod('month', '2024-02', NOW);
  assert.equal(leap.keys.length, 29);
  assert.equal(leap.endKey, '2024-02-29');

  const nonLeap = routeRangeForPeriod('month', '2026-02', NOW);
  assert.equal(nonLeap.keys.length, 28);
  assert.equal(nonLeap.endKey, '2026-02-28');
});

test('current-month anchor is byte-identical to no anchor', () => {
  const anchored = routeRangeForPeriod('month', '2026-08', NOW);
  const unanchored = routeRangeForPeriod('month', null, NOW);
  assert.deepEqual(anchored, unanchored);
  assert.equal(anchored.anchor, null);
});

test('day and 7d windows ignore a month anchor entirely', () => {
  assert.deepEqual(routeRangeForPeriod('day', '2026-07', NOW), routeRangeForPeriod('day', null, NOW));
  assert.deepEqual(routeRangeForPeriod('7d', '2026-07', NOW), routeRangeForPeriod('7d', null, NOW));
});

// ---------------------------------------------------------------------------
// Seam: all three producers must agree on the anchored window
// ---------------------------------------------------------------------------

test('seam: costs route, openclaw script and claudeCodeUsage derive the same anchored window', () => {
  for (const anchor of ['2026-07', '2026-01', '2024-02']) {
    const route = routeRangeForPeriod('month', anchor, NOW);
    const openclaw = openclawRangeForPeriod('month', anchor, NOW);
    const claudeCode = claudeCodeRangeForPeriod('month', NOW, anchor);

    assert.deepEqual(openclaw.keys, route.keys, `openclaw keys must match route keys for ${anchor}`);
    assert.deepEqual(claudeCode.keys, route.keys, `claudeCode keys must match route keys for ${anchor}`);
    assert.deepEqual(openclaw.previous.keys, route.previousKeys, `openclaw previous keys must match for ${anchor}`);
    assert.deepEqual(claudeCode.previousKeys, route.previousKeys, `claudeCode previous keys must match for ${anchor}`);

    assert.equal(openclaw.startKey, route.startKey);
    assert.equal(openclaw.endKey, route.endKey);
    assert.equal(claudeCode.keys[0], route.startKey);
    assert.equal(claudeCode.keys.at(-1), route.endKey);
    assert.equal(openclaw.anchor, anchor);
    assert.equal(claudeCode.anchor, anchor);
  }
});

test('seam: unanchored month window still agrees across producers', () => {
  const route = routeRangeForPeriod('month', null, NOW);
  const openclaw = openclawRangeForPeriod('month', null, NOW);
  const claudeCode = claudeCodeRangeForPeriod('month', NOW, null);

  assert.deepEqual(openclaw.keys, route.keys);
  assert.deepEqual(claudeCode.keys, route.keys);
  assert.deepEqual(openclaw.previous.keys, route.previousKeys);
  assert.deepEqual(claudeCode.previousKeys, route.previousKeys);
});

// ---------------------------------------------------------------------------
// Anchor parsing / validation
// ---------------------------------------------------------------------------

test('parseMonthAnchor accepts a past month and normalizes the current month to no anchor', () => {
  assert.deepEqual(parseMonthAnchor('2026-07', NOW), { ok: true, anchor: '2026-07' });
  assert.deepEqual(parseMonthAnchor('2026-08', NOW), { ok: true, anchor: null });
  assert.deepEqual(parseMonthAnchor(undefined, NOW), { ok: true, anchor: null });
  assert.deepEqual(parseMonthAnchor('', NOW), { ok: true, anchor: null });
});

test('parseMonthAnchor rejects bad formats and future months', () => {
  for (const bad of ['2026-13', '2026-00', '2026-7', 'july', '2026/07', '2026-07-01', '20267', ['2026-07', '2026-06']]) {
    assert.equal(parseMonthAnchor(bad, NOW).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.equal(parseMonthAnchor('2026-09', NOW).ok, false, 'next month must be rejected');
  assert.equal(parseMonthAnchor('2999-01', NOW).ok, false, 'far future must be rejected');
});

test('cache keys keep anchored months separated from the live month', () => {
  assert.equal(costsCacheKey('month', null), 'costs:month');
  assert.equal(costsCacheKey('day', null), 'costs:day');
  assert.equal(costsCacheKey('month', '2026-07'), 'costs:month:2026-07');
  assert.notEqual(costsCacheKey('month', '2026-07'), costsCacheKey('month', '2026-06'));
  assert.notEqual(costsCacheKey('month', '2026-07'), costsCacheKey('month', null));
});

// ---------------------------------------------------------------------------
// CodexBar scan window
// ---------------------------------------------------------------------------

test('claudeCodeScanDays widens the codexbar window to reach the anchored month', () => {
  assert.equal(claudeCodeScanDays(null, NOW), 70, 'unanchored behaviour is unchanged');
  assert.equal(claudeCodeScanDays('2026-08', NOW), 70, 'current month needs no widening');

  // The scan must reach the start of the month BEFORE the anchor: the
  // previous month is the comparison baseline and buildClaudeCodeUsageSummary
  // needs every one of its days for previousPeriodApiEquivalentUsd.
  const january = claudeCodeScanDays('2026-01', NOW);
  const daysSincePreviousMonthStart = Math.ceil((NOW.getTime() - new Date(2025, 11, 1).getTime()) / 86400000);
  assert.equal(january, daysSincePreviousMonthStart + 2);
  assert.ok(january > 70, 'an older anchor must widen past the default 70 days');
});

test('claudeCodeScanDays covers the full previous-month comparison window', () => {
  // Viewing June 2026 on 2026-08-01: the baseline is May, so the scan must
  // reach 2026-05-01 (92 days back) — the old anchor-start math stopped at
  // June 1 and the 70-day default silently dropped May 1-23.
  const june = claudeCodeScanDays('2026-06', NOW);
  const daysSinceMayStart = Math.ceil((NOW.getTime() - new Date(2026, 4, 1).getTime()) / 86400000);
  assert.equal(june, daysSinceMayStart + 2);
  assert.ok(june >= 92, `scan must reach 2026-05-01, got ${june} days`);
});

test('parseMonthAnchor rejects months older than the 24-month history window', () => {
  // The UI navigator floors at 24 months (monthAnchorFloor); the API enforces
  // the same floor so the codexbar scan window stays bounded without ever
  // silently truncating a valid request.
  assert.equal(parseMonthAnchor('2024-08', NOW).ok, true, 'exactly at the floor is allowed');
  assert.equal(parseMonthAnchor('2024-07', NOW).ok, false, 'older than the floor is rejected');
  assert.equal(parseMonthAnchor('2020-01', NOW).ok, false, 'far past is rejected');
});

// ---------------------------------------------------------------------------
// Cache staleness: anchored past months are immutable
// ---------------------------------------------------------------------------

test('a cached anchored past month does not force a refresh on every request', () => {
  const pastMonthValue = { period: { key: 'month', anchor: '2026-07', start: '2026-07-01', end: '2026-07-31' } };
  assert.equal(isAnchoredPastMonth(pastMonthValue, NOW), true);
  assert.equal(needsCurrentPeriodRefresh(pastMonthValue, NOW), false);
});

test('a cached current-period value still refreshes when it does not reach today', () => {
  const currentValue = { period: { key: 'month', anchor: null, start: '2026-08-01', end: '2026-07-31' } };
  assert.equal(isAnchoredPastMonth(currentValue, NOW), false);
  assert.equal(needsCurrentPeriodRefresh(currentValue, NOW), true);

  const anchoredToCurrentMonth = { period: { key: 'month', anchor: '2026-08', end: '2026-07-31' } };
  assert.equal(isAnchoredPastMonth(anchoredToCurrentMonth, NOW), false);
  assert.equal(
    needsCurrentPeriodRefresh(anchoredToCurrentMonth, NOW),
    true,
    'an anchor naming the CURRENT month must not disable the end-of-day staleness check',
  );

  const reachesToday = { period: { key: 'month', anchor: null, end: '2026-08-01' } };
  assert.equal(needsCurrentPeriodRefresh(reachesToday, NOW), false);
});

test('a garbage anchor cannot switch off the staleness check', () => {
  const spoofed = { period: { key: 'month', anchor: 'not-a-month', end: '2026-07-31' } };
  assert.equal(isAnchoredPastMonth(spoofed, NOW), false);
  assert.equal(needsCurrentPeriodRefresh(spoofed, NOW), true);
});

// ---------------------------------------------------------------------------
// Claude Code summary honours the anchor
// ---------------------------------------------------------------------------

test('buildClaudeCodeUsageSummary scopes totals to the anchored month', () => {
  const raw = [{
    provider: 'claude',
    billingMode: 'api_metered',
    daily: [
      { date: '2026-06-15', totalCost: 4, totalTokens: 400, modelBreakdowns: [{ modelName: 'claude-opus', totalTokens: 400, cost: 4 }] },
      { date: '2026-07-02', totalCost: 1, totalTokens: 100, modelBreakdowns: [{ modelName: 'claude-opus', totalTokens: 100, cost: 1 }] },
      { date: '2026-07-31', totalCost: 2, totalTokens: 200, modelBreakdowns: [{ modelName: 'claude-opus', totalTokens: 200, cost: 2 }] },
      { date: '2026-08-01', totalCost: 9, totalTokens: 900, modelBreakdowns: [{ modelName: 'claude-opus', totalTokens: 900, cost: 9 }] },
    ],
  }];

  const anchored = buildClaudeCodeUsageSummary(raw, 'month', NOW, '2026-07');
  assert.equal(anchored.periodAnchor, '2026-07');
  assert.equal(anchored.periodRange.start, '2026-07-01');
  assert.equal(anchored.periodRange.end, '2026-07-31');
  assert.equal(anchored.daily.length, 31);
  assert.equal(anchored.summary.periodUsd, 3, 'only July rows count toward the anchored period');
  assert.equal(anchored.summary.periodTokens, 300);
  assert.equal(anchored.summary.previousPeriodApiEquivalentUsd, 4, 'previous window is the full month of June');
  assert.equal(anchored.summary.thisMonthUsd, 3, 'this-month totals follow the anchored month, not the wall clock');
  assert.equal(anchored.summary.todayUsd, 0, 'a past month has no "today" row inside its window');

  const live = buildClaudeCodeUsageSummary(raw, 'month', NOW);
  assert.equal(live.periodAnchor, null);
  assert.equal(live.periodRange.start, '2026-08-01');
  assert.equal(live.summary.periodUsd, 9, 'unanchored behaviour is unchanged');
});

// ---------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------

test('GET /api/costs rejects malformed and future month anchors with 400', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-anchor-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;

  const express = require('express');
  const { buildCostsRouter } = require('../server/routes/costs');
  const app = express();
  app.use(buildCostsRouter({
    mcConfig: { budget: { monthly: 0 } },
    projectRoot: path.join(__dirname, '..'),
    sessionsService: { listVisibleSessions: async () => ({ sessions: [] }) },
  }));

  const server = await new Promise((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const futureMonth = `${new Date().getFullYear() + 5}-01`;
    for (const month of ['2026-13', 'july', '2026-7', futureMonth]) {
      const response = await fetch(`${base}/api/costs?period=month&month=${encodeURIComponent(month)}`);
      assert.equal(response.status, 400, `month=${month} must be rejected`);
      const body = await response.json();
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'a 400 must carry an error message');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Normalization must not zero out an anchored month's budget spend
// ---------------------------------------------------------------------------

test('normalizeUsageCosts keeps the anchored month spend as thisMonthUsd', () => {
  const { normalizeUsageCosts } = require('../server/services/costSanity');
  // An anchored July payload normalized during a later wall-clock month:
  // costSummaryFromDaily's month prefix must follow the anchor, not "now",
  // or the historical budget card and alerts read $0 for every past month.
  const normalized = normalizeUsageCosts({
    source: 'combined.agent_usage',
    period: { key: 'month', anchor: '2026-07', start: '2026-07-01', end: '2026-07-31' },
    summary: { periodUsd: 31, thisMonthUsd: 31, totalUsd: 31 },
    daily: [
      { date: '2026-07-01', cost: 10, totalCost: 10, tokens: 100, totalTokens: 100 },
      { date: '2026-07-15', cost: 21, totalCost: 21, tokens: 210, totalTokens: 210 },
    ],
    dailyByModel: [],
    byService: [],
  });
  assert.equal(normalized.summary.thisMonthUsd, 31, 'anchored month spend must survive normalization');
  assert.equal(normalized.summary.periodUsd, 31);
});

test('normalizeUsageCosts honors a pre-normalization periodAnchor tag too', () => {
  const { normalizeUsageCosts } = require('../server/services/costSanity');
  const normalized = normalizeUsageCosts({
    source: 'combined.agent_usage',
    periodAnchor: '2026-07',
    summary: { periodUsd: 5, thisMonthUsd: 5 },
    daily: [{ date: '2026-07-03', cost: 5, totalCost: 5 }],
    dailyByModel: [],
    byService: [],
  });
  assert.equal(normalized.summary.thisMonthUsd, 5);
});
