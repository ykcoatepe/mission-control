const fs = require('fs');
const path = require('path');
const {
  buildClaudeCodeUsageSummary,
  hasClaudeCodeAgent,
  mergeCodexBarReports,
  needsClaudeCodeCacheRefresh,
  needsCurrentPeriodRefresh,
  sumUsageSummaries,
} = require('../../services/claudeCodeUsage');

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

// Confirmed-empty evidence decays: transcripts for a past month can be restored or appended after the scan, and the cheap availability probes never inspect OpenClaw. After the TTL the month falls back to "unknown" (selectable), and selecting it runs a fresh detailed scan that re-stamps the entry. Calibration: detailed rescans are user-triggered and cheap at this cadence; revisit if users report months flickering back on.
const CONFIRMED_EMPTY_TTL_MS = 24 * 60 * 60 * 1000;

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

function hostUserHome() {
  const candidates = [
    process.env.MC_USER_HOME,
    '/Users/yordamkocatepe',
    process.env.HOME,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, '.openclaw'))) || process.env.HOME || candidates[0];
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

// The codex home the usage script must scan. Resolved HERE and pinned into the
// child env as MC_CODEX_HOME (an explicit configuration signal) so a stray
// CODEX_HOME inherited from whichever agent launched the server cannot
// silently redirect the Codex buckets.
function codexHomePath() {
  if (process.env.MC_CODEX_HOME) return process.env.MC_CODEX_HOME;
  // An explicit MC_USER_HOME is authoritative for the codex home even when it
  // holds no .openclaw tree: hostUserHome() validates its candidates by
  // .openclaw presence, and that check must not veto a codex-only home.
  if (process.env.MC_USER_HOME) return path.join(process.env.MC_USER_HOME, '.codex');
  return path.join(hostUserHome(), '.codex');
}

// Identity of the data sources a detailed scan actually read. Confirmed-empty
// evidence is only valid under the SAME identity: pointing the server at a
// different OpenClaw home, Hermes profile, or Codex home invalidates old
// emptiness.
function producerFingerprint() {
  return [hostUserHome(), hermesProfileDbPath(), codexHomePath()].join('|');
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

module.exports = {
  cachedUsageAgent,
  claudeCodeScanDays,
  CONFIRMED_EMPTY_TTL_MS,
  costsCacheKey,
  createRefreshLimiter,
  preservedEntryIsDetailed,
  isValidMonthAnchor,
  parseMonthAnchor,
  rangeForPeriod,
  shiftMonthAnchor,
  sumPreviousApiEquivalentUsd,
  codexHomePath,
  producerFingerprint,
};
