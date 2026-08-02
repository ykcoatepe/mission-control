#!/usr/bin/env node
/**
 * openclaw-usage-summary.js
 * Fast, bounded OpenClaw + standalone Codex token/cost summary for Mission
 * Control. Scans ~/.openclaw/agents session JSONL (OpenClaw bucket, nested
 * codex-home runs included) and ~/.codex/sessions rollouts (Codex App vs
 * Codex CLI buckets, split by session_meta originator).
 *
 * The official OpenClaw session-cost-usage bundle currently walks every session
 * with loadSessionCostSummary and can hang for minutes on Yordam's session corpus.
 * This script reads the persisted session JSONL usage records directly instead:
 * one pass over recent files, no gateway calls, no per-session bundle fan-out.
 */
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const costSanity = require('../server/services/costSanity');

const VALID_PERIODS = new Set(['day', '7d', 'month']);
const MONTH_ANCHOR_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// Bucket contract (2026-08-02): OpenClaw owns EVERYTHING it launched — native
// sessions and its nested agent/codex-home Codex runs alike. The Codex buckets
// come from the standalone Codex home (~/.codex/sessions): "Codex Desktop"
// originator = the Codex/ChatGPT desktop app, every other originator
// (codex_exec spawns from Claude Code, Hermes, scripts) = Codex CLI.
const SESSION_BUCKETS = [
  {
    key: 'openclaw',
    label: 'OpenClaw',
    accent: '#5E5CE6',
    source: 'openclaw.sessions',
  },
  {
    key: 'codex_app',
    label: 'Codex App Sessions',
    accent: '#64D2FF',
    source: 'codex.app_sessions',
  },
  {
    key: 'codex_cli',
    label: 'Codex CLI',
    accent: '#FF9500',
    source: 'codex.cli_sessions',
  },
];

function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
}

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

// Anchored past month: FULL calendar month, previous = FULL preceding month.
// Must stay identical to server/routes/costs.js and server/services/claudeCodeUsage.js.
function anchoredMonthRange(anchor) {
  const current = monthAnchorBounds(anchor);
  const previous = monthAnchorBounds(shiftMonthAnchor(anchor, -1));
  const keys = dayKeysBetween(current.start, current.end);
  const previousKeys = dayKeysBetween(previous.start, previous.end);
  return {
    startMs: current.start.getTime(),
    endMs: current.end.getTime(),
    keys,
    startKey: keys[0],
    endKey: keys[keys.length - 1],
    anchor,
    previous: {
      startMs: previous.start.getTime(),
      endMs: previous.end.getTime(),
      keys: previousKeys,
      startKey: previousKeys[0],
      endKey: previousKeys[previousKeys.length - 1],
      anchor: shiftMonthAnchor(anchor, -1),
    },
  };
}

function rangeForPeriod(period, monthAnchor = null, now = new Date()) {
  if (period === 'month' && isValidMonthAnchor(monthAnchor) && String(monthAnchor) < dayKey(now).slice(0, 7)) {
    return anchoredMonthRange(String(monthAnchor));
  }
  const start = new Date(now);
  if (period === 'day') {
    start.setHours(0, 0, 0, 0);
    const previousStart = new Date(start);
    previousStart.setDate(previousStart.getDate() - 1);
    const previousEnd = new Date(previousStart);
    previousEnd.setHours(23, 59, 59, 999);
    return {
      startMs: start.getTime(),
      endMs: now.getTime(),
      keys: [dayKey(start)],
      startKey: dayKey(start),
      endKey: dayKey(now),
      previous: {
        startMs: previousStart.getTime(),
        endMs: previousEnd.getTime(),
        keys: [dayKey(previousStart)],
        startKey: dayKey(previousStart),
        endKey: dayKey(previousEnd),
      },
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
      startMs: start.getTime(),
      endMs: now.getTime(),
      keys,
      startKey: keys[0],
      endKey: keys[keys.length - 1],
      previous: {
        startMs: previousStart.getTime(),
        endMs: previousEnd.getTime(),
        keys: previousKeys,
        startKey: previousKeys[0],
        endKey: previousKeys[previousKeys.length - 1],
      },
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
    startMs: start.getTime(),
    endMs: now.getTime(),
    keys,
    startKey: keys[0],
    endKey: keys[keys.length - 1],
    previous: {
      startMs: previousStart.getTime(),
      endMs: previousEnd.getTime(),
      keys: previousKeys,
      startKey: previousKeys[0],
      endKey: previousKeys[previousKeys.length - 1],
    },
  };
}

function modelName(provider, model, record = {}) {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p && !m) return 'unknown';
  // OpenClaw native Codex session_meta often records provider=openai but omits
  // model. Yordam's default OpenClaw model is GPT-5.5, which is subscription
  // included; leaving this as openai/unknown makes Mission Control show a fake
  // unknown-cost bucket for most OpenClaw tokens. Codex rollouts (standalone
  // home or nested codex-home) record the model per turn, so a model-less
  // record there stays openai/unknown instead of inheriting that default.
  if (p === 'openai' && (!m || m === 'unknown')) {
    return isCodexRolloutRecord(record)
      ? 'openai/unknown'
      : process.env.MC_OPENCLAW_DEFAULT_MODEL || 'openai/gpt-5.5';
  }
  if (!p) return m;
  if (!m) return p;
  return `${p}/${m}`;
}

