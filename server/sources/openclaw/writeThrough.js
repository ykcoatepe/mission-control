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
    const views = pending.map(mutation => typeof mutation.meta === 'function' ? mutation.meta(base) : mutation.meta);
    const meta = { ...base.meta, ...Object.assign({}, ...views) };
    const observations = views.filter((view, index) => pending[index].observed && view);
    const unavailable = observations.find(view => view.stale || view.ok === false);
    if (unavailable) Object.assign(meta, { ok: false, stale: true, error: unavailable.error });
    if (observations.length) {
      meta.ageMs = Math.max(...observations.map(view => view.ageMs || 0));
      meta.observedAt = observations.map(view => view.observedAt).filter(Boolean).sort()[0] || meta.observedAt;
      meta.verified = pending.every(mutation => mutation.observed);
    }
    if (refreshFailed || pending.some(mutation => !mutation.observed)) Object.assign(meta, { ok: false, stale: true,
      error: { code: 'post_write_refresh_pending', message: 'The command was sent; upstream confirmation is pending' } });
    return { ...base, data, meta };
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
  source.publishMutation = async (mutation, { refresh: shouldRefresh = true } = {}) => {
    for (const item of Array.isArray(mutation) ? mutation : [mutation]) {
      pending = pending.filter(previous => previous.key !== item.key && !(item.removePrefix && previous.key.startsWith(item.removePrefix)));
      pending.push(item);
    }
    // Use the public method so injected failures and source-specific refresh
    // wrappers are honored. Never turn a committed mutation into an HTTP error.
    if (shouldRefresh) { try { await source.refresh(); } catch { refreshFailed = true; } }
    return source.snapshot();
  };
  return source;
}

async function publishMutation(source, mutation, options) {
  if (!source) return { data: (Array.isArray(mutation) ? mutation : [mutation]).reduce((data, item) => item.apply(data), null), meta: { ok: false, stale: true, error: { code: 'post_write_refresh_pending', message: 'The write succeeded; upstream confirmation is pending' } } };
  return withWriteThrough(source).publishMutation(mutation, options);
}
module.exports = { withWriteThrough, publishMutation };
