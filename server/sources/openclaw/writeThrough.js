'use strict';

// Core sources intentionally have no set()/invalidate() primitive. Hold only
// facts established by a successful mutation above their last-good reading.
// A pre-write in-flight read or a failed/lagging read cannot undo those facts.
// The scheduler retires each projection once its upstream confirms it.
function withWriteThrough(source) {
  if (!source || source.publishMutation) return source;
  const snapshot = source.snapshot.bind(source);
  const refresh = source.refresh?.bind(source);
  let pending = [];
  let refreshFailed = false;
  source.snapshot = () => {
    const base = snapshot();
    const data = pending.reduce((value, mutation) => mutation.apply(value), base.data);
    return { ...base, data, meta: pending.length || refreshFailed ? {
      ...base.meta, ok: false, stale: true,
      ...Object.assign({}, ...pending.map(mutation => mutation.meta)),
      error: { code: 'post_write_refresh_pending', message: 'The write succeeded; upstream confirmation is pending' },
    } : base.meta };
  };
  source.refresh = async () => {
    try {
      if (!refresh) throw new Error('No targeted refresh');
      await refresh();
      const base = snapshot();
      pending = pending.filter(mutation => !mutation.confirmed(base.data, base.meta));
      refreshFailed = false;
    } catch {
      refreshFailed = true;
    }
    return source.snapshot();
  };
  source.publishMutation = async mutation => {
    for (const item of Array.isArray(mutation) ? mutation : [mutation]) {
      pending = pending.filter(previous => previous.key !== item.key && !(item.removePrefix && previous.key.startsWith(item.removePrefix)));
      pending.push(item);
    }
    // Use the public method so injected failures and source-specific refresh
    // wrappers are honored. Never turn a committed mutation into an HTTP error.
    try { await source.refresh(); } catch { refreshFailed = true; }
    return source.snapshot();
  };
  return source;
}

async function publishMutation(source, mutation) {
  if (!source) return { data: (Array.isArray(mutation) ? mutation : [mutation]).reduce((data, item) => item.apply(data), null), meta: { ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The write succeeded; upstream confirmation is pending' } } };
  return withWriteThrough(source).publishMutation(mutation);
}
module.exports = { withWriteThrough, publishMutation };