function applyModelContext(context, payload = {}) {
  const provider = payload.model_provider_id || payload.model_provider || payload.provider;
  const model = payload.model || payload.model_id;
  if (
    provider
    && providerFamily(provider) !== providerFamily(context.provider)
    && !model
  ) context.model = '';
  context.provider = provider || context.provider;
  context.model = model || context.model;
}

function providerFamily(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return [
    'openai',
    'openai-codex',
    'openai-responses',
    'openai-chatgpt-responses',
  ].includes(normalized)
    ? 'openai'
    : normalized;
}

function sessionMetaBillingMode(payload = {}) {
  const source = typeof payload.source === 'string'
    ? payload.source
    : payload.source && typeof payload.source === 'object'
      ? Object.keys(payload.source)[0]
      : '';
  return payload.originator === 'openclaw' && (source === 'vscode' || source === 'subagent')
    ? 'subscription_included'
    : '';
}

function isSubscriptionIncludedRecord(record = {}) {
  return record.provider === 'openai-codex'
    || record.billingProvider === 'openai-codex'
    || record.billingMode === 'subscription_included';
}

// A "codex rollout" is a session transcript written by the Codex CLI/app —
// either into the standalone Codex home or into an OpenClaw agent's nested
// codex-home. The distinction drives model-name fallbacks, not bucketing.
function isCodexRolloutRecord(record = {}) {
  if (record.origin === 'codex') return true;
  const normalized = String(record.sessionKey || '').split(path.sep).join('/');
  return normalized.includes('/agent/codex-home/sessions/');
}

function sessionMetaSourceKey(payload = {}) {
  return typeof payload.source === 'string'
    ? payload.source
    : payload.source && typeof payload.source === 'object'
      ? Object.keys(payload.source)[0]
      : '';
}

// Rollout classification needs BOTH originator and source: neither alone is
// sufficient on the real corpus (2026-08-02 census). Observed originators:
// "Codex Desktop" / "codex_work_desktop" (desktop installs, but source:"exec"
// means a codex exec run that merely inherited the desktop originator),
// "codex_exec" / "codex_cli_rs" / "codex-tui" (CLI/TUI), and "hermes" —
// Hermes drives Codex over the app-server protocol and records the SAME
// tokens in its own state.db (verified: session 20260702_192320_d80d9474 =
// 30.09M tokens vs 20.86M in the matching rollouts), so hermes-owned rollouts
// are EXCLUDED here and counted once via the Hermes bucket.
// An unknown originator is NOT silently swallowed: it classifies as CLI and
// is reported through the unrecognizedOriginators counter (stderr + summary).
const KNOWN_CLI_ORIGINATORS = new Set(['codex_exec', 'codex_cli_rs', 'codex-tui', 'codex_cli']);

function classifyCodexSession(originator, sourceKey) {
  const o = String(originator || '').trim().toLowerCase();
  if (o === 'hermes') return 'hermes_owned';
  if (o.includes('desktop')) return sourceKey === 'exec' ? 'codex_cli' : 'codex_app';
  if (KNOWN_CLI_ORIGINATORS.has(o)) return 'codex_cli';
  return 'unrecognized';
}

