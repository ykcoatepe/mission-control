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
};

// Standard API list prices per 1M tokens. These are comparison rates only:
// subscription-included and local usage remains $0 tracked spend.
// Sources reviewed 2026-09-13: OpenAI and Z.ai public rate cards
// (gpt-6-astra, gpt-5.3-codex-spark, glm-5.3-flash added then).
const API_RATE_CARDS = [
  { match: 'gpt-6-astra', input: 10, cachedInput: 1, output: 50, cacheWrite: 12.5 },
  { match: 'gpt-5.6-sol', input: 5, cachedInput: 0.5, output: 30, cacheWrite: 6.25 },
  { match: 'gpt-5.6-terra', input: 2.5, cachedInput: 0.25, output: 15, cacheWrite: 3.125 },
  { match: 'gpt-5.6-luna', input: 1, cachedInput: 0.1, output: 6, cacheWrite: 1.25 },
  { match: 'gpt-5.6', input: 5, cachedInput: 0.5, output: 30, cacheWrite: 6.25 },
  { match: 'gpt-5.5', input: 5, cachedInput: 0.5, output: 30, cacheWrite: 5 },
  { match: 'gpt-5.4-mini', input: 0.75, cachedInput: 0.075, output: 4.5, cacheWrite: 0.75 },
  { match: 'gpt-5.4-nano', input: 0.2, cachedInput: 0.02, output: 1.25, cacheWrite: 0.2 },
  { match: 'gpt-5.4', input: 2.5, cachedInput: 0.25, output: 15, cacheWrite: 2.5 },
  { match: 'gpt-5.3-codex-spark', input: 1.75, cachedInput: 0.175, output: 14, cacheWrite: 2.1875 },
  { match: 'claude-fable-5', input: 10, cachedInput: 1, output: 50, cacheWrite: 12.5 },
  { match: 'claude-opus-4-8', input: 5, cachedInput: 0.5, output: 25, cacheWrite: 6.25 },
  { match: 'claude-opus-4.8', input: 5, cachedInput: 0.5, output: 25, cacheWrite: 6.25 },
  { match: 'claude-opus-4-6', input: 5, cachedInput: 0.5, output: 25, cacheWrite: 6.25 },
  { match: 'claude-sonnet-5', input: 3, cachedInput: 0.3, output: 15, cacheWrite: 3.75 },
  { match: 'claude-sonnet-4-6', input: 3, cachedInput: 0.3, output: 15, cacheWrite: 3.75 },
  { match: 'glm-5.3-flash', input: 0.15, cachedInput: 0.03, output: 0.5, cacheWrite: 0.1875 },
  // Must stay AFTER the flash card: includes-matching would otherwise catch
  // 'glm-5.3-flash' rows at the larger model's rates.
  { match: 'glm-5.3', input: 1.4, cachedInput: 0.26, output: 4.4, cacheWrite: 1.75 },
  // Known free tiers must zero-price before the generic default tier can
  // fabricate a cost for them (mirrors the frontend pricing registry).
  { match: 'qwen3-free', input: 0, cachedInput: 0, output: 0, cacheWrite: 0, free: true },
  { match: 'qwen3.6-free', input: 0, cachedInput: 0, output: 0, cacheWrite: 0, free: true },
  { match: 'nemotron-free', input: 0, cachedInput: 0, output: 0, cacheWrite: 0, free: true },
];

// Rows matching no known card are priced at this generic premium-cloud tier so
// the dashboard shows a documented partial estimate instead of dropping the
// total to unavailable when a new model appears. Cache-write rates follow the
// file's 1.25x-input convention where providers do not bill writes separately.
const API_DEFAULT_RATE = { input: 2.5, cachedInput: 0.25, output: 10, cacheWrite: 2.5 };

const SUMMARY_COST_FIELDS = ['periodUsd', 'todayUsd', 'yesterdayUsd', 'thisWeekUsd', 'thisMonthUsd', 'totalUsd'];

