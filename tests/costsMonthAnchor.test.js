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

// ---------------------------------------------------------------------------
// /api/costs/codexbar must honor the same anchor contract
// ---------------------------------------------------------------------------

test('GET /api/costs/codexbar validates the month anchor like /api/costs', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-codexbar-'));
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
    // Validation must run BEFORE the codexbar exec: these answer 400 whether
    // or not the codexbar binary exists on the host.
    for (const month of ['2026-13', 'july', '2020-01']) {
      const response = await fetch(`${base}/api/costs/codexbar?month=${encodeURIComponent(month)}`);
      assert.equal(response.status, 400, `codexbar month=${month} must be rejected`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The fast fallback must never attach an anchor to live session data
// ---------------------------------------------------------------------------

test('an anchored month never falls back to live session totals', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-fallback-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;

  const express = require('express');
  const { buildCostsRouter } = require('../server/routes/costs');
  const LIVE_TOKENS = 987654;
  const app = express();
  app.use(buildCostsRouter({
    mcConfig: { budget: { monthly: 0 } },
    projectRoot: path.join(__dirname, '..'),
    sessionsService: {
      listVisibleSessions: async () => ({
        sessions: [{ key: 'agent:live', channel: 'agent', totalTokens: LIVE_TOKENS, updatedAt: new Date().toISOString() }],
      }),
    },
  }));

  const server = await new Promise((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Anchored past month, cold cache: the detailed producers have not answered
    // yet, so the payload must be an EMPTY anchored window — never the live
    // rolling-7-day session totals wearing the historical month's label.
    const now = new Date();
    const anchorDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const anchor = `${anchorDate.getFullYear()}-${String(anchorDate.getMonth() + 1).padStart(2, '0')}`;

    const response = await fetch(`${base}/api/costs?period=month&month=${anchor}`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.period?.anchor, anchor, 'the anchor must still be reported');
    assert.notEqual(
      body.summary?.periodTokens,
      LIVE_TOKENS,
      'live session tokens must not be served as the anchored month total',
    );
    assert.equal(body.summary?.periodTokens || 0, 0, 'a pending anchored month reports no tokens');
    assert.equal(body.summary?.totalTokens || 0, 0);
    for (const row of body.daily || []) {
      assert.ok(
        String(row.date || '').startsWith(anchor),
        `fallback row ${row.date} must fall inside the anchored month`,
      );
    }
    assert.equal(body.meta?.refreshing, true, 'a pending anchored month must be marked refreshing');

    // The live (unanchored) fallback keeps its existing behaviour.
    const liveResponse = await fetch(`${base}/api/costs?period=day`);
    const liveBody = await liveResponse.json();
    assert.equal(liveBody.summary?.periodTokens, LIVE_TOKENS, 'the live fast fallback is unchanged');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The OpenClaw scan cap must not evict the anchored month
// ---------------------------------------------------------------------------

test('newer files cannot evict the anchored window from the OpenClaw scan cap', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  // An OLD anchor is where the cap actually bites: months of newer files exist
  // between the anchored window and today.
  const range = openclawRangeForPeriod('month', '2026-03', NOW);

  const inWindow = [
    { path: 'march-a.jsonl', mtimeMs: new Date(2026, 2, 5).getTime() },
    { path: 'march-b.jsonl', mtimeMs: new Date(2026, 2, 20).getTime() },
  ];
  // The flood of files touched in the months AFTER the anchor — exactly the
  // shape that used to evict March before any record timestamp was inspected.
  const newer = Array.from({ length: 50 }, (_, index) => ({
    path: `later-${index}.jsonl`,
    mtimeMs: new Date(2026, 7, 1).getTime() - index * 60 * 1000,
  }));

  const scanned = prioritizeScanFiles([...newer, ...inWindow], range, 3);
  const scannedPaths = scanned.map((file) => file.path);

  assert.equal(scanned.length, 3, 'the cap is still respected');
  for (const file of inWindow) {
    assert.ok(
      scannedPaths.includes(file.path),
      `${file.path} falls inside the anchored window and must survive the cap (got ${scannedPaths.join(', ')})`,
    );
  }
  assert.ok(
    scannedPaths.some((name) => name.startsWith('later-')),
    'files outside the window still fill the remaining budget — they may carry older records',
  );
});

test('the unanchored scan order is unchanged (newest first)', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  const range = openclawRangeForPeriod('month', null, NOW);
  const files = [
    { path: 'old.jsonl', mtimeMs: NOW.getTime() - 3000 },
    { path: 'newest.jsonl', mtimeMs: NOW.getTime() - 1000 },
    { path: 'mid.jsonl', mtimeMs: NOW.getTime() - 2000 },
  ];
  assert.deepEqual(
    prioritizeScanFiles(files, range, 10).map((file) => file.path),
    ['newest.jsonl', 'mid.jsonl', 'old.jsonl'],
  );
});

test('a session opened inside the anchored month survives the cap even when appended later', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  const range = openclawRangeForPeriod('month', '2026-03', NOW);

  // Opened during the anchored month, last appended in August: its mtime is far
  // outside the window but it still carries March records.
  const lateAppended = {
    path: 'march-session-appended-in-august.jsonl',
    birthtimeMs: new Date(2026, 2, 12).getTime(),
    mtimeMs: new Date(2026, 7, 1).getTime(),
  };
  // Sessions created AFTER the window: they cannot hold March records.
  const createdAfter = Array.from({ length: 50 }, (_, index) => ({
    path: `after-${index}.jsonl`,
    birthtimeMs: new Date(2026, 5, 1).getTime() + index * 1000,
    mtimeMs: new Date(2026, 7, 1).getTime() - index * 1000,
  }));

  const scanned = prioritizeScanFiles([...createdAfter, lateAppended], range, 2)
    .map((file) => file.path);
  assert.ok(
    scanned.includes(lateAppended.path),
    `a late-appended anchored session must outrank files created after the window (got ${scanned.join(', ')})`,
  );
});

test('a post-window birthtime is not evidence against a file', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  const range = openclawRangeForPeriod('month', '2026-03', NOW);

  // A copied/restored tree gives a transcript full of March records an August
  // birthtime, so birthtime may only ever PROMOTE a file. A post-window
  // birthtime and an unknown one are therefore peers, ordered by recency —
  // neither may sink below the other on provenance grounds.
  const unknownBirth = { path: 'unknown-birth.jsonl', birthtimeMs: null, mtimeMs: new Date(2026, 7, 1).getTime() - 1000 };
  const createdAfter = { path: 'created-after.jsonl', birthtimeMs: new Date(2026, 5, 1).getTime(), mtimeMs: new Date(2026, 7, 1).getTime() };

  const both = prioritizeScanFiles([createdAfter, unknownBirth], range, 2).map((file) => file.path);
  assert.deepEqual(both, ['created-after.jsonl', 'unknown-birth.jsonl'], 'same rank, newest first');

  // Swapping which one is newer flips the order: rank does not depend on birthtime.
  const flipped = prioritizeScanFiles(
    [{ ...createdAfter, mtimeMs: new Date(2026, 7, 1).getTime() - 2000 }, unknownBirth],
    range,
    2,
  ).map((file) => file.path);
  assert.deepEqual(flipped, ['unknown-birth.jsonl', 'created-after.jsonl']);
});

// ---------------------------------------------------------------------------
// Navigating months must not fan out unbounded detailed refreshes
// ---------------------------------------------------------------------------

test('detailed refreshes are bounded while months queue up', async () => {
  const { createRefreshLimiter } = require('../server/routes/costs');
  const limiter = createRefreshLimiter(2);

  let active = 0;
  let peak = 0;
  const releases = [];
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  // Ten months clicked through before any scan finishes.
  const jobs = Array.from({ length: 10 }, () => limiter.run(() => {
    active += 1;
    peak = Math.max(peak, active);
    return new Promise((resolve) => {
      releases.push(() => { active -= 1; resolve(); });
    });
  }));

  await settle();
  assert.equal(peak, 2, 'at most two scans may run at once');
  assert.equal(limiter.stats().queued, 8, 'the rest wait their turn instead of spawning');

  // Drain: every queued month must still run — work is delayed, never dropped.
  while (releases.length > 0) {
    releases.shift()();
    await settle();
  }
  await Promise.all(jobs);
  assert.equal(peak, 2, 'the ceiling holds for the whole drain');
  assert.equal(limiter.stats().queued, 0);
  assert.equal(limiter.stats().active, 0);
});

test('a failing refresh releases its slot', async () => {
  const { createRefreshLimiter } = require('../server/routes/costs');
  const limiter = createRefreshLimiter(1);

  await assert.rejects(limiter.run(() => Promise.reject(new Error('scan blew up'))), /scan blew up/);
  assert.equal(limiter.stats().active, 0, 'a rejected job must not leak its slot');
  assert.equal(await limiter.run(() => Promise.resolve('next month')), 'next month');
});

test('a restored transcript is never ranked irrelevant on birthtime alone', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  const range = openclawRangeForPeriod('month', '2026-03', NOW);

  // A `.openclaw` tree copied/restored after the anchored month: the inode was
  // created in July, but the transcript inside holds March records. birthtime
  // must never be read as proof that this file can be skipped.
  const restored = {
    path: 'restored-march-transcript.jsonl',
    birthtimeMs: new Date(2026, 6, 15).getTime(),
    mtimeMs: new Date(2026, 6, 15).getTime(),
  };
  const newerUnknown = {
    path: 'newer-unknown.jsonl',
    birthtimeMs: null,
    mtimeMs: new Date(2026, 6, 10).getTime(),
  };

  const ranked = prioritizeScanFiles([newerUnknown, restored], range, 2).map((file) => file.path);
  assert.equal(ranked.length, 2, 'neither file may be discarded');
  // Same rank: ordering falls back to recency, and the restored file is newer.
  assert.equal(ranked[0], restored.path, 'a restored transcript must not sink below unknown-provenance files');
});

test('birthtime still promotes a genuinely late-appended anchored session', () => {
  const { prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
  const range = openclawRangeForPeriod('month', '2026-03', NOW);
  const lateAppended = { path: 'opened-in-march.jsonl', birthtimeMs: new Date(2026, 2, 12).getTime(), mtimeMs: new Date(2026, 7, 1).getTime() };
  const newer = Array.from({ length: 20 }, (_, i) => ({ path: `newer-${i}.jsonl`, birthtimeMs: new Date(2026, 5, 1).getTime(), mtimeMs: new Date(2026, 7, 1).getTime() - i * 1000 }));
  assert.ok(
    prioritizeScanFiles([...newer, lateAppended], range, 1).map((f) => f.path).includes(lateAppended.path),
    'positive birthtime evidence must still win the top slot',
  );
});

test('the newest queued month is served first so it outlives its poller', async () => {
  const { createRefreshLimiter } = require('../server/routes/costs');
  const limiter = createRefreshLimiter(1);
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  const order = [];
  let releaseFirst;
  // Occupies the only slot.
  const running = limiter.run(() => new Promise((resolve) => { order.push('running'); releaseFirst = resolve; }));
  await settle();

  // Three months clicked through while the first scan is still busy.
  const queued = ['superseded-a', 'superseded-b', 'currently-viewed'].map((name) =>
    limiter.run(async () => { order.push(name); }));

  releaseFirst();
  await Promise.all([running, ...queued]);

  assert.equal(order[0], 'running');
  assert.equal(order[1], 'currently-viewed', `the month the user is looking at must not wait behind superseded ones (order: ${order.join(' -> ')})`);
  assert.equal(order.length, 4, 'superseded months still run — work is deprioritized, never dropped');
});

test('a preserved anchored.pending entry keeps the short fallback TTL', () => {
  const { preservedEntryIsDetailed } = require('../server/routes/costs');

  // All producers failed for a cold historical month: the preserved value is
  // the empty pending payload. Marking it detailed would grant it the long TTL
  // while needsCurrentPeriodRefresh never fires for an anchored month, so the
  // page could poll for a full minute unable to trigger a retry.
  assert.equal(
    preservedEntryIsDetailed({ source: 'anchored.pending', period: { anchor: '2026-03' } }),
    false,
    'an empty pending payload is not detailed data',
  );

  // Real preserved data keeps its detailed status and long TTL.
  assert.equal(preservedEntryIsDetailed({ source: 'combined.agent_usage' }), true);
  assert.equal(preservedEntryIsDetailed({ source: 'openclaw.usage' }), true);
  assert.equal(preservedEntryIsDetailed(undefined), true, 'absent source must not silently downgrade');
});

// ---------------------------------------------------------------------------
// Every producer needs a preservation path, not just OpenClaw and Claude Code
// ---------------------------------------------------------------------------

test('a transient Hermes failure cannot silently drop its slice from a cached month', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  // Hermes previously had no cached-preservation path: if sqlite blipped while
  // another producer succeeded, the merge rewrote the detailed cache without
  // the Hermes agent and did not even mark the result stale.
  assert.match(routeSource, /function isHermesAgent\(agent\)/);
  assert.match(routeSource, /function cachedHermesUsage\(previous, period\)/);
  assert.match(routeSource, /const effectiveHermesData = hermesData \|\| \(preservedPreviousHermes \? cachedHermesUsage\(previous, period\) : null\);/);
  assert.match(routeSource, /mergeUsage\(effectiveOpenClawData, effectiveHermesData, effectiveClaudeCodeData/);
  assert.match(
    routeSource,
    /stale: preservedPreviousOpenClaw\s*\|\| preservedPreviousClaudeCode\s*\|\| preservedPreviousHermes/,
    'a Hermes-preserved result must be reported stale like the other producers',
  );
});

test('a cold partial historical result is reported stale so polling continues', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  // On an uncached month every preservedPrevious* flag is false (there is no
  // prior slice), so staleness must come from the producer statuses themselves
  // — otherwise a partial result looks settled and the page stops retrying.
  // Optional integrations that are absent are settled; only configured failures
  // continue polling.
  assert.match(
    routeSource,
    /stale: preservedPreviousOpenClaw\s*\|\| preservedPreviousClaudeCode\s*\|\| preservedPreviousHermes[\s\S]*?\|\| !openclawData\s*\|\| \(!hermesData && hermesConfigured\(\)\)\s*\|\| \(!claudeCodeData && codexbarConfigured\(\) && !claudeScanEmpty\),/,
    'a configured unavailable producer must mark the combined result stale even with nothing preserved',
  );
});

test('a stale detailed entry falls back to the short TTL', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  assert.match(
    routeSource,
    /const\s+ttl\s*=\s*cached\.detailed\s*&&\s*\!cached\.value\?\.meta\?\.stale\s*\?\s*costsCacheTtl\s*:\s*costsFallbackCacheTtl/,
    'stale detailed entries must use the short fallback TTL',
  );
});

