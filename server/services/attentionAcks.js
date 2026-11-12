'use strict';

// Attention acknowledgements: the badge rule's memory (acknowledge / shelve).
//
// One JSON file in the data directory (<dataDir>/attention/acks.json):
//   { version: 3, acks: [{ key, kind, at, until, id, absentSince,
//       fingerprint: { rank, reasonIds, counts } }] }
//
// Whether an acknowledgement holds is a pure function of the stored record and
// the item as it is now; nothing about it is remembered or written:
//   kind 'ack'    holds while the item is NOT worse than the fingerprint taken
//                 at the acknowledgement (worseThan() in
//                 sources/mloop/attention.js: the rank is not higher, no
//                 reason id outside the acknowledged set, no count above its
//                 acknowledged value). While an item is worse it counts as
//                 new; when it is back at the acknowledged level or better the
//                 acknowledgement applies again. That is the intended rule.
//   kind 'shelve' holds until `until` (null = until unshelved), except that a
//                 shelved item counts while its rank is critical.
//
// The store is single-writer by construction, like the app's other data
// files: ONE Mission Control process uses a data directory. One instance per
// file per process (a second is refused), writes are synchronous (so they are
// serialized) and atomic (temp file 0600 + rename). The only writers are
// POST and DELETE /api/attention/acks; each also drops shelves that ran out
// and acknowledgements whose item has been absent, at those writes, for
// GC_AFTER_MS (7 days). Reads never write.
//
// A missing file is an empty store. An unparsable, oversized, partly invalid
// or older-version file starts empty; its content is copied to
// acks.json.corrupt-<time> before the first write replaces it, and a write
// that cannot keep that copy fails instead. When the file cannot be read
// (permissions) or a write failed, the store is unavailable: available() is
// false, nothing is treated as acknowledged and writes answer 503, until a
// later write attempt finds it readable and writable again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../core/http');
const { stateRank } = require('../core/state');
const { isAckKey, isFingerprint, keyDomain, worseThan } = require('../sources/mloop/attention');

const STORE_VERSION = 3;
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const GC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHELVE_MS = 366 * 24 * 60 * 60 * 1000;
const KINDS = new Set(['ack', 'shelve']);
const CRITICAL_RANK = stateRank('critical');
const HEX12 = /^[0-9a-f]{12}$/;

// Store files open in this process (resolved paths).
const OPEN_STORES = new Set();

function isoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { key, kind, at, until = null, id, absentSince = null, fingerprint } = raw;
  if (!isAckKey(key) || !KINDS.has(kind) || isoMs(at) === null) return null;
  if (until !== null && (kind !== 'shelve' || isoMs(until) === null)) return null;
  if (typeof id !== 'string' || !HEX12.test(id)) return null;
  if (absentSince !== null && isoMs(absentSince) === null) return null;
  if (!isFingerprint(fingerprint) || fingerprint.rank > CRITICAL_RANK) return null;
  return {
    key, kind, at, until, id, absentSince,
    fingerprint: { rank: fingerprint.rank, reasonIds: [...fingerprint.reasonIds], counts: { ...fingerprint.counts } },
  };
}

function publicAck(entry) {
  return { kind: entry.kind, at: entry.at, until: entry.until ?? null };
}

/**
 * Validate a POST body's kind/until against the clock. Throws httpError 400.
 * Returns { kind, until } with until an ISO string or null.
 */
function validateAckRequest({ kind, until }, nowMs) {
  if (!KINDS.has(kind)) throw httpError(400, 'invalid_kind', "kind must be 'ack' or 'shelve'");
  if (until === undefined || until === null) return { kind, until: null };
  if (kind !== 'shelve') throw httpError(400, 'invalid_until', 'Only a shelve takes an until date');
  const ms = typeof until === 'string' && until.length <= 40 ? isoMs(until) : null;
  if (ms === null) throw httpError(400, 'invalid_until', 'until must be an ISO date or null');
  if (ms <= nowMs) throw httpError(400, 'invalid_until', 'until must be in the future');
  if (ms - nowMs > MAX_SHELVE_MS) throw httpError(400, 'invalid_until', 'until must be within a year');
  return { kind, until: new Date(ms).toISOString() };
}