function dayKey(date) {
  return date.toLocaleDateString('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
}

function costSummaryFromDaily(daily = [], fallbackCost = 0, anchorMonthPrefix = null) {
  const periodUsd = daily.length
    ? daily.reduce((sum, row) => sum + Number(row.cost || row.totalCost || 0), 0)
    : Number(fallbackCost || 0);
  const today = new Date();
  const todayKey = dayKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKey(yesterday);
  // An anchored past-month payload must keep ITS month as "this month" — the
  // wall-clock prefix matches none of its rows and would zero the budget spend.
  const monthPrefix = anchorMonthPrefix || todayKey.slice(0, 7);
  const thisWeekRows = daily.slice(-7);
  return {
    periodUsd,
    todayUsd: Number((daily.find((row) => row.date === todayKey) || {}).cost || 0),
    yesterdayUsd: Number((daily.find((row) => row.date === yesterdayKey) || {}).cost || 0),
    thisWeekUsd: thisWeekRows.reduce((sum, row) => sum + Number(row.cost || row.totalCost || 0), 0),
    thisMonthUsd: daily
      .filter((row) => String(row.date || '').startsWith(monthPrefix))
      .reduce((sum, row) => sum + Number(row.cost || row.totalCost || 0), 0),
    totalUsd: periodUsd,
  };
}

function modelKey(name) {
  return String(name || '').replace(/^(OpenClaw|Codex App Sessions|Codex CLI|Hermes|Claude Code) \/ /, '').toLowerCase();
}

function isLocalModel(name) {
  const lower = modelKey(name);
  return lower.includes('ollama/') || lower.includes('localhost') || lower.includes('lmstudio') || lower.includes('local/');
}

function isSubscriptionIncludedModel(name) {
  const lower = modelKey(name);
  return lower.includes('openai-codex/gpt-5.5') || lower.includes('gpt-5.5');
}

function lookupFallbackPricing(name) {
  if (!name || isLocalModel(name) || isSubscriptionIncludedModel(name)) return null;
  const lower = modelKey(name);
  // The specificity-aware chain must run first: generic map keys like
  // 'openai-codex/gpt-5.4' are substrings of 'gpt-5.4-nano' and would
  // otherwise shadow the intended nano/mini/her rates.
  if (lower.includes('gpt-5.4-mini') || lower.includes('gpt-5.4-nano')) return FALLBACK_PRICING['openai-codex/gpt-5.4-mini'];
  if (lower.includes('gpt-5.4') && !lower.includes('mini')) return FALLBACK_PRICING['openai-codex/gpt-5.4'];
  if (lower.includes('gpt-5.3-codex') || lower.includes('gpt-5.3')) return FALLBACK_PRICING['openai-codex/gpt-5.3-codex-spark'];
  if (lower.includes('minimax-m2.7')) return FALLBACK_PRICING['minimax/minimax-m2.7'];
  if (lower.includes('minimax-m2.5')) return FALLBACK_PRICING['minimax/minimax-m2.5'];
  if (lower.includes('minimax-m2.1')) return FALLBACK_PRICING['minimax/minimax-m2.1'];
  if (lower.includes('minimax-m2-her')) return FALLBACK_PRICING['minimax/minimax-m2-her'];
  if (lower.includes('minimax-m2')) return FALLBACK_PRICING['minimax/minimax-m2'];
  for (const [key, rate] of Object.entries(FALLBACK_PRICING)) {
    if (lower.includes(key.toLowerCase())) return rate;
  }
  return null;
}

function lookupApiRateCard(name) {
  const lower = modelKey(name);
  return API_RATE_CARDS.find((rate) => lower.includes(rate.match)) || null;
}

function estimateApiEquivalentCost(item = {}) {
  if (isLocalModel(item.name)) {
    return { usd: 0, status: 'not_applicable', source: 'local_model' };
  }

  if (String(item.billingModes || '').toLowerCase().includes('channel_rollup')) {
    // Fast-fallback channel rollups name channels, not models; pricing them
    // at a model rate would fabricate a total.
    return { usd: null, status: 'unavailable', source: 'channel_rollup' };
  }

  const recordedApiEquivalent = Number(item.apiEquivalentUsd);
  if (item.apiEquivalentUsd !== null && item.apiEquivalentUsd !== undefined
    && Number.isFinite(recordedApiEquivalent) && recordedApiEquivalent >= 0) {
    return {
      usd: recordedApiEquivalent,
      status: item.apiEquivalentStatus || 'estimated',
      source: item.apiEquivalentSource || 'recorded_cost_estimate',
    };
  }

  const matchedRate = lookupApiRateCard(item.name);
  const input = Math.max(Number(item.input || 0), 0);
  const output = Math.max(Number(item.output || 0), 0);
  const cacheRead = Math.max(Number(item.cacheRead || 0), 0);
  const cacheWrite = Math.max(Number(item.cacheWrite || 0), 0);
  const hasTokenClasses = input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0;

  if (hasTokenClasses) {
    // CodexBar-style rows include cached tokens inside input, while OpenClaw
    // native rows commonly expose uncached input and cache reads separately.
    // Pick the interpretation that best reconciles with the recorded total.
    const totalTokens = Math.max(Number(item.tokens || 0), 0);
    // Reasoning tokens are metadata within output tokens, not an additional
    // billable token class. Keep them visible without double-counting output.
    const includedCacheDelta = Math.abs((input + output + cacheWrite) - totalTokens);
    const separateCacheDelta = Math.abs((input + cacheRead + output + cacheWrite) - totalTokens);
    const cacheIsSeparate = cacheRead > 0 && separateCacheDelta < includedCacheDelta;
    const cachedInput = cacheIsSeparate ? cacheRead : Math.min(cacheRead, input);
    const uncachedInput = cacheIsSeparate ? input : Math.max(input - cachedInput, 0);
    const rate = matchedRate || API_DEFAULT_RATE;
    const usd = (
      uncachedInput * rate.input
      + cachedInput * rate.cachedInput
      + output * rate.output
      + cacheWrite * rate.cacheWrite
    ) / 1_000_000;
    if (matchedRate) {
      return matchedRate.free
        ? { usd: 0, status: 'estimated', source: 'free_rate_card' }
        : { usd, status: 'estimated', source: 'official_rate_card' };
    }
    // Unmatched model with real recorded spend: the bill is better evidence
    // than a fabricated default-tier estimate. But when that cost is itself a
    // fallback heuristic, keep the uncertainty visible instead of relabeling
    // it as recorded evidence.
    const meteredCost = Number(item.cost || 0);
    if (meteredCost > 0 && Number.isFinite(meteredCost)) {
      const provenance = String(item.costSource || '').toLowerCase();
      if (provenance.includes('fallback') || provenance.includes('unknown')) {
        return { usd: meteredCost, status: 'partial', source: 'fallback_blended_estimate' };
      }
      return { usd: meteredCost, status: 'estimated', source: 'recorded_cost_estimate' };
    }
    return { usd, status: 'partial', source: 'default_rate_card' };
  }

  // Rows without a token-class breakdown keep the best available evidence in
  // order: recorded cost, then the matched card's blended rate (free cards
  // zero-price), then the generic default blend — the default is reserved for
  // truly unpriced rows so it never buries better data.
  const fallbackTokens = Math.max(Number(item.tokens || 0), 0);
  const currentCost = Number(item.cost || 0);
  if (fallbackTokens > 0 || currentCost > 0) {
    if (matchedRate && matchedRate.free) {
      return { usd: 0, status: 'estimated', source: 'free_rate_card' };
    }
    if (currentCost > 0 && Number.isFinite(currentCost)) {
      return { usd: currentCost, status: 'estimated', source: 'recorded_cost_estimate' };
    }
    if (matchedRate) {
      const blended = (matchedRate.input + matchedRate.output) / 2;
      return { usd: fallbackTokens * blended / 1_000_000, status: 'partial', source: 'rate_card_blended' };
    }
    const blended = (API_DEFAULT_RATE.input + API_DEFAULT_RATE.output) / 2;
    return { usd: fallbackTokens * blended / 1_000_000, status: 'partial', source: 'default_rate_card_blended' };
  }

  return { usd: null, status: 'unavailable', source: 'unpriced_model' };
}

function withApiEquivalent(item = {}) {
  const estimate = estimateApiEquivalentCost(item);
  return {
    ...item,
    apiEquivalentUsd: estimate.usd,
    apiEquivalentStatus: estimate.status,
    apiEquivalentSource: estimate.source,
  };
}

function isImplausibleCloudCost({ name, tokens, cost }) {
  const tokenCount = Number(tokens || 0);
  const usd = Number(cost || 0);
  if (!Number.isFinite(tokenCount) || !Number.isFinite(usd)) return false;
  if (tokenCount < 100_000 || usd <= 0 || isLocalModel(name)) return false;
  const usdPerMillionTokens = usd / tokenCount * 1_000_000;
  return usdPerMillionTokens > 0 && usdPerMillionTokens < 0.01;
}

function displayCostLabel(item = {}) {
  const source = String(item.costSource || '').toLowerCase();
  const status = String(item.costStatus || '').toLowerCase();
  const mode = String(item.billingModes || '').toLowerCase();
  if (source.includes('included') || status.includes('included') || mode.includes('included')) return 'included';
  if (source.includes('unknown') || status.includes('unknown')) return 'unknown';
  if (source.includes('fallback')) return 'estimated';
  if (source.includes('api')) return 'metered';
  return 'unknown';
}

function isIncludedCost(item = {}) {
  const source = String(item.costSource || '').toLowerCase();
  const status = String(item.costStatus || '').toLowerCase();
  const mode = String(item.billingModes || '').toLowerCase();
  return source.includes('included') || status.includes('included') || mode.includes('included');
}

function isEstimatedCostSource(source) {
  const lower = String(source || '').toLowerCase();
  return lower.includes('fallback') || lower.includes('estimate');
}

function combineApiEquivalentReliability(values = []) {
  const statuses = values.filter(Boolean);
  const active = statuses.filter((status) => status !== 'no_usage' && status !== 'not_applicable');
  if (!active.length) return statuses.includes('not_applicable') ? 'not_applicable' : 'no_usage';
  const hasEstimated = active.includes('estimated');
  const hasPartial = active.includes('partial');
  const hasUnavailable = active.includes('unavailable');
  if (hasPartial || (hasEstimated && hasUnavailable)) return 'partial';
  if (hasUnavailable) return 'unavailable';
  return hasEstimated ? 'estimated' : 'unavailable';
}

function normalizeServiceCost(item = {}) {
  const out = { ...item };
  const tokens = Number(out.tokens || 0);
  const currentCost = Number(out.cost || 0);

  if (isIncludedCost(out) || isImplausibleCloudCost({ name: out.name, tokens, cost: currentCost })) {
    out.cost = 0;
    out.costSource = 'included';
    out.costStatus = 'included';
    if (isLocalModel(out.name) || String(out.billingModes || '').toLowerCase().includes('local')) {
      out.billingModes = 'local_included';
      out.costNote = 'Local model usage; not treated as billable cloud spend';
    } else {
      out.billingModes = 'subscription_included';
      out.costNote = 'Subscription-included or implausible micro-cost; not treated as billable spend';
    }
    return withApiEquivalent(out);
  }

  if ((currentCost === 0 || !Number.isFinite(currentCost)) && tokens > 0) {
    const rate = lookupFallbackPricing(out.name);
    if (rate !== null && rate > 0) {
      out.cost = tokens * rate / 1_000_000;
      out.costSource = 'fallback_estimate';
      out.costStatus = out.costStatus || 'estimated';
    } else if (isLocalModel(out.name)) {
      out.cost = 0;
      out.costSource = 'included';
      out.costStatus = 'included';
      out.billingModes = out.billingModes || 'local_included';
    } else {
      out.cost = 0;
      out.costSource = 'unknown';
      out.costStatus = 'unknown';
    }
  } else if (currentCost > 0 && String(out.costSource || '').toLowerCase().includes('api')) {
    out.costStatus = out.costStatus || 'metered';
  }

  return withApiEquivalent(out);
}

function normalizeUsageCosts(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const normalized = { ...usage };
  const byService = (usage.byService || []).map(normalizeServiceCost);
  normalized.byService = byService;

  const costsByName = new Map(byService.map((item) => [String(item.name || ''), item]));
  normalized.dailyByModel = (usage.dailyByModel || []).map((row) => {
    const out = { ...row, totalCost: 0, apiEquivalentCost: 0, totalTokens: Number(row.totalTokens || 0) };
    for (const svc of byService) {
      const key = String(svc.name || '');
      if (!key || !(key in out)) continue;
      // Daily model rows must only use the tokens recorded for that day. Falling back
      // to the service's full-period token count manufactures spend on idle days.
      const tokens = Number(out[`${key}_tokens`] || 0);
      const normalizedSvc = costsByName.get(key) || svc;
      const rowSource = out[`${key}_costSource`];
      const source = isIncludedCost(normalizedSvc) ? (normalizedSvc.costSource || 'included') : (rowSource || normalizedSvc.costSource || 'unknown');
      const rawCost = Number(out[key] || 0);
      let cost = rawCost;
      if (source === 'included' || source === 'unknown') {
        cost = 0;
      } else if (tokens <= 0 && isEstimatedCostSource(source)) {
        // Estimated/fallback daily spend is only valid when the same row has tokens.
        // Keeping a pre-filled period estimate on zero-token days smears one tiny
        // estimate across every day in the chart and inflates period totals.
        cost = 0;
      } else if ((rawCost === 0 || !Number.isFinite(rawCost)) && tokens > 0) {
        const rate = lookupFallbackPricing(key);
        cost = rate !== null && rate > 0 ? tokens * rate / 1_000_000 : 0;
      } else if (isImplausibleCloudCost({ name: key, tokens, cost: rawCost })) {
        cost = 0;
      }
      out[key] = cost;
      out[`${key}_costSource`] = source;
      out.totalCost += Number(cost || 0);

      const apiEquivalent = estimateApiEquivalentCost({
        name: key,
        cost,
        tokens,
        costSource: String(out[`${key}_costSource`] || ''),
        apiEquivalentUsd: out[`${key}_apiEquivalentUsd`],
        apiEquivalentStatus: out[`${key}_apiEquivalentStatus`],
        input: Number(out[`${key}_input`] || 0),
        output: Number(out[`${key}_output`] || 0),
        reasoning: Number(out[`${key}_reasoning`] || 0),
        cacheRead: Number(out[`${key}_cacheRead`] || 0),
        cacheWrite: Number(out[`${key}_cacheWrite`] || 0),
      });
      out[`${key}_apiEquivalentUsd`] = apiEquivalent.usd;
      out[`${key}_apiEquivalentStatus`] = apiEquivalent.status;
      if (apiEquivalent.usd !== null) out.apiEquivalentCost += Number(apiEquivalent.usd || 0);
    }
    return out;
  });

  const dailyCostByDate = new Map((normalized.dailyByModel || []).map((row) => [row.date, Number(row.totalCost || 0)]));
  const dailyApiEquivalentByDate = new Map((normalized.dailyByModel || []).map((row) => [row.date, Number(row.apiEquivalentCost || 0)]));
  normalized.daily = (usage.daily || []).map((row) => {
    const cost = dailyCostByDate.has(row.date) ? dailyCostByDate.get(row.date) : Number(row.cost || row.totalCost || 0);
    const apiEquivalentCost = dailyApiEquivalentByDate.get(row.date) || 0;
    return { ...row, cost, totalCost: cost, apiEquivalentCost };
  });

  const fallbackServiceCost = byService.reduce((sum, item) => sum + Number(item.cost || 0), 0);
  const periodAnchor = usage.period?.anchor || usage.periodAnchor || null;
  const anchorMonthPrefix = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodAnchor || '')) ? String(periodAnchor) : null;
  const costSummary = costSummaryFromDaily(normalized.daily || [], fallbackServiceCost, anchorMonthPrefix);
  normalized.summary = { ...(usage.summary || {}) };
  SUMMARY_COST_FIELDS.forEach((field) => {
    if (field in normalized.summary) normalized.summary[field] = costSummary[field];
  });
  if ('periodUsd' in normalized.summary || byService.length) normalized.summary.periodUsd = costSummary.periodUsd;
  if ('totalUsd' in normalized.summary || byService.length) normalized.summary.totalUsd = costSummary.totalUsd;
  const apiEquivalentStatuses = byService
    .filter((item) => Number(item.tokens || 0) > 0 || Number(item.cost || 0) > 0)
    .map((item) => item.apiEquivalentStatus);
  const hasEstimatedApiEquivalent = apiEquivalentStatuses.includes('estimated');
  // Default-tier rows are estimates too (flagged partial); they count toward
  // publishing the total so a day dominated by brand-new models still shows a
  // documented number instead of null.
  const hasPricedApiEquivalent = hasEstimatedApiEquivalent || apiEquivalentStatuses.includes('partial');
  // One truth table for every rollup: the exported combiner treats partial
  // (and estimated+unavailable) as partial, matching the frontend gates.
  let apiEquivalentReliability = apiEquivalentStatuses.length === 0
    ? 'no_usage'
    : combineApiEquivalentReliability(apiEquivalentStatuses);
  const sourceStatuses = [
    usage.meta?.openclawStatus,
    usage.meta?.hermesStatus,
    usage.meta?.claudeCodeStatus,
  ].filter(Boolean);
  const sourceCoveragePartial = sourceStatuses.includes('unavailable');
  const scanTruncated = usage.summary?.scanTruncated === true || usage.scanTruncated === true;
  // A truncated scan understates the API-equivalent estimate exactly as much as
  // it understates tracked cost, and the headline/month-total/trend labels read
  // this field — not costReliability.
  const coverageIncomplete = sourceCoveragePartial || scanTruncated;
  const coverageCanBePartial = ['estimated', 'no_usage', 'not_applicable'];
  if (coverageIncomplete && coverageCanBePartial.includes(apiEquivalentReliability)) apiEquivalentReliability = 'partial';
  // The published value sums the daily rows; when the producer supplied
  // byService evidence without any dailyByModel rows (fast fallback path),
  // fall back to that sum instead of publishing a confident $0.00.
  const byServiceApiEquivalentSum = byService.reduce((sum, item) => (
    item.apiEquivalentUsd === null ? sum : sum + Number(item.apiEquivalentUsd || 0)
  ), 0);
  const estimatedPeriodApiEquivalentUsd = (normalized.dailyByModel || []).length > 0
    ? normalized.daily.reduce((sum, row) => sum + Number(row.apiEquivalentCost || 0), 0)
    : byServiceApiEquivalentSum;
  const periodApiEquivalentUsd = hasPricedApiEquivalent ? estimatedPeriodApiEquivalentUsd : null;
  normalized.summary.periodApiEquivalentUsd = periodApiEquivalentUsd;
  normalized.summary.apiEquivalentUsd = periodApiEquivalentUsd;
  if (coverageIncomplete && coverageCanBePartial.includes(normalized.summary.previousPeriodApiEquivalentReliability)) {
    normalized.summary.previousPeriodApiEquivalentReliability = 'partial';
  }
  // A truncated scan means we KNOW the totals are understated: the file cap cut
  // the candidate set before any record was read. That is partial coverage no matter
  // how clean the producer statuses look, and the frontend gates budget progress
  // and projections on this field alone.
  normalized.costReliability = scanTruncated
    || sourceCoveragePartial
    || byService.some((item) => item.costSource === 'unknown')
    ? 'partial_unknown'
    : 'normalized';
  normalized.apiEquivalentReliability = apiEquivalentReliability;

  if (Array.isArray(usage.agents)) {
    normalized.agents = usage.agents.map((agent) => {
      const agentOut = { ...agent, byService: (agent.byService || []).map(normalizeServiceCost) };
      const agentCost = agentOut.byService.reduce((sum, item) => sum + Number(item.cost || 0), 0);
      agentOut.summary = { ...(agent.summary || {}) };
      // With no byService rows there is nothing to roll up; keep the
      // producer-supplied summary instead of clobbering it with zeros.
      if (agentOut.byService.length) {
        agentOut.summary.periodUsd = agentCost;
        agentOut.summary.totalUsd = agentCost;
      }
      const agentApiEquivalentStatuses = agentOut.byService
        .filter((item) => Number(item.tokens || 0) > 0 || Number(item.cost || 0) > 0)
        .map((item) => item.apiEquivalentStatus);
      const agentHasEstimated = agentApiEquivalentStatuses.includes('estimated');
      // Default-tier rows are priced estimates flagged partial; they count
      // toward the agent's published total instead of nulling it.
      const agentHasPartial = agentApiEquivalentStatuses.includes('partial');
      const agentHasPriced = agentHasEstimated || agentHasPartial;
      const agentApiEquivalent = agentOut.byService.reduce((sum, item) => (
        item.apiEquivalentUsd === null ? sum : sum + Number(item.apiEquivalentUsd || 0)
      ), 0);
      agentOut.summary.periodApiEquivalentUsd = agentHasPriced ? agentApiEquivalent : null;
      agentOut.summary.apiEquivalentUsd = agentHasPriced ? agentApiEquivalent : null;
      agentOut.summary.apiEquivalentStatus = agentApiEquivalentStatuses.length === 0
        ? 'no_usage'
        : combineApiEquivalentReliability(agentApiEquivalentStatuses);
      return agentOut;
    });
  }

  return normalized;
}

module.exports = {
  FALLBACK_PRICING,
  API_RATE_CARDS,
  displayCostLabel,
  estimateApiEquivalentCost,
  combineApiEquivalentReliability,
  isImplausibleCloudCost,
  isLocalModel,
  isSubscriptionIncludedModel,
  lookupFallbackPricing,
  lookupApiRateCard,
  normalizeServiceCost,
  normalizeUsageCosts,
};
