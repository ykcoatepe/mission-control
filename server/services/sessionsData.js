// OpenClaw sessions: list, history, send and hide. Moved out of server.js
// without behaviour change, except one fix: a failed sessions read is no
// longer cached as an authoritative empty list. The visible list is a core
// source holding last-good data; a failed read keeps it and marks it stale.

const fsDefault = require('fs');
const os = require('os');
const path = require('path');
const { parseFirstJson } = require('./cronData');
const { readJsonFileSafe, writeJsonFileAtomic } = require('./jsonFiles');
const { attachRawSessions, buildOperationsSessionsPayload } = require('./sessionOperationsView');
const { resolveSessionTranscriptFile } = require('./sessionTranscripts');
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

function messageEntryText(content) {
  if (Array.isArray(content)) return content.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text || '').join('\n');
  return typeof content === 'string' ? content : '';
}

function createSessionsService({
  fetchSessions,
  hiddenSessionsPath,
  openclawConfigPath,
  gatewayPort,
  gatewayToken,
  homeDir = os.homedir(),
  fs = fsDefault,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  visibleSessionsTtlMs = 30000,
  // A sessions read is CLI (15 s) then gateway (20 s), plus lane wait.
  visibleSessionsTimeoutMs = 60000,
  visibleSessionsStaleAfterMs = 120000,
}) {
  if (typeof fetchSessions !== 'function') throw new TypeError('createSessionsService: fetchSessions is required');
  let hiddenSessions = readJsonFileSafe(hiddenSessionsPath, []);
  // One in-flight send per session: overlapping requests could otherwise
  // correlate each other's replies in the transcript fallback path.
  const pendingSendsBySession = new Map();

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

  // Poll a pending send's transcript until an assistant reply correlated to
  // this send appears — anchored on the send's own user entry and requiring
  // text-producing output, so intermediate tool-call records do not release
  // the lock early. Hard-capped so a vanished transcript cannot lock a
  // session forever.
  function watchSessionReply(sessionKey, { transcriptFile, sentAtMs }, message) {
    const startedAt = Date.now();
    const poll = () => {
      let replied = false;
      try {
        if (transcriptFile && fs.existsSync(transcriptFile)) {
          const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
          let anchorIndex = -1;
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            try {
              const entry = JSON.parse(lines[index]);
              if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
              if (messageEntryText(entry.message.content).trim() === message.trim()) {
                anchorIndex = index;
                break;
              }
            } catch {}
          }
          for (let index = lines.length - 1; index > anchorIndex; index -= 1) {
            try {
              const entry = JSON.parse(lines[index]);
              const entryMs = new Date(entry.timestamp || 0).getTime();
              if (!Number.isFinite(entryMs) || entryMs <= sentAtMs) continue;
              if (entry.type === 'message' && entry.message?.role === 'assistant'
                && messageEntryText(entry.message.content).trim()) {
                replied = true;
                break;
              }
            } catch {}
          }
        }
      } catch {}
      if (replied || Date.now() - startedAt > 15 * 60 * 1000) {
        pendingSendsBySession.delete(sessionKey);
        return;
      }
      setTimeout(poll, 10000).unref?.();
    };
    setTimeout(poll, 10000).unref?.();
  }

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
    async getSessionHistory(sessionKey) {
      const decoded = decodeURIComponent(sessionKey);
      const payload = await fetchSessions(200);
      const session = (payload.sessions || []).find((entry) => entry.key === decoded);
      const transcriptFile = resolveSessionTranscriptFile(session);
      if (!transcriptFile) return { messages: [], info: 'No transcript found' };
      if (!fs.existsSync(transcriptFile)) return { messages: [], info: 'Transcript file missing' };

      const lines = fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'message' || !entry.message) continue;
          const role = entry.message.role;
          if (!role || role === 'toolResult' || role === 'toolUse') continue;
          let text = '';
          if (typeof entry.message.content === 'string') {
            text = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            text = entry.message.content.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text || '').join('\n');
          }
          if (text.trim()) {
            messages.push({ role, content: text.substring(0, 3000), ts: entry.timestamp });
          }
        } catch {}
      }
      return { messages: messages.slice(-50), total: messages.length, sessionKey: decoded };
    },
    async sendSessionMessage(sessionKey, message) {
      const decoded = decodeURIComponent(sessionKey);
      if (pendingSendsBySession.has(decoded)) {
        return { ok: false, busy: true, result: 'A message to this session is still in progress — wait for the current reply before sending again.' };
      }
      let pendingWatch = null;
      const send = (async () => {
      const cfg = fs.existsSync(openclawConfigPath) ? JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8')) : {};
      const sendGatewayToken = cfg.gateway?.auth?.token || process.env.MC_GATEWAY_TOKEN || gatewayToken || '';
      const sendGatewayPort = cfg.gateway?.port || gatewayPort;
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 90000);
      // Transcript boundary for the fallback scan: any assistant entry written
      // before this moment belongs to an earlier turn, not to this send.
      const sentAtMs = Date.now();

      try {
        const response = await fetchImpl(`http://127.0.0.1:${sendGatewayPort}/tools/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sendGatewayToken}` },
          signal: controller.signal,
          body: JSON.stringify({
            tool: 'sessions_send',
            args: { sessionKey: decoded, message, timeoutSeconds: 90 },
          }),
        });
        clearTimeout(timeout);
        const data = await response.json();
        let resultText = data?.result?.content?.[0]?.text || '';
        try {
          const parsed = JSON.parse(resultText);
          if (parsed.reply) resultText = parsed.reply;
        } catch {}
        return { ok: !!resultText, result: resultText };
      } catch {
        clearTimeout(timeout);
        let resultText = '';
        try {
          // The gateway never answered inside its window; read the reply from
          // the session's owning agent transcript, same ownership rule as
          // getSessionHistory. Resolve the session from the in-memory cache
          // or the CLI only — never the gateway that just stalled.
          let session = (visibleSessionsSource.snapshot().data?.sessions || []).find((entry) => entry.key === decoded);
          if (!session) {
            const payload = await fetchSessions(200, { allowGateway: false });
            session = (payload.sessions || []).find((entry) => entry.key === decoded);
          }
          const transcriptFile = resolveSessionTranscriptFile(session);
          if (transcriptFile) pendingWatch = { transcriptFile, sentAtMs };
          if (transcriptFile && fs.existsSync(transcriptFile)) {
            const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n');
            // Anchor on this send's own user entry: only assistant replies
            // written after it can answer this request, so overlapping sends
            // cannot misattribute each other's replies. Without a matching
            // user entry, fall back to the sentAt boundary alone.
            let anchorIndex = -1;
            for (let index = lines.length - 1; index >= 0; index -= 1) {
              try {
                const entry = JSON.parse(lines[index]);
                if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
                if (messageEntryText(entry.message.content).trim() === message.trim()) {
                  anchorIndex = index;
                  break;
                }
              } catch {}
            }
            for (let index = lines.length - 1; index > anchorIndex; index -= 1) {
              try {
                const entry = JSON.parse(lines[index]);
                const entryMs = new Date(entry.timestamp || 0).getTime();
                if (!Number.isFinite(entryMs) || entryMs <= sentAtMs) continue;
                if (entry.type === 'message' && entry.message?.role === 'assistant') {
                  resultText = messageEntryText(entry.message.content);
                  if (resultText) break;
                }
              } catch {}
            }
          }
        } catch {}
        // Only a send that ran the full gateway window and was aborted counts
        // as accepted-but-pending; an immediate transport failure never
        // reached the agent and must not read as pending to the client.
        return resultText
          ? { ok: true, result: resultText }
          : timedOut
            ? { ok: false, pending: true, result: 'Response is taking longer than expected. The agent is still working — check back in a moment.' }
            : { ok: false, result: 'Could not reach the OpenClaw gateway — the message was not delivered.' };
      }
      })();
      pendingSendsBySession.set(decoded, send);
      let outcome;
      try {
        outcome = await send;
      } catch (error) {
        // Setup failures (e.g. a malformed config) must not leave a stuck
        // lock behind.
        pendingSendsBySession.delete(decoded);
        throw error;
      }
      if (outcome && outcome.pending) {
        if (pendingWatch) {
          // Accepted by the agent and still working: hold the per-session lock
          // until the transcript shows this send's assistant reply (polled), so
          // a follow-up send cannot interleave while the reply may still land.
          // Hard-capped so a vanished transcript cannot lock a session forever;
          // the anchor correlation keeps replies attributable after the cap.
          watchSessionReply(decoded, pendingWatch, message);
        } else {
          // Transcript metadata unavailable (cache and CLI both failed): hold
          // a bounded grace lock instead of releasing while the response says
          // the agent is still working; the sentAt boundary still guards the
          // eventual fallback scan.
          setTimeout(() => pendingSendsBySession.delete(decoded), 120000).unref?.();
        }
      } else {
        pendingSendsBySession.delete(decoded);
      }
      return outcome;
    },
    hideSession(sessionKey) {
      const decoded = decodeURIComponent(sessionKey);
      const next = new Set(readHiddenSessions().map((item) => String(item)));
      next.add(decoded);
      hiddenSessions = Array.from(next);
      writeJsonFileAtomic(hiddenSessionsPath, hiddenSessions);
      return { status: 'hidden', message: `Session "${decoded}" hidden from view` };
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
