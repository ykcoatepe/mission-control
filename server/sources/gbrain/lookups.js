'use strict';
const { createSource } = require('../../core/source');
const { httpError } = require('../../core/http');
const { readError } = require('./client');
const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/;
function slugInput(value) {
  if (typeof value !== 'string' || value.length > 240 || !SLUG_PATTERN.test(value)) throw httpError(400, 'invalid_slug', 'A strict page slug is required');
  return value;
}
function limitInput(value, fallback = 20, max = 100) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d{0,3}$/.test(value) || Number(value) > max) throw httpError(400, 'invalid_limit', `limit must be an integer from 1 to ${max}`);
  return Number(value);
}
function queryInput(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\x00-\x1f\x7f]/.test(value)) throw httpError(400, 'invalid_query', 'q must contain 1 to 300 printable characters');
  return value.trim();
}
const privateRecord = (r) => [r.type, r.slug, r.chunk_source, r.source_kind].some((v) =>
  typeof v === 'string' && /transcript|conversation|(?:^|[/:_-])sessions?(?:[/:_-]|$)/i.test(v));
function safeText(value, max = 1000) {
  if (typeof value !== 'string') return null;
  return value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(?:postgres(?:ql)?|mysql|redis):\/\/[^\s)"']+/gi, '[redacted connection]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',}]+/gi, '[redacted credential]').slice(0, max);
}
function createLookups({ client, now = Date.now, ttlMs = 15_000, capacity = 100 } = {}) {
  const cache = new Map();
  function entry(key, read) {
    if (cache.has(key)) return cache.get(key);
    if (cache.size >= capacity) {
      const victim = [...cache].find(([, s]) => !s.status().refreshing);
      if (!victim) throw httpError(503, 'gbrain_lookup_busy', 'GBrain lookup capacity reached');
      cache.delete(victim[0]);
    }
    const source = createSource({ id: 'gbrain.lookup', read: async () => {
      try { return await read(); } catch (error) {
        throw readError(/^gbrain_[a-z_]+$/.test(error?.code) ? error.code : 'gbrain_read_failed');
      }
    }, now, ttlMs, staleAfterMs: ttlMs, timeoutMs: 25_000 });
    cache.set(key, source); return source;
  }
  async function lookup(key, read) {
    const s = entry(key, read); const snap = s.snapshot();
    const attemptedAt = s.status().lastAttemptAt;
    const failedRecently = snap.meta.error && attemptedAt && now() - Date.parse(attemptedAt) < ttlMs;
    if (!failedRecently && (snap.data === null || snap.meta.stale)) await s.refresh();
    return s.snapshot();
  }
  return {
    async search(q, limit) {
      q = queryInput(q); limit = limitInput(limit);
      return lookup(JSON.stringify(['search', q, limit]), async () => {
        // Explicit user-initiated read exception; no expansion, LLM or mutation flags.
        const rows = await client.run(['call', '--source', '__all__', 'search', JSON.stringify({ query: q, limit,
          match: 'keyword', snippet_chars: 300, return_unit: 'page', token_budget: 3000 })], { timeoutMs: 20_000 });
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.slug !== 'string')) throw readError('gbrain_invalid_payload');
        return { query: q, limit, results: rows.filter((r) => !privateRecord(r)).slice(0, limit).map((r) => ({ slug: r.slug,
          title: safeText(r.title), type: safeText(r.type, 80), snippet: safeText(r.chunk_text, 300),
          score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null })),
          withheld: rows.filter(privateRecord).length };
      });
    },
    async page(slug) {
      slug = slugInput(slug);
      return lookup(JSON.stringify(['page', slug]), async () => {
        const p = await client.run(['call', '--source', '__all__', 'get_page', JSON.stringify({ slug, body: 'window', max_bytes: 40_000, bytes: { offset: 0, length: 40_000 } })], { timeoutMs: 20_000 });
        if (p.slug !== slug) throw readError('gbrain_page_unavailable');
        if (privateRecord(p)) throw readError('gbrain_private_content');
        if (typeof p.window?.text !== 'string') throw readError('gbrain_invalid_payload');
        return { slug, title: safeText(p.title), type: safeText(p.type, 80), content: safeText(p.window.text, 40_000),
          revision: safeText(p.revision, 100), updatedAt: safeText(p.updated_at, 80),
          truncated: Boolean(p.truncated || (typeof p.size?.total_bytes === 'number' && p.window.byte_end < p.size.total_bytes)) };
      });
    },
  };
}
module.exports = { createLookups, slugInput, limitInput, queryInput, safeText };
