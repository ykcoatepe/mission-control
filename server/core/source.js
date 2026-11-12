'use strict';

// A source is one upstream reading held in memory as last-good data.
//
//   const source = createSource({ id, read, ttlMs, timeoutMs, staleAfterMs });
//   await source.refresh();     // single-flight read; never throws
//   source.snapshot();          // { data, meta: { ok, stale, observedAt, ageMs, error, latencyMs, source } }
//   source.onRefresh(fn);       // fn() after every refresh settles (dependent bookkeeping)
//   source.get();               // snapshot now, background refresh if older than ttlMs
//                               // (starts an upstream read: never call it from a GET
//                               // handler; routes use snapshot(), the scheduler refreshes)
//
// Rules:
//   - A failed, timed-out or empty read never replaces last-good data. It
//     sets meta.error and marks the data stale.
//   - With no good read yet, data is null. Never a default.
//   - Only one read runs at a time. A read that outlives its timeout keeps
//     its slot until it settles, so a hung upstream cannot pile up children;
//     its late result is discarded.

class SourceReadError extends Error {
  constructor(message, { code = 'read_failed', cause } = {}) {
    super(message);
    this.name = 'SourceReadError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function toErrorInfo(error) {
  if (!error) return { code: 'read_failed', message: 'Read failed' };
  const code = typeof error.code === 'string' && error.code ? error.code : 'read_failed';
  const message = typeof error.message === 'string' && error.message
    ? error.message.split('\n')[0].slice(0, 300)
    : 'Read failed';
  return { code, message };
}

function createSource({
  id,
  read,
  ttlMs = 60_000,
  timeoutMs = 30_000,
  staleAfterMs,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logger = null,
} = {}) {
  if (typeof id !== 'string' || !id) throw new TypeError('createSource: id is required');
  if (typeof read !== 'function') throw new TypeError(`createSource(${id}): read must be a function`);
  const staleAfter = Number.isFinite(staleAfterMs) ? staleAfterMs : ttlMs * 3;

  let data = null;
  let observedAtMs = null;
  let lastError = null;
  let lastAttemptAtMs = null;
  let lastLatencyMs = null;
  let reads = 0;
  let failures = 0;
  const listeners = new Set(); // called after every refresh settles (see onRefresh)
  let inFlight = null; // promise of the running refresh (resolves to a snapshot)
  let readRunning = false; // true until the underlying read settles

  function snapshot() {
    const nowMs = now();
    const ageMs = observedAtMs == null ? null : Math.max(0, nowMs - observedAtMs);
    const hasData = data !== null;
    const ok = hasData && lastError === null;
    const stale = !hasData || lastError !== null || (ageMs != null && ageMs > staleAfter);
    return {
      data,
      meta: {
        ok,
        stale,
        observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
        ageMs,
        error: lastError,
        latencyMs: lastLatencyMs,
        source: id,
      },
    };
  }

  function recordFailure(error, startedAt) {
    failures += 1;
    lastError = toErrorInfo(error);
    lastLatencyMs = now() - startedAt;
    if (logger) logger.warn?.(`[source:${id}] read failed: ${lastError.code}: ${lastError.message}`);
  }

  function refresh() {
    if (inFlight) return inFlight;
    if (readRunning) {
      // A previous read timed out but has not settled; do not start another.
      return Promise.resolve(snapshot());
    }
    const startedAt = now();
    lastAttemptAtMs = startedAt;
    reads += 1;
    readRunning = true;
    let timedOut = false;

    inFlight = new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer) clearTimeoutImpl(timer);
        inFlight = null;
        resolve(snapshot());
        for (const listener of listeners) {
          try {
            listener();
          } catch {}
        }
      };

      timer = setTimeoutImpl(() => {
        timedOut = true;
        recordFailure(new SourceReadError(`Read timed out after ${timeoutMs} ms`, { code: 'timeout' }), startedAt);
        finish();
      }, timeoutMs);
      timer?.unref?.();

      Promise.resolve()
        .then(() => read({ id, startedAt }))
        .then((value) => {
          readRunning = false;
          if (timedOut) return; // late result: discarded
          if (value === undefined || value === null) {
            recordFailure(new SourceReadError('Read returned no data', { code: 'empty_read' }), startedAt);
          } else {
            data = value;
            observedAtMs = now();
            lastError = null;
            lastLatencyMs = observedAtMs - startedAt;
          }
          finish();
        }, (error) => {
          readRunning = false;
          if (timedOut) return;
          recordFailure(error, startedAt);
          finish();
        });
    });
    return inFlight;
  }

  function get() {
    const snap = snapshot();
    const expired = observedAtMs == null || (now() - observedAtMs) > ttlMs;
    const recentlyAttempted = lastAttemptAtMs != null && (now() - lastAttemptAtMs) < Math.min(ttlMs, 5_000);
    if (expired && !inFlight && !(lastError && recentlyAttempted)) refresh();
    return snap;
  }

  function status() {
    const snap = snapshot();
    return {
      id,
      ok: snap.meta.ok,
      stale: snap.meta.stale,
      observedAt: snap.meta.observedAt,
      ageMs: snap.meta.ageMs,
      error: snap.meta.error,
      latencyMs: snap.meta.latencyMs,
      lastAttemptAt: lastAttemptAtMs == null ? null : new Date(lastAttemptAtMs).toISOString(),
      refreshing: Boolean(inFlight) || readRunning,
      reads,
      failures,
      ttlMs,
      timeoutMs,
      staleAfterMs: staleAfter,
    };
  }

  /** Call `listener` after every refresh settles (good, failed or timed out). Returns an unsubscribe. */
  function onRefresh(listener) {
    if (typeof listener !== 'function') throw new TypeError(`source(${id}).onRefresh: listener must be a function`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { id, refresh, snapshot, get, status, onRefresh };
}

module.exports = { createSource, SourceReadError };
