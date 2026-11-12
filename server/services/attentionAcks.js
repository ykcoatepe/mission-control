'use strict';

// Attention acknowledgements: the badge rule's memory (acknowledge / shelve).
//
// One JSON file in the data directory (<dataDir>/attention/acks.json):
//   { version: 2, acks: [{ key, kind, at, until, id, lastSeenAt,
//       fingerprint: { rank, reasonIds, counts }, voidedAt, voidReason }] }
// kind 'ack'    "seen, it will stay like this": holds while the item is not
//               worse than the fingerprint taken at the acknowledgement
//               (worseThan() in sources/mloop/attention.js: rank rose, a new
//               reason id, or a count above its acknowledged value).
// kind 'shelve' silence until `until` (null = until unshelved); a shelved item
//               that BECOMES critical counts again.
//
// Rules (there are four, and no others):
//   1. A void is a durable tombstone on the record (voidedAt, voidReason). It
//      is written by reconcile() only, which the scheduler runs right after
//      the attention readings refresh (a non-request path), synchronously,
//      before reconcile() returns. A tombstoned record never holds again; it
//      goes when the item is acknowledged again or collected.
//   2. Reads (resolve, peek, list) are pure functions of the stored records
//      and the item they are given. They never write and keep no memory: an
//      item that is worse than its acknowledgement does not hold in that
//      answer, and the tombstone follows at the next reconcile().
//   3. One process owns the file. Ownership is <file>.owner, created with
//      O_EXCL, holding this process's pid AND start time (`ps -o lstart=`,
//      run through the core process runner). An owner is stale only when that
//      pid is gone or its start time is different (a reused pid); a live owner
//      is never displaced and nothing is ever taken over by age. A store that
//      cannot own the file does not open (AckStoreUnavailableError);
//      openAttentionAckStore() then serves every read as "nothing
//      acknowledged" with available() === false. The app opens the store when
//      it starts (runtime.start(), never while a request is served).
//   4. Writes are synchronous, so they are serialized in-process, and atomic
//      (temp file 0600 + rename). Ownership is checked before every write.
//
// An acknowledgement whose item has been absent for GC_AFTER_MS (7 days) is
// dropped by reconcile(), never at once (items flap); an item is only known
// absent when its reading was read. An expired shelve is dropped there too.
//
// A missing file is an empty store. An unparsable, oversized, partly invalid
// or older-version file starts empty; its content is copied to
// acks.json.corrupt-<time> before the first write replaces it, and a write
// that cannot keep that copy fails instead. A file that cannot be read at all
// (permissions) does not open.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../core/http');
const { stateRank } = require('../core/state');
const { isAckKey, isFingerprint, keyDomain, worseThan } = require('../sources/mloop/attention');

const STORE_VERSION = 2;
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 1024 * 1024;
const GC_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SHELVE_MS = 366 * 24 * 60 * 60 * 1000;
// lastSeenAt is rewritten at most this often (it only feeds the 7-day rule).
const LAST_SEEN_STEP_MS = 60 * 60 * 1000;
const KINDS = new Set(['ack', 'shelve']);
const VOID_REASONS = new Set(['rank', 'reason', 'count', 'critical']);
const CRITICAL_RANK = stateRank('critical');
const HEX12 = /^[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{24}$/;

class AckStoreUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AckStoreUnavailableError';
    this.code = code; // 'ack_store_owned' | 'ack_store_unreadable' | 'ack_store_identity_unknown'
  }
}

function isoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { key, kind, at, until = null, id, lastSeenAt = null, fingerprint, voidedAt = null, voidReason = null } = raw;
  if (!isAckKey(key) || !KINDS.has(kind) || isoMs(at) === null) return null;
  if (until !== null && (kind !== 'shelve' || isoMs(until) === null)) return null;
  if (typeof id !== 'string' || !HEX12.test(id)) return null;
  if (lastSeenAt !== null && isoMs(lastSeenAt) === null) return null;
  if (!isFingerprint(fingerprint) || fingerprint.rank > CRITICAL_RANK) return null;
  if ((voidedAt === null) !== (voidReason === null)) return null;
  if (voidedAt !== null && (isoMs(voidedAt) === null || !VOID_REASONS.has(voidReason))) return null;
  return {
    key, kind, at, until, id, lastSeenAt,
    fingerprint: { rank: fingerprint.rank, reasonIds: [...fingerprint.reasonIds], counts: { ...fingerprint.counts } },
    voidedAt, voidReason,
  };
}

function publicAck(entry) {
  return { kind: entry.kind, at: entry.at, until: entry.until ?? null };
}

/**
 * This process's identity for the owner file, read through the core process
 * runner: { pid, startTime(pid) } where startTime resolves to the start time
 * the system reports (`ps -o lstart= -p <pid>`), null when there is no such
 * process, and rejects when that cannot be told.
 */