test('scan truncation is propagated to the combined summary, not just stderr', () => {
  const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'openclaw-usage-summary.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  assert.ok(
    scriptSource.split('scanTruncated,').length - 1 >= 3,
    'the top-level and both agent summaries must carry scanTruncated',
  );
  assert.match(routeSource, /scanTruncated:\s*sources\.some\(/);
  assert.match(routeSource, /OpenClaw scan TRUNCATED by the file cap/);
});

test('child tool stderr is surfaced, never swallowed', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  // execPromise captures stderr; destructuring only stdout drops every warning a
  // child emits (scan truncation, degraded modes) — the diagnostic channel goes
  // dark exactly when something is wrong.
  assert.match(routeSource, /function surfaceChildStderr\(label, stderr\)/);
  for (const label of ['OpenClaw Usage Summary', 'Claude Code Usage Summary', 'CodexBar', 'Hermes sqlite']) {
    assert.ok(
      routeSource.includes(`surfaceChildStderr('${label}', stderr)`),
      `${label} must surface its child's stderr`,
    );
  }
  assert.doesNotMatch(
    routeSource,
    /const \{ stdout \} = await execPromise/,
    'no exec site may destructure stdout alone — that silently discards the child stderr',
  );
});

test('an absent optional producer is not retried forever', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  assert.match(routeSource, /function\s+hermesConfigured\(\)/);
  assert.match(routeSource, /function\s+codexbarConfigured\(\)/);
  assert.match(routeSource, /\(!hermesData\s*&&\s*hermesConfigured\(\)\)/);
  assert.match(routeSource, /\(!claudeCodeData\s*&&\s*codexbarConfigured\(\)\s*&&\s*!claudeScanEmpty\)/);
  assert.match(routeSource, /hermesStatus:\s*hermesData\s*\?\s*'ready'\s*:\s*\(hermesConfigured\(\)\s*\?\s*'unavailable'\s*:\s*'not_configured'\)/);
  assert.match(routeSource, /claudeCodeStatus:\s*claudeCodeData\s*\?\s*'ready'\s*:\s*claudeScanEmpty\s*\?\s*'no_usage'\s*:\s*\(codexbarConfigured\(\)\s*\?\s*'unavailable'\s*:\s*'not_configured'\)/);
});

