'use strict';

// HTTP plumbing shared by every route:
//   asyncHandler     wrap an async handler so a rejection reaches the error handler
//   requestContext   request id (X-Request-Id) + one structured log line per /api request
//   apiNotFound      JSON 404 for any unknown /api/* path
//   errorHandler     the one final error handler: { error: { code, message } }
//   httpError        build an error with a status and a client-safe code/message
//   sendEnvelope     send a source snapshot ({ data, meta })
//   listRoutes       the mounted route table (for tests and diagnostics)

const crypto = require('crypto');

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
    if (pathOnly.startsWith('/api/') || pathOnly === '/api' || pathOnly === '/healthz') {
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
  asyncHandler,
  httpError,
  requestContext,
  apiNotFound,
  errorHandler,
  sendEnvelope,
  listRoutes,
};
