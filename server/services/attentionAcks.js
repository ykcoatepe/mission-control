'use strict';

// Attention acknowledgements: the badge rule's memory (acknowledge / shelve).
//
// One JSON file in the data directory (<dataDir>/attention/acks.json):
//   { version: 1, sessions: [{ id, pid, at }],
//     acks: [{ key, kind, at, until, rank, count, lastSeenAt, id?, reasons? }] }
// kind 'ack'    "seen, it will stay like this": holds while the item is no
//               worse than its fingerprint (severity rank, count and, for a
//               system, the hashed identities of its reasons at the time of
//               the ack). A rise or a new reason voids it for good.
// kind 'shelve' silence until `until` (null = until unshelved); a shelved item
//               that BECOMES critical counts again (voided).
//
// Voids never come back. Reads (resolve, peek) are pure: they never touch the
// disk, so a void a GET sees is kept in memory first. It reaches the file
// from a non-request path: sweep() (the scheduler's `attention.acks` job, a
// few seconds apart, which also evaluates every countable item itself), any
// POST/DELETE, and close() at shutdown. Restore is conservative: every
// process that uses the file is listed in `sessions` while it runs and
// removes itself in close(). A session whose process is gone without that
// final write may have died holding voids only it knew, so when a store finds
// one, NONE of the acknowledgements present at that moment are trusted: they
// are voided (fail closed; the operator acknowledges again). Until this
// process is listed itself, restored acknowledgements do not hold.
//
// One store instance per file per process (a second one is refused), and
// every write re-reads the file and merges under an exclusive lock file
// (<file>.lock, stale-lock recovery), so another process cannot lose entries
// either. Writes are atomic (temp file 0600 + rename) and bounded
// (MAX_ENTRIES). An acknowledgement whose item has been absent for
// GC_AFTER_MS (7 days) is dropped at a write, never at once (items flap); an
// item is only known absent when its reading was read.
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
const MAX_SESSIONS = 32;
const MAX_REASONS = 64;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 15;
const KINDS = new Set(['ack', 'shelve']);
const CRITICAL_RANK = stateRank('critical');
const MAX_RANK = CRITICAL_RANK;
const HEX12 = /^[0-9a-f]{12}$/;
const SESSION_ID = /^[0-9a-f]{16}$/;

// Stores open in this process, by resolved file path -> session id.
const OPEN_STORES = new Map();

function isoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validReasons(reasons) {
  return Array.isArray(reasons) && reasons.length <= MAX_REASONS && reasons.every((r) => typeof r === 'string' && HEX12.test(r));
}

function validEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { key, kind, at, until = null, rank, count, lastSeenAt = null, id, reasons } = raw;
  if (!isAckKey(key) || !KINDS.has(kind) || isoMs(at) === null) return null;
  if (until !== null && (kind !== 'shelve' || isoMs(until) === null)) return null;
  if (!Number.isInteger(rank) || rank < 0 || rank > MAX_RANK) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  if (lastSeenAt !== null && isoMs(lastSeenAt) === null) return null;
  if (id !== undefined && (typeof id !== 'string' || !HEX12.test(id))) return null;
  if (reasons !== undefined && !validReasons(reasons)) return null;
  return {
    key, kind, at, until, rank, count, lastSeenAt,
    ...(id !== undefined ? { id } : {}),
    ...(reasons !== undefined ? { reasons: [...reasons] } : {}),
  };
}

function validSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, pid, at } = raw;
  if (typeof id !== 'string' || !SESSION_ID.test(id) || !Number.isInteger(pid) || pid <= 0 || isoMs(at) === null) return null;
  return { id, pid, at };
}

/** The identity of one acknowledgement (a re-ack of the same key is a different one). */
function identity(entry) {
  return entry.id || entry.at;
}

