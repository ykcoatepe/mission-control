const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  normalizeUsageCosts,
  lookupFallbackPricing,
  isImplausibleCloudCost,
  displayCostLabel,
  estimateApiEquivalentCost,
  combineApiEquivalentReliability,
} = require('../server/services/costSanity');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('a truncated scan is reported as partial coverage', () => {
  const base = {
    source: 'combined.agent_usage',
    meta: { openclawStatus: 'ready', hermesStatus: 'ready', claudeCodeStatus: 'ready' },
    summary: { periodUsd: 1 },
    daily: [{ date: '2026-07-01', cost: 1, totalCost: 1, tokens: 10, totalTokens: 10 }],
    dailyByModel: [],
    byService: [{ name: 'openai/gpt-5.6-sol', tokens: 10, cost: 1, costSource: 'api' }],
  };

  assert.equal(normalizeUsageCosts({ ...base, summary: { ...base.summary, scanTruncated: true } }).costReliability, 'partial_unknown');
  assert.equal(normalizeUsageCosts({ ...base, summary: { ...base.summary, scanTruncated: false } }).costReliability, 'normalized');
  assert.equal(normalizeUsageCosts({ ...base, scanTruncated: true }).costReliability, 'partial_unknown');
});

(function testCombinedApiEquivalentReliabilityPreservesPartialCoverage() {
  assert.equal(combineApiEquivalentReliability(['estimated', 'unavailable']), 'partial');
  assert.equal(combineApiEquivalentReliability(['estimated', 'partial']), 'partial');
  assert.equal(combineApiEquivalentReliability(['no_usage', 'estimated']), 'estimated');
  assert.equal(combineApiEquivalentReliability(['unavailable']), 'unavailable');
})();

(function testUnavailableSourceCoverageDowngradesCurrentAndPreviousEstimates() {
  const usage = normalizeUsageCosts({
    meta: { openclawStatus: 'unavailable', hermesStatus: 'ready', claudeCodeStatus: 'ready' },
    summary: {
      periodUsd: 0,
      periodTokens: 1_000_000,
      previousPeriodApiEquivalentUsd: 4,
      previousPeriodApiEquivalentReliability: 'estimated',
    },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 1_000_000, totalTokens: 1_000_000 }],
    dailyByModel: [{
      date: '2026-07-13', totalCost: 0, totalTokens: 1_000_000,
      'openai/gpt-5.6-sol': 0, 'openai/gpt-5.6-sol_tokens': 1_000_000,
      'openai/gpt-5.6-sol_input': 1_000_000,
    }],
    byService: [{
      name: 'openai/gpt-5.6-sol', cost: 0, tokens: 1_000_000, input: 1_000_000,
      costSource: 'included',
    }],
  });

  assert.equal(usage.apiEquivalentReliability, 'partial');
  assert.equal(usage.summary.previousPeriodApiEquivalentReliability, 'partial');
  assert.equal(usage.costReliability, 'partial_unknown');
})();

(function testUnavailableSourceCoverageCannotClaimNoUsageOrNotApplicable() {
  const noUsage = normalizeUsageCosts({
    meta: { openclawStatus: 'unavailable', hermesStatus: 'ready', claudeCodeStatus: 'ready' },
    summary: {
      periodUsd: 0,
      periodTokens: 0,
      previousPeriodApiEquivalentReliability: 'no_usage',
    },
    daily: [],
    dailyByModel: [],
    byService: [],
  });
  assert.equal(noUsage.apiEquivalentReliability, 'partial');
  assert.equal(noUsage.summary.previousPeriodApiEquivalentReliability, 'partial');

  const localOnly = normalizeUsageCosts({
    meta: { openclawStatus: 'ready', hermesStatus: 'unavailable', claudeCodeStatus: 'ready' },
    summary: { periodUsd: 0, periodTokens: 10 },
    daily: [{ date: '2026-07-16', cost: 0, totalCost: 0, tokens: 10, totalTokens: 10 }],
    dailyByModel: [{
      date: '2026-07-16', totalCost: 0, totalTokens: 10,
      'ollama/qwen': 0, 'ollama/qwen_tokens': 10,
    }],
    byService: [{ name: 'ollama/qwen', cost: 0, tokens: 10 }],
  });
  assert.equal(localOnly.apiEquivalentReliability, 'partial');
})();