test('costSanity only treats an explicitly unavailable producer as partial', () => {
  const costSanitySource = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'costSanity.js'), 'utf8');

  assert.match(costSanitySource, /sourceStatuses\.includes\('unavailable'\)/);
  assert.ok(!costSanitySource.includes("'not_configured'"));
});

test('an explicitly configured Hermes path stays retryable when the db is missing', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  const functionStart = routeSource.indexOf('function hermesConfigured()');
  assert.ok(functionStart >= 0, 'hermesConfigured must exist');
  const functionEnd = routeSource.indexOf('\n  }', functionStart);
  assert.ok(functionEnd > functionStart, 'hermesConfigured body must be readable');

  const functionSource = routeSource.slice(functionStart, functionEnd);
  assert.match(functionSource, /if \(process\.env\.HERMES_STATE_DB \|\| process\.env\.HERMES_PROFILE_DIR\) return true;/);
  const envCheckIndex = functionSource.indexOf('if (process.env.HERMES_STATE_DB || process.env.HERMES_PROFILE_DIR) return true;');
  const existsSyncIndex = functionSource.indexOf('fs.existsSync(hermesProfileDbPath())');
  assert.ok(envCheckIndex >= 0, 'explicit Hermes configuration must stay retryable');
  assert.ok(existsSyncIndex >= 0, 'hermesConfigured must still support discovery by existence');
  assert.ok(envCheckIndex < existsSyncIndex, 'explicit configuration must be checked before discovery by existence');
});