function publicAck(entry) {
  return { kind: entry.kind, at: entry.at, until: entry.until ?? null };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
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
  lockStaleMs = LOCK_STALE_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  lockRetryMs = LOCK_RETRY_MS,
  isAlive = pidAlive,
} = {}) {
  if (!file) throw new TypeError('createAttentionAckStore: file is required');
  const resolved = path.resolve(file);
  if (OPEN_STORES.has(resolved)) {
    throw new Error('createAttentionAckStore: an acknowledgement store is already open for this file in this process');
  }
  const sessionId = crypto.randomBytes(8).toString('hex');
  const lockPath = `${file}.lock`;
  let entries = new Map(); // the file's acknowledgements as last read or written
  let diskSessions = []; // the sessions the file listed then
  let diskSig = null; // ino:mtime:size of the file then
  let unreadable = false; // the file exists but cannot be read: never overwrite
  let registered = false; // this session is listed in the file
  let closed = false;
  const seen = new Map(); // key -> ms an item was last seen countable (memory)
  const voided = new Map(); // key -> identity of the voided acknowledgement (memory until written)
  let queue = Promise.resolve();
  let seq = 0;

  function signature() {
    try {
      const stat = fsImpl.statSync(file);
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  // The file as it is now: { exists, corrupt, entries, sessions, deadSession }.
  // Throws { unreadable: true } when it exists but cannot be read.
  function readDisk() {
    const out = { exists: false, corrupt: false, entries: new Map(), sessions: [], deadSession: false };
    let text;
    try {
      const stat = fsImpl.statSync(file);
      out.exists = true;
      if (stat.size > maxFileBytes) {
        out.corrupt = true;
        return out;
      }
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...out, exists: false };
      throw Object.assign(new Error('unreadable'), { unreadable: true, code: error?.code });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      out.corrupt = true;
      return out;
    }
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !Array.isArray(parsed.acks)
      || (parsed.sessions !== undefined && !Array.isArray(parsed.sessions))) {
      out.corrupt = true;
      return out;
    }
    for (const raw of parsed.acks.slice(0, maxEntries)) {
      const entry = validEntry(raw);
      if (!entry || out.entries.has(entry.key)) {
        out.corrupt = true;
        continue;
      }
      out.entries.set(entry.key, entry);
    }
    if (parsed.acks.length > maxEntries) out.corrupt = true;
    for (const raw of (parsed.sessions || []).slice(0, MAX_SESSIONS * 2)) {
      const session = validSession(raw);
      // An unreadable session record may be a process that died: it counts as one.
      if (!session) out.deadSession = true;
      else out.sessions.push(session);
    }
    return out;
  }

  function sessionAlive(session) {
    if (session.id === sessionId) return true;
    if (session.pid === process.pid) return [...OPEN_STORES.values()].includes(session.id);
    return isAlive(session.pid);
  }

  function hasDeadSession(disk) {
    return disk.deadSession || disk.sessions.some((session) => !sessionAlive(session));
  }

  // --- lock -----------------------------------------------------------------

  function tryLock() {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fsImpl.openSync(lockPath, 'wx', 0o600);
        try {
          fsImpl.writeSync(fd, JSON.stringify({ pid: process.pid, session: sessionId, at: new Date().toISOString() }));
        } finally {
          fsImpl.closeSync(fd);
        }
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      if (!removeStaleLock()) return false;
    }
    return false;
  }

  // A lock is stale when its process is gone (or is this process: a commit
  // never holds it across an await, so it is a leftover) or it is older than
  // lockStaleMs. It is moved aside and removed only if it is still the same
  // file that was judged stale.
  function removeStaleLock() {
    let stat;
    let owner = null;
    try {
      stat = fsImpl.statSync(lockPath);
      try {
        owner = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'));
      } catch {}
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    const pid = Number.isInteger(owner?.pid) ? owner.pid : null;
    const old = Date.now() - stat.mtimeMs > lockStaleMs;
    const gone = pid !== null && (pid === process.pid || !isAlive(pid));
    if (!old && !gone) return false;
    const aside = `${lockPath}.stale-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.renameSync(lockPath, aside);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    try {
      if (fsImpl.statSync(aside).ino !== stat.ino) {
        // Another writer took the lock in between: put it back.
        try {
          fsImpl.linkSync(aside, lockPath);
        } catch {}
        return false;
      }
      return true;
    } finally {
      try {
        fsImpl.rmSync(aside, { force: true });
      } catch {}
    }
  }

  function unlock() {
    try {
      fsImpl.rmSync(lockPath, { force: true });
    } catch {}
  }

  async function acquireLock() {
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      if (tryLock()) return;
      if (Date.now() >= deadline) throw httpError(503, 'ack_store_busy', 'Acknowledgements cannot be saved right now');
      await new Promise((resolve) => setTimeout(resolve, lockRetryMs));
    }
  }

  // --- evaluation (memory only) ---------------------------------------------

  function expired(entry, nowMs) {
    return entry.kind === 'shelve' && entry.until !== null && isoMs(entry.until) <= nowMs;
  }

  function isVoid(entry) {
    return voided.get(entry.key) === identity(entry);
  }

  /**
   * Whether the stored acknowledgement of a countable item holds as far as the
   * item goes (registration aside). A rise, a new reason or a shelved item
   * turning critical voids it in memory; it never holds again.
   */
  function evaluate(item) {
    const key = item?.key;
    const entry = key ? entries.get(key) : null;
    if (!entry || isVoid(entry)) return null;
    const nowMs = now();
    seen.set(key, nowMs);
    const rank = Number.isInteger(item.rank) ? item.rank : 0;
    const count = Number.isInteger(item.count) ? item.count : 1;
    if (entry.kind === 'ack') {
      const known = new Set(entry.reasons || []);
      const newReason = Array.isArray(item.reasons) && item.reasons.some((reason) => !known.has(reason));
      if (rank > entry.rank || count > entry.count || newReason) {
        voided.set(key, identity(entry));
        return null;
      }
    }
    if (entry.kind === 'shelve') {
      if (expired(entry, nowMs)) return null;
      if (rank >= CRITICAL_RANK && entry.rank < CRITICAL_RANK) {
        voided.set(key, identity(entry));
        return null;
      }
    }
    return entry;
  }

  /**
   * Whether the acknowledgement of a countable item holds. item: { key, rank,
   * count, reasons? }. Pure as far as the disk goes. Restored acknowledgements
   * hold only once this session is listed in the file.
   */
  function resolve(item) {
    const entry = evaluate(item);
    if (!entry || !registered) return { ack: null, holds: false };
    return { ack: publicAck(entry), holds: true };
  }

  /** The stored acknowledgement of a key that is not countable now (or null). */
  function peek(key) {
    const entry = entries.get(key);
    if (!entry || !registered || isVoid(entry) || expired(entry, now())) return null;
    return publicAck(entry);
  }

  function has(key) {
    return entries.has(key);
  }

  function list() {
    return [...entries.values()].map((entry) => ({ key: entry.key, ...publicAck(entry), superseded: isVoid(entry) }));
  }

  // --- writes (under the lock, re-read + merge) -----------------------------

  function persist(next, sessions, corruptOnDisk) {
    const dir = path.dirname(file);
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    const body = JSON.stringify({ version: STORE_VERSION, sessions, acks: [...next.values()] }, null, 1);
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
      if (isVoid(entry) || expired(entry, nowMs)) {
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

  // One read-modify-write of the file. The caller holds the lock; nothing in
  // here awaits.
  function commit(mutate, current, { closing = false } = {}) {
    const disk = readDisk();
    const nowMs = now();
    const next = disk.entries;
    if (hasDeadSession(disk) && next.size) {
      // A process stopped without its final write: it may have known voids
      // nobody else knows. Trust none of what is stored now.
      for (const entry of next.values()) voided.set(entry.key, identity(entry));
      logger?.warn?.(`[attention-acks] a previous session ended without closing the store; ${next.size} acknowledgement(s) are no longer trusted`);
    }
    collect(next, current, nowMs);
    const result = mutate ? mutate(next, nowMs) : undefined;
    const others = disk.sessions.filter((session) => session.id !== sessionId && sessionAlive(session));
    const sessions = closing ? others : [...others, { id: sessionId, pid: process.pid, at: new Date(nowMs).toISOString() }];
    persist(next, sessions.slice(-MAX_SESSIONS), disk.corrupt);
    entries = next;
    diskSessions = sessions;
    diskSig = signature();
    registered = !closing;
    // A void is in the file once its acknowledgement is gone from it.
    for (const [key, id] of [...voided]) if (!entries.has(key) || identity(entries.get(key)) !== id) voided.delete(key);
    for (const key of [...seen.keys()]) if (!entries.has(key)) seen.delete(key);
    return result;
  }

  function write(mutate, current) {
    const run = async () => {
      if (unreadable || closed) throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
      await acquireLock();
      try {
        return commit(mutate, current)?.value;
      } catch (error) {
        if (error?.status && error?.code) throw error; // an httpError from mutate
        if (error?.unreadable) unreadable = true;
        logger?.error?.(`[attention-acks] could not save: ${error?.code || error?.message || error}`);
        throw httpError(503, 'ack_store_unavailable', 'Acknowledgements cannot be saved right now');
      } finally {
        unlock();
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  }

  /** Store an ack/shelve for a countable item (fingerprint = its current rank, count and reasons). */
  function set({ key, kind, until = null, rank, count, reasons }, current = null) {
    return write((next, nowMs) => {
      if (!next.has(key) && next.size >= maxEntries) {
        throw httpError(409, 'ack_store_full', 'Too many acknowledgements are stored; remove some first');
      }
      const at = new Date(nowMs).toISOString();
      const entry = validEntry({
        key, kind, at, until: kind === 'shelve' ? until : null, rank, count: Number.isInteger(count) && count > 0 ? count : 1, lastSeenAt: at,
        id: crypto.randomBytes(6).toString('hex'),
        ...(Array.isArray(reasons) ? { reasons: reasons.slice(0, MAX_REASONS) } : {}),
      });
      if (!entry) throw httpError(400, 'invalid_ack', 'The acknowledgement is not valid');
      next.set(key, entry);
      seen.set(key, nowMs);
      return { value: publicAck(entry) };
    }, current);
  }

  /** Remove a stored acknowledgement. Resolves true; 404 when there was none. */
  function remove(key, current = null) {
    return write((next) => {
      const existed = next.delete(key);
      if (!existed && !entries.has(key)) throw httpError(404, 'ack_not_found', 'Nothing is acknowledged under that key');
      return { value: true };
    }, current);
  }

  /**
   * The scheduled, non-request path: pick up other processes' writes, judge
   * every countable item of `current` (attentionItems() output), and write
   * when something is to be written (a void, this session not listed yet
   * while acknowledgements exist, or a session that ended without closing).
   * Resolves true when it wrote.
   */
  async function sweep(current) {
    if (unreadable || closed) return false;
    let disk = null;
    const sig = signature();
    if (sig !== diskSig) {
      try {
        disk = readDisk();
      } catch (error) {
        if (error?.unreadable) unreadable = true;
        return false;
      }
      if (!disk.corrupt) {
        entries = disk.entries;
        diskSessions = disk.sessions;
        diskSig = sig;
        registered = registered && disk.sessions.some((session) => session.id === sessionId);
      }
    }
    for (const item of current?.countable?.values?.() || []) evaluate(item);
    const dead = disk ? hasDeadSession(disk) : diskSessions.some((session) => !sessionAlive(session));
    const pending = [...entries.values()].some(isVoid) || (entries.size > 0 && (!registered || dead));
    if (!pending) return false;
    await write(null, current);
    return true;
  }

  /**
   * Final write at shutdown (synchronous): pending voids reach the file and
   * this session leaves the list. If the lock cannot be had, the session stays
   * listed and the next start does not trust what is stored (conservative).
   */
  function close() {
    if (closed) return;
    closed = true;
    try {
      const pending = registered || [...entries.values()].some(isVoid);
      if (!pending || unreadable) return;
      if (!tryLock()) {
        logger?.warn?.('[attention-acks] store busy at shutdown; the next start will not trust stored acknowledgements');
        return;
      }
      try {
        commit(null, null, { closing: true });
      } finally {
        unlock();
      }
    } catch (error) {
      logger?.error?.(`[attention-acks] could not save at shutdown: ${error?.code || error?.message || error}`);
    } finally {
      OPEN_STORES.delete(resolved);
    }
  }

  OPEN_STORES.set(resolved, sessionId);

  // Restore: read the file; when it holds acknowledgements, list this session
  // in it at once (and drop what a dead session leaves untrusted), so a void
  // seen from here on can never be outlived by an unlisted crash.
  try {
    const disk = readDisk();
    entries = disk.entries;
    diskSessions = disk.sessions;
    diskSig = signature();
    if (disk.corrupt) logger?.warn?.('[attention-acks] store had invalid entries; a copy is kept at the next write');
    if (entries.size > 0) {
      if (tryLock()) {
        try {
          commit(null, null);
        } finally {
          unlock();
        }
      } else {
        logger?.warn?.('[attention-acks] store busy at start; stored acknowledgements hold once this session is listed');
      }
    }
  } catch (error) {
    if (error?.unreadable) {
      unreadable = true;
      logger?.error?.(`[attention-acks] store cannot be read (${error?.code || 'error'}); acknowledgements are read-only`);
    } else {
      logger?.error?.(`[attention-acks] could not register at start: ${error?.code || error?.message || error}`);
    }
  }

  return { file, resolve, peek, has, list, set, remove, sweep, close };
}

module.exports = {
  createAttentionAckStore, validateAckRequest, publicAck,
  ACK_STORE_VERSION: STORE_VERSION, ACK_MAX_ENTRIES: MAX_ENTRIES, ACK_GC_AFTER_MS: GC_AFTER_MS,
};