(function testApiEquivalentUsesOfficialTokenClassRates() {
  const estimate = estimateApiEquivalentCost({
    name: 'openai/gpt-5.6-sol',
    tokens: 1_100_000,
    input: 1_000_000,
    output: 100_000,
    cacheRead: 800_000,
    cacheWrite: 50_000,
  });

  assert.equal(estimate.status, 'estimated');
  assert.equal(estimate.source, 'official_rate_card');
  assert.equal(estimate.usd, 4.7125);
})();

(function testApiEquivalentPricesReasoningAtTheOutputRate() {
  const estimate = estimateApiEquivalentCost({
    name: 'openai/gpt-5.6-sol',
    tokens: 1_100_000,
    input: 1_000_000,
    output: 100_000,
    reasoning: 100_000,
  });

  assert.equal(estimate.status, 'estimated');
  assert.equal(estimate.usd, 8);
})();

(function testSubscriptionIncludedUsageKeepsApiEquivalentSeparateFromSpend() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 1_100_000 },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 1_100_000, totalTokens: 1_100_000 }],
    dailyByModel: [{
      date: '2026-07-13',
      totalCost: 0,
      totalTokens: 1_100_000,
      'openai/gpt-5.6-sol': 0,
      'openai/gpt-5.6-sol_tokens': 1_100_000,
      'openai/gpt-5.6-sol_input': 1_000_000,
      'openai/gpt-5.6-sol_output': 100_000,
      'openai/gpt-5.6-sol_cacheRead': 800_000,
      'openai/gpt-5.6-sol_cacheWrite': 50_000,
      'openai/gpt-5.6-sol_costSource': 'included',
    }],
    byService: [{
      name: 'openai/gpt-5.6-sol',
      cost: 0,
      tokens: 1_100_000,
      input: 1_000_000,
      output: 100_000,
      cacheRead: 800_000,
      cacheWrite: 50_000,
      costSource: 'included',
      costStatus: 'included',
      billingModes: 'subscription_included',
    }],
    agents: [{
      key: 'openclaw',
      label: 'OpenClaw',
      summary: { periodUsd: 0, periodTokens: 1_100_000 },
      byService: [{
        name: 'OpenClaw / openai/gpt-5.6-sol',
        cost: 0,
        tokens: 1_100_000,
        input: 1_000_000,
        output: 100_000,
        cacheRead: 800_000,
        cacheWrite: 50_000,
        costSource: 'included',
        costStatus: 'included',
        billingModes: 'subscription_included',
      }],
    }],
  });

  assert.equal(usage.byService[0].cost, 0);
  assert.equal(usage.byService[0].apiEquivalentUsd, 4.7125);
  assert.equal(usage.byService[0].apiEquivalentSource, 'official_rate_card');
  assert.equal(usage.dailyByModel[0]['openai/gpt-5.6-sol_apiEquivalentUsd'], 4.7125);
  assert.equal(usage.daily[0].apiEquivalentCost, 4.7125);
  assert.equal(usage.summary.periodApiEquivalentUsd, 4.7125);
  assert.equal(usage.agents[0].summary.periodApiEquivalentUsd, 4.7125);
})();

(function testLocalAndUnpricedModelsExposeExplicitApiEquivalentStatus() {
  const local = estimateApiEquivalentCost({ name: 'ollama/qwen3.6', tokens: 1_000_000 });
  const unknown = estimateApiEquivalentCost({ name: 'vendor/new-cloud-model', tokens: 1_000_000 });

  assert.deepEqual(local, { usd: 0, status: 'not_applicable', source: 'local_model' });
  assert.deepEqual(unknown, { usd: null, status: 'unavailable', source: 'unpriced_model' });
})();

(function testUnpricedOnlyUsageDoesNotFabricateZeroApiEquivalent() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 1_000_000 },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 1_000_000, totalTokens: 1_000_000 }],
    dailyByModel: [{ date: '2026-07-13', totalCost: 0, totalTokens: 1_000_000, 'vendor/new-cloud-model': 0, 'vendor/new-cloud-model_tokens': 1_000_000 }],
    byService: [{ name: 'vendor/new-cloud-model', cost: 0, tokens: 1_000_000 }],
  });

  assert.equal(usage.summary.periodApiEquivalentUsd, null);
  assert.equal(usage.apiEquivalentReliability, 'unavailable');
})();

