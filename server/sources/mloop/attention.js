'use strict';

// The one "needs the operator" number. /api/signals (attention) and
// /api/loops (totals.needsOperator) both call needsOperator(), so the rail
// badge and the Attention page show the same count.
//
// Badge rule (alarm management): the count holds only NEW items, that is
// items that are not acknowledged, not shelved and not restricted.
//
//   count = systems               SYSTEMS (gbrain, hermes, openclaw, any other
//                                 id) that need the operator, at most one each
//                                 however many reasons they carry: state warning
//                                 or critical by the shared ordering, or a source
//                                 that FAILED (meta.error). A source that is only
//                                 being re-read (stale, no error) never adds:
//                                 for it the last settled state is held, and the
//                                 system's state is the worse of that and what
//                                 its fresh sources say. A critical item is never
//                                 held. The hold never lowers a state.
//         + findings              manager-loop findings rated warning/error
//                                 that are not about a confirmation
//         + overdueConfirmations  confirmations that need the operator: an
//                                 overdue pending row, or a warning/error
//                                 confirmation finding (TEYIT_STALE,
//                                 TEYIT_KEEP_KILL, ...), one per confirmation id
//   each part counting only items whose acknowledgement does not hold.
//
//   standing   = items of those parts that are acknowledged or shelved (and
//                whose acknowledgement still holds)
//   restricted = counts-only projects (Argus, or not verifiable): the same two
//                kinds, by count. Information only: NEVER in count or worst,
//                never keyed, never ackable.
//   worst      = the worst state over the NEW items; 'healthy' when count is 0.
//
// Every countable item has a stable key (system:<id>,
// finding:<project>:<CODE>:<hash of subject>, confirmation:<project>:<id>,
// cron:<job id>) and a fingerprint of what "worse" means: the severity rank
// from server/core/state.js and a count (1 unless the item carries one).
// Whether an acknowledgement holds is decided by the ack store
// (server/services/attentionAcks.js), passed in as `acks`.
//
// breakdown.systemReasons (the overview's attention items) and
// breakdown.restricted (= restricted) are reported apart and never added to the
// count. Info findings are not operator work. Each part is a number or null
// (not read). The count is the sum of the known parts; when any part is null
// the result says `partial: true` and names it in `missing`. Nothing known at
// all is null, never 0.

