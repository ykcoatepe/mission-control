const RAW_SESSIONS = Symbol('rawSessions');

function attachRawSessions(payload, sessions) {
  Object.defineProperty(payload, RAW_SESSIONS, {
    value: Array.isArray(sessions) ? sessions : [],
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return payload;
}

function operationSession(session, nowMs) {
  const updatedAt = session?.updatedAt || session?.lastActive || session?.createdAt || null;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
  return {
    ...session,
    isActive: updatedMs > 0 && (nowMs - updatedMs) < 30 * 60 * 1000,
  };
}

function buildOperationsSessionsPayload(payload, operationsSource, { now = () => Date.now() } = {}) {
  const rawSessions = Array.isArray(payload?.[RAW_SESSIONS])
    ? payload[RAW_SESSIONS]
    : Array.isArray(payload?.sessions)
      ? payload.sessions
      : [];
  const sessions = rawSessions.map((session) => operationSession(session, now()));
  return {
    count: sessions.filter((session) => session.isActive).length,
    sessions,
    operationsSource,
  };
}

module.exports = {
  attachRawSessions,
  buildOperationsSessionsPayload,
};
