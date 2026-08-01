const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');
const { exec } = require('child_process');
const { normalizeUsageCosts, combineApiEquivalentReliability } = require('../services/costSanity');
const {
  buildClaudeCodeUsageSummary,
  hasClaudeCodeAgent,
  mergeCodexBarReports,
  needsClaudeCodeCacheRefresh,
  needsCurrentPeriodRefresh,
  sumUsageSummaries,
} = require('../services/claudeCodeUsage');

// ---------------------------------------------------------------------------
// Month anchor + period window (single source of truth for the /api/costs range)
//
// The Monthly view can be anchored to a PAST calendar month via `?month=YYYY-MM`.
// Three producers derive the same window (this file, scripts/openclaw-usage-summary.js,
// server/services/claudeCodeUsage.js) and tests/costsMonthAnchor.test.js asserts they
// agree — keep the anchored semantics identical if you touch any of them.
// ---------------------------------------------------------------------------

const MONTH_ANCHOR_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// Mirrors the frontend navigator floor (lib.ts monthAnchorFloor).
const MONTH_ANCHOR_HISTORY_MONTHS = 24;

function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
}

function monthKeyOf(date) {
  return dayKey(date).slice(0, 7);
}

function isValidMonthAnchor(value) {
  return MONTH_ANCHOR_PATTERN.test(String(value ?? ''));
}

function shiftMonthAnchor(anchor, delta) {
  const [year, month] = String(anchor).split('-').map(Number);
  const shifted = new Date(year, month - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

function monthAnchorBounds(anchor) {
  const [year, month] = String(anchor).split('-').map(Number);
  return {
    start: new Date(year, month - 1, 1, 0, 0, 0, 0),
    end: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

function dayKeysBetween(start, end) {
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

/**
 * Normalizes the `month` query param.
 *  { ok: true, anchor: null }      -> absent, empty, or the CURRENT month (byte-identical legacy behavior)
 *  { ok: true, anchor: 'YYYY-MM' } -> anchored past month
 *  { ok: false, error }            -> route answers 400
 */
function parseMonthAnchor(value, now = new Date()) {
  if (value === undefined || value === null || value === '') return { ok: true, anchor: null };
  const raw = String(value);
  if (!isValidMonthAnchor(raw)) {
    return { ok: false, error: 'month must be formatted as YYYY-MM with a month between 01 and 12' };
  }
  const current = monthKeyOf(now);
  if (raw > current) return { ok: false, error: 'month cannot be in the future' };
  // Same floor as the UI navigator (monthAnchorFloor): keeps the codexbar scan
  // window bounded without ever silently truncating an accepted request.
  const floor = shiftMonthAnchor(current, -MONTH_ANCHOR_HISTORY_MONTHS);
  if (raw < floor) {
    return { ok: false, error: `month is older than the ${MONTH_ANCHOR_HISTORY_MONTHS}-month history window` };
  }
  return { ok: true, anchor: raw === current ? null : raw };
}

function anchoredMonthRange(anchor) {
  const { start, end } = monthAnchorBounds(anchor);
  const previous = monthAnchorBounds(shiftMonthAnchor(anchor, -1));
  const keys = dayKeysBetween(start, end);
  const previousKeys = dayKeysBetween(previous.start, previous.end);
  return {
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(end.getTime() / 1000),
    keys,
    startKey: keys[0],
    endKey: keys[keys.length - 1],
    previousStartSec: Math.floor(previous.start.getTime() / 1000),
    previousEndSec: Math.floor(previous.end.getTime() / 1000),
    previousKeys,
    anchor,
  };
}

function rangeForPeriod(period, monthAnchor = null, now = new Date()) {
  if (period === 'month' && isValidMonthAnchor(monthAnchor) && String(monthAnchor) < monthKeyOf(now)) {
    return anchoredMonthRange(String(monthAnchor));
  }

  const start = new Date(now);
  if (period === 'day') {
    start.setHours(0, 0, 0, 0);
    const previousStart = new Date(start);
    previousStart.setDate(previousStart.getDate() - 1);
    const previousEnd = new Date(start.getTime() - 1);
    return {
      startSec: Math.floor(start.getTime() / 1000),
      endSec: Math.floor(now.getTime() / 1000),
      keys: [dayKey(start)],
      startKey: dayKey(start),
      endKey: dayKey(now),
      previousStartSec: Math.floor(previousStart.getTime() / 1000),
      previousEndSec: Math.floor(previousEnd.getTime() / 1000),
      previousKeys: [dayKey(previousStart)],
      anchor: null,
    };
  }
  if (period === '7d') {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    const keys = [];
    const cursor = new Date(start);
    while (cursor <= now) {
      keys.push(dayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd);
    previousStart.setHours(0, 0, 0, 0);
    previousStart.setDate(previousStart.getDate() - 6);
    const previousKeys = [];
    const previousCursor = new Date(previousStart);
    while (previousCursor <= previousEnd) {
      previousKeys.push(dayKey(previousCursor));
      previousCursor.setDate(previousCursor.getDate() + 1);
    }
    return {
      startSec: Math.floor(start.getTime() / 1000),
      endSec: Math.floor(now.getTime() / 1000),
      keys,
      startKey: keys[0],
      endKey: keys[keys.length - 1],
      previousStartSec: Math.floor(previousStart.getTime() / 1000),
      previousEndSec: Math.floor(previousEnd.getTime() / 1000),
      previousKeys,
      anchor: null,
    };
  }
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  const keys = [];
  const cursor = new Date(start);
  while (cursor <= now) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  const previousEnd = new Date(start);
  previousEnd.setDate(0);
  const previousStart = new Date(previousEnd);
  previousStart.setDate(1);
  previousEnd.setDate(Math.min(now.getDate(), previousEnd.getDate()));
  previousEnd.setHours(23, 59, 59, 999);
  const previousKeys = [];
  const previousCursor = new Date(previousStart);
  while (previousCursor <= previousEnd) {
    previousKeys.push(dayKey(previousCursor));
    previousCursor.setDate(previousCursor.getDate() + 1);
  }
  return {
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(now.getTime() / 1000),
    keys,
    startKey: keys[0],
    endKey: keys[keys.length - 1],
    previousStartSec: Math.floor(previousStart.getTime() / 1000),
    previousEndSec: Math.floor(previousEnd.getTime() / 1000),
    previousKeys,
    anchor: null,
  };
}

// `codexbar cost --days N` only reaches N days back, so an anchored past month
// needs a window wide enough to cover its first day — AND the first day of the
// month before it: buildClaudeCodeUsageSummary derives the comparison baseline
// (previousPeriodApiEquivalentUsd) from that previous month's rows. With the
// MONTH_ANCHOR_HISTORY_MONTHS floor on anchors, the widest valid window is
// ~25 months, so the safety cap below is unreachable for accepted requests.
const CLAUDE_CODE_SCAN_MAX_DAYS = 800;

function claudeCodeScanDays(monthAnchor, now = new Date()) {
  if (!isValidMonthAnchor(monthAnchor)) return 70;
  const { start } = monthAnchorBounds(shiftMonthAnchor(String(monthAnchor), -1));
  const days = Math.ceil((now.getTime() - start.getTime()) / 86400000) + 2;
  return Math.min(Math.max(days, 70), CLAUDE_CODE_SCAN_MAX_DAYS);
}

function costsCacheKey(period, monthAnchor) {
  return monthAnchor ? `costs:month:${monthAnchor}` : `costs:${period}`;
}

/**
 * Bounds how many detailed refreshes may run at once.
 *
 * Every refresh launches an OpenClaw JSONL scan (tens of seconds, up to
 * MC_OPENCLAW_USAGE_MAX_FILES files), a Hermes sqlite query and a codexbar
 * child process. Anchored months each own a distinct cache key, so clicking
 * through the navigator would otherwise start one full fan-out per month with
 * nothing holding them back. Work is queued, never dropped: the caller still
 * gets the promise for its own key, it just may wait its turn.
 */
function createRefreshLimiter(maxConcurrent = 2) {
  const limit = Math.max(1, Number(maxConcurrent) || 1);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      // LIFO, deliberately: month navigation supersedes: the newest request is
      // the month the user is actually looking at, and its page stops polling
      // after a bounded window. Serving it first keeps bounded work from
      // outliving its only consumer; superseded months still run as the queue
      // drains, they just lose their place to the live selection.
      const job = queue.pop();
      active += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ run: task, resolve, reject });
        pump();
      });
    },
    stats() {
      return { active, queued: queue.length, limit };
    },
  };
}