(function testEmptyUsageHasDistinctNoUsageApiEquivalentState() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 0 },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 0, totalTokens: 0 }],
    dailyByModel: [{ date: '2026-07-13', totalCost: 0, totalTokens: 0 }],
    byService: [],
  });

  assert.equal(usage.summary.periodApiEquivalentUsd, null);
  assert.equal(usage.apiEquivalentReliability, 'no_usage');
})();

(function testMixedPricedAndUnpricedUsageMarksApiEquivalentPartial() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 2_000_000 },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 2_000_000, totalTokens: 2_000_000 }],
    dailyByModel: [{
      date: '2026-07-13', totalCost: 0, totalTokens: 2_000_000,
      'openai/gpt-5.6-sol': 0, 'openai/gpt-5.6-sol_tokens': 1_000_000,
      'openai/gpt-5.6-sol_input': 1_000_000,
      'vendor/new-cloud-model': 0, 'vendor/new-cloud-model_tokens': 1_000_000,
    }],
    byService: [
      { name: 'openai/gpt-5.6-sol', cost: 0, tokens: 1_000_000, input: 1_000_000, costSource: 'included' },
      { name: 'vendor/new-cloud-model', cost: 0, tokens: 1_000_000 },
    ],
  });

  assert.equal(usage.summary.periodApiEquivalentUsd, 5);
  assert.equal(usage.apiEquivalentReliability, 'partial');
})();

(function testGpt55IsSubscriptionIncludedNotFallbackPriced() {
  assert.equal(lookupFallbackPricing('openai-codex/gpt-5.5'), null);
  assert.equal(displayCostLabel({ costSource: 'included', costStatus: 'included' }), 'included');
})();

(function testPlausibleExplicitGpt55ApiSpendRemainsMetered() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 25, periodTokens: 1_000_000 },
    daily: [{ date: '2026-07-13', cost: 25, totalCost: 25, tokens: 1_000_000, totalTokens: 1_000_000 }],
    dailyByModel: [{
      date: '2026-07-13',
      totalCost: 25,
      totalTokens: 1_000_000,
      'openai-codex/gpt-5.5': 25,
      'openai-codex/gpt-5.5_tokens': 1_000_000,
      'openai-codex/gpt-5.5_costSource': 'api',
    }],
    byService: [{
      name: 'openai-codex/gpt-5.5',
      cost: 25,
      tokens: 1_000_000,
      costSource: 'api',
    }],
  });

  assert.equal(usage.byService[0].cost, 25);
  assert.equal(usage.byService[0].costSource, 'api');
  assert.equal(usage.byService[0].costStatus, 'metered');
  assert.equal(usage.summary.periodUsd, 25);
})();

(function testZeroCostGpt55WithoutSubscriptionEvidenceRemainsUnknown() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 1_000_000 },
    daily: [{ date: '2026-07-13', cost: 0, totalCost: 0, tokens: 1_000_000, totalTokens: 1_000_000 }],
    dailyByModel: [{
      date: '2026-07-13',
      totalCost: 0,
      totalTokens: 1_000_000,
      'openai-codex/gpt-5.5': 0,
      'openai-codex/gpt-5.5_tokens': 1_000_000,
      'openai-codex/gpt-5.5_costSource': 'unknown',
    }],
    byService: [{
      name: 'openai-codex/gpt-5.5',
      cost: 0,
      tokens: 1_000_000,
      costSource: 'unknown',
      costStatus: 'unknown',
    }],
  });

  assert.equal(usage.byService[0].cost, 0);
  assert.equal(usage.byService[0].costSource, 'unknown');
  assert.equal(usage.byService[0].costStatus, 'unknown');
  assert.equal(usage.summary.periodUsd, 0);
})();