function createAttentionAckStore({
  file,
  now = Date.now,
  logger = console,
  fsImpl = fs,
  maxEntries = MAX_ENTRIES,
  maxFileBytes = MAX_FILE_BYTES,
  gcAfterMs = GC_AFTER_MS,
} = {}) {
  if (!file) throw new TypeError('createAttentionAckStore: file is required');
  const resolved = path.resolve(file);
  if (OPEN_STORES.has(resolved)) {
    throw new Error('createAttentionAckStore: an acknowledgement store is already open for this file in this process');
  }
  let entries = new Map();
  let corruptOnDisk = false; // the file's content must be kept aside before it is replaced
  let failure = null; // 'ack_store_unreadable' | 'ack_store_unwritable' | null
  let closed = false;
  let seq = 0;

  // Read the file into memory. Sets `failure` when it exists but cannot be read.
  function load() {
    entries = new Map();
    corruptOnDisk = false;
    failure = null;
    let text;
    try {
      const stat = fsImpl.statSync(file);
      if (stat.size > maxFileBytes) {
        corruptOnDisk = true;
        return;
      }
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      failure = 'ack_store_unreadable';
      logger?.error?.(`[attention-acks] the store cannot be read (${error?.code || 'error'}); acknowledgements are unavailable`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      corruptOnDisk = true;
      return;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !Array.isArray(parsed.acks)) {
      corruptOnDisk = true;
      return;
    }
    for (const raw of parsed.acks.slice(0, maxEntries)) {
      const entry = validEntry(raw);
      if (!entry || entries.has(entry.key)) {
        corruptOnDisk = true;
        continue;
      }
      entries.set(entry.key, entry);
    }
    if (parsed.acks.length > maxEntries) corruptOnDisk = true;
  }

  function persist() {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (corruptOnDisk) {
      // Never lose content we could not read: keep it before replacing it.
      try {
        const copy = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
        fsImpl.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
        fsImpl.chmodSync(copy, 0o600);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const body = JSON.stringify({ version: STORE_VERSION, acks: [...entries.values()] }, null, 1);
    seq += 1;
    const tmp = `${file}.tmp-${process.pid}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.chmodSync(tmp, 0o600);
      fsImpl.renameSync(tmp, file);
    } catch (error) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch {}
      throw error;
    }
    corruptOnDisk = false;
  }

  function expired(entry, nowMs) {
    return entry.kind === 'shelve' && entry.until !== null && isoMs(entry.until) <= nowMs;
  }

  // Housekeeping done only as part of a write. current: attentionItems()
  // output from the readings at write time, or null when they were not read
  // (then no absence is known).
  function collect(current, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    for (const [key, entry] of [...entries]) {
      if (expired(entry, nowMs)) {
        entries.delete(key);
        continue;
      }
      if (!current?.domains?.has?.(keyDomain(key))) continue;
      if (current.countable?.has?.(key)) {
        if (entry.absentSince !== null) entries.set(key, { ...entry, absentSince: null });
      } else if (entry.absentSince === null) {
        entries.set(key, { ...entry, absentSince: nowIso });
      } else if (nowMs - isoMs(entry.absentSince) >= gcAfterMs) {
        entries.delete(key);
      }
    }
  }

  // One write: memory and the file change together, or neither does.
  function write(change, current) {
    if (closed) throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
    // After a failure every write starts from the file again.
    if (failure) load();
    if (failure) throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
    const before = new Map(entries);
    try {
      const nowMs = now();
      collect(current, nowMs);
      const value = change(nowMs);
      persist();
      return value;
    } catch (error) {
      entries = before;
      if (error?.status && error?.code) throw error; // an httpError from change()
      failure = 'ack_store_unwritable';
      logger?.error?.(`[attention-acks] could not save (${error?.code || error?.message || error}); acknowledgements are unavailable`);
      throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
    }
  }

  /**
   * Whether the acknowledgement of a countable item (item.key,
   * item.fingerprint) holds now. Pure: no write, no memory.
   */
  function resolve(item) {
    const none = { ack: null, holds: false };
    if (closed || failure) return none;
    const entry = item?.key ? entries.get(item.key) : null;
    if (!entry || !isFingerprint(item.fingerprint) || expired(entry, now())) return none;
    const counts = entry.kind === 'ack'
      ? worseThan(entry.fingerprint, item.fingerprint) !== null
      : item.fingerprint.rank >= CRITICAL_RANK;
    return counts ? none : { ack: publicAck(entry), holds: true };
  }

  /** The stored acknowledgement of a key that is not countable now (or null). */
  function peek(key) {
    const entry = entries.get(key);
    return !closed && !failure && entry && !expired(entry, now()) ? publicAck(entry) : null;
  }

  /** Store an ack/shelve for a countable item with its current fingerprint. */
  function set({ key, kind, until = null, fingerprint }, current = null) {
    return write((nowMs) => {
      if (!entries.has(key) && entries.size >= maxEntries) {
        throw httpError(409, 'ack_store_full', 'Too many acknowledgements are stored; remove some first');
      }
      const entry = validEntry({
        key, kind, at: new Date(nowMs).toISOString(), until: kind === 'shelve' ? until : null,
        id: crypto.randomBytes(6).toString('hex'), absentSince: null, fingerprint,
      });
      if (!entry) throw httpError(400, 'invalid_ack', 'The acknowledgement is not valid');
      entries.set(key, entry);
      return publicAck(entry);
    }, current);
  }

  /** Remove a stored acknowledgement. True; 404 when there was none. */
  function remove(key, current = null) {
    return write(() => {
      if (!entries.delete(key)) throw httpError(404, 'ack_not_found', 'Nothing is acknowledged under that key');
      return true;
    }, current);
  }

  function close() {
    closed = true;
    OPEN_STORES.delete(resolved);
  }

  OPEN_STORES.add(resolved);
  load();
  if (corruptOnDisk) logger?.warn?.('[attention-acks] the store file is not valid (or is an older version); it starts empty and a copy is kept at the next write');

  return {
    file,
    available: () => !closed && failure === null,
    unavailableReason: () => (closed ? 'ack_store_unavailable' : failure),
    resolve, peek, set, remove, close,
  };
}

/** The envelope field every attention reading carries: whether acknowledgements could be read. */
function acksStatus(acks) {
  if (!acks || typeof acks.available !== 'function') return { available: true, reason: null };
  const available = acks.available() === true;
  return { available, reason: available ? null : (typeof acks.unavailableReason === 'function' ? acks.unavailableReason() : null) || 'ack_store_unavailable' };
}

module.exports = {
  createAttentionAckStore, acksStatus, validateAckRequest, publicAck,
  ACK_STORE_VERSION: STORE_VERSION, ACK_MAX_ENTRIES: MAX_ENTRIES, ACK_GC_AFTER_MS: GC_AFTER_MS,
};