function bucketForRecord(record = {}) {
  if (record.origin === 'codex') {
    return record.codexClass === 'codex_app'
      ? SESSION_BUCKETS[1]
      : SESSION_BUCKETS[2];
  }
  // Everything under ~/.openclaw belongs to OpenClaw — including its nested
  // agent/codex-home Codex runs, which OpenClaw itself launched.
  return SESSION_BUCKETS[0];
}

function usageCostTotal(cost) {
  if (typeof cost === 'number') return Number.isFinite(cost) ? cost : 0;
  if (!cost || typeof cost !== 'object') return 0;
  return Number(cost.total || cost.totalCost || cost.usd || 0) || 0;
}

function usageNumber(usage, keys) {
  for (const key of keys) {
    if (usage[key] !== undefined && usage[key] !== null) return Number(usage[key]) || 0;
  }
  return 0;
}

function normalizeUsageNumbers(usage = {}) {
  const input = usageNumber(usage, ['input', 'inputTokens', 'promptTokens', 'input_tokens']);
  const output = usageNumber(usage, ['output', 'outputTokens', 'completionTokens', 'output_tokens']);
  const cacheRead = usageNumber(usage, ['cacheRead', 'cacheReadTokens', 'cachedInputTokens', 'cached_input_tokens', 'cache_read_tokens']);
  const cacheWrite = usageNumber(usage, ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens']);
  const totalTokens = usageNumber(usage, ['totalTokens', 'tokens', 'total_tokens']) || input + output + cacheRead + cacheWrite;
  const totalCost = usageCostTotal(usage.cost);
  return { input, output, cacheRead, cacheWrite, totalTokens, totalCost };
}

function extractUsageRecord(obj, fallbackTimestampMs, sessionKey, context = {}) {
  if (!obj || typeof obj !== 'object') return null;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const tokenCount = obj.type === 'event_msg' && obj.payload?.type === 'token_count'
    ? obj.payload?.info?.last_token_usage
    : null;
  const usage = message?.usage || tokenCount;
  if (!usage || typeof usage !== 'object') return null;

  const { input, output, cacheRead, cacheWrite, totalTokens, totalCost } = normalizeUsageNumbers(usage);
  if (totalTokens <= 0 && totalCost <= 0) return null;

  const timestampRaw = message?.timestamp || obj.timestamp;
  const timestampMs = typeof timestampRaw === 'number'
    ? (timestampRaw < 10_000_000_000 ? timestampRaw * 1000 : timestampRaw)
    : Date.parse(timestampRaw || '') || fallbackTimestampMs;
  const explicitProvider = message?.provider || message?.api;
  const explicitModel = message?.model || message?.modelId;
  const providerMatchesContext = !explicitProvider || (
    context.provider
    && providerFamily(explicitProvider) === providerFamily(context.provider)
  );
  const contextualModel = providerMatchesContext
    ? context.model
    : '';
  const provider = !explicitModel && contextualModel && explicitProvider
    ? context.provider
    : explicitProvider || context.provider || 'unknown';

  return {
    timestampMs,
    date: dayKey(new Date(timestampMs)),
    provider,
    model: explicitModel || contextualModel || 'unknown',
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalCost,
    billingProvider: explicitProvider || context.provider || '',
    billingMode: message?.billingMode || message?.billing_mode || usage.billingMode || usage.billing_mode || context.billingMode || '',
    sessionKey,
  };
}

function listJsonlFiles(dir, agentId, agentsBase, startMs, files, depth = 0, origin = 'openclaw', keyPrefix = '') {
  if (depth > 10) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) listJsonlFiles(fullPath, agentId, agentsBase, startMs, files, depth + 1, origin, keyPrefix);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.endsWith('.trajectory.jsonl')) continue;
    try {
      const stat = fs.statSync(fullPath);
      // mtime is a coarse prefilter only; each usage record is checked by timestamp below.
      if (stat.mtimeMs >= startMs - 24 * 60 * 60 * 1000) {
        // birthtime bounds the OLDEST record a file can hold: a session created
        // after the anchored window cannot contain that month's records, while a
        // session created inside it can — even if it was appended much later.
        // Not every filesystem reports it, so 0/absent means "unknown".
        const birthtimeMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
          ? stat.birthtimeMs
          : null;
        files.push({
          agentId,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          birthtimeMs,
          origin,
          sessionKey: keyPrefix + path.relative(agentsBase, fullPath),
        });
      }
    } catch {}
  }
}

