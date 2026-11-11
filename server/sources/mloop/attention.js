'use strict';

// The one "needs the operator" number. /api/signals (attention) and
// /api/loops (totals.needsOperator) both call needsOperator(), so the top
// bar, the sidebar and the Attention page show the same count.
//
//   count = systems               SYSTEMS (gbrain, hermes, openclaw, any other
//                                 id) whose state is warning or critical by the
//                                 shared ordering: at most one per system, however
//                                 many reasons it carries. While a system's source
//                                 is being re-read (stale, no error) and a settled
//                                 reading exists, its last settled state is used.
//         + findings              manager-loop findings rated warning/error
//                                 that are not about a confirmation
//         + overdueConfirmations  confirmations that need the operator: an
//                                 overdue pending row, or a warning/error
//                                 confirmation finding (TEYIT_STALE,
//                                 TEYIT_KEEP_KILL, ...), one per confirmation id
//         + restricted            counts-only projects (Argus, or not
//                                 verifiable): the same two kinds, by count
//
// breakdown.systemReasons (the overview's attention items) is reported apart
// and never added to the count. Info findings are not operator work. Each part is a number or null (not
// read). The count is the sum of the known parts; when any part is null the
// result says `partial: true` and names it in `missing`. Nothing known at all
// is null, never 0.

const { worstState, stateRank } = require('../../core/state');

// Findings that stand for a pending live confirmation (restricted counts).
const CONFIRMATION_CODES = new Set([
  'TEYIT_DUE', 'TEYIT_STALE', 'TEYIT_UNRESOLVED', 'DEPLOYED_UNCONFIRMED', 'ACCEPTED_NOT_LIVE',
]);
// TEYIT_STALE = past its deadline or silent too long (aggregated rows carry `count`).
const OVERDUE_CODES = new Set(['TEYIT_STALE']);
// Findings whose subject is a TEYİT id (mloop check, mloop.py teyit loop): the
// same confirmation under several codes is one operator item.
const CONFIRMATION_ID_CODES = new Set([
  'TEYIT_DUE', 'TEYIT_STALE', 'TEYIT_UNRESOLVED', 'TEYIT_KEEP_KILL', 'TEYIT_RESCHEDULED_REPEATEDLY',
]);
// mloop severity -> state vocabulary (server/core/state.js).
const LOOP_STATE = Object.freeze({ error: 'critical', warning: 'warning' });
const PARTS = Object.freeze(['systems', 'findings', 'overdueConfirmations', 'restricted']);
// Which Operations sources a system's reading comes from (overview meta.sources).
const SYSTEM_SOURCES = Object.freeze({
  gbrain: Object.freeze(['gbrain']),
  hermes: Object.freeze(['hermes', 'hermesGateway']),
  openclaw: Object.freeze(['status', 'sessions']),
});
// A settled state is held through a refresh for at most this long.
const HOLD_MAX_MS = 10 * 60_000;
const OPERATOR_RANK = stateRank('warning');
// Last settled state per system, per overview service (both routes pass the
// same service, so /api/signals and /api/loops share one memory).
const settledByService = new WeakMap();

function systemNeedsOperator(state) {
  return stateRank(state, 'inactive') >= OPERATOR_RANK;
}

