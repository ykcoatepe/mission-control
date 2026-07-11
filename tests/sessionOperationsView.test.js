const assert = require('node:assert/strict');
const test = require('node:test');

const {
  attachRawSessions,
  buildOperationsSessionsPayload,
} = require('../server/services/sessionOperationsView');

test('keeps raw active sessions for Operations when the UI list is limited', () => {
  const nowMs = Date.parse('2026-07-11T13:30:00Z');
  const rawSessions = Array.from({ length: 30 }, (_, index) => ({
    key: `session-${index}`,
    updatedAt: new Date(nowMs - 60_000).toISOString(),
  }));
  const uiPayload = attachRawSessions({
    count: 25,
    sessions: rawSessions.slice(0, 25),
  }, rawSessions);

  const operations = buildOperationsSessionsPayload(uiPayload, {
    sourceSucceeded: true,
    provenance: 'openclaw-sessions-cli',
    observedAt: '2026-07-11T13:30:00Z',
  }, { now: () => nowMs });

  assert.equal(operations.count, 30);
  assert.equal(operations.sessions.length, 30);
  assert.equal(operations.sessions.filter((session) => session.isActive).length, 30);
});

test('does not apply hidden-session UI filtering to Operations reconciliation', () => {
  const nowMs = Date.parse('2026-07-11T13:30:00Z');
  const rawSessions = [
    { key: 'visible', updatedAt: '2026-07-11T13:29:00Z' },
    { key: 'hidden-by-ui', updatedAt: '2026-07-11T13:29:00Z' },
  ];
  const uiPayload = attachRawSessions({ count: 1, sessions: rawSessions.slice(0, 1) }, rawSessions);

  const operations = buildOperationsSessionsPayload(uiPayload, {
    sourceSucceeded: true,
    provenance: 'openclaw-sessions-cli',
    observedAt: '2026-07-11T13:30:00Z',
  }, { now: () => nowMs });

  assert.deepEqual(operations.sessions.map((session) => session.key), ['visible', 'hidden-by-ui']);
  assert.equal(operations.count, 2);
});