function findSessionDirs(root, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.name === 'sessions') {
      out.push(fullPath);
    } else {
      findSessionDirs(fullPath, out, depth + 1);
    }
  }
  return out;
}

function codexSessionsRoot() {
  const codexHome = process.env.MC_CODEX_HOME
    || process.env.CODEX_HOME
    || path.join(process.env.HOME || '/home/ubuntu', '.codex');
  return path.join(codexHome, 'sessions');
}

// The router passes the authoritative path via MC_HERMES_DB_PATH (see
// server/routes/costs.js hermesProfileDbPath — the single source for the
// discovery rules). The HOME-scoped default below only covers standalone CLI
// runs of this script and deliberately has no absolute-path fallbacks.
function hermesDbPath() {
  if (process.env.MC_HERMES_DB_PATH) return process.env.MC_HERMES_DB_PATH;
  const profile = process.env.HERMES_PROFILE || 'hmudur';
  return path.join(process.env.HOME || '/home/ubuntu', '.hermes', 'profiles', profile, 'state.db');
}

function listSessionFiles(startMs) {
  const agentsBase = path.join(process.env.HOME || '/home/ubuntu', '.openclaw', 'agents');
  const files = [];
  let agents = [];
  try {
    agents = fs.readdirSync(agentsBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    agents = [];
  }

  for (const agentId of agents) {
    const agentRoot = path.join(agentsBase, agentId);
    for (const sessionsDir of findSessionDirs(agentRoot)) {
      listJsonlFiles(sessionsDir, agentId, agentsBase, startMs, files);
    }
  }

  // Standalone Codex home rollouts: the Codex/ChatGPT desktop app and every
  // codex CLI spawn that runs outside OpenClaw write here. The key prefix keeps
  // these session keys from colliding with OpenClaw-relative paths.
  const codexRoot = codexSessionsRoot();
  listJsonlFiles(codexRoot, 'codex', codexRoot, startMs, files, 0, 'codex', 'codex-sessions/');

  return files;
}

// The scan cap keeps the newest files, which silently evicts an anchored month
// on installations with more recent files than the cap. Files are NOT filtered
// by an mtime upper bound — a session opened in the anchored month and appended
// to later still carries that month's records — they are RANKED: anything last
// touched inside the window (plus a day of slack) is scanned first, and newer
// files only fill whatever budget is left.
// Ranks decide who survives the scan cap; nothing is dropped outright.
//
// Filesystem timestamps are only ever POSITIVE evidence here. mtime inside the
// window, or a birthtime at//before it, means the file can plausibly hold the
// anchored month's records — that promotes it. The reverse is NOT true: copying
// or restoring a `.openclaw` tree rewrites birthtime to the copy time, so a
// transcript full of March records can legitimately carry an August birthtime.
// Treating that as proof of irrelevance would silently understate the month, so
// there is no "proven irrelevant" rank — everything unproven shares rank 1 and
// is ordered by recency, and truncation is reported (see scanTruncated) rather
// than hidden.
//   0 — plausibly overlaps the anchored window
//   1 — cannot be ruled in or out
function scanFileRank(file, windowEnd) {
  if (file.mtimeMs <= windowEnd) return 0;
  if (file.birthtimeMs === null || file.birthtimeMs === undefined) return 1;
  return file.birthtimeMs <= windowEnd ? 0 : 1;
}

function prioritizeScanFiles(files, range, maxFiles) {
  const limit = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 20000;
  const windowEnd = range.endMs + 24 * 60 * 60 * 1000;
  return files
    .map((file) => ({ file, rank: scanFileRank(file, windowEnd) }))
    .sort((a, b) => a.rank - b.rank || b.file.mtimeMs - a.file.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

async function scanUsageRecords(range) {
  const files = listSessionFiles(range.startMs);
  const records = [];
  const maxFiles = Number(process.env.MC_OPENCLAW_USAGE_MAX_FILES || 20000);
  const scanFiles = prioritizeScanFiles(files, range, maxFiles);
  // Exclusions and unknowns must stay visible: zero-output-with-green-signals
  // is the failure mode this dashboard exists to prevent.
  const hermesOwned = { files: new Set(), tokens: 0 };
  const hermesRetained = { files: new Set(), tokens: 0 };
  const unrecognizedOriginators = new Map();
  // hermes-owned rollouts duplicate Hermes state.db tokens — but only when
  // that db actually exists. Dropping them with no db present would erase the
  // tokens from EVERY bucket, so exclusion is gated on availability.
  const hermesDbAvailable = fs.existsSync(hermesDbPath());

  for (const file of scanFiles) {
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // Standalone Codex home rollouts run under the ChatGPT subscription and
    // never persist a cost figure; without this default they would surface as
    // unknown metered spend instead of subscription-included usage.
    // KALİBRASYON NOTU: bu bir varsayımdır, transcript'ten kanıtı yoktur —
    // session_meta hiçbir auth/fatura alanı taşımıyor (2026-08-02 censusu).
    // Dayanak: bu makinedeki tüm yerel codex kullanımı ChatGPT-auth ve rollout
    // hiçbir zaman cost kaydetmiyor. Gözden geçirme koşulu: rollout'lar cost>0
    // yazmaya başlarsa ya da API-key auth kullanılırsa bu varsayılan kalkar.
    const context = {
      provider: '',
      model: '',
      billingMode: file.origin === 'codex' ? 'subscription_included' : '',
      originator: '',
      // No session_meta at all ⇒ stays unrecognized ⇒ CLI bucket + counter.
      codexClass: file.origin === 'codex' ? 'unrecognized' : '',
    };
    for await (const line of rl) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'session_meta' && obj.payload && typeof obj.payload === 'object') {
        applyModelContext(context, obj.payload);
        context.billingMode = sessionMetaBillingMode(obj.payload) || context.billingMode;
        if (obj.payload.originator) context.originator = String(obj.payload.originator);
        if (file.origin === 'codex') {
          context.codexClass = classifyCodexSession(context.originator, sessionMetaSourceKey(obj.payload));
        }
      }
      if (obj.type === 'event_msg' && obj.payload?.type === 'thread_settings_applied') {
        const settings = obj.payload.thread_settings;
        if (settings && typeof settings === 'object') {
          applyModelContext(context, settings);
        }
      }
      if (obj.type === 'turn_context' && obj.payload && typeof obj.payload === 'object') {
        applyModelContext(context, obj.payload);
      }
      const record = extractUsageRecord(obj, file.mtimeMs, file.sessionKey, context);
      if (!record || record.timestampMs < range.startMs || record.timestampMs > range.endMs) continue;
      record.origin = file.origin || 'openclaw';
      record.originator = context.originator;
      record.codexClass = context.codexClass;
      if (file.origin === 'codex') {
        if (context.codexClass === 'hermes_owned') {
          if (hermesDbAvailable) {
            // Counted once via the Hermes state.db bucket; excluded here, loudly.
            hermesOwned.files.add(file.sessionKey);
            hermesOwned.tokens += record.totalTokens;
            continue;
          }
          // No Hermes db to count them: retain in Codex CLI instead, loudly.
          hermesRetained.files.add(file.sessionKey);
          hermesRetained.tokens += record.totalTokens;
        }
        if (context.codexClass === 'unrecognized') {
          const name = context.originator || '(no session_meta)';
          unrecognizedOriginators.set(name, (unrecognizedOriginators.get(name) || 0) + record.totalTokens);
        }
      }
      records.push(record);
    }
  }
  // No silent caps: when the budget truncated the candidate set the totals may
  // be understated, and that has to be visible rather than inferred from a
  // filesScanned/filesAvailable comparison nobody is obliged to make.
  return {
    records,
    filesScanned: scanFiles.length,
    filesAvailable: files.length,
    scanTruncated: scanFiles.length < files.length,
    hermesOwnedCodexSkipped: {
      files: hermesOwned.files.size,
      tokens: hermesOwned.tokens,
    },
    hermesOwnedCodexRetained: {
      files: hermesRetained.files.size,
      tokens: hermesRetained.tokens,
    },
    unrecognizedCodexOriginators: Object.fromEntries(unrecognizedOriginators),
  };
}

function createTotalsBucket(name) {
  return { name, cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, records: 0, includedRecords: 0, sessionKeys: new Set() };
}

function createAccumulator(keys) {
  return {
    recordsScanned: 0,
    dailyMap: new Map(keys.map((date) => [date, {
      date,
      cost: 0,
      totalCost: 0,
      tokens: 0,
      totalTokens: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }])),
    modelTotals: new Map(),
    modelDailyTotals: new Map(),
  };
}

function addRecord(accumulator, record) {
  const daily = accumulator.dailyMap.get(record.date);
  if (!daily) return;
  accumulator.recordsScanned += 1;
  daily.cost += record.totalCost;
  daily.totalCost = daily.cost;
  daily.tokens += record.totalTokens;
  daily.totalTokens = daily.tokens;
  daily.input += record.input;
  daily.output += record.output;
  daily.cacheRead += record.cacheRead;
  daily.cacheWrite += record.cacheWrite;

  const name = modelName(record.provider, record.model, record);
  const model = accumulator.modelTotals.get(name) || createTotalsBucket(name);
  model.cost += record.totalCost;
  model.tokens += record.totalTokens;
  model.input += record.input;
  model.output += record.output;
  model.cacheRead += record.cacheRead;
  model.cacheWrite += record.cacheWrite;
  model.records += 1;
  if (isSubscriptionIncludedRecord(record)) model.includedRecords += 1;
  if (record.sessionKey) model.sessionKeys.add(record.sessionKey);
  accumulator.modelTotals.set(name, model);

  const dailyKey = `${record.date}::${name}`;
  const dailyModel = accumulator.modelDailyTotals.get(dailyKey) || {
    date: record.date,
    name,
    cost: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    records: 0,
    includedRecords: 0,
  };
  dailyModel.cost += record.totalCost;
  dailyModel.tokens += record.totalTokens;
  dailyModel.input += record.input;
  dailyModel.output += record.output;
  dailyModel.cacheRead += record.cacheRead;
  dailyModel.cacheWrite += record.cacheWrite;
  dailyModel.records += 1;
  if (isSubscriptionIncludedRecord(record)) dailyModel.includedRecords += 1;
  accumulator.modelDailyTotals.set(dailyKey, dailyModel);
}

function buildUsageFromAccumulator({
  accumulator,
  period,
  range,
  source,
  note,
  filesScanned,
  filesAvailable,
  scanTruncated = false,
}) {
  const daily = range.keys.map((date) => accumulator.dailyMap.get(date));
  let byServiceList = Array.from(accumulator.modelTotals.values())
    .filter((item) => item.tokens > 0 || item.cost > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((item) => {
      const subscriptionIncluded = item.cost <= 0 && item.records > 0 && item.includedRecords === item.records;
      const normalized = costSanity.normalizeServiceCost({
        name: item.name,
        cost: item.cost,
        tokens: item.tokens,
        input: item.input,
        output: item.output,
        cacheRead: item.cacheRead,
        cacheWrite: item.cacheWrite,
        sessions: item.sessionKeys.size,
        percentage: 0,
        costSource: item.cost > 0 ? 'api' : (subscriptionIncluded ? 'included' : 'unknown'),
        costStatus: subscriptionIncluded ? 'included' : undefined,
        billingModes: subscriptionIncluded ? 'subscription_included' : undefined,
      });
      return normalized;
    });

  const periodTokens = byServiceList.reduce((sum, item) => sum + Number(item.tokens || 0), 0);
  for (const item of byServiceList) {
    item.percentage = periodTokens > 0 ? Math.round((Number(item.tokens || 0) / periodTokens) * 100) : 0;
  }

  const dailyByModel = daily.map((row) => {
    const out = { date: row.date, totalCost: row.cost, totalTokens: row.tokens };
    for (const svc of byServiceList) {
      const key = `${row.date}::${svc.name}`;
      const b = accumulator.modelDailyTotals.get(key) || { cost: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, records: 0, includedRecords: 0 };
      const subscriptionIncluded = b.cost <= 0 && b.records > 0 && b.includedRecords === b.records;
      out[svc.name] = Number(b.cost || 0);
      out[`${svc.name}_tokens`] = Number(b.tokens || 0);
      out[`${svc.name}_input`] = Number(b.input || 0);
      out[`${svc.name}_output`] = Number(b.output || 0);
      out[`${svc.name}_cacheRead`] = Number(b.cacheRead || 0);
      out[`${svc.name}_cacheWrite`] = Number(b.cacheWrite || 0);
      out[`${svc.name}_costSource`] = b.cost > 0 ? 'api' : (subscriptionIncluded ? 'included' : 'unknown');
    }
    return out;
  });

  const todayKey = dayKey(new Date());
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);
  const todayRow = daily.find((d) => d.date === todayKey) || {};
  const yesterdayRow = daily.find((d) => d.date === yesterdayKey) || {};
  // With an anchored past month there is no "today" inside the window, so the
  // this-month totals follow the anchor instead (budget/monthly consumers read them).
  const monthPrefix = range.anchor || todayKey.slice(0, 7);
  const thisMonthRows = daily.filter((d) => String(d.date || '').startsWith(monthPrefix));
  const thisWeekRows = daily.slice(-7);

  return costSanity.normalizeUsageCosts({
    source,
    period,
    periodAnchor: range.anchor || null,
    periodRange: { start: range.startKey, end: range.endKey },
    summary: {
      periodUsd: daily.reduce((sum, d) => sum + Number(d.cost || 0), 0),
      previousPeriodUsd: null,
      periodTokens: daily.reduce((sum, d) => sum + Number(d.tokens || 0), 0),
      todayUsd: todayRow.cost || 0,
      yesterdayUsd: yesterdayRow.cost || 0,
      thisWeekUsd: thisWeekRows.reduce((sum, d) => sum + Number(d.cost || 0), 0),
      thisMonthUsd: thisMonthRows.reduce((sum, d) => sum + Number(d.cost || 0), 0),
      totalUsd: daily.reduce((sum, d) => sum + Number(d.cost || 0), 0),
      todayTokens: todayRow.tokens || 0,
      thisWeekTokens: thisWeekRows.reduce((sum, d) => sum + Number(d.tokens || 0), 0),
      thisMonthTokens: thisMonthRows.reduce((sum, d) => sum + Number(d.tokens || 0), 0),
      totalTokens: thisMonthRows.reduce((sum, d) => sum + Number(d.tokens || 0), 0),
      note,
      recordsScanned: accumulator.recordsScanned,
      filesScanned,
      filesAvailable,
      scanTruncated,
    },
    daily,
    dailyByModel,
    modelKeys: byServiceList.map((item) => item.name),
    byService: byServiceList,
  });
}

async function buildForPeriod(period, monthAnchor = null) {
  const r = rangeForPeriod(period, monthAnchor);
  const {
    records,
    filesScanned,
    filesAvailable,
    scanTruncated,
    hermesOwnedCodexSkipped,
    hermesOwnedCodexRetained,
    unrecognizedCodexOriginators,
  } = await scanUsageRecords({
    startMs: r.previous.startMs,
    endMs: r.endMs,
  });
  if (scanTruncated) {
    // stderr, not stdout: stdout is the JSON contract. Visible in the server log
    // so an understated month is never a silent zero.
    console.error(`[openclaw-usage-summary] scan truncated by MC_OPENCLAW_USAGE_MAX_FILES: ${filesScanned}/${filesAvailable} files${monthAnchor ? ` for anchor ${monthAnchor}` : ''}; totals may be understated`);
  }
  if (hermesOwnedCodexSkipped.tokens > 0) {
    console.error(`[openclaw-usage-summary] excluded ${hermesOwnedCodexSkipped.files} hermes-owned codex rollout file(s) / ${hermesOwnedCodexSkipped.tokens} tokens (counted once via the Hermes state.db bucket)`);
  }
  if (hermesOwnedCodexRetained.tokens > 0) {
    console.error(`[openclaw-usage-summary] Hermes state.db unavailable — retained ${hermesOwnedCodexRetained.files} hermes-owned codex rollout file(s) / ${hermesOwnedCodexRetained.tokens} tokens in the Codex CLI bucket to avoid dropping them from every bucket`);
  }
  const unrecognizedEntries = Object.entries(unrecognizedCodexOriginators || {});
  if (unrecognizedEntries.length > 0) {
    // Loud else-branch for the originator enumeration: an unknown originator
    // still lands in Codex CLI, but never silently.
    console.error(`[openclaw-usage-summary] unrecognized codex originator(s) bucketed as Codex CLI: ${unrecognizedEntries.map(([name, tokens]) => `${name}=${tokens}`).join(', ')}`);
  }
  const combinedAccumulator = createAccumulator(r.keys);
  const previousCombinedAccumulator = createAccumulator(r.previous.keys);
  const bucketAccumulators = new Map(SESSION_BUCKETS.map((bucket) => [bucket.key, createAccumulator(r.keys)]));
  const previousBucketAccumulators = new Map(SESSION_BUCKETS.map((bucket) => [bucket.key, createAccumulator(r.previous.keys)]));

  for (const record of records) {
    addRecord(combinedAccumulator, record);
    addRecord(previousCombinedAccumulator, record);
    const bucket = bucketForRecord(record);
    addRecord(bucketAccumulators.get(bucket.key), record);
    addRecord(previousBucketAccumulators.get(bucket.key), record);
  }

  const combined = buildUsageFromAccumulator({
    accumulator: combinedAccumulator,
    period,
    range: r,
    source: 'openclaw.session_jsonl_fast_scan',
    note: `Source: OpenClaw session JSONL fast scan (${records.length} usage records, ${filesScanned}/${filesAvailable} files${scanTruncated ? ', TRUNCATED — totals may be understated' : ''})`,
    filesScanned,
    filesAvailable,
    scanTruncated,
  });
  const previousCombined = buildUsageFromAccumulator({
    accumulator: previousCombinedAccumulator,
    period,
    range: r.previous,
    source: 'openclaw.session_jsonl_fast_scan.previous',
    note: 'Previous-period OpenClaw API-equivalent baseline',
    filesScanned,
    filesAvailable,
  });
  combined.summary.previousPeriodApiEquivalentUsd = previousCombined.summary.periodApiEquivalentUsd;
  combined.summary.previousPeriodApiEquivalentReliability = previousCombined.apiEquivalentReliability;
  combined.summary.hermesOwnedCodexSkipped = hermesOwnedCodexSkipped;
  combined.summary.hermesOwnedCodexRetained = hermesOwnedCodexRetained;
  combined.summary.unrecognizedCodexOriginators = unrecognizedCodexOriginators;

  combined.agents = SESSION_BUCKETS.map((bucket) => {
    const usage = buildUsageFromAccumulator({
      accumulator: bucketAccumulators.get(bucket.key),
      period,
      range: r,
      source: bucket.source,
      note: `Source: ${bucket.label} JSONL fast scan (${bucketAccumulators.get(bucket.key).recordsScanned} usage records)`,
      filesScanned,
      filesAvailable,
      scanTruncated,
    });
    const previousUsage = buildUsageFromAccumulator({
      accumulator: previousBucketAccumulators.get(bucket.key),
      period,
      range: r.previous,
      source: `${bucket.source}.previous`,
      note: `Previous-period ${bucket.label} API-equivalent baseline`,
      filesScanned,
      filesAvailable,
      scanTruncated,
    });
    usage.summary.previousPeriodApiEquivalentUsd = previousUsage.summary.periodApiEquivalentUsd;
    usage.summary.previousPeriodApiEquivalentReliability = previousUsage.apiEquivalentReliability;

    return {
      key: bucket.key,
      label: bucket.label,
      accent: bucket.accent,
      source: bucket.source,
      status: 'ready',
      summary: usage.summary,
      daily: usage.daily,
      dailyByModel: usage.dailyByModel,
      modelKeys: usage.modelKeys,
      byService: usage.byService,
    };
  });

  return combined;
}

async function main() {
  const args = process.argv.slice(2).map(String);
  const period = args.find((arg) => VALID_PERIODS.has(arg)) || 'month';
  const monthAnchor = args.find((arg) => isValidMonthAnchor(arg)) || null;
  const data = await buildForPeriod(period, monthAnchor);
  process.stdout.write(JSON.stringify(data));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[openclaw-usage-summary] failed', err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  buildForPeriod,
  extractUsageRecord,
  isValidMonthAnchor,
  listSessionFiles,
  prioritizeScanFiles,
  rangeForPeriod,
  bucketForRecord,
  classifyCodexSession,
};