test('an explicit Hermes path is never silently replaced by discovery', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  // Falling through to the candidate list when an explicit path is missing made
  // the server read a DIFFERENT profile's database than the operator configured
  // — and it also made the configured-but-failed state unreachable, so the
  // retryable/not_configured distinction could never fire.
  const start = routeSource.indexOf('function hermesProfileDbPath()');
  assert.ok(start > -1, 'hermesProfileDbPath must exist');
  const body = routeSource.slice(start, start + 900);
  assert.match(body, /if \(process\.env\.HERMES_STATE_DB\) return process\.env\.HERMES_STATE_DB;/);
  assert.match(body, /if \(process\.env\.HERMES_PROFILE_DIR\) return path\.join\(process\.env\.HERMES_PROFILE_DIR, 'state\.db'\);/);
  assert.ok(
    body.indexOf('HERMES_STATE_DB) return') < body.indexOf('const candidates'),
    'the explicit paths must short-circuit BEFORE the discovery candidate list',
  );
});

test('an empty Claude scan is settled, not retried', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');

  assert.match(routeSource, /let claudeScanEmpty = false;/);
  assert.match(routeSource, /claudeScanEmpty = summary === null;/);
  assert.match(routeSource, /\(!claudeCodeData\s*&&\s*codexbarConfigured\(\)\s*&&\s*!claudeScanEmpty\)/);
  assert.match(routeSource, /claudeCodeStatus:[\s\S]{0,220}'no_usage'/);
});
