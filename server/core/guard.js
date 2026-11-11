'use strict';

// Request guards for a loopback app with no login.
//
//   Host guard    every request's Host must be one of the names the server is
//                 bound to (DNS-rebinding defence).
//   Origin guard  a mutating request, or any request for an API path (GET,
//                 HEAD and OPTIONS included), that carries an Origin must come
//                 from exactly one of the server's own origins (parsed,
//                 compared as scheme://host:port, never by prefix). A
//                 cross-site Sec-Fetch-Site is rejected too. Requests without
//                 either header (curl, probes) pass.
//   Write guard   every non-GET/HEAD/OPTIONS /api request must carry
//                 `X-MC-Request: 1`. A custom header cannot be sent cross-site
//                 without a CORS preflight, which this server never grants.
//                 Mode 'report-only' (default) logs what would be rejected;
//                 'enforce' rejects with 403.
//   Fail closed   any exception inside a guard rejects the request.
//
// createAuditLog() is the append-only, bounded, atomic audit trail for writes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isApiPath } = require('./http');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);
const WRITE_GUARD_HEADER = 'x-mc-request';
const WRITE_GUARD_MODES = new Set(['report-only', 'enforce']);

function normalizeHostName(host) {
  const value = String(host || '').trim().toLowerCase();
  if (value === '::1') return '[::1]';
  if ((value.match(/:/g) || []).length > 1 && !value.startsWith('[')) return `[${value}]`; // bare IPv6 bind address
  return value;
}

function buildAllowedHosts({ bindHost, port }) {
  const names = new Set(LOOPBACK_NAMES);
  const bound = normalizeHostName(bindHost);
  if (!WILDCARD_HOSTS.has(bound) && !WILDCARD_HOSTS.has(String(bindHost || '').trim())) names.add(bound);
  const hosts = new Set();
  for (const name of names) {
    hosts.add(name);
    hosts.add(`${name}:${port}`);
  }
  const origins = new Set();
  for (const name of names) {
    origins.add(`http://${name}:${port}`);
    origins.add(`https://${name}:${port}`);
  }
  return { hosts, origins };
}

// Returns the canonical origin or null when the value is not a single valid
// http(s) origin.
function parseOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'null') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // An Origin header is scheme://host[:port] only.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
  if (raw.endsWith('/')) return null;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

function forbidden(res, code, message) {
  return res.status(403).json({ error: { code, message } });
}

