#!/usr/bin/env node
/**
 * openclaw-usage-summary.js
 * Fast, bounded OpenClaw token/cost summary for Mission Control.
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
const SESSION_BUCKETS = [
  {
    key: 'openclaw',
    label: 'OpenClaw',
    accent: '#5E5CE6',
    source: 'openclaw.direct_sessions',
  },
  {
    key: 'codex_app',
    label: 'Codex App Sessions',
    accent: '#64D2FF',
    source: 'openclaw.codex_app_sessions',
  },
];

function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
}

function rangeForPeriod(period) {
  const now = new Date();
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

function modelName(provider, model, sessionKey = '') {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p && !m) return 'unknown';
  // OpenClaw native Codex session_meta often records provider=openai but omits
  // model. Yordam's default OpenClaw model is GPT-5.5, which is subscription
  // included; leaving this as openai/unknown makes Mission Control show a fake
  // unknown-cost bucket for most OpenClaw tokens.
  if (p === 'openai' && (!m || m === 'unknown')) {
    return sessionBucketForKey(sessionKey).key === 'codex_app'
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
  if (provider && provider !== context.provider && !model) context.model = '';
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
  return record.provider === 'openai-codex' || record.billingMode === 'subscription_included';
}

function sessionBucketForKey(sessionKey) {
  const normalized = String(sessionKey || '').split(path.sep).join('/');
  return normalized.includes('/agent/codex-home/sessions/')
    ? SESSION_BUCKETS[1]
    : SESSION_BUCKETS[0];
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
    billingMode: message?.billingMode || message?.billing_mode || usage.billingMode || usage.billing_mode || context.billingMode || '',
    sessionKey,
  };
}

function listJsonlFiles(dir, agentId, agentsBase, startMs, files, depth = 0) {
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
      if (!entry.name.startsWith('.')) listJsonlFiles(fullPath, agentId, agentsBase, startMs, files, depth + 1);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.endsWith('.trajectory.jsonl')) continue;
    try {
      const stat = fs.statSync(fullPath);
      // mtime is a coarse prefilter only; each usage record is checked by timestamp below.
      if (stat.mtimeMs >= startMs - 24 * 60 * 60 * 1000) {
        files.push({
          agentId,
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          sessionKey: path.relative(agentsBase, fullPath),
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

function listSessionFiles(startMs) {
  const agentsBase = path.join(process.env.HOME || '/home/ubuntu', '.openclaw', 'agents');
  const files = [];
  let agents = [];
  try {
    agents = fs.readdirSync(agentsBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return files;
  }

  for (const agentId of agents) {
    const agentRoot = path.join(agentsBase, agentId);
    for (const sessionsDir of findSessionDirs(agentRoot)) {
      listJsonlFiles(sessionsDir, agentId, agentsBase, startMs, files);
    }
  }
  return files;
}

async function scanUsageRecords(range) {
  const files = listSessionFiles(range.startMs);
  const records = [];
  const maxFiles = Number(process.env.MC_OPENCLAW_USAGE_MAX_FILES || 20000);
  const scanFiles = files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 20000);

  for (const file of scanFiles) {
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const context = { provider: '', model: '', billingMode: '' };
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
      records.push(record);
    }
  }
  return { records, filesScanned: scanFiles.length, filesAvailable: files.length };
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

  const name = modelName(record.provider, record.model, record.sessionKey);
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
  const monthPrefix = todayKey.slice(0, 7);
  const thisMonthRows = daily.filter((d) => String(d.date || '').startsWith(monthPrefix));
  const thisWeekRows = daily.slice(-7);

  return costSanity.normalizeUsageCosts({
    source,
    period,
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
    },
    daily,
    dailyByModel,
    modelKeys: byServiceList.map((item) => item.name),
    byService: byServiceList,
  });
}

async function buildForPeriod(period) {
  const r = rangeForPeriod(period);
  const { records, filesScanned, filesAvailable } = await scanUsageRecords({
    startMs: r.previous.startMs,
    endMs: r.endMs,
  });
  const combinedAccumulator = createAccumulator(r.keys);
  const previousCombinedAccumulator = createAccumulator(r.previous.keys);
  const bucketAccumulators = new Map(SESSION_BUCKETS.map((bucket) => [bucket.key, createAccumulator(r.keys)]));
  const previousBucketAccumulators = new Map(SESSION_BUCKETS.map((bucket) => [bucket.key, createAccumulator(r.previous.keys)]));

  for (const record of records) {
    addRecord(combinedAccumulator, record);
    addRecord(previousCombinedAccumulator, record);
    const bucket = sessionBucketForKey(record.sessionKey);
    addRecord(bucketAccumulators.get(bucket.key), record);
    addRecord(previousBucketAccumulators.get(bucket.key), record);
  }

  const combined = buildUsageFromAccumulator({
    accumulator: combinedAccumulator,
    period,
    range: r,
    source: 'openclaw.session_jsonl_fast_scan',
    note: `Source: OpenClaw session JSONL fast scan (${records.length} usage records, ${filesScanned}/${filesAvailable} files)`,
    filesScanned,
    filesAvailable,
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

  combined.agents = SESSION_BUCKETS.map((bucket) => {
    const usage = buildUsageFromAccumulator({
      accumulator: bucketAccumulators.get(bucket.key),
      period,
      range: r,
      source: bucket.source,
      note: `Source: ${bucket.label} JSONL fast scan (${bucketAccumulators.get(bucket.key).recordsScanned} usage records)`,
      filesScanned,
      filesAvailable,
    });
    const previousUsage = buildUsageFromAccumulator({
      accumulator: previousBucketAccumulators.get(bucket.key),
      period,
      range: r.previous,
      source: `${bucket.source}.previous`,
      note: `Previous-period ${bucket.label} API-equivalent baseline`,
      filesScanned,
      filesAvailable,
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
  const period = process.argv.slice(2).find((arg) => VALID_PERIODS.has(String(arg))) || 'month';
  const data = await buildForPeriod(period);
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
  listSessionFiles,
  sessionBucketForKey,
};