(function testLocalIncludedCostKeepsLocalBillingMode() {
  const usage = normalizeUsageCosts({
    daily: [{ date: '2026-05-24', cost: 0, totalCost: 0, tokens: 10, totalTokens: 10 }],
    dailyByModel: [{
      date: '2026-05-24',
      totalCost: 0,
      totalTokens: 10,
      'ollama/qwen3.6:35b-a3b-nvfp4': 0,
      'ollama/qwen3.6:35b-a3b-nvfp4_tokens': 10,
      'ollama/qwen3.6:35b-a3b-nvfp4_costSource': 'included',
    }],
    byService: [{
      name: 'ollama/qwen3.6:35b-a3b-nvfp4',
      cost: 0,
      tokens: 10,
      costSource: 'included',
      costStatus: 'included',
      billingModes: 'local_included',
    }],
  });

  assert.equal(usage.byService[0].billingModes, 'local_included');
  assert.match(usage.byService[0].costNote, /Local model/);
})();

(function testImplausibleApiMicroCostIsNotTreatedAsSpend() {
  assert.equal(isImplausibleCloudCost({ name: 'openai-codex/gpt-5.5', tokens: 8_595_100, cost: 0.000009005297, costSource: 'api' }), true);

  const usage = clone({
    summary: {
      periodUsd: 0.000009005297,
      todayUsd: 0.000009005297,
      thisWeekUsd: 0.000009005297,
      thisMonthUsd: 0.000009005297,
      totalUsd: 0.000009005297,
      periodTokens: 8_595_100,
    },
    daily: [{ date: '2026-05-08', cost: 0.000009005297, totalCost: 0.000009005297, tokens: 8_595_100, totalTokens: 8_595_100 }],
    dailyByModel: [{
      date: '2026-05-08',
      totalCost: 0.000009005297,
      totalTokens: 8_595_100,
      'openai-codex/gpt-5.5': 0.000009005297,
      'openai-codex/gpt-5.5_tokens': 8_595_100,
      'openai-codex/gpt-5.5_costSource': 'api',
    }],
    byService: [{ name: 'openai-codex/gpt-5.5', cost: 0.000009005297, tokens: 8_595_100, sessions: 46, costSource: 'api' }],
  });

  const normalized = normalizeUsageCosts(usage);
  assert.equal(normalized.byService[0].cost, 0);
  assert.equal(normalized.byService[0].costSource, 'included');
  assert.equal(normalized.byService[0].costStatus, 'included');
  assert.equal(normalized.byService[0].billingModes, 'subscription_included');
  assert.equal(normalized.summary.periodUsd, 0);
  assert.equal(normalized.daily[0].cost, 0);
  assert.equal(normalized.dailyByModel[0]['openai-codex/gpt-5.5'], 0);
  assert.equal(normalized.dailyByModel[0]['openai-codex/gpt-5.5_costSource'], 'included');
})();

(function testUnknownZeroCostCloudModelsRemainUnknownNotDefaultSpend() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 1_000_000 },
    daily: [{ date: '2026-05-08', cost: 0, totalCost: 0, tokens: 1_000_000, totalTokens: 1_000_000 }],
    dailyByModel: [{ date: '2026-05-08', totalCost: 0, totalTokens: 1_000_000, 'vendor/new-cloud-model': 0, 'vendor/new-cloud-model_tokens': 1_000_000, 'vendor/new-cloud-model_costSource': 'fallback_estimate' }],
    byService: [{ name: 'vendor/new-cloud-model', cost: 0, tokens: 1_000_000, sessions: 1, costSource: 'fallback_estimate' }],
  });

  assert.equal(usage.byService[0].costSource, 'unknown');
  assert.equal(usage.byService[0].costStatus, 'unknown');
  assert.equal(usage.summary.periodUsd, 0);
})();

