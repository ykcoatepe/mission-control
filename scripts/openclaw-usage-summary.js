#!/usr/bin/env node
/**
 * openclaw-usage-summary.js
 * Unified token cost tracker — mirrors OpenClaw Gateway real token consumption.
 * API: session-cost-usage-CqgbAyAJ.js (loadCostUsageSummary + discoverAllSessions + loadSessionCostSummary)
 */
const path = require('node:path');
const fs = require('node:fs');

function readOpenclawConfig() {
  const configPath = path.join(process.env.HOME || '/home/ubuntu', '.openclaw', 'openclaw.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

async function loadUsageModule() {
  const distDir = '/opt/homebrew/lib/node_modules/openclaw/dist';
  // Pick the bundle that has all 6 exports (n=loadCostUsageSummary, t=discoverAllSessions, r=loadSessionCostSummary)
  const candidates = fs.readdirSync(distDir)
    .filter((entry) => entry.startsWith('session-cost-usage-') && entry.endsWith('.js'));
  // Prefer the one with 6 exports (CqgbAyAJ), fall back to scanning each
  for (const candidate of candidates) {
    try {
      const mod = await import(`file://${path.join(distDir, candidate)}`);
      const keys = Object.keys(mod);
      if (keys.length >= 6) {
        return {
          summary: mod.n,   // loadCostUsageSummary
          discover: mod.t,  // discoverAllSessions
          session: mod.r,   // loadSessionCostSummary
          _module: candidate,
        };
      }
    } catch {}
  }
  throw new Error('session-cost-usage bundle with full API not found in ' + distDir);
}

function usageDirAgents() {
  const base = path.join(process.env.HOME || '/home/ubuntu', '.openclaw', 'agents');
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return ['main'];
  }
}

function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
}

function rangeForPeriod(period) {
  const now = new Date();
  const start = new Date(now);
  if (period === 'day') {
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: now.getTime(), keys: [dayKey(start)], startKey: dayKey(start), endKey: dayKey(now) };
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
    return { startMs: start.getTime(), endMs: now.getTime(), keys, startKey: keys[0], endKey: keys[keys.length - 1] };
  }
  // month
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  const keys = [];
  const cursor = new Date(start);
  while (cursor <= now) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return { startMs: start.getTime(), endMs: now.getTime(), keys, startKey: keys[0], endKey: keys[keys.length - 1] };
}

// Fallback pricing per 1M output tokens (OpenRouter/OpenAI prices, 2026-04)
const FALLBACK_PRICING = {
  'openai-codex/gpt-5.4-mini': 4.5,
  'openai-codex/gpt-5.4': 15,
  'openai-codex/gpt-5.3-codex-spark': 14,
  'anthropic/claude-opus-4-6': 25,
  'anthropic/claude-sonnet-4-6': 15,
  'anthropic/claude-haiku': 5,
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': 0.4,
  'nvidia/nemotron-3-super-120b-a12b': 0.5,
  'minimax/minimax-m2.7': 1.2,
  'minimax/minimax-m2.5': 1.25,
  'minimax/minimax-m2.1': 0.95,
  'minimax/minimax-m2': 1.0,
  'minimax/minimax-m2-her': 1.2,
  'xiaomi/mimo-v2-omni': 2.0,
  'xiaomi/mimo-v2-pro': 3.0,
  'xiaomi/mimo-v2-flash': 0.29,
  '__default': 5,
};

function isLocalModel(name) {
  if (!name) return false;
  return name.toLowerCase().includes('ollama/') || name.toLowerCase().includes('localhost');
}