/**
 * Is a preserved cache entry real data, i.e. worth the long detailed TTL?
 *
 * An `anchored.pending` payload is empty by construction. Marking it detailed
 * would make the server treat it as fresh for the detailed TTL while
 * needsCurrentPeriodRefresh deliberately never fires for an anchored month, so
 * the page would keep polling a value that can never trigger a retry — even if
 * every producer recovered immediately.
 */
function preservedEntryIsDetailed(value) {
  return value?.source !== 'anchored.pending';
}

function cachedUsageAgent(previous, agent) {
  if (!agent?.label) return null;
  const prefix = `${agent.label} / `;
  const prefixedModelKeys = (previous.modelKeys || []).filter((key) => key.startsWith(prefix));
  const modelKeys = prefixedModelKeys.map((key) => key.replace(prefix, ''));
  const dailyByModel = (previous.dailyByModel || []).map((row) => {
    const out = { date: row.date, totalCost: 0, apiEquivalentCost: 0, totalTokens: 0 };
    prefixedModelKeys.forEach((prefixedKey, index) => {
      const key = modelKeys[index];
      const cost = Number(row[prefixedKey] || 0);
      const tokens = Number(row[`${prefixedKey}_tokens`] || 0);
      out[key] = cost;
      out[`${key}_tokens`] = tokens;
      out[`${key}_input`] = Number(row[`${prefixedKey}_input`] || 0);
      out[`${key}_output`] = Number(row[`${prefixedKey}_output`] || 0);
      out[`${key}_reasoning`] = Number(row[`${prefixedKey}_reasoning`] || 0);
      out[`${key}_cacheRead`] = Number(row[`${prefixedKey}_cacheRead`] || 0);
      out[`${key}_cacheWrite`] = Number(row[`${prefixedKey}_cacheWrite`] || 0);
      out[`${key}_apiEquivalentUsd`] = row[`${prefixedKey}_apiEquivalentUsd`] ?? null;
      out[`${key}_apiEquivalentStatus`] = row[`${prefixedKey}_apiEquivalentStatus`] || 'unavailable';
      out[`${key}_costSource`] = row[`${prefixedKey}_costSource`] || 'cached';
      out.totalCost += cost;
      if (out[`${key}_apiEquivalentUsd`] !== null) {
        out.apiEquivalentCost += Number(out[`${key}_apiEquivalentUsd`] || 0);
      }
      out.totalTokens += tokens;
    });
    return out;
  });
  const daily = dailyByModel.map((row) => ({
    date: row.date,
    cost: row.totalCost,
    totalCost: row.totalCost,
    tokens: row.totalTokens,
    totalTokens: row.totalTokens,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    apiEquivalentCost: row.apiEquivalentCost,
  }));
  const byService = (previous.byService || [])
    .filter((item) => item.agent === agent.label || String(item.name || '').startsWith(prefix))
    .map((item) => ({ ...item, name: String(item.name || '').replace(prefix, '') }));

  return {
    key: agent.key,
    label: agent.label,
    accent: agent.accent,
    source: `${agent.source || 'openclaw.usage'}.cached`,
    status: 'stale',
    summary: agent.summary || {},
    daily,
    dailyByModel,
    modelKeys,
    byService,
  };
}

function sumPreviousApiEquivalentUsd(sources = []) {
  let total = 0;
  for (const source of sources) {
    const amount = source.summary?.previousPeriodApiEquivalentUsd;
    const reliability = source.summary?.previousPeriodApiEquivalentReliability;
    if (reliability === 'no_usage' || reliability === 'not_applicable') continue;
    if (reliability !== 'estimated' && reliability !== 'partial') return null;
    if (amount !== null && amount !== undefined && Number.isFinite(Number(amount))) {
      total += Number(amount);
      continue;
    }
    return null;
  }
  return total;
}

function hermesModelName(provider, model) {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p && !m) return 'unknown';
  if (!p || p === 'unknown') return m || 'unknown';
  if (!m || m === 'unknown') return p;
  return `${p}/${m}`;
}