// The overview's systems as [{ id, state, held }] for the count, or null when
// the overview was not read. A system whose sources are all fresh records its
// state as settled; while any of them is stale without an error (a refresh in
// progress, e.g. GBrain's post-action re-read) the settled state is used.
function countedSystems(overview, { memoKey = null, now = Date.now } = {}) {
  const systems = overview?.systems;
  if (!systems || typeof systems !== 'object') return null;
  let settled = memoKey && typeof memoKey === 'object' ? settledByService.get(memoKey) : null;
  if (!settled) {
    settled = new Map();
    if (memoKey && typeof memoKey === 'object') settledByService.set(memoKey, settled);
  }
  const nowMs = now();
  const sources = overview?.meta?.sources || {};
  return Object.entries(systems).filter(([, system]) => system && typeof system === 'object').map(([id, system]) => {
    const metas = (SYSTEM_SOURCES[id] || []).map((name) => sources[name]).filter((meta) => meta && typeof meta === 'object');
    const failed = metas.some((meta) => meta.error);
    const refreshing = !failed && metas.some((meta) => meta.stale === true);
    if (metas.length && !failed && !refreshing) settled.set(id, { state: system.state, atMs: nowMs });
    const last = settled.get(id);
    if (refreshing && last && nowMs - last.atMs <= HOLD_MAX_MS) return { id, state: last.state, held: true };
    return { id, state: system.state, held: false };
  });
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

// mloop aggregates three or more rows of one code into a single row whose
// subject is the code and which carries `count`; it names no ids.
function isAggregate(finding) {
  return finding.subject === finding.code || (Number.isInteger(finding.count) && finding.count > 1);
}

// One project's operator items. `confirmations`: pending rows ({id, overdue}),
// null when the list was not read, undefined when the check is the only basis
// (restricted projects). Returns { findings, confirmations, states } where a
// part is null when its input was not read.
function projectNeeds(findings, confirmations) {
  if (!Array.isArray(findings)) return { findings: null, confirmations: null, states: [] };
  const states = [];
  let findingCount = 0;
  const ids = new Set();
  let aggregated = 0;
  for (const finding of findings) {
    const state = LOOP_STATE[finding?.severity];
    if (!state) continue;
    states.push(state);
    if (!CONFIRMATION_ID_CODES.has(finding.code)) {
      findingCount += 1;
    } else if (isAggregate(finding)) {
      aggregated = Math.max(aggregated, Number.isInteger(finding.count) && finding.count > 0 ? finding.count : 1);
    } else {
      ids.add(String(finding.subject));
    }
  }
  if (confirmations === null || (confirmations !== undefined && !Array.isArray(confirmations))) {
    return { findings: findingCount, confirmations: null, states };
  }
  (confirmations || []).forEach((row, index) => {
    if (!row?.overdue) return;
    ids.add(typeof row.id === 'string' && row.id ? row.id : `#row-${index}`);
    states.push('warning');
  });
  // An aggregate names no ids, so it overlaps whatever ids are known.
  return { findings: findingCount, confirmations: Math.max(ids.size, aggregated), states };
}

// systems: countedSystems() output (null = not read); systemsAttention: the
// overview's attention items, reported as systemReasons only.
function needsOperator({ systems = null, systemsAttention = null, loops = null } = {}) {
  const states = [];
  const breakdown = { systems: null, systemReasons: null, findings: null, overdueConfirmations: null, restricted: null };
  if (Array.isArray(systems)) {
    breakdown.systems = 0;
    for (const system of systems) {
      // worst follows the shared ordering over every system read; only
      // warning/critical systems are counted.
      states.push(system?.state);
      if (systemNeedsOperator(system?.state)) breakdown.systems += 1;
    }
  }
  if (Array.isArray(systemsAttention)) breakdown.systemReasons = systemsAttention.length;
  if (loops && Array.isArray(loops.projects)) {
    const sums = { findings: 0, overdueConfirmations: 0, restricted: 0 };
    for (const project of loops.projects) {
      if (project?.restricted) {
        const { operatorFindings: findings, operatorConfirmations: confirmations } = project;
        if (sums.restricted === null || !isCount(findings) || !isCount(confirmations)) {
          sums.restricted = null;
          continue;
        }
        sums.restricted += findings + confirmations;
        if (findings + confirmations > 0) states.push(LOOP_STATE[project.worstSeverity] || 'warning');
        continue;
      }
      const needs = projectNeeds(project?.findings, project?.pendingConfirmations);
      sums.findings = needs.findings === null || sums.findings === null ? null : sums.findings + needs.findings;
      sums.overdueConfirmations = needs.confirmations === null || sums.overdueConfirmations === null
        ? null : sums.overdueConfirmations + needs.confirmations;
      states.push(...needs.states);
    }
    Object.assign(breakdown, sums);
  }
  const missing = PARTS.filter((part) => breakdown[part] === null);
  if (missing.length === PARTS.length) return null;
  const count = PARTS.reduce((sum, part) => sum + (breakdown[part] ?? 0), 0);
  return { count, worst: worstState(states, { empty: null }), breakdown, partial: missing.length > 0, missing };
}

module.exports = {
  CONFIRMATION_CODES, CONFIRMATION_ID_CODES, OVERDUE_CODES, LOOP_STATE, SYSTEM_SOURCES,
  countedSystems, needsOperator, projectNeeds, systemNeedsOperator,
};