(function testFallbackRawCostsDoNotSmearOntoZeroTokenDays() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0.000896, periodTokens: 32 },
    daily: [
      { date: '2026-05-07', cost: 0.000448, totalCost: 0.000448, tokens: 0, totalTokens: 0 },
      { date: '2026-05-08', cost: 0.000448, totalCost: 0.000448, tokens: 32, totalTokens: 32 },
    ],
    dailyByModel: [
      { date: '2026-05-07', totalCost: 0.000448, totalTokens: 0, 'openai-codex/gpt-5.3-codex': 0.000448, 'openai-codex/gpt-5.3-codex_tokens': 0, 'openai-codex/gpt-5.3-codex_costSource': 'fallback_estimate' },
      { date: '2026-05-08', totalCost: 0.000448, totalTokens: 32, 'openai-codex/gpt-5.3-codex': 0.000448, 'openai-codex/gpt-5.3-codex_tokens': 32, 'openai-codex/gpt-5.3-codex_costSource': 'fallback_estimate' },
    ],
    byService: [{ name: 'openai-codex/gpt-5.3-codex', cost: 0.000448, tokens: 32, sessions: 4, costSource: 'fallback_estimate' }],
  });

  assert.equal(usage.dailyByModel[0]['openai-codex/gpt-5.3-codex'], 0);
  assert.equal(usage.daily[0].cost, 0);
  assert.equal(usage.dailyByModel[1]['openai-codex/gpt-5.3-codex'], 0.000448);
  assert.equal(usage.summary.periodUsd, 0.000448);
})();

(function testIncludedFallbackCostStatusIsNotSpend() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0.000448, periodTokens: 32 },
    daily: [{ date: '2026-05-08', cost: 0.000448, totalCost: 0.000448, tokens: 32, totalTokens: 32 }],
    dailyByModel: [{ date: '2026-05-08', totalCost: 0.000448, totalTokens: 32, 'openai-codex/gpt-5.3-codex': 0.000448, 'openai-codex/gpt-5.3-codex_tokens': 32, 'openai-codex/gpt-5.3-codex_costSource': 'fallback_estimate' }],
    byService: [{ name: 'openai-codex/gpt-5.3-codex', cost: 0.000448, tokens: 32, sessions: 4, costSource: 'fallback_estimate', costStatus: 'included' }],
  });

  assert.equal(usage.byService[0].cost, 0);
  assert.equal(usage.byService[0].costSource, 'included');
  assert.equal(usage.dailyByModel[0]['openai-codex/gpt-5.3-codex'], 0);
  assert.equal(usage.summary.periodUsd, 0);
})();

(function testDailyRowsDoNotBorrowFullPeriodTokens() {
  const usage = normalizeUsageCosts({
    summary: { periodUsd: 0, periodTokens: 2_000_000 },
    daily: [
      { date: '2026-05-07', cost: 0, totalCost: 0, tokens: 0, totalTokens: 0 },
      { date: '2026-05-08', cost: 0, totalCost: 0, tokens: 2_000_000, totalTokens: 2_000_000 },
    ],
    dailyByModel: [
      { date: '2026-05-07', totalCost: 0, totalTokens: 0, 'openai-codex/gpt-5.4-mini': 0, 'openai-codex/gpt-5.4-mini_tokens': 0, 'openai-codex/gpt-5.4-mini_costSource': 'fallback_estimate' },
      { date: '2026-05-08', totalCost: 0, totalTokens: 2_000_000, 'openai-codex/gpt-5.4-mini': 0, 'openai-codex/gpt-5.4-mini_tokens': 2_000_000, 'openai-codex/gpt-5.4-mini_costSource': 'fallback_estimate' },
    ],
    byService: [{ name: 'openai-codex/gpt-5.4-mini', cost: 0, tokens: 2_000_000, sessions: 1, costSource: 'fallback_estimate' }],
    agents: [{ key: 'openclaw', label: 'OpenClaw', summary: { periodUsd: 0, todayUsd: 123, thisWeekUsd: 123, totalUsd: 0 }, byService: [{ name: 'OpenClaw / openai-codex/gpt-5.4-mini', cost: 0, tokens: 2_000_000, sessions: 1, costSource: 'fallback_estimate' }] }],
  });

  assert.equal(usage.dailyByModel[0]['openai-codex/gpt-5.4-mini'], 0);
  assert.equal(usage.daily[0].cost, 0);
  assert.equal(usage.dailyByModel[1]['openai-codex/gpt-5.4-mini'], 9);
  assert.equal(usage.summary.periodUsd, 9);
  assert.equal(usage.agents[0].summary.periodUsd, 9);
  assert.equal(usage.agents[0].summary.todayUsd, 123);
})();

console.log('costSanity tests passed');