function createGuard({
  bindHost = '127.0.0.1',
  port,
  writeGuardMode = 'report-only',
  logger = console,
  onReport = null,
} = {}) {
  // port may be a number or a function returning the bound port (port 0 in
  // tests resolves only after listen).
  const readPort = typeof port === 'function' ? port : () => port;
  if (typeof port !== 'function' && (!Number.isInteger(Number(port)) || Number(port) < 0)) {
    throw new TypeError('createGuard: port is required');
  }
  const mode = WRITE_GUARD_MODES.has(writeGuardMode) ? writeGuardMode : 'enforce';
  let cached = { port: null, hosts: new Set(), origins: new Set() };
  function allowed() {
    const current = Number(readPort());
    if (!Number.isInteger(current) || current < 0) throw new Error('guard: bound port unknown');
    if (cached.port !== current) cached = { port: current, ...buildAllowedHosts({ bindHost, port: current }) };
    return cached;
  }
  const counters = { hostRejected: 0, originRejected: 0, writeRejected: 0, writeReported: 0, guardErrors: 0 };

  function checkHost(req) {
    const host = normalizeHostName(req.headers.host);
    if (!host) return { ok: false, code: 'forbidden_host', message: 'Missing Host header' };
    if (!allowed().hosts.has(host)) return { ok: false, code: 'forbidden_host', message: 'Forbidden host' };
    return { ok: true };
  }

  function checkOrigin(req) {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return { ok: false, code: 'forbidden_origin', message: 'Cross-site request' };
    if (req.headers.origin === undefined) return { ok: true, originPresent: false };
    const origin = parseOrigin(req.headers.origin);
    if (!origin) return { ok: false, code: 'forbidden_origin', message: 'Malformed or opaque origin' };
    const match = [...allowed().origins].some((candidate) => parseOrigin(candidate) === origin);
    if (!match) return { ok: false, code: 'forbidden_origin', message: 'Forbidden origin' };
    return { ok: true, originPresent: true };
  }

  function checkWriteHeader(req) {
    return String(req.headers[WRITE_GUARD_HEADER] || '') === '1';
  }

  function middleware(req, res, next) {
    let verdict;
    try {
      const host = checkHost(req);
      if (!host.ok) {
        counters.hostRejected += 1;
        verdict = () => forbidden(res, host.code, host.message);
      } else {
        const method = String(req.method || 'GET').toUpperCase();
        if (SAFE_METHODS.has(method)) {
          // Reads of the API are guarded too: a page on another site must not
          // be able to fire GETs at it (each one can start upstream work).
          // Header-less clients (curl, health probes) and non-API paths pass.
          const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
          const origin = isApiPath(pathOnly) ? checkOrigin(req) : { ok: true };
          if (!origin.ok) {
            counters.originRejected += 1;
            verdict = () => forbidden(res, origin.code, origin.message);
          } else {
            verdict = () => next();
          }
        } else {
          const origin = checkOrigin(req);
          if (!origin.ok) {
            counters.originRejected += 1;
            verdict = () => forbidden(res, origin.code, origin.message);
          } else {
            const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
            const isApi = isApiPath(pathOnly);
            req.writeGuard = { header: checkWriteHeader(req), mode };
            if (isApi && !req.writeGuard.header) {
              if (mode === 'enforce') {
                counters.writeRejected += 1;
                verdict = () => forbidden(res, 'write_guard', `Mutating requests need the header X-MC-Request: 1`);
              } else {
                counters.writeReported += 1;
                const line = `[guard] report-only: would reject ${method} ${pathOnly.slice(0, 200)} (missing X-MC-Request)`;
                logger?.warn?.(line);
                try {
                  onReport?.({ method, path: pathOnly, reason: 'missing_write_header' });
                } catch {}
                verdict = () => next();
              }
            } else {
              verdict = () => next();
            }
          }
        }
      }
    } catch (error) {
      counters.guardErrors += 1;
      try {
        logger?.error?.(`[guard] failing closed: ${error?.message || error}`);
      } catch {}
      return forbidden(res, 'guard_error', 'Request rejected');
    }
    return verdict();
  }

  function status() {
    let hosts = [];
    try {
      hosts = [...allowed().hosts].sort();
    } catch {}
    return { writeGuardMode: mode, allowedHosts: hosts, counters: { ...counters } };
  }

  return { middleware, status, checkHost, checkOrigin, mode };
}

// Append-only audit trail kept as a bounded JSON array, written atomically
// (tmp file + rename). Writes are synchronous, so two events can never
// interleave inside this process.
function createAuditLog({
  file,
  maxEntries = 2_000,
  fsImpl = fs,
  now = Date.now,
  logger = console,
} = {}) {
  if (!file) throw new TypeError('createAuditLog: file is required');
  let seq = 0;

  function readEntries() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function record(event = {}) {
    const entry = {
      at: new Date(now()).toISOString(),
      ...event,
    };
    const entries = readEntries();
    entries.push(entry);
    const bounded = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
    seq += 1;
    const tmp = `${file}.tmp-${process.pid}-${seq}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      let mode = 0o600;
      try {
        mode = fsImpl.statSync(file).mode & 0o777;
      } catch {}
      // Created 0600 regardless of umask; keeps the existing file's mode.
      fsImpl.writeFileSync(tmp, JSON.stringify(bounded, null, 1), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.chmodSync(tmp, mode);
      fsImpl.renameSync(tmp, file);
      return entry;
    } catch (error) {
      try {
        fsImpl.rmSync(tmp, { force: true });
      } catch {}
      logger?.error?.(`[audit] could not record event: ${error?.message || error}`);
      return null;
    }
  }

  return { record, readEntries, file };
}

// Middleware: one audit event per mutating /api request, written when the
// response finishes. Bodies are never stored.
function auditWrites({ auditLog }) {
  return function auditWritesMiddleware(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
    if (SAFE_METHODS.has(method) || !isApiPath(pathOnly)) return next();
    res.on('finish', () => {
      auditLog.record({
        requestId: req.id || null,
        method,
        path: pathOnly.slice(0, 200),
        status: res.statusCode,
        writeHeader: Boolean(req.writeGuard?.header),
        writeGuardMode: req.writeGuard?.mode || null,
      });
    });
    return next();
  };
}

module.exports = {
  createGuard,
  createAuditLog,
  auditWrites,
  parseOrigin,
  buildAllowedHosts,
  WRITE_GUARD_HEADER,
};
