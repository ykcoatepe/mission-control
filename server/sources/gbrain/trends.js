'use strict';
/**
 * Read-only projection of the readings ledger into 24-hour series for the Brain page's analog bars.
 *
 * The ledger only appends when a reading changed, so a series is the list of readings that were really
 * recorded, in time order. Nothing is interpolated, held or filled in: a reading that was not taken
 * (health "Unavailable", an entry whose source is "not-read") is left out, and a series with fewer than
 * two readings is empty, because a trend is never invented.
 */
const fs = require('fs');

const HOUR_MS = 3_600_000;
const WINDOW_MS = 24 * HOUR_MS;
const MAX_POINTS = 1000;
/** "99/100" (the ledger's own spelling of the quality score). */
const HEALTH = /^(\d+(?:\.\d+)?)\s*\/\s*100$/;
/** "99%" (the ledger rounds embedding coverage to a whole percent). */
const PERCENT = /^(\d+(?:\.\d+)?)\s*%$/;
/** "waiting / active / stalled". */
const QUEUE = /^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)$/;

function capturedMs(entry) {
  const t = Date.parse(entry?.capturedAt);
  return Number.isFinite(t) ? t : null;
}

/** Readings older than this, or dated more than this far ahead of the clock, are not readings of this ledger. */
const EARLIEST_MS = Date.parse('2020-01-01T00:00:00Z');
const FUTURE_SKEW_MS = 5 * 60_000;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a parsed ledger line is a reading: `capturedAt` is a string that parses to a time between
 * EARLIEST_MS and a little after `now`, `metrics` and `trust` (when present) are objects, every number
 * they carry is finite (JSON reads 1e999 as Infinity), and the three series fields are text or absent.
 * Anything else is a line that could not be read (counted, never silently dropped or kept).
 */
function validEntry(entry, now) {
  if (!plainObject(entry) || typeof entry.capturedAt !== 'string') return false;
  const t = Date.parse(entry.capturedAt);
  if (!Number.isFinite(t) || t < EARLIEST_MS || t > now + FUTURE_SKEW_MS) return false;
  for (const part of [entry.metrics, entry.trust]) {
    if (part === undefined || part === null) continue;
    if (!plainObject(part)) return false;
    for (const value of Object.values(part)) if (typeof value === 'number' && !Number.isFinite(value)) return false;
  }
  for (const name of ['health', 'embeddings', 'queue']) {
    const value = entry.metrics?.[name];
    if (value !== undefined && value !== null && typeof value !== 'string') return false;
  }
  return true;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Quality score out of 100, or null when the entry carries no real reading. */
function qualityOf(entry) {
  if (entry?.trust?.source === 'not-read') return null;
  const match = HEALTH.exec(text(entry?.metrics?.health));
  return match ? Number(match[1]) : null;
}

function embeddedPercentOf(entry) {
  if (entry?.trust?.source === 'not-read') return null;
  const match = PERCENT.exec(text(entry?.metrics?.embeddings));
  return match ? Number(match[1]) : null;
}

/** Jobs in the queue: waiting + active + stalled. */
function queueTotalOf(entry) {
  const match = QUEUE.exec(text(entry?.metrics?.queue));
  return match ? Number(match[1]) + Number(match[2]) + Number(match[3]) : null;
}

const SERIES = Object.freeze({ quality: qualityOf, embeddedPercent: embeddedPercentOf, queue: queueTotalOf });

/**
 * @param {Array<object>} entries ledger entries, any order
 * @param {{now: number, windowMs?: number}} options
 * @returns {{since: string, until: string, entryCount: number, series: Record<string, Array<{t:number, v:number}>>}}
 */
function projectTrends(entries, { now, windowMs = WINDOW_MS }) {
  const since = now - windowMs;
  const inWindow = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ entry, t: capturedMs(entry) }))
    .filter(({ t }) => t !== null && t >= since && t <= now)
    .sort((a, b) => a.t - b.t);
  const series = {};
  for (const [name, read] of Object.entries(SERIES)) {
    const points = [];
    for (const { entry, t } of inWindow) {
      const v = read(entry);
      if (v !== null && Number.isFinite(v)) points.push({ t, v });
    }
    // Newest readings win when there are more than the page can use.
    const kept = points.slice(-MAX_POINTS);
    series[name] = kept.length >= 2 ? kept : [];
  }
  return { since: new Date(since).toISOString(), until: new Date(now).toISOString(), entryCount: inWindow.length, series };
}

/** Read the ledger backwards in pieces of this size. */
const CHUNK_BYTES = 64 * 1024;
/** Hard cap on the bytes read for one window. The live ledger writes about 1.5 KB a reading and ~100 readings a day. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/** Hard cap on the lines parsed for one window. */
const MAX_TAIL_LINES = 5000;
/** Reading stops after this many readings in a row older than the window (the ledger appends in time order; a few out of place are tolerated). */
const OLDER_IN_A_ROW = 32;

class TrendsReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Reads only the tail of the ledger that the window needs. The ledger appends in time order, so reading
 * backwards stops once OLDER_IN_A_ROW complete readings in a row are older than `since`. Input is bounded twice: at most
 * `maxBytes` bytes are read and at most `maxLines` lines parsed; a window that needs more is a typed
 * failure (`gbrain_trends_too_large`), never a whole-file read that blocks the event loop. A line that
 * is not a valid reading (validEntry) is counted in `skippedLines`, never silently dropped or kept.
 */
function readLedgerTail(ledgerPath, { since, now = Date.now(), maxBytes = MAX_TAIL_BYTES, maxLines = MAX_TAIL_LINES, fsImpl = fs } = {}) {
  let fd;
  try {
    fd = fsImpl.openSync(ledgerPath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], skippedLines: 0, stat: null };
    throw new TrendsReadError('gbrain_timeline_unavailable', 'Timeline ledger unavailable');
  }
  try {
    let stat;
    try {
      stat = fsImpl.fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new TrendsReadError('gbrain_timeline_unavailable', 'Timeline ledger unavailable');
    }
    const entries = [];
    let skippedLines = 0;
    let lines = 0;
    let pos = stat.size;
    let carry = Buffer.alloc(0); // the start of a line whose beginning is not read yet
    let reachedStart = false;
    let older = 0;
    const take = (bytes) => {
      for (let end = bytes.length; end >= 0;) {
        const nl = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
        const line = bytes.subarray(nl + 1, end).toString('utf8').trim();
        end = nl;
        if (line) {
          lines += 1;
          if (lines > maxLines) throw new TrendsReadError('gbrain_trends_too_large', 'The readings history for the last 24 hours is too large to read');
          let parsed = null;
          try {
            parsed = JSON.parse(line);
          } catch {}
          if (!validEntry(parsed, now)) {
            skippedLines += 1;
          } else {
            const t = capturedMs(parsed);
            if (t < since) {
              older += 1;
              if (older >= OLDER_IN_A_ROW) return true;
            } else {
              older = 0;
              entries.push(parsed);
            }
          }
        }
        if (nl < 0) break;
      }
      return false;
    };
    while (pos > 0 && !reachedStart) {
      if (stat.size - pos >= maxBytes) throw new TrendsReadError('gbrain_trends_too_large', 'The readings history for the last 24 hours is too large to read');
      const length = Math.min(CHUNK_BYTES, pos, maxBytes - (stat.size - pos));
      const chunk = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fsImpl.readSync(fd, chunk, read, length - read, pos - length + read);
        if (n <= 0) break;
        read += n;
      }
      if (read < length) throw new TrendsReadError('gbrain_timeline_unavailable', 'Timeline ledger unavailable');
      pos -= length;
      const bytes = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      if (pos === 0) {
        reachedStart = take(bytes) || true;
        carry = Buffer.alloc(0);
      } else {
        // Everything after the first newline is made of whole lines; the part before it continues upwards.
        const first = bytes.indexOf(10);
        if (first < 0) {
          carry = bytes;
          continue;
        }
        carry = Buffer.from(bytes.subarray(0, first));
        reachedStart = take(bytes.subarray(first + 1));
      }
    }
    return { entries, skippedLines, stat };
  } finally {
    try {
      fsImpl.closeSync(fd);
    } catch {}
  }
}

/**
 * Reads the window's tail of the ledger and keeps it until the file changes, so a poll every minute does
 * not read the ledger every time. Returns { entries, skippedLines, observedAt } or throws an error whose
 * `code` is gbrain_timeline_unavailable (cannot be read) or gbrain_trends_too_large (over the caps).
 */
function createTrendsReader({ windowMs = WINDOW_MS, maxBytes = MAX_TAIL_BYTES, maxLines = MAX_TAIL_LINES, fsImpl = fs } = {}) {
  let cache = null;
  return function read(ledgerPath, { now = Date.now() } = {}) {
    let stat = null;
    try {
      stat = fsImpl.statSync(ledgerPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new TrendsReadError('gbrain_timeline_unavailable', 'Timeline ledger unavailable');
    }
    const since = now - windowMs;
    const key = stat ? `${ledgerPath}:${stat.ino}:${stat.mtimeMs}:${stat.size}` : `${ledgerPath}:absent`;
    // A cached tail covers any later window of the same file (the window only moves forward).
    if (cache && cache.key === key && cache.since <= since) return cache.value;
    const tail = readLedgerTail(ledgerPath, { since, now, maxBytes, maxLines, fsImpl });
    const value = {
      entries: tail.entries,
      skippedLines: tail.skippedLines,
      observedAt: tail.stat ? new Date(tail.stat.mtimeMs).toISOString() : null,
    };
    cache = { key, since, value };
    return value;
  };
}

module.exports = { projectTrends, createTrendsReader, readLedgerTail, WINDOW_MS, MAX_POINTS, MAX_TAIL_BYTES, MAX_TAIL_LINES };
