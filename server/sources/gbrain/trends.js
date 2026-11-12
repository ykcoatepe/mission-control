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

/**
 * Reads the ledger through `readTimeline` and keeps the parsed entries until the file changes, so a
 * poll every minute does not parse the whole ledger every time.
 */
function createTrendsReader({ readTimeline, limit = 5000 }) {
  let cache = null;
  return function read(ledgerPath) {
    let stat = null;
    try {
      stat = fs.statSync(ledgerPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(new Error('Timeline ledger unavailable'), { code: 'gbrain_timeline_unavailable' });
    }
    const key = stat ? `${ledgerPath}:${stat.mtimeMs}:${stat.size}` : `${ledgerPath}:absent`;
    if (cache && cache.key === key) return cache.value;
    const result = readTimeline({ ledgerPath, limit, maxLimit: limit, defaultLimit: limit });
    const value = { entries: result.entries || [], observedAt: stat ? new Date(stat.mtimeMs).toISOString() : null };
    cache = { key, value };
    return value;
  };
}

module.exports = { projectTrends, createTrendsReader, WINDOW_MS, MAX_POINTS };