function buildHermesUsageRows(rows, keys) {
  const byModel = new Map();
  const byDay = new Map();
  for (const row of rows) {
    const name = hermesModelName(row.provider, row.model);
    const tokens = Number(row.tokens || 0);
    const cost = Number(row.cost || 0);
    const sessions = Number(row.sessions || 0);
    const existing = byModel.get(name) || {
      name,
      cost: 0,
      tokens: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      sessions: 0,
      costStatus: row.statuses || 'unknown',
      billingModes: row.billingModes || 'unknown',
    };
    existing.cost += cost;
    existing.tokens += tokens;
    existing.input += Number(row.input || 0);
    existing.output += Number(row.output || 0);
    existing.cacheRead += Number(row.cacheRead || 0);
    existing.cacheWrite += Number(row.cacheWrite || 0);
    existing.reasoning += Number(row.reasoning || 0);
    existing.sessions += sessions;
    byModel.set(name, existing);

    const day = byDay.get(row.date) || { date: row.date, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, models: {} };
    day.cost += cost;
    day.tokens += tokens;
    day.input += Number(row.input || 0);
    day.output += Number(row.output || 0);
    day.cacheRead += Number(row.cacheRead || 0);
    day.cacheWrite += Number(row.cacheWrite || 0);
    day.reasoning += Number(row.reasoning || 0);
    const dayModel = day.models[name] || { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    dayModel.cost += cost;
    dayModel.tokens += tokens;
    dayModel.input += Number(row.input || 0);
    dayModel.output += Number(row.output || 0);
    dayModel.cacheRead += Number(row.cacheRead || 0);
    dayModel.cacheWrite += Number(row.cacheWrite || 0);
    dayModel.reasoning += Number(row.reasoning || 0);
    day.models[name] = dayModel;
    byDay.set(row.date, day);
  }

  const daily = keys.map((date) => {
    const day = byDay.get(date) || { date, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, models: {} };
    return { ...day, totalCost: day.cost, totalTokens: day.tokens };
  });
  const byService = Array.from(byModel.values())
    .filter((item) => item.tokens > 0 || item.cost > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((item) => ({ ...item, percentage: 0, costSource: item.cost > 0 ? 'api' : (String(item.costStatus || '').includes('included') ? 'included' : 'unknown') }));
  const periodTokens = daily.reduce((sum, day) => sum + Number(day.tokens || 0), 0);
  const periodUsd = daily.reduce((sum, day) => sum + Number(day.cost || 0), 0);
  byService.forEach((item) => {
    item.percentage = periodTokens > 0 ? Math.round((Number(item.tokens || 0) / periodTokens) * 100) : 0;
  });
  const dailyByModel = daily.map((day) => {
    const out = { date: day.date, totalCost: day.cost, totalTokens: day.tokens };
    for (const svc of byService) {
      const b = day.models[svc.name] || { cost: 0, tokens: 0 };
      out[svc.name] = b.cost || 0;
      out[`${svc.name}_tokens`] = b.tokens || 0;
      out[`${svc.name}_input`] = b.input || 0;
      out[`${svc.name}_output`] = b.output || 0;
      out[`${svc.name}_cacheRead`] = b.cacheRead || 0;
      out[`${svc.name}_cacheWrite`] = b.cacheWrite || 0;
      out[`${svc.name}_reasoning`] = b.reasoning || 0;
      out[`${svc.name}_costSource`] = svc.costSource;
    }
    return out;
  });

  return { daily, byService, dailyByModel, periodTokens, periodUsd };
}

function buildCostsRouter({ mcConfig, projectRoot, sessionsService }) {
  const router = express.Router();
  const execPromise = util.promisify(exec);
  const costsCache = new Map();
  const costsRefreshes = new Map();
  const refreshLimiter = createRefreshLimiter(Number(process.env.MC_COSTS_REFRESH_CONCURRENCY || 2));
  const codexbarScans = new Map();
  // null = not probed yet. Set to false the first time an exec fails because the
  // binary is missing; a missing optional tool must not look like a flaky one.
  let codexbarAvailable = null;

  function noteCodexbarExecError(error) {
    const message = String(error?.message || '');
    if (error?.code === 127 || /not found|ENOENT/i.test(message)) codexbarAvailable = false;
  }

  function codexbarConfigured() {
    return codexbarAvailable !== false;
  }

  const codexbarScanCache = new Map();
  const codexbarScanTtlMs = 30000;

  /**
   * One codexbar child per distinct scan depth: concurrent callers share the
   * in-flight promise, a recent result is reused for a short TTL, and the work
   * itself waits behind the same limiter as the detailed refreshes.
   */
  function codexbarScan(scanDays) {
    const key = `codexbar:${scanDays}`;
    const cached = codexbarScanCache.get(key);
    if (cached && Date.now() - cached.time < codexbarScanTtlMs) return Promise.resolve(cached.stdout);
    if (codexbarScans.has(key)) return codexbarScans.get(key);

    const scan = refreshLimiter.run(async () => {
      let stdout;
      let stderr;
      try {
        ({ stdout, stderr } = await execPromise(`codexbar cost --format json --provider both --days ${scanDays}`, {
          timeout: 30000,
          maxBuffer: 20 * 1024 * 1024,
          env: process.env,
        }));
      } catch (error) {
        noteCodexbarExecError(error);
        throw error;
      }
      surfaceChildStderr('CodexBar', stderr);
      codexbarScanCache.set(key, { stdout, time: Date.now() });
      return stdout;
    }).finally(() => {
      codexbarScans.delete(key);
    });
    codexbarScans.set(key, scan);
    return scan;
  }
  const costsCacheTtl = 60000;
  const costsFallbackCacheTtl = 15000;
  const costsDiskCacheFile = path.join(process.env.MC_COSTS_CACHE_DIR || path.join(os.tmpdir(), 'mission-control'), 'costs-cache.json');
  // OpenClaw's session-cost-usage aggregation can take ~55s for 7d on Yordam's host.
  // A too-low timeout silently produced null OpenClaw data, which mergeUsage then rendered as 0 tokens.
  const openclawUsageTimeoutMs = Number(process.env.MC_OPENCLAW_USAGE_TIMEOUT_MS || 120000);

  function persistCostsCache() {
    try {
      fs.mkdirSync(path.dirname(costsDiskCacheFile), { recursive: true });
      fs.writeFileSync(costsDiskCacheFile, JSON.stringify(Object.fromEntries(costsCache), null, 2));
    } catch (error) {
      console.warn('[Costs API cache persist]', error.message);
    }
  }

  function loadCostsCache() {
    try {
      if (!fs.existsSync(costsDiskCacheFile)) return;
      const raw = JSON.parse(fs.readFileSync(costsDiskCacheFile, 'utf8'));
      Object.entries(raw || {}).forEach(([key, entry]) => {
        if (entry?.value && Number.isFinite(Number(entry.time))) {
          costsCache.set(key, entry);
        }
      });
    } catch (error) {
      console.warn('[Costs API cache load]', error.message);
    }
  }

  function setCostsCache(cacheKey, entry) {
    const previous = costsCache.get(cacheKey);
    if (!entry?.detailed && previous?.detailed) {
      return previous;
    }
    costsCache.set(cacheKey, entry);
    persistCostsCache();
    return entry;
  }

  loadCostsCache();

  function hostUserHome() {
    const candidates = [
      process.env.MC_USER_HOME,
      '/Users/yordamkocatepe',
      process.env.HOME,
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(path.join(candidate, '.openclaw'))) || process.env.HOME || candidates[0];
  }

  // execPromise captures the child's stderr and then it is dropped on the floor,
  // so every warning a child tool emits (scan truncation, degraded modes) became
  // invisible. Diagnostics must land somewhere a human can read.
  function surfaceChildStderr(label, stderr) {
    const text = String(stderr || '').trim();
    if (text) console.warn(`[${label}][child stderr] ${text.slice(0, 2000)}`);
  }

  async function openclawUsageSummary(period = 'month', monthAnchor = null) {
    try {
      const script = path.join(projectRoot, 'scripts', 'openclaw-usage-summary.js');
      const args = [String(period)];
      if (isValidMonthAnchor(monthAnchor)) args.push(String(monthAnchor));
      const { stdout, stderr } = await execPromise(`node ${JSON.stringify(script)} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
        timeout: openclawUsageTimeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, HOME: hostUserHome() },
      });
      surfaceChildStderr('OpenClaw Usage Summary', stderr);
      const trimmed = String(stdout || '').trim();
      if (!trimmed) return null;
      const result = JSON.parse(trimmed);
      if (result && typeof result === 'object') {
        result.source = 'openclaw.usage';
      }
      return result;
    } catch (error) {
      console.error('[OpenClaw Usage Summary]', error.message);
      return null;
    }
  }

  async function claudeCodeUsageSummary(period = 'month', monthAnchor = null) {
    try {
      const days = claudeCodeScanDays(monthAnchor);
      const { stdout, stderr } = await execPromise(`codexbar cost --format json --provider claude --days ${days}`, {
        timeout: 30000,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env,
      });
      surfaceChildStderr('Claude Code Usage Summary', stderr);
      const trimmed = String(stdout || '').trim();
      if (!trimmed) return { data: null, empty: true };
      const summary = buildClaudeCodeUsageSummary(JSON.parse(trimmed), period, new Date(), monthAnchor);
      // An empty-but-successful scan is a settled "no usage" answer; a failure is
      // not. The distinction rides along with THIS result — the limiter runs two
      // refreshes at once, so router-wide state would let one month's outcome
      // decide another month's classification.
      return { data: summary, empty: summary === null };
    } catch (error) {
      noteCodexbarExecError(error);
      console.error('[Claude Code Usage Summary]', error.message);
      return { data: null, empty: false };
    }
  }

  async function sqliteJson(dbPath, sql) {
    const flatSql = String(sql || '').replace(/\s+/g, ' ').trim();
    const { stdout, stderr } = await execPromise(`sqlite3 -json ${JSON.stringify(dbPath)} ${JSON.stringify(flatSql)}`, {
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });
    surfaceChildStderr('Hermes sqlite', stderr);
    const trimmed = String(stdout || '').trim();
    return trimmed ? JSON.parse(trimmed) : [];
  }

  function hermesProfileDbPath() {
    const home = process.env.HOME || '/Users/yordamkocatepe';
    const profile = process.env.HERMES_PROFILE || 'hmudur';
    // An explicitly configured path WINS, even when it does not exist. Falling
    // through to discovery would silently read a different profile's database
    // than the operator asked for; a missing explicit path must surface as a
    // failed producer instead (see hermesConfigured).
    if (process.env.HERMES_STATE_DB) return process.env.HERMES_STATE_DB;
    if (process.env.HERMES_PROFILE_DIR) return path.join(process.env.HERMES_PROFILE_DIR, 'state.db');
    const candidates = [
      process.env.HERMES_STATE_DB,
      process.env.HERMES_PROFILE_DIR ? path.join(process.env.HERMES_PROFILE_DIR, 'state.db') : null,
      path.join(home, '.hermes', 'profiles', profile, 'state.db'),
      home.endsWith(path.join('.hermes', 'profiles', profile, 'home')) ? path.resolve(home, '..', 'state.db') : null,
      '/Users/yordamkocatepe/.hermes/profiles/hmudur/state.db',
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[candidates.length - 1];
  }

  function hermesConfigured() {
    // An explicit path or profile name is a statement of intent: a db that is temporarily
    // missing or on an unmounted volume is a producer that FAILED, not one that
    // was never set up — and only a configured-but-failed producer stays
    // retryable. Discovery-by-existence applies only when nothing was set.
    if (process.env.HERMES_STATE_DB || process.env.HERMES_PROFILE_DIR || process.env.HERMES_PROFILE) return true;
    try {
      return fs.existsSync(hermesProfileDbPath());
    } catch {
      return false;
    }
  }

  async function hermesUsageSummary(period = 'month', monthAnchor = null) {
    const dbPath = hermesProfileDbPath();
    try {
      const r = rangeForPeriod(period, monthAnchor);
      const rows = await sqliteJson(dbPath, `
        SELECT
          date(started_at, 'unixepoch', 'localtime') AS date,
          COALESCE(NULLIF(billing_provider, ''), 'unknown') AS provider,
          COALESCE(NULLIF(model, ''), 'unknown') AS model,
          COUNT(*) AS sessions,
          SUM(COALESCE(input_tokens, 0)) AS input,
          SUM(COALESCE(output_tokens, 0)) AS output,
          SUM(COALESCE(cache_read_tokens, 0)) AS cacheRead,
          SUM(COALESCE(cache_write_tokens, 0)) AS cacheWrite,
          SUM(COALESCE(reasoning_tokens, 0)) AS reasoning,
          SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)) AS tokens,
          SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) AS cost,
          GROUP_CONCAT(DISTINCT COALESCE(NULLIF(cost_status, ''), 'unknown')) AS statuses,
          GROUP_CONCAT(DISTINCT COALESCE(NULLIF(billing_mode, ''), 'unknown')) AS billingModes
        FROM sessions
        WHERE started_at >= ${r.previousStartSec} AND started_at <= ${r.endSec}
        GROUP BY date, provider, model
        ORDER BY date ASC, tokens DESC
      `);
      const currentKeys = new Set(r.keys);
      const previousKeys = new Set(r.previousKeys);
      const currentUsage = buildHermesUsageRows(rows.filter((row) => currentKeys.has(row.date)), r.keys);
      const previousUsage = buildHermesUsageRows(rows.filter((row) => previousKeys.has(row.date)), r.previousKeys);
      const normalizedPreviousUsage = normalizeUsageCosts({
        source: 'hermes.state.db.previous',
        period,
        periodRange: { start: r.previousKeys[0] || null, end: r.previousKeys[r.previousKeys.length - 1] || null },
        summary: { periodUsd: previousUsage.periodUsd },
        daily: previousUsage.daily,
        dailyByModel: previousUsage.dailyByModel,
        modelKeys: previousUsage.byService.map((item) => item.name),
        byService: previousUsage.byService,
      });
      const { daily, byService, dailyByModel, periodTokens, periodUsd } = currentUsage;

      const todayKey = dayKey(new Date());
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayKey = dayKey(yesterday);
      const todayRow = daily.find((day) => day.date === todayKey) || {};
      const yesterdayRow = daily.find((day) => day.date === yesterdayKey) || {};
      const thisWeekRows = daily.slice(-7);

      return {
        source: 'hermes.state.db',
        period,
        periodRange: { start: r.startKey, end: r.endKey },
        summary: {
          periodUsd,
          previousPeriodUsd: null,
          previousPeriodApiEquivalentUsd: normalizedPreviousUsage.summary?.periodApiEquivalentUsd ?? null,
          previousPeriodApiEquivalentReliability: normalizedPreviousUsage.apiEquivalentReliability,
          periodTokens,
          todayUsd: todayRow.cost || 0,
          yesterdayUsd: yesterdayRow.cost || 0,
          thisWeekUsd: thisWeekRows.reduce((sum, day) => sum + Number(day.cost || 0), 0),
          thisMonthUsd: periodUsd,
          totalUsd: periodUsd,
          todayTokens: todayRow.tokens || 0,
          thisWeekTokens: thisWeekRows.reduce((sum, day) => sum + Number(day.tokens || 0), 0),
          thisMonthTokens: periodTokens,
          totalTokens: periodTokens,
          note: `Source: Hermes profile SQLite (${dbPath})`,
        },
        daily,
        dailyByModel,
        modelKeys: byService.map((item) => item.name),
        byService,
      };
    } catch (error) {
      console.error('[Hermes Usage Summary]', error.message);
      return null;
    }
  }

  function namespaceUsage(data, agent) {
    if (!data) return null;
    const label = agent.label;
    const prefix = `${label} / `;
    const byService = (data.byService || []).map((item) => ({ ...item, name: `${prefix}${item.name}`, agent: label }));
    const modelKeys = byService.map((item) => item.name);
    const dailyByModel = (data.dailyByModel || []).map((row) => {
      const out = { date: row.date, totalCost: row.totalCost || 0, totalTokens: row.totalTokens || 0 };
      (data.byService || []).forEach((svc) => {
        const name = `${prefix}${svc.name}`;
        out[name] = Number(row[svc.name] || 0);
        out[`${name}_tokens`] = Number(row[`${svc.name}_tokens`] || 0);
        out[`${name}_input`] = Number(row[`${svc.name}_input`] || 0);
        out[`${name}_output`] = Number(row[`${svc.name}_output`] || 0);
        out[`${name}_cacheRead`] = Number(row[`${svc.name}_cacheRead`] || 0);
        out[`${name}_cacheWrite`] = Number(row[`${svc.name}_cacheWrite`] || 0);
        out[`${name}_reasoning`] = Number(row[`${svc.name}_reasoning`] || 0);
        out[`${name}_apiEquivalentUsd`] = row[`${svc.name}_apiEquivalentUsd`] ?? null;
        out[`${name}_apiEquivalentStatus`] = row[`${svc.name}_apiEquivalentStatus`] || 'unavailable';
        out[`${name}_costSource`] = row[`${svc.name}_costSource`] || svc.costSource || 'unknown';
      });
      return out;
    });
    return {
      ...data,
      byService,
      modelKeys,
      dailyByModel,
      agent: {
        key: agent.key,
        label,
        accent: agent.accent,
        source: agent.source || data.source,
        status: agent.status || 'ready',
        summary: data.summary || {},
        byService,
      },
    };
  }

  function sourceEntriesFromUsage(data, fallbackAgent) {
    if (!data) return [];
    if (Array.isArray(data.agents) && data.agents.length > 0) {
      return data.agents.map((agent) => namespaceUsage({
        source: agent.source || data.source,
        period: data.period,
        periodRange: data.periodRange,
        summary: agent.summary || {},
        daily: agent.daily || [],
        dailyByModel: agent.dailyByModel || [],
        modelKeys: agent.modelKeys || (agent.byService || []).map((item) => item.name),
        byService: agent.byService || [],
      }, {
        ...fallbackAgent,
        ...agent,
        source: agent.source || data.source || fallbackAgent.source,
        status: agent.status || fallbackAgent.status || 'ready',
      }));
    }
    return [namespaceUsage(data, fallbackAgent)];
  }

  function emptyUsage(period, source, monthAnchor = null) {
    const r = rangeForPeriod(period, monthAnchor);
    const daily = r.keys.map((date) => ({ date, cost: 0, totalCost: 0, tokens: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }));
    const dailyByModel = r.keys.map((date) => ({ date, totalCost: 0, totalTokens: 0 }));
    return {
      source,
      period,
      periodRange: { start: r.startKey, end: r.endKey },
      summary: {
        periodUsd: 0,
        previousPeriodUsd: null,
        periodTokens: 0,
        todayUsd: 0,
        yesterdayUsd: 0,
        thisWeekUsd: 0,
        thisMonthUsd: 0,
        totalUsd: 0,
        todayTokens: 0,
        thisWeekTokens: 0,
        thisMonthTokens: 0,
        totalTokens: 0,
        note: `No ${source} usage found for this period`,
      },
      daily,
      dailyByModel,
      modelKeys: [],
      byService: [],
    };
  }

  function mergeUsage(openclawData, hermesData, claudeCodeData, period, monthAnchor = null) {
    if (!openclawData && !hermesData && !claudeCodeData) return null;

    const sources = [
      ...sourceEntriesFromUsage(openclawData, { key: 'openclaw', label: 'OpenClaw', accent: '#5E5CE6', source: 'openclaw.usage', status: 'ready' }),
      ...sourceEntriesFromUsage(hermesData, { key: 'hermes', label: 'Hermes', accent: '#00C7BE', source: 'hermes.state.db', status: 'ready' }),
      ...sourceEntriesFromUsage(claudeCodeData, { key: 'claude_code', label: 'Claude Code', accent: '#D97757', source: 'claude-code.codexbar', status: 'ready' }),
    ].filter(Boolean);
    if (!sources.length) return null;

    const keySet = new Set();
    sources.forEach((src) => (src.daily || []).forEach((day) => keySet.add(day.date)));
    const keys = Array.from(keySet).sort();
    const daily = keys.map((date) => {
      const out = { date, cost: 0, totalCost: 0, tokens: 0, totalTokens: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      sources.forEach((src) => {
        const row = (src.daily || []).find((day) => day.date === date) || {};
        out.cost += Number(row.cost || row.totalCost || 0);
        out.totalCost = out.cost;
        out.tokens += Number(row.tokens || row.totalTokens || 0);
        out.totalTokens = out.tokens;
        out.input += Number(row.input || 0);
        out.output += Number(row.output || 0);
        out.reasoning += Number(row.reasoning || 0);
        out.cacheRead += Number(row.cacheRead || 0);
        out.cacheWrite += Number(row.cacheWrite || 0);
      });
      return out;
    });

    const byService = sources.flatMap((src) => src.byService || []);
    const modelKeys = byService.map((item) => item.name);
    const dailyByModel = keys.map((date) => {
      const out = { date, totalCost: 0, totalTokens: 0 };
      sources.forEach((src) => {
        const row = (src.dailyByModel || []).find((day) => day.date === date) || {};
        out.totalCost += Number(row.totalCost || 0);
        out.totalTokens += Number(row.totalTokens || 0);
        (src.modelKeys || []).forEach((key) => {
          out[key] = Number(row[key] || 0);
          out[`${key}_tokens`] = Number(row[`${key}_tokens`] || 0);
          out[`${key}_input`] = Number(row[`${key}_input`] || 0);
          out[`${key}_output`] = Number(row[`${key}_output`] || 0);
          out[`${key}_reasoning`] = Number(row[`${key}_reasoning`] || 0);
          out[`${key}_cacheRead`] = Number(row[`${key}_cacheRead`] || 0);
          out[`${key}_cacheWrite`] = Number(row[`${key}_cacheWrite`] || 0);
          out[`${key}_apiEquivalentUsd`] = row[`${key}_apiEquivalentUsd`] ?? null;
          out[`${key}_apiEquivalentStatus`] = row[`${key}_apiEquivalentStatus`] || 'unavailable';
          out[`${key}_costSource`] = row[`${key}_costSource`] || 'unknown';
        });
      });
      return out;
    });

    const rawSummaryValues = (field) => sources.map((src) => src.summary?.[field]);
    const summaryValues = (field) => rawSummaryValues(field)
      .filter((value) => value !== null && value !== undefined);
    const sumSummary = (field) => summaryValues(field)
      .reduce((sum, value) => sum + Number(value || 0), 0);
    const sumOptionalSummary = (field) => {
      const rawValues = rawSummaryValues(field);
      const values = summaryValues(field);
      return rawValues.length > 0 && values.length === rawValues.length
        ? values.reduce((sum, value) => sum + Number(value || 0), 0)
        : null;
    };
    const agents = sources.map((src) => src.agent).filter(Boolean);
    const previousPeriodApiEquivalentReliability = combineApiEquivalentReliability(
      sources.map((src) => src.summary?.previousPeriodApiEquivalentReliability),
    );

    return {
      source: 'combined.agent_usage',
      period,
      periodAnchor: monthAnchor || null,
      periodRange: { start: keys[0] || null, end: keys[keys.length - 1] || null },
      summary: {
        periodUsd: sumSummary('periodUsd'),
        previousPeriodUsd: sumOptionalSummary('previousPeriodUsd'),
        previousPeriodApiEquivalentUsd: sumPreviousApiEquivalentUsd(sources),
        previousPeriodApiEquivalentReliability,
        periodTokens: sumSummary('periodTokens'),
        todayUsd: sumSummary('todayUsd'),
        yesterdayUsd: sumSummary('yesterdayUsd'),
        thisWeekUsd: sumSummary('thisWeekUsd'),
        thisMonthUsd: sumSummary('thisMonthUsd'),
        totalUsd: sumSummary('totalUsd'),
        todayTokens: sumSummary('todayTokens'),
        thisWeekTokens: sumSummary('thisWeekTokens'),
        thisMonthTokens: sumSummary('thisMonthTokens'),
        totalTokens: sumSummary('totalTokens'),
        scanTruncated: sources.some((src) => src.summary?.scanTruncated === true),
        note: `Combined view: OpenClaw session-cost-usage + Hermes profile state.db + Claude Code local CodexBar scan${sources.some((src) => src.summary?.scanTruncated === true) ? ' — OpenClaw scan TRUNCATED by the file cap, totals may be understated' : ''}`,
      },
      daily,
      dailyByModel,
      modelKeys,
      byService,
      agents,
    };
  }

  // The sessions fast fallback is derived from CURRENT visible sessions: rolling
  // dates, live token totals. Wearing an anchored month's label it would report
  // today's usage as that month's. A pending anchored month gets an empty window
  // instead — the detailed producers are the only valid historical source.
  function buildAnchoredPendingCost(period, monthAnchor) {
    const range = rangeForPeriod(period, monthAnchor);
    const daily = range.keys.map((date) => ({ date, cost: 0, totalCost: 0, tokens: 0, totalTokens: 0 }));
    return {
      source: 'anchored.pending',
      period: {
        key: period,
        anchor: monthAnchor,
        start: range.startKey,
        end: range.endKey,
      },
      daily,
      summary: {
        periodUsd: 0,
        periodTokens: 0,
        todayUsd: 0,
        thisWeekUsd: 0,
        thisMonthUsd: 0,
        totalUsd: 0,
        todayTokens: 0,
        thisWeekTokens: 0,
        thisMonthTokens: 0,
        totalTokens: 0,
        note: `Historical month ${monthAnchor} is still loading; live session data is not a valid substitute`,
        budget: mcConfig.budget || { monthly: 0, warning: 0 },
      },
      byService: [],
      budget: mcConfig.budget || { monthly: 0 },
      dailyByModel: [],
      modelKeys: [],
    };
  }

  async function buildSessionsFallbackCost(period, monthAnchor = null) {
    if (monthAnchor) return buildAnchoredPendingCost(period, monthAnchor);
    const sessionData = await sessionsService.listVisibleSessions(50);
    const sessions = sessionData.sessions || [];
    const totalTokens = sessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0);

    const byService = Object.entries(
      sessions.reduce((acc, session) => {
        const channel = session.channel || session.kind || session.type || 'sessions';
        if (!acc[channel]) acc[channel] = { tokens: 0, sessions: 0 };
        acc[channel].tokens += session.totalTokens || 0;
        acc[channel].sessions += 1;
        return acc;
      }, {})
    )
      .filter(([, value]) => value.tokens > 0)
      .map(([name, value]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        cost: 0,
        tokens: value.tokens,
        sessions: value.sessions,
        percentage: totalTokens > 0 ? Math.round((value.tokens / totalTokens) * 100) : 0,
      }))
      .sort((left, right) => right.tokens - left.tokens);

    const dailyMap = {};
    sessions.forEach((session) => {
      if (!session.updatedAt) return;
      const day = new Date(session.updatedAt).toISOString().split('T')[0];
      dailyMap[day] = (dailyMap[day] || 0) + (session.totalTokens || 0);
    });

    const daily = [];
    const today = new Date();
    for (let index = 6; index >= 0; index -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - index);
      const dateStr = date.toISOString().split('T')[0];
      daily.push({ date: dateStr, cost: 0, tokens: dailyMap[dateStr] || 0 });
    }

    return {
      source: 'sessions.fast_fallback',
      period: {
        key: period,
        anchor: monthAnchor || null,
        start: daily[0]?.date || null,
        end: daily[daily.length - 1]?.date || null,
      },
      daily,
      summary: {
        periodUsd: 0,
        periodTokens: totalTokens,
        todayUsd: 0,
        thisWeekUsd: 0,
        thisMonthUsd: 0,
        totalUsd: 0,
        todayTokens: 0,
        thisWeekTokens: 0,
        thisMonthTokens: 0,
        totalTokens,
        note: 'Fast fallback: computed from cached visible sessions while detailed usage refreshes in the background',
        budget: mcConfig.budget || { monthly: 0, warning: 0 },
      },
      byService,
      budget: mcConfig.budget || { monthly: 0 },
      dailyByModel: [],
      modelKeys: [],
    };
  }

  function attachCostsMeta(costsResult, meta = {}) {
    const now = new Date().toISOString();
    return {
      ...costsResult,
      // The server's calendar month is the authority for the anchor contract:
      // parseMonthAnchor normalizes against THIS clock, so the UI must classify
      // past-vs-current months by it too. A browser in another time zone would
      // otherwise label a live month-to-date payload as a completed month.
      serverMonth: monthKeyOf(new Date()),
      meta: {
        updatedAt: costsResult?.meta?.updatedAt || now,
        refreshing: false,
        stale: false,
        ...(costsResult?.meta || {}),
        ...meta,
      },
    };
  }

  function isOpenClawDerivedAgent(agent) {
    const key = String(agent?.key || '').toLowerCase();
    const source = String(agent?.source || '').toLowerCase();
    return key === 'openclaw' || key === 'codex_app' || source.startsWith('openclaw.');
  }

  function isClaudeCodeAgent(agent) {
    const key = String(agent?.key || '').toLowerCase();
    const source = String(agent?.source || '').toLowerCase();
    return key === 'claude_code' || source.startsWith('claude-code.');
  }

  function isHermesAgent(agent) {
    const key = String(agent?.key || '').toLowerCase();
    const source = String(agent?.source || '').toLowerCase();
    return key === 'hermes' || source.startsWith('hermes.');
  }

  // A cached slice is worth preserving if it carries ANY usage signal — tokens
  // OR spend. Hermes keeps cost-only services (cost > 0, zero tokens), so a
  // tokens-only predicate silently drops real money from an immutable month.
  function agentHasUsage(agent) {
    return Number(agent?.summary?.periodTokens || 0) > 0
      || Number(agent?.summary?.periodUsd || 0) > 0;
  }

  function cachedFilteredUsage(previous, period, predicate, source, note) {
    const agents = (previous?.agents || [])
      .filter(predicate)
      .map((agent) => cachedUsageAgent(previous, agent))
      .filter(Boolean);
    if (!agents.length) return null;

    const dailyByDate = new Map();
    agents.forEach((agent) => {
      (agent.daily || []).forEach((row) => {
        const current = dailyByDate.get(row.date) || { date: row.date, cost: 0, totalCost: 0, tokens: 0, totalTokens: 0 };
        current.cost += Number(row.cost || row.totalCost || 0);
        current.totalCost = current.cost;
        current.tokens += Number(row.tokens || row.totalTokens || 0);
        current.totalTokens = current.tokens;
        dailyByDate.set(row.date, current);
      });
    });
    const daily = Array.from(dailyByDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const summary = {
      ...sumUsageSummaries(agents),
      note,
    };

    return {
      source,
      period,
      periodRange: {
        start: previous?.period?.start || daily[0]?.date || null,
        end: previous?.period?.end || daily[daily.length - 1]?.date || null,
      },
      summary,
      daily,
      dailyByModel: [],
      modelKeys: [],
      byService: [],
      agents,
    };
  }

  function cachedOpenClawUsage(previous, period) {
    return cachedFilteredUsage(
      previous,
      period,
      isOpenClawDerivedAgent,
      'openclaw.usage.cached',
      'Cached OpenClaw-derived usage split from previous detailed result',
    );
  }

  function cachedHermesUsage(previous, period) {
    return cachedFilteredUsage(
      previous,
      period,
      isHermesAgent,
      'hermes.state.db.cached',
      'Cached Hermes usage from previous detailed result',
    );
  }

  function cachedClaudeCodeUsage(previous, period) {
    return cachedFilteredUsage(
      previous,
      period,
      isClaudeCodeAgent,
      'claude-code.codexbar.cached',
      'Cached Claude Code usage from previous detailed result',
    );
  }

  function detailedCostsResult(period, combinedUsage, meta = {}, monthAnchor = null) {
    const normalizedUsage = normalizeUsageCosts({
      ...combinedUsage,
      meta: { ...(combinedUsage.meta || {}), ...meta },
    });
    const rangeRows = normalizedUsage.daily || [];
    return attachCostsMeta({
      source: normalizedUsage.source,
      period: {
        key: period,
        // Anchored past months are immutable, so needsCurrentPeriodRefresh must not
        // treat "period.end !== today" as staleness. The anchor tag is that signal.
        anchor: monthAnchor || combinedUsage.periodAnchor || null,
        start: normalizedUsage.periodRange?.start || (rangeRows[0]?.date || null),
        end: normalizedUsage.periodRange?.end || (rangeRows[rangeRows.length - 1]?.date || null),
      },
      daily: rangeRows,
      summary: {
        ...(normalizedUsage.summary || {}),
        budget: mcConfig.budget || { monthly: 0, warning: 0 },
      },
      dailyByModel: normalizedUsage.dailyByModel || [],
      modelKeys: normalizedUsage.modelKeys || [],
      byService: normalizedUsage.byService || [],
      agents: normalizedUsage.agents || [],
      costReliability: normalizedUsage.costReliability,
      apiEquivalentReliability: normalizedUsage.apiEquivalentReliability,
      budget: mcConfig.budget || { monthly: 0 },
    }, meta);
  }

  function refreshCostsCache(cacheKey, period, monthAnchor = null) {
    if (costsRefreshes.has(cacheKey)) return costsRefreshes.get(cacheKey);

    const startedAt = new Date().toISOString();
    // The queue is entered here, not around the whole function: the cacheKey
    // guard above must still de-duplicate concurrent requests for the SAME
    // month immediately, while distinct months line up behind the limiter.
    const refresh = refreshLimiter.run(() => new Promise((resolve) => {
      setImmediate(async () => {
        try {
          const [openclawData, hermesData, claudeCodeResult] = await Promise.all([
            openclawUsageSummary(period, monthAnchor),
            hermesUsageSummary(period, monthAnchor),
            claudeCodeUsageSummary(period, monthAnchor),
          ]);
          const claudeCodeData = claudeCodeResult?.data ?? null;
          const claudeScanEmpty = claudeCodeResult?.empty === true;
          const previous = costsCache.get(cacheKey)?.value;
          const hasPreviousOpenClaw = !!previous?.agents?.some((agent) => isOpenClawDerivedAgent(agent) && agentHasUsage(agent));
          const hasPreviousClaudeCode = hasClaudeCodeAgent(previous);
          // Hermes had no preservation path: a transient sqlite failure while
          // another producer succeeded overwrote the cached result WITHOUT the
          // Hermes slice, silently understating a month that cannot change.
          const hasPreviousHermes = !!previous?.agents?.some((agent) => isHermesAgent(agent) && agentHasUsage(agent));
          const preservedPreviousOpenClaw = !openclawData && hasPreviousOpenClaw;
          const preservedPreviousClaudeCode = !claudeCodeData && hasPreviousClaudeCode;
          const preservedPreviousHermes = !hermesData && hasPreviousHermes;
          const effectiveOpenClawData = openclawData || (preservedPreviousOpenClaw ? cachedOpenClawUsage(previous, period) : null);
          const effectiveClaudeCodeData = claudeCodeData || (preservedPreviousClaudeCode ? cachedClaudeCodeUsage(previous, period) : null);
          const effectiveHermesData = hermesData || (preservedPreviousHermes ? cachedHermesUsage(previous, period) : null);
          const combinedUsage = mergeUsage(effectiveOpenClawData, effectiveHermesData, effectiveClaudeCodeData, period, monthAnchor);
          if (combinedUsage) {
            const costsResult = detailedCostsResult(period, combinedUsage, {
              refreshing: false,
              // A cold month has no prior slice to preserve, so the
              // preservedPrevious* flags stay false even when a producer just
              // failed. Without this the incomplete result looks settled, the
              // page stops polling, and an immutable month stays understated
              // for the rest of the view. Any unavailable producer means the
              // answer is not final yet — the retry loop is bounded either way.
              stale: preservedPreviousOpenClaw
                || preservedPreviousClaudeCode
                || preservedPreviousHermes
                // Only a CONFIGURED producer that failed is worth retrying. An
                // absent optional integration is a settled state, not a fault.
                || !openclawData
                || (!hermesData && hermesConfigured())
                || (!claudeCodeData && codexbarConfigured() && !claudeScanEmpty),
              refreshStartedAt: startedAt,
              openclawStatus: openclawData ? 'ready' : 'unavailable',
              hermesStatus: hermesData ? 'ready' : (hermesConfigured() ? 'unavailable' : 'not_configured'),
              claudeCodeStatus: claudeCodeData
                ? 'ready'
                : claudeScanEmpty
                  ? 'no_usage'
                  : (codexbarConfigured() ? 'unavailable' : 'not_configured'),
              preservedPreviousOpenClaw,
              preservedPreviousClaudeCode,
              preservedPreviousHermes,
            }, monthAnchor);
            setCostsCache(cacheKey, { value: costsResult, time: Date.now(), detailed: true });
            resolve(costsResult);
            return;
          }

          if (!costsCache.has(cacheKey)) {
            const fallback = attachCostsMeta(await buildSessionsFallbackCost(period, monthAnchor), {
              refreshing: false,
              stale: false,
              openclawStatus: 'unavailable',
              hermesStatus: 'unavailable',
              claudeCodeStatus: 'unavailable',
            });
            setCostsCache(cacheKey, { value: fallback, time: Date.now(), detailed: false });
            resolve(fallback);
            return;
          }

          const previousEntry = costsCache.get(cacheKey);
          if (previousEntry) {
            const preserved = attachCostsMeta(previousEntry.value, {
              refreshing: false,
              stale: true,
              refreshStartedAt: startedAt,
              openclawStatus: 'unavailable',
              hermesStatus: 'unavailable',
              claudeCodeStatus: 'unavailable',
              preservedPreviousUsage: true,
            });
            // An empty anchored.pending payload is NOT detailed data: marking it
            // so would give it the long detailed TTL, and since
            // needsCurrentPeriodRefresh deliberately never fires for an anchored
            // month, the page would poll against a value the server considers
            // fresh — unable to retry even if the producers recovered at once.
            setCostsCache(cacheKey, { value: preserved, time: Date.now(), detailed: preservedEntryIsDetailed(preserved) });
            resolve(preserved);
            return;
          }

          resolve(null);
        } catch (error) {
          console.error('[Costs API background refresh]', error.message);
          resolve(null);
        } finally {
          costsRefreshes.delete(cacheKey);
        }
      });
    }));
    costsRefreshes.set(cacheKey, refresh);
    return refresh;
  }

  router.get('/api/costs', async (req, res) => {
    try {
      const period = String(req.query.period || 'month');
      const parsedAnchor = parseMonthAnchor(req.query.month);
      if (!parsedAnchor.ok) return res.status(400).json({ error: parsedAnchor.error });
      // The anchor only shapes the Monthly window; day/7d ignore it entirely.
      const monthAnchor = period === 'month' ? parsedAnchor.anchor : null;
      const cacheKey = costsCacheKey(period, monthAnchor);
      const cached = costsCache.get(cacheKey);
      const refreshing = costsRefreshes.has(cacheKey);

      if (cached) {
        const ageMs = Date.now() - cached.time;
        // A stale detailed entry (some producer was unavailable) must not hold
        // the long TTL: recovery would go unnoticed for a full minute. It gets
        // the short fallback TTL instead — long enough that 2.5s polls mostly
        // observe the deduplicated refresh rather than starting new scans.
        const ttl = cached.detailed && !cached.value?.meta?.stale
          ? costsCacheTtl
          : costsFallbackCacheTtl;
        const isFresh = ageMs < ttl
          && !needsClaudeCodeCacheRefresh(cached.value)
          && !needsCurrentPeriodRefresh(cached.value);
        if (!isFresh && !refreshing) refreshCostsCache(cacheKey, period, monthAnchor);
        const normalizedCachedValue = normalizeUsageCosts(cached.value);
        return res.json(attachCostsMeta(normalizedCachedValue, {
          refreshing: refreshing || !isFresh,
          stale: Boolean(cached.value?.meta?.stale) || !isFresh,
          ageMs,
        }));
      }

      if (!refreshing) refreshCostsCache(cacheKey, period, monthAnchor);
      const fallback = attachCostsMeta(await buildSessionsFallbackCost(period, monthAnchor), {
        refreshing: true,
        stale: false,
        openclawStatus: 'refreshing',
        hermesStatus: 'refreshing',
        claudeCodeStatus: 'refreshing',
      });
      setCostsCache(cacheKey, { value: fallback, time: Date.now(), detailed: false });
      return res.json(fallback);
    } catch (error) {
      console.error('[Costs API]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });


  router.get('/api/costs/codexbar', async (req, res) => {
    // Same anchor contract as /api/costs: an anchored past month widens the
    // scan so the codexbar-derived UI cells aren't zero-filled for months
    // older than the default 70-day window. Validation runs before the exec.
    const parsedAnchor = parseMonthAnchor(req.query.month);
    if (!parsedAnchor.ok) {
      return res.status(400).json({ error: parsedAnchor.error });
    }
    try {
      const scanDays = claudeCodeScanDays(parsedAnchor.anchor);
      // Navigating months would otherwise spawn one codexbar child per selection,
      // outside the refresh limiter. Same scan depth = same work, so requests are
      // de-duplicated by depth, share one in-flight process, briefly cached, and
      // queued behind the same concurrency bound as the detailed refreshes.
      const stdout = await codexbarScan(scanDays);
      const data = JSON.parse(stdout);
      const raw = mergeCodexBarReports(data);
      if (!raw) throw new Error('CodexBar returned no Codex or Claude usage reports');

      const daily = (raw.daily || []).map((day) => ({
        date: day.date,
        totalCost: day.totalCost || 0,
        totalTokens: day.totalTokens || 0,
        inputTokens: day.inputTokens || 0,
        outputTokens: day.outputTokens || 0,
        models: (day.modelBreakdowns || []).map((model) => ({
          model: model.modelName,
          cost: model.cost || 0,
          totalTokens: model.totalTokens || 0,
        })),
      }));

      const totals = raw.totals || {};
      return res.json({
        source: 'codexbar',
        provider: raw.provider,
        updatedAt: raw.updatedAt || null,
        last30DaysCostUSD: raw.last30DaysCostUSD || 0,
        last30DaysTokens: raw.last30DaysTokens || 0,
        sessionCostUSD: raw.sessionCostUSD || 0,
        sessionTokens: raw.sessionTokens || 0,
        totals: {
          totalCost: totals.totalCost || 0,
          totalTokens: totals.totalTokens || 0,
          inputTokens: totals.inputTokens || 0,
          outputTokens: totals.outputTokens || 0,
        },
        daily,
      });
    } catch (error) {
      console.error('CodexBar costs error:', error.message);
      return res.status(500).json({ error: `Failed to load CodexBar cost data: ${error.message}` });
    }
  });

  return router;
}

module.exports = {
  buildCostsRouter,
  cachedUsageAgent,
  claudeCodeScanDays,
  costsCacheKey,
  createRefreshLimiter,
  preservedEntryIsDetailed,
  isValidMonthAnchor,
  parseMonthAnchor,
  rangeForPeriod,
  shiftMonthAnchor,
  sumPreviousApiEquivalentUsd,
};