const crypto = require('crypto');
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
// The parts the count adds up (restricted is information only).
const COUNTED_PARTS = Object.freeze(['systems', 'findings', 'overdueConfirmations']);
// Which Operations sources a system's reading comes from (overview meta.sources).
const SYSTEM_SOURCES = Object.freeze({
  gbrain: Object.freeze(['gbrain']),
  hermes: Object.freeze(['hermes', 'hermesGateway', 'cron']),
  openclaw: Object.freeze(['status', 'sessions', 'cron']),
});
// Which source an overview evidence id comes from (operationsOverview.js
// evidence()). An unknown id stands for all of its system's sources.
const EVIDENCE_SOURCES = Object.freeze({
  'hermes:gateway': ['hermesGateway'],
  'hermes:kanban': ['hermes'],
  'hermes:cron': ['cron'],
  'openclaw:status-sessions': ['status'],
  'openclaw:heartbeat': ['status'],
  'openclaw:sessions': ['sessions'],
  'openclaw:cron': ['cron'],
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

function evidenceSources(ref, systemId) {
  return EVIDENCE_SOURCES[ref] || SYSTEM_SOURCES[systemId] || [];
}

// The overview's systems as [{ id, state, held, failed }] for the count, or
// null when the overview was not read. Per system:
//   failed      a source has meta.error: the system counts once.
//   refreshing  sources that are stale without an error (being re-read).
// With nothing refreshing the overview state is used and recorded as settled.
// While a source is refreshing (and a settled state is at most HOLD_MAX_MS
// old) the state is the worst of: the settled state, every attention item and
// evidence item that names a source NOT being re-read, and every critical
// item. So only the re-read source's contribution is held, and a state is
// never lowered below what fresh evidence says.
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
  const attention = Array.isArray(overview?.attention) ? overview.attention : [];
  const evidence = Array.isArray(overview?.evidence) ? overview.evidence : [];
  return Object.entries(systems).filter(([, system]) => system && typeof system === 'object').map(([id, system]) => {
    const names = SYSTEM_SOURCES[id] || [];
    const metas = names.map((name) => [name, sources[name]]).filter(([, meta]) => meta && typeof meta === 'object');
    const failed = metas.some(([, meta]) => meta.error);
    const refreshing = new Set(metas.filter(([, meta]) => meta.stale === true && !meta.error).map(([name]) => name));
    const items = attention.filter((item) => item?.system === id);
    // Never held: criticals, and a failed read (at least 'unavailable').
    const criticals = [
      ...items.filter((item) => item.severity === 'critical').map(() => 'critical'),
      ...(failed ? ['unavailable'] : []),
    ];
    if (metas.length && !failed && !refreshing.size) settled.set(id, { state: system.state, atMs: nowMs });
    const last = settled.get(id);
    if (!refreshing.size || !last || nowMs - last.atMs > HOLD_MAX_MS) {
      return { id, state: worstState([system.state, ...criticals], { empty: system.state }), held: false, failed };
    }
    const reRead = (refs) => {
      const named = (Array.isArray(refs) && refs.length ? refs : [null]).flatMap((ref) => evidenceSources(ref, id));
      return named.length > 0 && named.every((name) => refreshing.has(name));
    };
    const fresh = [
      ...items.filter((item) => !reRead(item.evidenceRefs)).map((item) => item.severity),
      ...evidence.filter((item) => item?.system === id && !reRead([item.id])).map((item) => item.status),
    ];
    return { id, state: worstState([last.state, ...fresh, ...criticals], { empty: last.state }), held: true, failed };
  });
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

// --- keys --------------------------------------------------------------------

const KEY_MAX_LENGTH = 300;
const PROJECT_PART = '[A-Za-z0-9][A-Za-z0-9._-]{0,99}';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const SYSTEM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const CRON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const KEY_SHAPES = Object.freeze({
  system: new RegExp(`^system:[a-z0-9][a-z0-9_-]{0,39}$`),
  finding: new RegExp(`^finding:${PROJECT_PART}:[A-Z0-9_]{1,64}:[0-9a-f]{12}$`),
  confirmation: new RegExp(`^confirmation:${PROJECT_PART}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`),
  cron: new RegExp(`^cron:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$`),
});
// Which reading a key's item comes from (an item is known absent only when
// its reading was read).
const KEY_DOMAINS = Object.freeze({ system: 'systems', finding: 'loops', confirmation: 'loops', cron: 'cron' });

function hash12(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

/** The key's kind (system|finding|confirmation|cron) or null when the shape is not known. */
function keyKind(key) {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX_LENGTH) return null;
  const kind = key.slice(0, key.indexOf(':'));
  return Object.hasOwn(KEY_SHAPES, kind) && KEY_SHAPES[kind].test(key) ? kind : null;
}

function isAckKey(key) {
  return keyKind(key) !== null;
}

function keyDomain(key) {
  const kind = keyKind(key);
  return kind ? KEY_DOMAINS[kind] : null;
}

/** The project a finding/confirmation key names, else null. */
function keyProject(key) {
  const kind = keyKind(key);
  if (kind !== 'finding' && kind !== 'confirmation') return null;
  return key.split(':')[1];
}

function systemKey(id) {
  return typeof id === 'string' && SYSTEM_ID_PATTERN.test(id) ? `system:${id}` : null;
}

function findingKey(project, code, subject) {
  if (typeof project !== 'string' || !new RegExp(`^${PROJECT_PART}$`).test(project)) return null;
  const safeCode = typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'UNKNOWN';
  return `finding:${project}:${safeCode}:${hash12(subject)}`;
}

// A confirmation id is kept as is when it is a short plain id (T1, TEYIT-42),
// otherwise it is hashed (h + 12 hex), so the key stays bounded and URL-safe.
function confirmationKey(project, id) {
  if (typeof project !== 'string' || !new RegExp(`^${PROJECT_PART}$`).test(project)) return null;
  if (typeof id !== 'string' || !id || id.startsWith('#')) return null;
  return `confirmation:${project}:${SAFE_ID.test(id) ? id : `h${hash12(id)}`}`;
}

function cronKey(jobId) {
  return typeof jobId === 'string' && CRON_ID_PATTERN.test(jobId) ? `cron:${jobId}` : null;
}

/** The key a listed manager-loop finding carries (confirmation findings share their confirmation's key). */
function findingItemKey(project, finding) {
  if (CONFIRMATION_ID_CODES.has(finding?.code)) {
    return confirmationKey(project, typeof finding.subject === 'string' && finding.subject ? finding.subject : finding.code);
  }
  return findingKey(project, finding?.code, finding?.subject);
}

// --- items -------------------------------------------------------------------

function itemCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function makeItem(key, part, state, { count = 1, units = 1 } = {}) {
  return { key, part, state, rank: stateRank(state), count: itemCount(count), units };
}

function mergeInto(map, item) {
  if (!item.key) {
    map.set(Symbol('unkeyed'), item);
    return;
  }
  const known = map.get(item.key);
  if (!known) {
    map.set(item.key, item);
    return;
  }
  const state = worstState([known.state, item.state], { empty: known.state });
  map.set(item.key, {
    ...known, state, rank: stateRank(state), count: Math.max(known.count, item.count, known.units + item.units), units: known.units + item.units,
  });
}

// The overview systems that need the operator, as countable items.
function systemItems(systems) {
  if (!Array.isArray(systems)) return null;
  const items = [];
  for (const system of systems) {
    const failed = system?.failed === true;
    if (!systemNeedsOperator(system?.state) && !failed) continue;
    const state = failed ? worstState([system?.state, 'unavailable']) : system.state;
    items.push(makeItem(systemKey(system?.id), 'systems', state));
  }
  return items;
}

// mloop aggregates three or more rows of one code into a single row whose
// subject is the code and which carries `count`; it names no ids.
function isAggregate(finding) {
  return finding.subject === finding.code || (Number.isInteger(finding.count) && finding.count > 1);
}

// One project's operator items. `confirmations`: pending rows ({id, overdue}),
// null when the list was not read, undefined when the check is the only basis
// (restricted projects). Returns { findings, confirmations, states, items }
// where a part is null when its input was not read. Items carry keys only when
// `projectId` is given (never for a restricted project).
function projectNeeds(findings, confirmations, projectId = null) {
  if (!Array.isArray(findings)) return { findings: null, confirmations: null, states: [], items: [] };
  const keyed = typeof projectId === 'string';
  const states = [];
  let findingCount = 0;
  const findingItems = new Map();
  const ids = new Map(); // confirmation id -> state
  let aggregate = null;
  for (const finding of findings) {
    const state = LOOP_STATE[finding?.severity];
    if (!state) continue;
    states.push(state);
    if (!CONFIRMATION_ID_CODES.has(finding.code)) {
      findingCount += 1;
      mergeInto(findingItems, makeItem(keyed ? findingKey(projectId, finding.code, finding.subject) : null, 'findings', state, { count: finding.count }));
    } else if (isAggregate(finding)) {
      const n = Number.isInteger(finding.count) && finding.count > 0 ? finding.count : 1;
      if (!aggregate || n > aggregate.count) aggregate = { finding, count: n, state };
    } else {
      const id = String(finding.subject);
      ids.set(id, worstState([ids.get(id), state], { empty: state }));
    }
  }
  const findingList = [...findingItems.values()];
  if (confirmations === null || (confirmations !== undefined && !Array.isArray(confirmations))) {
    return { findings: findingCount, confirmations: null, states, items: findingList };
  }
  (confirmations || []).forEach((row, index) => {
    if (!row?.overdue) return;
    const id = typeof row.id === 'string' && row.id ? row.id : `#row-${index}`;
    ids.set(id, worstState([ids.get(id), 'warning'], { empty: 'warning' }));
    states.push('warning');
  });
  const items = [...findingList];
  for (const [id, state] of ids) items.push(makeItem(keyed ? confirmationKey(projectId, id) : null, 'overdueConfirmations', state));
  // An aggregate names no ids, so it overlaps whatever ids are known: it adds
  // only the confirmations beyond them.
  if (aggregate) {
    const subject = typeof aggregate.finding.subject === 'string' && aggregate.finding.subject ? aggregate.finding.subject : aggregate.finding.code;
    items.push(makeItem(keyed ? confirmationKey(projectId, subject) : null, 'overdueConfirmations', aggregate.state, {
      count: aggregate.count, units: Math.max(0, aggregate.count - ids.size),
    }));
  }
  return { findings: findingCount, confirmations: Math.max(ids.size, aggregate?.count || 0), states, items };
}

const NO_ACKS = Object.freeze({ resolve: () => ({ ack: null, holds: false }), peek: () => null });

function holds(acks, item) {
  if (!item.key || !acks || typeof acks.resolve !== 'function') return false;
  try {
    return acks.resolve(item)?.holds === true;
  } catch {
    return false;
  }
}

// Every countable item, by key, from the readings: systems (countedSystems()
// output, null = not read), loops (the mloop source data) and cronJobs (jobs
// already known to count: enabled with a failed last run; null = not read).
// `listed` holds every key the routes expose (countable or not), `domains`
// the readings that were read.
function attentionItems({ systems = null, loops = null, cronJobs = null, allCronJobs = null } = {}) {
  const countable = new Map();
  const listed = new Set();
  const domains = new Set();
  const add = (item) => {
    if (!item.key) return;
    listed.add(item.key);
    const known = countable.get(item.key);
    if (!known) {
      countable.set(item.key, item);
      return;
    }
    const state = worstState([known.state, item.state], { empty: known.state });
    countable.set(item.key, {
      ...known, state, rank: stateRank(state), units: known.units + item.units, count: Math.max(known.count, item.count),
    });
  };
  const sys = systemItems(systems);
  if (sys) {
    domains.add('systems');
    for (const system of systems) {
      const key = systemKey(system?.id);
      if (key) listed.add(key);
    }
    sys.forEach(add);
  }
  if (loops && Array.isArray(loops.projects)) {
    domains.add('loops');
    for (const project of loops.projects) {
      if (!project || project.restricted) continue;
      for (const finding of Array.isArray(project.findings) ? project.findings : []) {
        const key = findingItemKey(project.id, finding);
        if (key) listed.add(key);
      }
      for (const row of Array.isArray(project.pendingConfirmations) ? project.pendingConfirmations : []) {
        const key = confirmationKey(project.id, row?.id);
        if (key) listed.add(key);
      }
      projectNeeds(project.findings, project.pendingConfirmations, project.id).items.forEach(add);
    }
  }
  if (Array.isArray(cronJobs)) {
    domains.add('cron');
    for (const job of Array.isArray(allCronJobs) ? allCronJobs : cronJobs) {
      const key = cronKey(job?.id);
      if (key) listed.add(key);
    }
    for (const job of cronJobs) add(makeItem(cronKey(job?.id), 'cron', 'warning'));
  }
  return { countable, listed, domains };
}

// systems: countedSystems() output (null = not read); systemsAttention: the
// overview's attention items, reported as systemReasons only; acks: the ack
// store (resolve(item) -> { ack, holds }), null = nothing acknowledged.
function needsOperator({ systems = null, systemsAttention = null, loops = null, acks = null } = {}) {
  const breakdown = { systems: null, systemReasons: null, findings: null, overdueConfirmations: null, restricted: null };
  const fresh = [];
  let standing = 0;
  const take = (item) => {
    if (holds(acks, item)) {
      standing += item.units;
      return;
    }
    breakdown[item.part] += item.units;
    if (item.units > 0) fresh.push(item.state);
  };
  const sys = systemItems(systems);
  if (sys) {
    breakdown.systems = 0;
    sys.forEach(take);
  }
  if (Array.isArray(systemsAttention)) breakdown.systemReasons = systemsAttention.length;
  if (loops && Array.isArray(loops.projects)) {
    const known = { findings: true, overdueConfirmations: true };
    let restricted = 0;
    const pending = [];
    for (const project of loops.projects) {
      if (project?.restricted) {
        const { operatorFindings: findings, operatorConfirmations: confirmations } = project;
        if (restricted === null || !isCount(findings) || !isCount(confirmations)) {
          restricted = null;
          continue;
        }
        restricted += findings + confirmations;
        continue;
      }
      const needs = projectNeeds(project?.findings, project?.pendingConfirmations, typeof project?.id === 'string' ? project.id : null);
      if (needs.findings === null) known.findings = false;
      if (needs.confirmations === null) known.overdueConfirmations = false;
      pending.push(...needs.items);
    }
    breakdown.findings = known.findings ? 0 : null;
    breakdown.overdueConfirmations = known.overdueConfirmations ? 0 : null;
    breakdown.restricted = restricted;
    // A part that was not read counts nothing (it is named in `missing`).
    pending.filter((item) => breakdown[item.part] !== null).forEach(take);
  }
  const missing = PARTS.filter((part) => breakdown[part] === null);
  if (missing.length === PARTS.length) return null;
  const count = COUNTED_PARTS.reduce((sum, part) => sum + (breakdown[part] ?? 0), 0);
  return {
    count,
    worst: count > 0 ? worstState(fresh, { empty: 'warning' }) : 'healthy',
    standing,
    restricted: breakdown.restricted,
    breakdown,
    partial: missing.length > 0,
    missing,
  };
}

module.exports = {
  CONFIRMATION_CODES, CONFIRMATION_ID_CODES, OVERDUE_CODES, LOOP_STATE, SYSTEM_SOURCES, KEY_MAX_LENGTH, NO_ACKS,
  attentionItems, confirmationKey, countedSystems, cronKey, findingItemKey, findingKey, isAckKey, keyDomain, keyKind,
  keyProject, needsOperator, projectNeeds, systemKey, systemNeedsOperator,
};