function runnerProcessInfo(exec, pid = process.pid) {
  if (typeof exec?.run !== 'function') throw new TypeError('runnerProcessInfo: exec runner required');
  return {
    pid,
    async startTime(other) {
      const result = await exec.run('ps', ['-o', 'lstart=', '-p', String(other)], {
        lane: 'default', key: `ps:lstart:${other}`, timeoutMs: 5000, maxOutputBytes: 4096,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      });
      const out = String(result?.stdout || '').trim();
      if (result?.ok && out) return out;
      // ps exits 1 and prints nothing when the pid does not exist.
      if (result && !result.ok && !result.error && result.code === 1 && !out) return null;
      throw new Error('process start time could not be read');
    },
  };
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

function unavailable() {
  return httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
}

/**
 * Open the store (async: it reads process start times). Rejects with
 * AckStoreUnavailableError when another live process owns the file, the file
 * cannot be read, or this process's own identity cannot be told.
 * processInfo: { pid, startTime(pid) -> string | null } (null = no such
 * process; a throw = cannot tell); see runnerProcessInfo().
 */
async function createAttentionAckStore({
  file,
  now = Date.now,
  logger = console,
  fsImpl = fs,
  maxEntries = MAX_ENTRIES,
  maxFileBytes = MAX_FILE_BYTES,
  gcAfterMs = GC_AFTER_MS,
  processInfo,
} = {}) {
  if (!file) throw new TypeError('createAttentionAckStore: file is required');
  if (!Number.isInteger(processInfo?.pid) || typeof processInfo.startTime !== 'function') {
    throw new TypeError('createAttentionAckStore: processInfo { pid, startTime } is required');
  }
  const ownerPath = `${file}.owner`;
  const token = crypto.randomBytes(12).toString('hex');
  let entries = new Map();
  let corruptOnDisk = false; // the file's content must be kept aside before it is replaced
  let dirty = false; // memory is ahead of the file (a write failed); retried at the next reconcile
  let closed = false;
  let lost = false; // ownership was lost: never write again
  let seq = 0;

  // --- ownership ------------------------------------------------------------

  function readOwner() {
    let text;
    try {
      text = fsImpl.readFileSync(ownerPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { absent: true };
      throw new AckStoreUnavailableError('ack_store_unreadable', 'The acknowledgement store owner file cannot be read');
    }
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const valid = parsed && Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.startTime === 'string' && parsed.startTime
      && typeof parsed.token === 'string' && TOKEN.test(parsed.token);
    return { absent: false, text, owner: valid ? parsed : null };
  }

  // Stale only when the recorded process is gone or is a different process
  // (same pid, other start time). Anything that cannot be told is a live owner.
  async function ownerIsStale(owner) {
    if (!owner) return false; // unreadable record: cannot tell, never displaced
    let start;
    try {
      start = await processInfo.startTime(owner.pid);
    } catch {
      return false;
    }
    return start === null || start !== owner.startTime;
  }

  async function claim() {
    let myStart;
    try {
      myStart = await processInfo.startTime(processInfo.pid);
    } catch {
      myStart = null;
    }
    if (typeof myStart !== 'string' || !myStart) {
      throw new AckStoreUnavailableError('ack_store_identity_unknown', 'This process cannot identify itself, so it cannot own the acknowledgement store');
    }
    const body = JSON.stringify({ pid: processInfo.pid, startTime: myStart, token, at: new Date(now()).toISOString() });
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fsImpl.writeFileSync(ownerPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new AckStoreUnavailableError('ack_store_unreadable', 'The acknowledgement store owner file cannot be written');
      }
      const seen = readOwner();
      if (seen.absent) continue; // released in between: try to create it again
      if (!(await ownerIsStale(seen.owner))) {
        throw new AckStoreUnavailableError('ack_store_owned', 'Another running process owns the acknowledgement store');
      }
      // The owner is gone. Replace its record atomically, but only if it is
      // still the record that was judged stale.
      const again = readOwner();
      if (again.absent) continue;
      if (again.text !== seen.text) {
        throw new AckStoreUnavailableError('ack_store_owned', 'Another running process owns the acknowledgement store');
      }
      const tmp = `${ownerPath}.tmp-${token}`;
      try {
        fsImpl.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fsImpl.renameSync(tmp, ownerPath);
      } catch {
        try { fsImpl.rmSync(tmp, { force: true }); } catch {}
        throw new AckStoreUnavailableError('ack_store_unreadable', 'The acknowledgement store owner file cannot be written');
      }
      if (!owned()) throw new AckStoreUnavailableError('ack_store_owned', 'Another running process owns the acknowledgement store');
      logger?.warn?.('[attention-acks] the previous owner of the store is gone; this process owns it now');
      return;
    }
    throw new AckStoreUnavailableError('ack_store_owned', 'Another running process owns the acknowledgement store');
  }

  function owned() {
    try {
      const seen = readOwner();
      return !seen.absent && seen.owner?.token === token;
    } catch {
      return false;
    }
  }

  // --- file -----------------------------------------------------------------

  function load() {
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
      throw new AckStoreUnavailableError('ack_store_unreadable', 'The acknowledgement store cannot be read');
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

  // Write memory to the file. Synchronous; throws when it cannot.
  function persist() {
    if (closed || lost) throw new Error('store is closed');
    if (!owned()) {
      lost = true;
      logger?.error?.('[attention-acks] this process no longer owns the store; acknowledgements are unavailable');
      throw new Error('store ownership lost');
    }
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
    const tmp = `${file}.tmp-${processInfo.pid}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.chmodSync(tmp, 0o600);
      fsImpl.renameSync(tmp, file);
    } catch (error) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch {}
      throw error;
    }
    corruptOnDisk = false;
    dirty = false;
  }

  // Apply a change to memory and the file together: when the file cannot be
  // written, memory goes back to what the file holds.
  function mutate(change) {
    if (closed || lost) throw unavailable();
    const before = new Map(entries);
    try {
      const value = change();
      persist();
      return value;
    } catch (error) {
      entries = before;
      if (error?.status && error?.code) throw error; // an httpError from change()
      logger?.error?.(`[attention-acks] could not save: ${error?.code || error?.message || error}`);
      throw unavailable();
    }
  }

  // --- reads (pure) ---------------------------------------------------------

  function expired(entry, nowMs) {
    return entry.kind === 'shelve' && entry.until !== null && isoMs(entry.until) <= nowMs;
  }

  // Why the acknowledgement does not cover the item as it is now, or null.
  function voidReasonFor(entry, fingerprint) {
    if (entry.kind === 'ack') return worseThan(entry.fingerprint, fingerprint);
    return fingerprint.rank >= CRITICAL_RANK && entry.fingerprint.rank < CRITICAL_RANK ? 'critical' : null;
  }

  function live(entry, nowMs) {
    return Boolean(entry) && entry.voidedAt === null && !expired(entry, nowMs);
  }

  /**
   * Whether the acknowledgement of a countable item holds: it is stored, not
   * tombstoned, not expired, and the item (item.fingerprint) is not worse than
   * what was acknowledged. Pure: no write, no memory.
   */
  function resolve(item) {
    const entry = item?.key ? entries.get(item.key) : null;
    if (closed || lost || !live(entry, now()) || !isFingerprint(item.fingerprint) || voidReasonFor(entry, item.fingerprint)) {
      return { ack: null, holds: false };
    }
    return { ack: publicAck(entry), holds: true };
  }

  /** The stored acknowledgement of a key that is not countable now (or null). */
  function peek(key) {
    const entry = entries.get(key);
    return !closed && !lost && live(entry, now()) ? publicAck(entry) : null;
  }

  function has(key) {
    return entries.has(key);
  }

  function list() {
    return [...entries.values()].map((entry) => ({ key: entry.key, ...publicAck(entry), voidedAt: entry.voidedAt, voidReason: entry.voidReason }));
  }

  // --- writes ---------------------------------------------------------------

  /** Store an ack/shelve for a countable item with its current fingerprint. Replaces a tombstone. */
  function set({ key, kind, until = null, fingerprint }) {
    return mutate(() => {
      const nowMs = now();
      if (!entries.has(key) && entries.size >= maxEntries) {
        // Room is made from tombstones first (oldest), never from live records.
        const oldest = [...entries.values()].filter((entry) => entry.voidedAt !== null).sort((a, b) => isoMs(a.voidedAt) - isoMs(b.voidedAt))[0];
        if (!oldest) throw httpError(409, 'ack_store_full', 'Too many acknowledgements are stored; remove some first');
        entries.delete(oldest.key);
      }
      const at = new Date(nowMs).toISOString();
      const entry = validEntry({
        key, kind, at, until: kind === 'shelve' ? until : null, id: crypto.randomBytes(6).toString('hex'), lastSeenAt: at, fingerprint,
      });
      if (!entry) throw httpError(400, 'invalid_ack', 'The acknowledgement is not valid');
      entries.set(key, entry);
      return publicAck(entry);
    });
  }

  /** Remove a stored acknowledgement (or its tombstone). True; 404 when there was none. */
  function remove(key) {
    return mutate(() => {
      if (!entries.delete(key)) throw httpError(404, 'ack_not_found', 'Nothing is acknowledged under that key');
      return true;
    });
  }

  /**
   * The one place a void is decided and written. current: attentionItems()
   * output ({ countable, domains }) from the readings as just refreshed. Every
   * stored acknowledgement is compared with its item's fresh fingerprint; a
   * worse item gets a tombstone, and the file is written before this returns.
   * Also drops expired shelves and acknowledgements absent for gcAfterMs.
   * Returns { voided: [keys], wrote }. Throws when the file cannot be written
   * (memory keeps the tombstones, and the next call writes them).
   */
  function reconcile(current) {
    if (closed || lost) return { voided: [], wrote: false };
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const voided = [];
    let changed = dirty;
    for (const [key, entry] of [...entries]) {
      const item = current?.countable?.get?.(key);
      const domainRead = Boolean(current?.domains?.has?.(keyDomain(key)));
      const lastSeenMs = isoMs(entry.lastSeenAt) ?? isoMs(entry.at);
      if (entry.voidedAt === null && expired(entry, nowMs)) {
        entries.delete(key);
        changed = true;
        continue;
      }
      if (!item) {
        if (domainRead && nowMs - lastSeenMs >= gcAfterMs) {
          entries.delete(key);
          changed = true;
        }
        continue;
      }
      let next = entry;
      const reason = entry.voidedAt === null && isFingerprint(item.fingerprint) ? voidReasonFor(entry, item.fingerprint) : null;
      if (reason) {
        next = { ...next, voidedAt: nowIso, voidReason: reason };
        voided.push(key);
      }
      if (reason || nowMs - lastSeenMs >= LAST_SEEN_STEP_MS) next = { ...next, lastSeenAt: nowIso };
      if (next !== entry) {
        entries.set(key, next);
        changed = true;
      }
    }
    if (!changed) return { voided, wrote: false };
    dirty = true;
    persist();
    return { voided, wrote: true };
  }

  /** Release ownership at shutdown. Nothing else is pending: every change is written when it is made. */
  function close() {
    if (closed) return;
    try {
      if (dirty && !lost) persist();
    } catch (error) {
      logger?.error?.(`[attention-acks] could not save at shutdown: ${error?.code || error?.message || error}`);
    }
    closed = true;
    try {
      if (!lost && owned()) fsImpl.rmSync(ownerPath, { force: true });
    } catch {}
  }

  await claim();
  try {
    load();
  } catch (error) {
    try { fsImpl.rmSync(ownerPath, { force: true }); } catch {}
    throw error;
  }
  if (corruptOnDisk) logger?.warn?.('[attention-acks] the store file is not valid (or is an older version); it starts empty and a copy is kept at the next write');

  return { file, available: () => !closed && !lost, resolve, peek, has, list, set, remove, reconcile, close };
}

/**
 * The store as the app uses it: made closed, opened by open() (the app's
 * start and every scheduled reconcile call it; never a request). Until it is
 * open, and while the file cannot be owned, every read answers "nothing
 * acknowledged" (never "everything acknowledged"), available() is false and
 * writes are refused (503). open() never rejects; it resolves to available().
 */
function openAttentionAckStore(options = {}) {
  const { logger = console } = options;
  let store = null;
  let reason = 'ack_store_not_open';
  let closed = false;
  let opening = null;
  function open() {
    // A store that lost the file is dropped, so ownership can be claimed again once it is free.
    if (store && !store.available()) store = null;
    if (store || closed) return Promise.resolve(Boolean(store));
    if (!opening) {
      opening = createAttentionAckStore(options).then((opened) => {
        if (closed) opened.close();
        else store = opened;
        reason = null;
      }, (error) => {
        const code = error instanceof AckStoreUnavailableError ? error.code : 'ack_store_unavailable';
        if (reason !== code) logger?.warn?.(`[attention-acks] acknowledgements are unavailable: ${String(error?.message || error).split('\n')[0]}`);
        reason = code;
      }).then(() => {
        opening = null;
        return Boolean(store) && store.available();
      });
    }
    return opening;
  }
  const usable = () => Boolean(store) && store.available();
  return {
    file: options.file,
    available: usable,
    unavailableReason: () => (usable() ? null : reason || 'ack_store_unavailable'),
    resolve: (item) => (usable() ? store.resolve(item) : { ack: null, holds: false }),
    peek: (key) => (usable() ? store.peek(key) : null),
    has: (key) => usable() && store.has(key),
    list: () => (usable() ? store.list() : []),
    set(entry) {
      if (!usable()) throw unavailable();
      return store.set(entry);
    },
    remove(key) {
      if (!usable()) throw unavailable();
      return store.remove(key);
    },
    open,
    reconcile: (current) => (usable() ? store.reconcile(current) : { voided: [], wrote: false }),
    close() {
      closed = true;
      store?.close();
    },
  };
}

/** The envelope field every attention reading carries: whether acknowledgements could be read. */
function acksStatus(acks) {
  if (!acks || typeof acks.available !== 'function') return { available: true, reason: null };
  const available = acks.available() === true;
  return { available, reason: available ? null : (typeof acks.unavailableReason === 'function' ? acks.unavailableReason() : null) || 'ack_store_unavailable' };
}

module.exports = {
  AckStoreUnavailableError, createAttentionAckStore, openAttentionAckStore, runnerProcessInfo, acksStatus, validateAckRequest, publicAck,
  ACK_STORE_VERSION: STORE_VERSION, ACK_MAX_ENTRIES: MAX_ENTRIES, ACK_GC_AFTER_MS: GC_AFTER_MS,
};
