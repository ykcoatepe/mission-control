'use strict';

// HTTP plumbing shared by every route:
//   asyncHandler     wrap an async handler so a rejection reaches the error handler
//   requestContext   request id (X-Request-Id) + one structured log line per /api request
//   apiBoundary      classify once (API or not), 400 for malformed targets; with
//   nonApiOnly / apiFallthrough: static and SPA can never answer an API path
//   apiNotFound      JSON 404 for any unknown /api/* path
//   errorHandler     the one final error handler: { error: { code, message } }
//   httpError        build an error with a status and a client-safe code/message
//   sendEnvelope     send a source snapshot ({ data, meta })
//   listRoutes       the mounted route table (for tests and diagnostics)

const crypto = require('crypto');

// The one canonicalization of a request target. Used by the guard, the audit,
// the request log and apiBoundary, so they can never disagree.
//   - absolute-form targets (GET http://host/api/x) lose scheme and authority;
//   - the path is percent-decoded exactly once (a second level stays literal,
//     as it does for Express and for static serving);
//   - backslashes count as slashes, repeated slashes collapse, "." and ".."
//     segments are resolved, case is folded.
// A path is API when ANY reading of it is under /api: as sent, decoded, or
// fully resolved. "/x/../api/health" is API (static serving would resolve it
// to a file under api/), and so is "/api/../x" (Express can still match it
// against an /api/:param route). A target that cannot be decoded is malformed
// and counts as API so guards apply before it is rejected with 400.
function isUnderApi(pathValue) {
  return pathValue === '/api' || pathValue.startsWith('/api/');
}

