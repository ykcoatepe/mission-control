'use strict';

// Attention acknowledgements: the badge rule's memory (acknowledge / shelve).
//
// One JSON file in the data directory (<dataDir>/attention/acks.json):
//   { version: 1, acks: [{ key, kind, at, until, rank, count, lastSeenAt }] }
// kind 'ack'    "seen, it will stay like this": holds while the item is no
//               worse than its fingerprint (severity rank and count at the
//               time of the ack). A rise voids it for good (superseded).
// kind 'shelve' silence until `until` (null = until unshelved); a shelved item
//               that BECOMES critical counts again (superseded).
//
// Reads are pure: resolve() and peek() never touch the disk. What a read
// learns (an ack voided by a rise, the last time an item was seen) is kept in
// memory and written with the next POST/DELETE. Writes are serialized (one
// queue), atomic (temp file 0600 + rename) and bounded (MAX_ENTRIES). An
// acknowledgement whose item has been absent for GC_AFTER_MS (7 days) is
// dropped at a write, never at once (items flap); an item is only known
// absent when its reading was read.
//
// A missing file is an empty store. An unparsable, oversized or partly
// invalid file starts empty too; its content is copied to
// acks.json.corrupt-<time> before the first write replaces it, and a write
// that cannot keep that copy fails instead. A file that cannot be read at all
// (permissions) leaves the store read-only, so it is never overwritten.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../core/http');
const { stateRank } = require('../core/state');
const { isAckKey, keyDomain } = require('../sources/mloop/attention');

const STORE_VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const GC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHELVE_MS = 366 * 24 * 60 * 60 * 1000;
const KINDS = new Set(['ack', 'shelve']);
const CRITICAL_RANK = stateRank('critical');
const MAX_RANK = CRITICAL_RANK;

function isoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { key, kind, at, until = null, rank, count, lastSeenAt = null } = raw;
  if (!isAckKey(key) || !KINDS.has(kind) || isoMs(at) === null) return null;
  if (until !== null && (kind !== 'shelve' || isoMs(until) === null)) return null;
  if (!Number.isInteger(rank) || rank < 0 || rank > MAX_RANK) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  if (lastSeenAt !== null && isoMs(lastSeenAt) === null) return null;
  return { key, kind, at, until, rank, count, lastSeenAt };
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
  let entries = new Map();
  let corrupt = false; // the file on disk holds content we could not use
  let unreadable = false; // the file exists but cannot be read: never overwrite
  const seen = new Map(); // key -> ms an item was last seen countable (memory)
  const superseded = new Set(); // keys voided by a read, persisted at the next write
  let queue = Promise.resolve();
  let seq = 0;

  (function load() {
    let text;
    try {
      const stat = fsImpl.statSync(file);
      if (stat.size > maxFileBytes) {
        corrupt = true;
        return;
      }
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        unreadable = true;
        logger?.error?.(`[attention-acks] store cannot be read (${error?.code || 'error'}); acknowledgements are read-only`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      corrupt = true;
      return;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !Array.isArray(parsed.acks)) {
      corrupt = true;
      return;
    }
    for (const raw of parsed.acks.slice(0, maxEntries)) {
      const entry = validEntry(raw);
      if (!entry || entries.has(entry.key)) {
        corrupt = true;
        continue;
      }
      entries.set(entry.key, entry);
    }
    if (parsed.acks.length > maxEntries) corrupt = true;
    if (corrupt) logger?.warn?.('[attention-acks] store had invalid entries; a copy is kept at the next write');
  }());

  function expired(entry, nowMs) {
    return entry.kind === 'shelve' && entry.until !== null && isoMs(entry.until) <= nowMs;
  }

  /**
   * Whether the acknowledgement of a countable item holds. item: { key, rank,
   * count }. Pure as far as the disk goes: a rise is remembered in memory.
   */
  function resolve(item) {
    const key = item?.key;
    const entry = key ? entries.get(key) : null;
    if (!entry || superseded.has(key)) return { ack: null, holds: false };
    const nowMs = now();
    seen.set(key, nowMs);
    const rank = Number.isInteger(item.rank) ? item.rank : 0;
    const count = Number.isInteger(item.count) ? item.count : 1;
    if (entry.kind === 'ack' && (rank > entry.rank || count > entry.count)) {
      superseded.add(key);
      return { ack: null, holds: false };
    }
    if (entry.kind === 'shelve') {
      if (expired(entry, nowMs)) return { ack: null, holds: false };
      if (rank >= CRITICAL_RANK && entry.rank < CRITICAL_RANK) {
        superseded.add(key);
        return { ack: null, holds: false };
      }
    }
    return { ack: publicAck(entry), holds: true };
  }

  /** The stored acknowledgement of a key that is not countable now (or null). */
  function peek(key) {
    const entry = entries.get(key);
    if (!entry || superseded.has(key) || expired(entry, now())) return null;
    return publicAck(entry);
  }

  function has(key) {
    return entries.has(key);
  }

  function list() {
    return [...entries.values()].map((entry) => ({ key: entry.key, ...publicAck(entry), superseded: superseded.has(entry.key) }));
  }

  function persist(next) {
    const dir = path.dirname(file);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (corrupt) {
      // Never lose content we could not read: keep it before replacing it.
      try {
        const copy = `${file}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
        fsImpl.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
        fsImpl.chmodSync(copy, 0o600);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const body = JSON.stringify({ version: STORE_VERSION, acks: [...next.values()] }, null, 1);
    seq += 1;
    const tmp = `${file}.tmp-${process.pid}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.chmodSync(tmp, 0o600);
      fsImpl.renameSync(tmp, file);
    } catch (error) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {}
      throw error;
    }
  }

  // current: { countable: Map<key, item>, domains: Set } from the readings at
  // write time, or null when they could not be read (no absence is known).
  function collect(next, current, nowMs) {
    const nowIso = new Date(nowMs).toISOString();
    for (const [key, entry] of next) {
      if (superseded.has(key) || expired(entry, nowMs)) {
        next.delete(key);
        continue;
      }
      const persistedSeen = isoMs(entry.lastSeenAt) ?? -Infinity;
      const memorySeen = seen.get(key) ?? -Infinity;
      const lastMs = Math.max(persistedSeen, memorySeen, isoMs(entry.at));
      const domainRead = Boolean(current?.domains?.has(keyDomain(key)));
      if (domainRead && current.countable?.has(key)) {
        next.set(key, { ...entry, lastSeenAt: nowIso });
      } else if (domainRead && nowMs - lastMs >= gcAfterMs) {
        next.delete(key);
      } else if (memorySeen > persistedSeen) {
        next.set(key, { ...entry, lastSeenAt: new Date(memorySeen).toISOString() });
      }
    }
  }

  function write(mutate, current) {
    const run = () => {
      if (unreadable) throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
      const nowMs = now();
      const next = new Map(entries);
      collect(next, current, nowMs);
      const result = mutate(next, nowMs);
      try {
        persist(next);
      } catch (error) {
        logger?.error?.(`[attention-acks] could not save: ${error?.code || error?.message || error}`);
        throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
      }
      for (const key of [...superseded]) if (!next.has(key) || result?.replaced === key) superseded.delete(key);
      for (const key of [...seen.keys()]) if (!next.has(key)) seen.delete(key);
      entries = next;
      corrupt = false;
      return result?.value;
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  /** Store an ack/shelve for a countable item (fingerprint = its current rank and count). */
  function set({ key, kind, until = null, rank, count }, current = null) {
    return write((next, nowMs) => {
      if (!next.has(key) && next.size >= maxEntries) {
        throw httpError(409, 'ack_store_full', 'Too many acknowledgements are stored; remove some first');
      }
      const at = new Date(nowMs).toISOString();
      const entry = validEntry({
        key, kind, at, until: kind === 'shelve' ? until : null, rank, count: Number.isInteger(count) && count > 0 ? count : 1, lastSeenAt: at,
      });
      if (!entry) throw httpError(400, 'invalid_ack', 'The acknowledgement is not valid');
      next.set(key, entry);
      seen.set(key, nowMs);
      return { value: publicAck(entry), replaced: key };
    }, current);
  }

  /** Remove a stored acknowledgement. Resolves false when there was none. */
  function remove(key, current = null) {
    return write((next) => {
      const existed = next.delete(key);
      if (!existed && !entries.has(key)) throw httpError(404, 'ack_not_found', 'Nothing is acknowledged under that key');
      return { value: true };
    }, current);
  }

  return { file, resolve, peek, has, list, set, remove };
}

module.exports = {
  createAttentionAckStore, validateAckRequest, publicAck,
  ACK_STORE_VERSION: STORE_VERSION, ACK_MAX_ENTRIES: MAX_ENTRIES, ACK_GC_AFTER_MS: GC_AFTER_MS,
};