function lookupFallbackPricing(name) {
  if (!name || isLocalModel(name)) return 0;
  const lower = name.toLowerCase();
  for (const [key, rate] of Object.entries(FALLBACK_PRICING)) {
    if (key === '__default') continue;
    if (lower.includes(key.toLowerCase())) return rate;
  }
  if (lower.includes('gpt-5.4-mini') || lower.includes('gpt-5.4-nano')) return FALLBACK_PRICING['openai-codex/gpt-5.4-mini'];
  if (lower.includes('gpt-5.4') && !lower.includes('mini')) return FALLBACK_PRICING['openai-codex/gpt-5.4'];
  if (lower.includes('gpt-5.3-codex') || lower.includes('gpt-5.3')) return FALLBACK_PRICING['openai-codex/gpt-5.3-codex-spark'];
  if (lower.includes('minimax-m2.7')) return FALLBACK_PRICING['minimax/minimax-m2.7'];
  if (lower.includes('minimax-m2.5')) return FALLBACK_PRICING['minimax/minimax-m2.5'];
  if (lower.includes('minimax-m2.1')) return FALLBACK_PRICING['minimax/minimax-m2.1'];
  if (lower.includes('minimax-m2-her')) return FALLBACK_PRICING['minimax/minimax-m2-her'];
  if (lower.includes('minimax-m2')) return FALLBACK_PRICING['minimax/minimax-m2'];
  return null;
}

function modelName(provider, model) {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p && !m) return 'unknown';
  if (!p) return m;
  if (!m) return p;
  return p + '/' + m;
}