function foldPath(value) {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

function classifyRequestPath(rawUrl) {
  let value = String(rawUrl ?? '');
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(value);
  if (absolute) value = value.slice(absolute[0].length) || '/';
  value = value.split('?')[0].split('#')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = null;
  }
  if (decoded === null || decoded.includes('\0')) return { malformed: true, api: true, canonical: null };
  const asSent = foldPath(value);
  const asDecoded = foldPath(decoded);
  const segments = [];
  for (const segment of asDecoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const canonical = `/${segments.join('/')}`;
  return {
    malformed: false,
    api: isUnderApi(asSent) || isUnderApi(asDecoded) || isUnderApi(canonical),
    canonical,
  };
}

// The canonical path, or null when the target is malformed.
function normalizeRequestPath(rawUrl) {
  return classifyRequestPath(rawUrl).canonical;
}

function isApiPath(rawUrl) {
  return classifyRequestPath(rawUrl).api;
}

function requestIsApi(req) {
  if (typeof req.isApiRequest === 'boolean') return req.isApiRequest;
  return isApiPath(req.originalUrl || req.url);
}

// Install before any static or SPA handler. Classifies the request once, for
// every method:
//   - a malformed target is a 400 in the error contract;
//   - OPTIONS on an API path is a JSON 405 (there is no CORS surface, and
//     Express would otherwise answer "200 GET, HEAD" in plain text);
//   - req.isApiRequest tells nonApiOnly() and apiFallthrough() what to do.
function apiBoundary() {
  return function apiBoundaryMiddleware(req, res, next) {
    const verdict = classifyRequestPath(req.originalUrl || req.url);
    if (verdict.malformed) return next(httpError(400, 'bad_request', 'Malformed request path'));
    req.isApiRequest = verdict.api;
    if (verdict.api && String(req.method).toUpperCase() === 'OPTIONS') {
      return next(httpError(405, 'method_not_allowed', 'OPTIONS is not supported on the API'));
    }
    return next();
  };
}

// Wrap every handler that is not an API route (static files, the SPA shell):
// it never sees an API request.
function nonApiOnly(handler) {
  return function nonApiOnlyMiddleware(req, res, next) {
    return requestIsApi(req) ? next() : handler(req, res, next);
  };
}

// Mount after the last API router: whatever API request is still unanswered
// gets the JSON 404, for any method.
function apiFallthrough() {
  const notFound = apiNotFound();
  return function apiFallthroughMiddleware(req, res, next) {
    return requestIsApi(req) ? notFound(req, res) : next();
  };
}

function asyncHandler(fn) {
  return function asyncRoute(req, res, next) {
    return Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.expose = true;
  return error;
}

function requestContext({ logger = console, now = Date.now, idFactory = () => crypto.randomUUID() } = {}) {
  return function requestContextMiddleware(req, res, next) {
    const startedAt = now();
    const incoming = String(req.headers['x-request-id'] || '');
    req.id = /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : idFactory();
    res.setHeader('X-Request-Id', req.id);
    const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
    if (isApiPath(pathOnly) || normalizeRequestPath(pathOnly) === '/healthz') {
      res.on('finish', () => {
        try {
          logger.log(JSON.stringify({
            t: new Date(startedAt).toISOString(),
            id: req.id,
            method: req.method,
            path: pathOnly.slice(0, 200),
            status: res.statusCode,
            ms: now() - startedAt,
          }));
        } catch {}
      });
    }
    next();
  };
}

function apiNotFound() {
  return function apiNotFoundMiddleware(req, res) {
    const pathOnly = String(req.originalUrl || req.url || '').split('?')[0].slice(0, 200);
    res.status(404).json({
      error: { code: 'not_found', message: `No API route for ${req.method} ${pathOnly}` },
    });
  };
}

const STATUS_CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  408: 'request_timeout',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
  429: 'too_many_requests',
  503: 'unavailable',
};

function resolveStatus(error) {
  const raw = Number(error?.status ?? error?.statusCode);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
}

function errorHandler({ logger = console } = {}) {
  // Express recognises error middleware by its four parameters.
  // eslint-disable-next-line no-unused-vars
  return function finalErrorHandler(error, req, res, next) {
    const status = resolveStatus(error);
    if (status >= 500) {
      logger.error?.(`[error] ${req.id || '-'} ${req.method} ${String(req.originalUrl || '').split('?')[0]}: ${error?.stack || error}`);
    }
    if (res.headersSent) {
      // The response is already streaming; the connection can only be cut.
      try {
        res.destroy?.();
      } catch {}
      return undefined;
    }
    let code;
    let message;
    if (status >= 500) {
      code = status === 503 && error?.expose && typeof error.code === 'string' ? error.code : 'internal_error';
      message = status === 503 && error?.expose && error.message ? String(error.message).slice(0, 300) : 'Internal server error';
    } else if (error?.type === 'entity.parse.failed') {
      code = 'invalid_json';
      message = 'Request body is not valid JSON';
    } else if (error?.type === 'entity.too.large') {
      code = 'payload_too_large';
      message = 'Request body is too large';
    } else {
      code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
        ? error.code
        : STATUS_CODES[status] || 'request_error';
      // 4xx messages are client-facing only when the thrower marked them so.
      message = error?.expose && error.message
        ? String(error.message).split('\n')[0].slice(0, 300)
        : STATUS_CODES[status]?.replace(/_/g, ' ') || 'Request error';
    }
    res.status(status).json({ error: { code, message } });
    return undefined;
  };
}

function sendEnvelope(res, snapshot) {
  const data = snapshot?.data ?? null;
  const meta = snapshot?.meta || { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: null };
  return res.status(data === null ? 503 : 200).json({ data, meta });
}

function layerPath(layer) {
  if (layer.route?.path) return layer.route.path;
  return '';
}

// Walk an Express 5 app or router and return ["GET /api/x", ...].
function listRoutes(appOrRouter) {
  const out = [];
  const root = appOrRouter?.router || appOrRouter?._router || appOrRouter;
  const visit = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
        const routePath = layerPath(layer);
        for (const method of methods) {
          out.push(`${method.toUpperCase()} ${prefix}${routePath instanceof RegExp ? routePath.toString() : routePath}`);
        }
      } else if (layer.handle?.stack) {
        visit(layer.handle.stack, prefix);
      }
    }
  };
  visit(root?.stack, '');
  return out;
}

module.exports = {
  isApiPath,
  normalizeRequestPath,
  classifyRequestPath,
  apiBoundary,
  nonApiOnly,
  apiFallthrough,
  asyncHandler,
  httpError,
  requestContext,
  apiNotFound,
  errorHandler,
  sendEnvelope,
  listRoutes,
};
