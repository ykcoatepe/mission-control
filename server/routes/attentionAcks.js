'use strict';

// POST   /api/attention/acks        { key, kind: 'ack'|'shelve', until?: ISO|null } -> 200 { ok, key, ack }
// DELETE /api/attention/acks/:key                                                   -> 200 { ok, key, ack: null }
//
// The badge rule's writes (server/services/attentionAcks.js). A key must have a
// known shape and name an item the readings show NOW as countable (ackable);
// its fingerprint (severity rank, count and, for a system, its reasons) is
// taken from that reading.
// Restricted items have no key: a guessed one is unknown (404), and the
// response says nothing about it. Both routes go through the write guard and
// the audit log like every mutating /api request. Errors: { error: { code,
// message } }.

const express = require('express');
const { asyncHandler, httpError } = require('../core/http');
const { validateAckRequest } = require('../services/attentionAcks');
const { attentionItems, countedSystems, isAckKey, keyDomain, keyProject } = require('../sources/mloop/attention');
const { isRestrictedId, restrictedMarkers } = require('../sources/mloop/restricted');
const { isFailedJob } = require('../sources/openclaw/automations');

function cronJobsOf(snapshot) {
  const jobs = snapshot?.data?.cron?.jobs;
  return Array.isArray(jobs) ? jobs : null;
}

function operationsCronJobs(snapshot) {
  const cron = snapshot?.data;
  if (!cron || cron.operationsSource?.sourceSucceeded !== true || !Array.isArray(cron.jobs)) return null;
  return cron.jobs;
}

/**
 * The current countable items from memory (no spawn, no write): the overview
 * systems (held through a refresh exactly as the GET routes do), the mloop
 * reading and the automations reading.
 */
function createAttentionReader({
  operationsOverviewService = null,
  loopsSource,
  automationsSnapshot = () => null,
  operationsCronSnapshot = () => null,
  now = Date.now,
} = {}) {
  return async function readAttention() {
    const overview = operationsOverviewService ? await operationsOverviewService.getOverview() : null;
    const systems = countedSystems(overview, { memoKey: operationsOverviewService, now });
    const loops = loopsSource?.snapshot?.()?.data ?? null;
    let allJobs = null;
    let failedJobs = null;
    try {
      allJobs = cronJobsOf(automationsSnapshot());
      failedJobs = allJobs ? allJobs.filter(isFailedJob) : null;
    } catch {}
    if (!allJobs) {
      try {
        // Same rule as the /api/signals fallback: status 'failed' counts.
        allJobs = operationsCronJobs(operationsCronSnapshot());
        failedJobs = allJobs ? allJobs.filter((job) => job?.status === 'failed') : null;
      } catch {}
    }
    return attentionItems({ systems, loops, cronJobs: failedJobs, allCronJobs: allJobs });
  };
}

function buildAttentionAcksRouter({ acks, readAttention, env = process.env, now = Date.now } = {}) {
  if (typeof acks?.set !== 'function') throw new TypeError('buildAttentionAcksRouter: acks store required');
  if (typeof readAttention !== 'function') throw new TypeError('buildAttentionAcksRouter: readAttention required');
  const markers = restrictedMarkers(env);
  const router = express.Router();

  function checkedKey(value) {
    if (!isAckKey(value)) throw httpError(400, 'invalid_key', 'key is not a known attention key');
    const project = keyProject(value);
    // A restricted project has no keys; a guessed one is simply unknown.
    if (project && isRestrictedId(project, markers)) throw httpError(404, 'ack_key_not_found', 'No attention item has that key');
    return value;
  }

  router.post('/api/attention/acks', asyncHandler(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'A JSON object body is required');
    const key = checkedKey(body.key);
    const { kind, until } = validateAckRequest(body, now());
    const current = await readAttention();
    if (!current.domains.has(keyDomain(key))) {
      throw httpError(503, 'attention_not_read', 'That part of the attention reading is not available yet');
    }
    const item = current.countable.get(key);
    if (!item) {
      if (current.listed.has(key)) throw httpError(409, 'not_ackable', 'That item does not need the operator now, so it cannot be acknowledged');
      throw httpError(404, 'ack_key_not_found', 'No attention item has that key');
    }
    const ack = await acks.set({ key, kind, until, rank: item.rank, count: item.count, reasons: item.reasons }, current);
    return res.json({ ok: true, key, ack });
  }));

  router.delete('/api/attention/acks/:key', asyncHandler(async (req, res) => {
    const key = checkedKey(String(req.params.key || ''));
    if (!acks.has(key)) throw httpError(404, 'ack_not_found', 'Nothing is acknowledged under that key');
    let current = null;
    try {
      current = await readAttention();
    } catch {
      // Without a reading nothing is known absent; the removal still applies.
    }
    await acks.remove(key, current);
    return res.json({ ok: true, key, ack: null });
  }));

  return router;
}

module.exports = { buildAttentionAcksRouter, createAttentionReader };
