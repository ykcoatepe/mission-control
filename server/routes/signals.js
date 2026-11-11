'use strict';

// GET /api/signals — the small, fixed contract the shell polls. Composed from
// memory only (the Operations overview sources, mloop, launchd/reachability,
// and sibling automations/usage sources when they exist). A part that is not
// observed is null, never zero.
//
// data: {
//   systems:     { gbrain|hermes|openclaw: { state, observedAt, reason, detailHref } } | null
//   attention:   { count, worst, breakdown: { systems, findings, overdueConfirmations, restricted },
//                  partial, missing } | null
//                the one needs-the-operator number (sources/mloop/attention.js),
//                equal to /api/loops totals.needsOperator; a part not read is
//                null and named in `missing`; null when nothing was read
//   automations: { failed, nextRunAt } | null
//   loops:       { openFindings, overdueConfirmations } | null
//   services:    { down } | null                  launchd down/failed + unreachable endpoints
//   usage:       { todayUsd, budgetUsedPct } | null
// }

const express = require('express');
const { asyncHandler, sendEnvelope } = require('../core/http');
const { composeMeta } = require('../services/operationsOverview');
const { scrubText } = require('../core/scrub');
const { loopsView } = require('../sources/mloop');
const { needsOperator } = require('../sources/mloop/attention');

const SYSTEM_LABELS = Object.freeze({ gbrain: 'GBrain', hermes: 'Hermes', openclaw: 'OpenClaw' });
const MAX_REASON = 200;

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function snapshotOf(getter) {
  try {
    const snap = typeof getter === 'function' ? getter() : null;
    return snap && typeof snap === 'object' && 'meta' in snap ? snap : null;
  } catch {
    return null;
  }
}

// Why a system is not healthy: its first caveat, else the first attention
// item for it, else a plain sentence from the state. Scrubbed, one line.
function systemReason(id, system, attention) {
  if (!system || system.state === 'healthy') return null;
  const caveat = Array.isArray(system.caveats) ? system.caveats.find((item) => typeof item === 'string' && item.trim()) : null;
  const item = (attention || []).find((entry) => entry?.system === id && typeof entry.title === 'string');
  const label = SYSTEM_LABELS[id] || id;
  const text = caveat || item?.title
    || (system.state === 'unavailable' ? `${label} evidence is unavailable.` : `${label} is ${system.state}.`);
  const line = scrubText(String(text).split('\n')[0].trim());
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
}

function systemsSignal(overview) {
  if (!overview?.systems) return null;
  const out = {};
  for (const id of ['gbrain', 'hermes', 'openclaw']) {
    const system = overview.systems[id];
    out[id] = system
      ? {
        state: system.state,
        observedAt: system.observedAt ?? null,
        reason: systemReason(id, system, overview.attention),
        detailHref: typeof system.detailHref === 'string' ? system.detailHref : null,
      }
      : null;
  }
  return out;
}

function attentionSignal(overview, loopsData) {
  return needsOperator({
    systemsAttention: Array.isArray(overview?.attention) ? overview.attention : null,
    loops: loopsData,
  });
}

// Prefer the automations source's summary; otherwise derive it from the
// Operations cron reading when its scheduler proof succeeded.
function automationsSignal(automations, operationsCron) {
  const summary = automations?.data?.cron?.summary;
  if (summary && Number.isInteger(summary.failed)) {
    return { failed: summary.failed, nextRunAt: typeof summary.nextRunAt === 'string' ? summary.nextRunAt : null };
  }
  const cron = operationsCron?.data;
  if (!cron || cron.operationsSource?.sourceSucceeded !== true || !Array.isArray(cron.jobs)) return null;
  const next = cron.jobs
    .map((job) => job?.nextRun)
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { failed: cron.jobs.filter((job) => job?.status === 'failed').length, nextRunAt: next[0] || null };
}

function servicesSignal(launchd, reachability) {
  if (!launchd?.data && !reachability?.data) return null;
  let down = 0;
  if (launchd?.data?.counts) down += (launchd.data.counts.down || 0) + (launchd.data.counts.failed || 0);
  const endpoints = reachability?.data
    ? [reachability.data.gateways?.openclaw, reachability.data.gateways?.hermes, reachability.data.ollama]
    : [];
  down += endpoints.filter((endpoint) => endpoint?.state === 'down').length;
  return { down };
}

function usageSignal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const todayUsd = finiteOrNull(usage.todayUsd);
  const budgetUsedPct = finiteOrNull(usage.budgetUsedPct);
  if (todayUsd === null && budgetUsedPct === null) return null;
  return { todayUsd, budgetUsedPct };
}

// The usage area is built in parallel; read its summary defensively. Accepts
// a service with summary() (envelope or plain data), a source with
// snapshot(), or a function. Reads today.apiEquivalentUsd (else billedUsd)
// and budget.usedPct; anything else is null.
function usageFromSibling(candidate) {
  try {
    if (!candidate) return null;
    let value = null;
    if (typeof candidate.summary === 'function') value = candidate.summary();
    else if (typeof candidate.snapshot === 'function') value = candidate.snapshot();
    else if (typeof candidate === 'function') value = candidate();
    if (!value || typeof value !== 'object' || typeof value.then === 'function') return null;
    const data = 'data' in value && 'meta' in value ? value.data : value;
    if (!data || typeof data !== 'object') return null;
    const today = data.today || {};
    return {
      todayUsd: finiteOrNull(today.apiEquivalentUsd) ?? finiteOrNull(today.billedUsd) ?? finiteOrNull(data.todayUsd),
      budgetUsedPct: finiteOrNull(data.budget?.usedPct) ?? finiteOrNull(data.budgetUsedPct),
    };
  } catch {
    return null;
  }
}

function buildSignalsRouter({
  operationsOverviewService,
  operationsSources = {},
  loopsSource,
  launchdSource,
  reachabilitySource,
  automationsSnapshot = () => null,
  usageSummary = () => null,
  now = Date.now,
} = {}) {
  if (typeof operationsOverviewService?.getOverview !== 'function') throw new TypeError('buildSignalsRouter: operationsOverviewService required');
  for (const [name, source] of Object.entries({ loopsSource, launchdSource, reachabilitySource })) {
    if (typeof source?.snapshot !== 'function') throw new TypeError(`buildSignalsRouter: ${name} required`);
  }
  const router = express.Router();

  router.get('/api/signals', asyncHandler(async (req, res) => {
    const overview = await operationsOverviewService.getOverview();
    const loops = loopsSource.snapshot();
    const launchd = launchdSource.snapshot();
    const reachability = reachabilitySource.snapshot();
    const automations = snapshotOf(automationsSnapshot);
    const operationsCron = snapshotOf(() => operationsSources.cron?.snapshot());
    let usage = null;
    try {
      usage = usageSummary();
    } catch {}
    const loopsData = loopsView(loops.data);

    const parts = { loops, launchd, reachability };
    if (overview?.meta) parts.operations = { meta: overview.meta };
    if (automations) parts.automations = automations;

    return sendEnvelope(res, {
      data: {
        generatedAt: new Date(now()).toISOString(),
        systems: systemsSignal(overview),
        attention: attentionSignal(overview, loops.data),
        automations: automationsSignal(automations, operationsCron),
        loops: loopsData
          ? { openFindings: loopsData.totals.openFindings, overdueConfirmations: loopsData.totals.overdueConfirmations }
          : null,
        services: servicesSignal(launchd, reachability),
        usage: usageSignal(usage),
      },
      meta: composeMeta(parts, 'signals'),
    });
  }));

  return router;
}

module.exports = { buildSignalsRouter, usageFromSibling };
