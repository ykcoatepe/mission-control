// OpenClaw sessions: the raw read and the visible list. A failed sessions read is no
// longer cached as an authoritative empty list. The visible list is a core
// source holding last-good data; a failed read keeps it and marks it stale.

const os = require('os');
const path = require('path');
const { parseFirstJson } = require('./cronData');
const { readJsonFileSafe } = require('./jsonFiles');
const { attachRawSessions, buildOperationsSessionsPayload } = require('./sessionOperationsView');
const { createSource } = require('../core/source');

const OPERATIONS_SOURCE = Symbol('operationsSource');

function attachOperationsSource(payload, operationsSource) {
  Object.defineProperty(payload, OPERATIONS_SOURCE, {
    value: operationsSource,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return payload;
}

function readOperationsSource(payload) {
  return payload?.[OPERATIONS_SOURCE] || null;
}

function createFetchSessions({
  openclawExec,
  fetchImpl = (...args) => fetch(...args),
  gatewayPort,
  gatewayToken,
  logger = console,
}) {
  return async function fetchSessions(limit = 50, { allowGateway = true } = {}) {
    const normalizeSessionPayload = (payload, { allowEmpty = false } = {}) => {
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      if (!sessions.length && !allowEmpty) return null;
      return attachRawSessions({
        ...payload,
        count: Math.min(Number(payload?.count || sessions.length), limit),
        sessions: sessions.slice(0, limit),
      }, sessions);
    };

    try {
      const { stdout } = await openclawExec(['sessions', '--json', '--all-agents'], 15000);
      const parsed = parseFirstJson(stdout, {});
      const normalized = normalizeSessionPayload(parsed, { allowEmpty: Array.isArray(parsed?.sessions) });
      if (normalized) return attachOperationsSource(normalized, {
        sourceSucceeded: true,
        provenance: 'openclaw-sessions-cli',
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      const normalized = normalizeSessionPayload(parseFirstJson(error?.stdout || '', {}));
      if (normalized) return attachOperationsSource(normalized, {
        sourceSucceeded: false,
        provenance: 'openclaw-sessions-cli-failed',
        observedAt: null,
      });
    }

    if (!allowGateway) {
      return attachOperationsSource({ count: 0, sessions: [] }, {
        sourceSucceeded: false,
        provenance: 'openclaw-sessions-unavailable',
        observedAt: null,
      });
    }

    let gatewayTimer = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      gatewayTimer = timer;
      const response = await fetchImpl(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          tool: 'sessions_list',
          args: { limit, messageLimit: 1 },
        }),
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error('OpenClaw sessions gateway unavailable');
      const data = await response.json();
      const details = data?.result?.details || {};
      const detailPayload = normalizeSessionPayload(details, { allowEmpty: Array.isArray(details?.sessions) });
      if (detailPayload) return attachOperationsSource(detailPayload, {
        sourceSucceeded: true,
        provenance: 'openclaw-sessions-gateway',
        observedAt: new Date().toISOString(),
      });
      const textResult = data?.result?.content?.[0]?.text;
      if (textResult) {
        const parsed = JSON.parse(textResult);
        const normalized = normalizeSessionPayload(parsed, { allowEmpty: Array.isArray(parsed?.sessions) });
        if (normalized) return attachOperationsSource(normalized, {
          sourceSucceeded: true,
          provenance: 'openclaw-sessions-gateway',
          observedAt: new Date().toISOString(),
        });
      }
      return attachOperationsSource({ count: 0, sessions: [] }, {
        sourceSucceeded: false,
        provenance: 'openclaw-sessions-unavailable',
        observedAt: null,
      });
    } catch (error) {
      logger.error?.('[fetchSessions]', error.message);
      return attachOperationsSource({ count: 0, sessions: [] }, {
        sourceSucceeded: false,
        provenance: 'openclaw-sessions-unavailable',
        observedAt: null,
      });
    } finally {
      // A rejected fetch used to leave the abort timer armed for 20 s.
      if (gatewayTimer) clearTimeout(gatewayTimer);
    }
  };
}

function detectSessionType(session) {
  const key = String(session?.key || '');
  if (key === 'agent:main:main') return 'main';
  if (key.includes(':subagent:')) return 'sub-agent';
  if (key.includes('discord') || key.includes('#')) return 'discord';
  if (key.includes('web') || key.includes('mission-control')) return 'web';
  return 'other';
}

function createSessionsService({
  fetchSessions,
  hiddenSessionsPath,
  homeDir = os.homedir(),
  now = Date.now,
  visibleSessionsTtlMs = 30000,
  // A sessions read is CLI (15 s) then gateway (20 s), plus lane wait.
  visibleSessionsTimeoutMs = 60000,
  visibleSessionsStaleAfterMs = 120000,
}) {
  if (typeof fetchSessions !== 'function') throw new TypeError('createSessionsService: fetchSessions is required');
  let hiddenSessions = readJsonFileSafe(hiddenSessionsPath, []);

  // Last-good raw OpenClaw sessions. A read whose provenance says the source
  // did not succeed (CLI and gateway both failed) throws, so the previous
  // good list stays in place and is marked stale instead of being replaced
  // by an empty list.
  const visibleSessionsSource = createSource({
    id: 'openclaw.sessions',
    ttlMs: visibleSessionsTtlMs,
    timeoutMs: visibleSessionsTimeoutMs,
    staleAfterMs: visibleSessionsStaleAfterMs,
    now,
    read: async () => {
      const payload = await fetchSessions(100);
      const source = readOperationsSource(payload);
      if (!source?.sourceSucceeded) {
        const error = new Error('OpenClaw sessions could not be read (CLI and gateway failed)');
        error.code = source?.provenance || 'openclaw-sessions-unavailable';
        throw error;
      }
      return {
        sessions: Array.isArray(payload.sessions) ? payload.sessions : [],
        provenance: source.provenance,
      };
    },
  });

  const readHiddenSessions = () => {
    hiddenSessions = Array.isArray(readJsonFileSafe(hiddenSessionsPath, hiddenSessions))
      ? readJsonFileSafe(hiddenSessionsPath, hiddenSessions)
      : hiddenSessions;
    return hiddenSessions;
  };

  function normalizeVisibleSessionsPayload(payload, limit = 25) {
    const hidden = new Set(readHiddenSessions().map((item) => String(item)));
    const nowMs = now();
    const sessions = (Array.isArray(payload?.sessions) ? payload.sessions : [])
      .filter((session) => !hidden.has(String(session?.key || '')))
      .map((session) => {
        const updatedAt = session.updatedAt || session.lastActive || session.createdAt || null;
        const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
        return {
          ...session,
          displayName: session.displayName || session.label || session.key,
          type: detectSessionType(session),
          isActive: updatedMs > 0 ? (nowMs - updatedMs) < (30 * 60 * 1000) : false,
        };
      })
      .sort((left, right) => new Date(right.updatedAt || right.lastActive || 0).getTime() - new Date(left.updatedAt || left.lastActive || 0).getTime())
      .slice(0, limit);
    return { count: sessions.length, sessions };
  }

  function readSessionsFileFallback(limit = 25) {
    try {
      const sessionsFile = path.join(homeDir, '.openclaw/agents/main/sessions/sessions.json');
      const raw = readJsonFileSafe(sessionsFile, {});
      const sessions = Array.isArray(raw)
        ? raw
        : Object.entries(raw || {}).map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }));
      return normalizeVisibleSessionsPayload({ sessions }, limit);
    } catch {
      return { count: 0, sessions: [] };
    }
  }

  return {
    fetchSessionsRaw: fetchSessions,
    visibleSessionsSource,
    async getOperationsSessions(limit = 25) {
      const payload = await fetchSessions(Math.max(limit * 4, 100));
      return buildOperationsSessionsPayload(payload, readOperationsSource(payload) || {
        sourceSucceeded: false,
        provenance: 'openclaw-sessions-unavailable',
        observedAt: null,
      });
    },
    // { count, sessions, meta }. With last-good OpenClaw data the list comes
    // from it (meta.stale when the latest read failed or it aged out). With
    // none yet, the legacy sessions.json file fallback is served and meta
    // says so: ok false, source 'openclaw.sessions.file-fallback'.
    async listVisibleSessions(limit = 25) {
      // GET is pure: serve memory only. The scheduler refreshes the source
      // (registered in server/app.js); a cold source serves the file fallback.
      const snapshot = visibleSessionsSource.snapshot();
      if (snapshot.data) {
        return {
          ...normalizeVisibleSessionsPayload(snapshot.data, limit),
          meta: snapshot.meta,
        };
      }
      return {
        ...readSessionsFileFallback(limit),
        meta: {
          ...snapshot.meta,
          ok: false,
          stale: true,
          source: 'openclaw.sessions.file-fallback',
        },
      };
    },
  };
}

module.exports = {
  OPERATIONS_SOURCE,
  attachOperationsSource,
  readOperationsSource,
  createFetchSessions,
  createSessionsService,
  detectSessionType,
};