async function buildForPeriod(period) {
  const cfg = readOpenclawConfig();
  const usage = await loadUsageModule();
  const r = rangeForPeriod(period);
  const agents = usageDirAgents();

  // Primary source: loadCostUsageSummary (mirrors Gateway real token counts)
  const summaryData = await usage.summary({
    startMs: r.startMs,
    endMs: r.endMs,
    config: cfg,
  });

  const dailyMap = {};
  if (summaryData && summaryData.daily) {
    for (const d of summaryData.daily) {
      dailyMap[d.date] = d;
    }
  }

  // Build daily rows
  const daily = r.keys.map((date) => {
    const src = dailyMap[date];
    if (src) {
      return {
        date,
        cost: src.totalCost || 0,
        totalCost: src.totalCost || 0,
        tokens: src.totalTokens || 0,
        totalTokens: src.totalTokens || 0,
        input: src.input || 0,
        output: src.output || 0,
        cacheRead: src.cacheRead || 0,
        cacheWrite: src.cacheWrite || 0,
      };
    }
    return { date, cost: 0, totalCost: 0, tokens: 0, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  });

  // Per-session model breakdown (aggregated across all sessions for today)
  // Discover sessions in range
  const allSessions = [];
  for (const agentId of agents) {
    const sessions = await usage.discover({ startMs: r.startMs });
    for (const s of sessions || []) {
      if (s && s.sessionId) allSessions.push(s);
    }
  }

  // Deduplicate
  const seen = new Set();
  const uniqueSessions = [];
  for (const s of allSessions) {
    const k = s.sessionId;
    if (!seen.has(k)) {
      seen.add(k);
      uniqueSessions.push(s);
    }
  }

  // Aggregate model usage from sessions
  const modelTotals = {};
  const modelDailyTotals = {};
  const todayKey = dayKey(new Date());
  const chunkSize = 20;

  for (let i = 0; i < uniqueSessions.length; i += chunkSize) {
    const chunk = uniqueSessions.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map((s) =>
      usage.session({ sessionId: s.sessionId, config: cfg, startMs: r.startMs, endMs: r.endMs })
    ));
    for (const s of results) {
      if (!s || !s.modelUsage) continue;
      for (let j = 0; j < s.modelUsage.length; j++) {
        const mu = s.modelUsage[j];
        const name = modelName(mu.provider, mu.model);
        if (!modelTotals[name]) {
          modelTotals[name] = { name, cost: 0, tokens: 0, sessions: new Set() };
        }
        modelTotals[name].tokens += Number(mu.totals && mu.totals.totalTokens || 0);
        modelTotals[name].cost += Number(mu.totals && mu.totals.totalCost || 0);
        modelTotals[name].sessions.add(s.sessionId);
      }
      // Daily model usage
      if (s.dailyModelUsage) {
        for (let j = 0; j < s.dailyModelUsage.length; j++) {
          const dm = s.dailyModelUsage[j];
          if (!r.keys.includes(String(dm.date || ''))) continue;
          const name = modelName(dm.provider, dm.model);
          const dk = dm.date + '::' + name;
          if (!modelDailyTotals[dk]) modelDailyTotals[dk] = { date: dm.date, name, cost: 0, tokens: 0 };
          modelDailyTotals[dk].tokens += Number(dm.tokens || 0);
          modelDailyTotals[dk].cost += Number(dm.cost || 0);
        }
      }
    }
  }

  // Build byService list — apply fallback pricing when cost=0 but tokens>0 (local/cloud-free tier)
  let byServiceList = Object.values(modelTotals)
    .filter((x) => x.tokens > 0 || x.cost > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .map((x) => {
      let cost = x.cost;
      let costSource = cost > 0 ? 'api' : 'fallback_estimate';
      if ((cost === 0 || cost === undefined) && x.tokens > 0) {
        const rate = lookupFallbackPricing(x.name);
        if (rate !== null && rate > 0) {
          cost = x.tokens * rate / 1_000_000;
        }
      }
      return {
        name: x.name,
        cost,
        tokens: x.tokens,
        sessions: x.sessions.size,
        percentage: 0,
        costSource,
      };
    });

  const periodCost = byServiceList.reduce((sum, x) => sum + x.cost, 0);
  for (const item of byServiceList) {
    item.percentage = periodCost > 0 ? Math.round((item.cost / periodCost) * 100) : 0;
  }

  // Build dailyByModel
  const dailyByModel = daily.map((row) => {
    const out = { date: row.date, totalCost: row.cost, totalTokens: row.tokens };
    for (const svc of byServiceList) {
      const key = row.date + '::' + svc.name;
      const b = modelDailyTotals[key] || { cost: 0, tokens: 0 };
      let cost = b.cost;
      if ((cost === 0 || cost === undefined) && b.tokens > 0) {
        const rate = lookupFallbackPricing(svc.name);
        if (rate !== null && rate > 0) cost = b.tokens * rate / 1_000_000;
      }
      out[svc.name] = cost;
      out[svc.name + '_tokens'] = b.tokens || 0;
      out[svc.name + '_costSource'] = (cost === 0 || cost === undefined) ? 'fallback_estimate' : 'api';
    }
    return out;
  });

  // Summary derivation
  const todayRow = daily.find((d) => d.date === todayKey) || {};
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);
  const yesterdayRow = daily.find((d) => d.date === yesterdayKey) || {};

  const monthPrefix = (r.startKey || '').slice(0, 7);
  const thisMonthRows = daily.filter((d) => String(d.date || '').startsWith(monthPrefix));
  const thisMonthTokens = thisMonthRows.reduce((sum, d) => sum + Number(d.tokens || 0), 0);
  const thisMonthUsd = thisMonthRows.reduce((sum, d) => sum + Number(d.cost || 0), 0);
  const thisWeekRows = daily.slice(-7);
  const thisWeekTokens = thisWeekRows.reduce((sum, d) => sum + Number(d.tokens || 0), 0);
  const thisWeekUsd = thisWeekRows.reduce((sum, d) => sum + Number(d.cost || 0), 0);

  // Period totals from summary (most accurate)
  const periodTokens = daily.reduce((sum, d) => sum + Number(d.tokens || 0), 0);
  const globalTotalCost = summaryData && summaryData.totals ? summaryData.totals.totalCost : periodCost;

  return {
    period,
    periodRange: { start: r.startKey, end: r.endKey },
    summary: {
      periodUsd: globalTotalCost,
      thisMonthUsd,
      previousPeriodUsd: 0,
      periodTokens,
      todayUsd: todayRow.cost || 0,
      yesterdayUsd: yesterdayRow.cost || 0,
      thisWeekUsd,
      thisMonthUsd,
      totalUsd: globalTotalCost,
      todayTokens: todayRow.tokens || 0,
      thisWeekTokens,
      thisMonthTokens,
      totalTokens: thisMonthTokens,
      note: 'Source: OpenClaw session-cost-usage (loadCostUsageSummary + per-session aggregation)',
      moduleUsed: usage._module,
    },
    daily,
    dailyByModel,
    modelKeys: byServiceList.map((x) => x.name),
    byService: byServiceList,
  };
}

async function main() {
  const period = String(process.argv[2] || 'month');
  const data = await buildForPeriod(period);
  process.stdout.write(JSON.stringify(data));
}

main().catch((err) => {
  console.error('[openclaw-usage-summary] failed', err && err.message ? err.message : String(err));
  process.exit(1);
});
