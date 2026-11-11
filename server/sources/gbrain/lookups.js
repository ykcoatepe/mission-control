'use strict';
const { createSource } = require('../../core/source');
const { httpError } = require('../../core/http');
const { redactString } = require('../../core/config');
const { createEvidenceCache } = require('./cache');
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
const PAGE_CREDENTIAL_KEYS = new Set([
  'token', 'pass', 'password', 'passwd', 'pwd', 'secret', 'apikey', 'authorization', 'credential',
  // Previously supported complete credential names; never match a substring.
  'secretkey', 'accesstoken', 'authtoken',
]);
function redactPageText(text) {
  // Segment assignments before core redaction: applying core's strong-name rule
  // to an entire prose RHS would erase its first word. Other core protections
  // (provider tokens, Authorization, URL userinfo, private keys) stay in use.
  const pairs = /(^|[\r\n{,;])([ \t]*(?:[-*+][ \t]+)?["'`]?)([A-Za-z][A-Za-z0-9_. -]*?)(["'`]?[ \t]*(?::(?!\/\/)|=)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[^\r\n,;{}\[\]]*)/g;
  let output = ''; let cursor = 0;
  for (const match of text.matchAll(pairs)) {
    const [, boundary, lead, name, separator, raw] = match;
    const value = raw.trimEnd(); const trailing = raw.slice(value.length);
    const quote = /^["'`]/.test(value) && value.at(-1) === value[0] ? value[0] : '';
    let decoded = quote ? value.slice(1, -1) : value;
    if (quote === '"') { try { decoded = JSON.parse(value); } catch {} }
    const key = name.trim().toLowerCase()
      .replace(/^api(?:[ \t]+|[_.-])key$/, 'apikey')
      .replace(/^secret[_-]key$/, 'secretkey')
      .replace(/^(access|auth)[_-]token$/, '$1token');
    const following = text.slice(match.index + match[0].length);
    const quotedProse = quote && /^[ \t]+[^ \t\r\n,;{}\[\]#]/.test(following);
    let replacement;
    const databasePair = decoded.match(/^(\S{4,})([ \t]+)((?:postgres(?:ql)?|mysql|redis):\/\/\S+)$/i);
    if (quotedProse) replacement = redactPageText(decoded);
    else if (PAGE_CREDENTIAL_KEYS.has(key) && databasePair) {
      // Adjacent database connection fields are structured credentials, not prose.
      replacement = '[redacted]' + databasePair[2] + redactString(databasePair[3]);
    } else if (PAGE_CREDENTIAL_KEYS.has(key) && /^\S{4,}$/u.test(decoded)) replacement = '[redacted]';
    else if (key === 'authorization' && /^(?:basic|bearer|token|digest)\s+\S{4,}$/i.test(decoded)) {
      replacement = redactString(`Authorization: ${decoded}`).slice('Authorization: '.length);
    } else replacement = redactPageText(decoded);
    let rendered = value;
    if (replacement !== decoded) rendered = quote === '"' ? JSON.stringify(replacement)
      : quote ? `${quote}${replacement}${quote}` : replacement;
    const left = boundary + lead + name + separator;
    output += redactString(text.slice(cursor, match.index)) + redactString(left) + rendered + trailing;
    cursor = match.index + match[0].length;
  }
  return output + redactString(text.slice(cursor));
}
function redactQuotedExamples(text) {
  // Serialized JSON examples can encode credential field names/quotes more than
  // once. Decode only valid quoted string literals, inspect their shorter value,
  // and re-encode only if something was actually redacted. Prose stays byte-for-byte.
  return text.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    if (!quoted.includes('\\')) return quoted;
    try {
      const decoded = JSON.parse(quoted);
      const redacted = redactPageText(redactQuotedExamples(decoded));
      return redacted === decoded ? quoted : JSON.stringify(redacted);
    } catch { return quoted; }
  });
}
function safeText(value, max = 1000) {
  if (typeof value !== 'string') return null;
  // Core handles JSON/TOML assignments, private keys, provider token formats,
  // Authorization schemes and URL passwords. Page-specific short API secrets
  // and database connection strings are also withheld, before truncation.
  return redactPageText(redactQuotedExamples(value))
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(?:postgres(?:ql)?|mysql|redis):\/\/[^\s)"']+/gi, '[redacted connection]')
    .slice(0, max);
}
function createLookups({ client, now = Date.now, ttlMs = 15_000, capacity = 100 } = {}) {
  const cache = createEvidenceCache({ capacity, useful: (data) => data != null
    && (Array.isArray(data.results) ? data.results.length > 0 : typeof data.content === 'string' && data.content.length > 0) });
  function entry(key, read) {
    return cache.get(key, () => createSource({ id: 'gbrain.lookup', read: async () => {
      try { return await read(); } catch (error) {
        throw readError(/^gbrain_[a-z_]+$/.test(error?.code) ? error.code : 'gbrain_read_failed');
      }
    }, now, ttlMs, staleAfterMs: ttlMs, timeoutMs: 35_000 }));
  }
  async function lookup(key, read) {
    const s = entry(key, read); const snap = s.snapshot();
    const attemptedAt = s.status().lastAttemptAt;
    const failedRecently = snap.meta.error && attemptedAt && now() - Date.parse(attemptedAt) < (snap.meta.error.code === 'gbrain_lookup_busy' ? Math.min(ttlMs, 2000) : ttlMs);
    if (!failedRecently && (snap.data === null || snap.meta.stale)) await s.refresh();
    cache.promote(key);
    const result = s.snapshot();
    if (result.meta.error?.code === 'gbrain_lookup_busy') throw httpError(429, 'gbrain_lookup_busy', 'GBrain lookup lane is busy');
    if (result.meta.error?.code === 'gbrain_lookup_quarantined') throw httpError(503, 'gbrain_lookup_quarantined', 'GBrain lookup lane is quarantined');
    return result;
  }
  return {
    async search(q, limit) {
      q = queryInput(q); limit = limitInput(limit);
      return lookup(JSON.stringify(['search', q, limit]), async () => {
        // Explicit user-initiated read exception; no expansion, LLM or mutation flags.
        const rows = await client.run(['call', '--source', '__all__', 'search', JSON.stringify({ query: q, limit,
          match: 'keyword', snippet_chars: 300, return_unit: 'page', token_budget: 3000 })], { timeoutMs: 20_000, lane: 'lookup' });
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.slug !== 'string')) throw readError('gbrain_invalid_payload');
        return { query: safeText(q, 300), limit, results: rows.filter((r) => !privateRecord(r)).slice(0, limit).map((r) => ({ slug: safeText(r.slug, 240),
          title: safeText(r.title), type: safeText(r.type, 80), snippet: safeText(r.chunk_text, 300),
          score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null })),
          withheld: rows.filter(privateRecord).length };
      });
    },
    async page(slug) {
      slug = slugInput(slug);
      return lookup(JSON.stringify(['page', slug]), async () => {
        const p = await client.run(['call', '--source', '__all__', 'get_page', JSON.stringify({ slug, body: 'window', max_bytes: 40_000, bytes: { offset: 0, length: 40_000 } })], { timeoutMs: 20_000, lane: 'lookup' });
        if (p.slug !== slug) throw readError('gbrain_page_unavailable');
        if (privateRecord(p)) throw readError('gbrain_private_content');
        if (typeof p.window?.text !== 'string') throw readError('gbrain_invalid_payload');
        return { slug: safeText(slug, 240), title: safeText(p.title), type: safeText(p.type, 80), content: safeText(p.window.text, 40_000),
          revision: safeText(p.revision, 100), updatedAt: safeText(p.updated_at, 80),
          truncated: Boolean(p.truncated || (typeof p.size?.total_bytes === 'number' && p.window.byte_end < p.size.total_bytes)) };
      });
    },
  };
}
module.exports = { createLookups, slugInput, limitInput, queryInput, safeText };
