const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOperationsOverview,
  buildOperationsCapabilities,
  createOperationsOverviewService,
  deriveOverallStatus,
} = require('../server/services/operationsOverview');

const generatedAt = '2026-07-10T12:00:00.000Z';

function healthyInput(overrides = {}) {
  return {
    status: {
      generatedAt,
      agent: { activeSessions: 0, channels: ['telegram'] },
      heartbeat: { lastHeartbeat: Date.parse(generatedAt) },
    },
    sessions: {
      generatedAt,
      count: 25,
      sessions: [
        { key: 'a', isActive: true },
        { key: 'b', isActive: true },
        { key: 'c', isActive: true },
      ],
    },
    cron: {
      generatedAt,
      jobs: [
        { id: 'openclaw:a', scheduler: 'openclaw', enabled: true },
        { id: 'hermes:a', scheduler: 'hermes', enabled: true },
      ],
    },
    hermes: {
      ok: true,
      refreshedAt: generatedAt,
      summary: { active: 2, running: 1, blocked: 0, total: 63 },
    },
    gbrain: {
      ok: true,
      refreshedAt: generatedAt,
      trust: {
        status: 'healthy',
        score: 100,
        label: 'Live trusted',
        lastVerifiedAt: generatedAt,
      },
      caveats: [],
    },
    capabilities: buildOperationsCapabilities({
      gbrainActions: [{
        id: 'doctor-fast',
        label: 'Run system check',
        description: 'Read-only diagnostic',
        kind: 'diagnostic',
        safetyClass: 'R0',
        requiresConfirmation: false,
        timeoutMs: 15_000,
        refreshAfter: true,
        command: 'gbrain doctor --fast',
        token: 'Bearer secret',
      }],
    }),
    ...overrides,
  };
}

test('builds schema v1 from allowlisted evidence and surfaces source conflicts', () => {
  const input = healthyInput();
  input.sessions.sessions[0].message = 'session message';
  input.hermes.taskBody = 'task body';
  input.status.command = 'cat /Users/example/.config/private';
  input.gbrain.token = 'Bearer secret';

  const overview = buildOperationsOverview(input, { generatedAt });

  assert.equal(overview.ok, true);
  assert.equal(overview.schemaVersion, '1');
  assert.equal(overview.mode, 'live-read-first');
  assert.equal(overview.systems.openclaw.metrics.activeSessions, 3);
  assert.equal(overview.systems.hermes.metrics.running, 1);
  assert.equal(overview.systems.gbrain.state, 'healthy');
  assert.equal(overview.systems.openclaw.freshness, 'fresh');
  assert.equal(overview.capabilities[0].safetyClass, 'R0');
  assert.deepEqual(Object.keys(overview.capabilities[0]).sort(), [
    'actionEndpoint',
    'description',
    'disabledReason',
    'enabled',
    'id',
    'kind',
    'label',
    'refreshAfter',
    'requiresConfirmation',
    'safetyClass',
    'system',
    'timeoutMs',
  ].sort());
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_session_count_conflict'));
  assert.doesNotMatch(JSON.stringify(overview), /session message|task body|Bearer|cat \/Users|\/Users\//);
});

test('keeps GBrain caveats visible when trust is 100 and freshness is independent', () => {
  const input = healthyInput();
  input.gbrain.caveats = ['Embedding worker persistence is not verified.'];
  input.gbrain.live = { sources: { freshness: { staleCount: 2 } } };

  const overview = buildOperationsOverview(input, { generatedAt });

  assert.equal(overview.systems.gbrain.metrics.trustScore, 100);
  assert.equal(overview.systems.gbrain.state, 'warning');
  assert.equal(overview.systems.gbrain.freshness, 'stale');
  assert.ok(overview.systems.gbrain.caveats.includes('Embedding worker persistence is not verified.'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'gbrain_active_caveat'));
});

test('blocked Hermes work is critical and outranks warnings', () => {
  const input = healthyInput();
  input.hermes.summary.blocked = 2;
  input.gbrain.caveats = ['Backfill proof is pending.'];

  const overview = buildOperationsOverview(input, { generatedAt });

  assert.equal(overview.overall.state, 'critical');
  assert.equal(overview.attention[0].reasonCode, 'hermes_tasks_blocked');
  assert.equal(overview.attention[0].severity, 'critical');
  assert.ok(overview.attention.slice(1).every((item) => item.severity !== 'critical'));
});

test('missing evidence and explicitly failed readers never become healthy', () => {
  const missing = buildOperationsOverview({ capabilities: [] }, { generatedAt });

  assert.equal(missing.overall.state, 'unavailable');
  assert.equal(missing.systems.openclaw.state, 'unavailable');
  assert.equal(missing.systems.hermes.state, 'unavailable');
  assert.equal(missing.systems.gbrain.state, 'unavailable');
  assert.ok(missing.attention.some((item) => item.reasonCode === 'openclaw_unavailable'));

  const failed = buildOperationsOverview(healthyInput({
    hermes: { ok: false, unavailable: true, error: 'Bearer secret /Users/example/private' },
  }), { generatedAt });

  assert.equal(failed.systems.hermes.state, 'unavailable');
  assert.equal(failed.systems.hermes.observedAt, null);
  assert.equal(failed.systems.hermes.freshness, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /Bearer|\/Users\//);
});

test('derives the worst explicit state without averaging evidence', () => {
  assert.equal(deriveOverallStatus({
    a: { state: 'healthy' },
    b: { state: 'inactive' },
    c: { state: 'unavailable' },
  }), 'unavailable');
  assert.equal(deriveOverallStatus({
    a: { state: 'warning' },
    b: { state: 'critical' },
  }), 'critical');
});

test('bounds reader failures independently and still returns the successful evidence', async () => {
  const input = healthyInput();
  const service = createOperationsOverviewService({
    readers: {
      status: async () => input.status,
      sessions: async () => input.sessions,
      cron: async () => input.cron,
      hermes: async () => input.hermes,
      gbrain: async () => {
        throw new Error('Bearer secret from /Users/example/private');
      },
    },
    listCapabilities: () => input.capabilities,
    now: () => new Date(generatedAt),
    sourceTimeoutMs: 100,
  });

  const overview = await service.getOverview();

  assert.equal(overview.systems.hermes.state, 'healthy');
  assert.equal(overview.systems.gbrain.state, 'unavailable');
  assert.equal(overview.overall.state, 'warning');
  assert.ok(overview.attention.some((item) => item.reasonCode === 'gbrain_unavailable'));
  assert.doesNotMatch(JSON.stringify(overview), /Bearer|\/Users\//);
});

test('times out only the stalled source and preserves the remaining snapshot', async () => {
  const input = healthyInput();
  const service = createOperationsOverviewService({
    readers: {
      status: async () => input.status,
      sessions: async () => new Promise(() => {}),
      cron: async () => input.cron,
      hermes: async () => input.hermes,
      gbrain: async () => input.gbrain,
    },
    listCapabilities: () => [],
    now: () => new Date(generatedAt),
    sourceTimeoutMs: 5,
  });

  const overview = await service.getOverview();

  assert.equal(overview.systems.openclaw.state, 'warning');
  assert.equal(overview.systems.openclaw.metrics.activeSessions, 0);
  assert.equal(overview.systems.hermes.state, 'healthy');
  assert.equal(overview.systems.gbrain.state, 'healthy');
});

test('projects a shared cron reader failure into visible system evidence', async () => {
  const input = healthyInput();
  const service = createOperationsOverviewService({
    readers: {
      status: async () => input.status,
      sessions: async () => input.sessions,
      cron: async () => {
        throw new Error('scheduler output included /Users/example/private');
      },
      hermes: async () => input.hermes,
      gbrain: async () => input.gbrain,
    },
    listCapabilities: () => [],
    now: () => new Date(generatedAt),
  });

  const overview = await service.getOverview();

  assert.equal(overview.systems.openclaw.state, 'warning');
  assert.equal(overview.systems.hermes.state, 'warning');
  assert.equal(overview.systems.openclaw.metrics.cronJobs, null);
  assert.equal(overview.systems.hermes.metrics.cronJobs, null);
  assert.ok(overview.evidence.some((item) => item.id === 'openclaw:cron' && item.status === 'unavailable'));
  assert.ok(overview.evidence.some((item) => item.id === 'hermes:cron' && item.status === 'unavailable'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_cron_unavailable'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'hermes_cron_unavailable'));
  assert.doesNotMatch(JSON.stringify(overview), /\/Users\//);
});

test('treats fulfilled ok-false status, sessions, and cron results as unavailable evidence', () => {
  const failedStatus = buildOperationsOverview(healthyInput({
    status: { ok: false, generatedAt, agent: { activeSessions: 3 }, heartbeat: { lastHeartbeat: Date.parse(generatedAt) } },
  }), { generatedAt });
  assert.equal(failedStatus.systems.openclaw.state, 'warning');
  assert.equal(failedStatus.systems.openclaw.freshness, 'unavailable');
  assert.ok(failedStatus.attention.some((item) => item.reasonCode === 'openclaw_status_unavailable'));

  const failedSessions = buildOperationsOverview(healthyInput({
    sessions: { ok: false, count: 3, sessions: [{ key: 'a', isActive: true }] },
  }), { generatedAt });
  assert.equal(failedSessions.systems.openclaw.state, 'warning');
  assert.ok(failedSessions.attention.some((item) => item.reasonCode === 'openclaw_sessions_unavailable'));
  assert.ok(failedSessions.evidence.some((item) => item.id === 'openclaw:sessions' && item.status === 'unavailable'));

  const failedCron = buildOperationsOverview(healthyInput({
    cron: { ok: false, generatedAt, jobs: [{ id: 'unsafe', scheduler: 'openclaw' }] },
  }), { generatedAt });
  assert.equal(failedCron.systems.openclaw.state, 'warning');
  assert.equal(failedCron.systems.hermes.state, 'warning');
  assert.equal(failedCron.systems.openclaw.metrics.cronJobs, null);
  assert.equal(failedCron.systems.hermes.metrics.cronJobs, null);
  assert.ok(failedCron.attention.some((item) => item.reasonCode === 'openclaw_cron_unavailable'));
  assert.ok(failedCron.attention.some((item) => item.reasonCode === 'hermes_cron_unavailable'));
});

test('projects raw action definitions through the capability allowlist at the service boundary', async () => {
  const input = healthyInput();
  const service = createOperationsOverviewService({
    readers: {
      status: async () => input.status,
      sessions: async () => input.sessions,
      cron: async () => input.cron,
      hermes: async () => input.hermes,
      gbrain: async () => input.gbrain,
    },
    listCapabilities: () => [{
      id: 'doctor-fast',
      label: 'Run system check',
      description: 'Read-only diagnostic',
      kind: 'diagnostic',
      safetyClass: 'R0',
      requiresConfirmation: false,
      timeoutMs: 15_000,
      refreshAfter: true,
      command: 'gbrain doctor --fast --config /Users/example/private',
      token: 'Bearer super-secret',
      homePath: '/Users/example/.gbrain',
    }],
    now: () => new Date(generatedAt),
  });

  const overview = await service.getOverview();

  assert.deepEqual(Object.keys(overview.capabilities[0]).sort(), [
    'actionEndpoint',
    'description',
    'disabledReason',
    'enabled',
    'id',
    'kind',
    'label',
    'refreshAfter',
    'requiresConfirmation',
    'safetyClass',
    'system',
    'timeoutMs',
  ].sort());
  assert.equal(overview.capabilities[0].id, 'doctor-fast');
  assert.doesNotMatch(JSON.stringify(overview), /gbrain doctor|super-secret|\/Users\//);
});

test('keeps session-conflict attention detail stable when cron also fails', () => {
  const overview = buildOperationsOverview(healthyInput({
    cron: { ok: false, generatedAt, jobs: [] },
  }), { generatedAt });
  const conflict = overview.attention.find((item) => item.reasonCode === 'openclaw_session_count_conflict');

  assert.ok(conflict);
  assert.equal(conflict.detail, 'Status reports 0 active sessions while the session reader reports 3.');
  assert.doesNotMatch(conflict.detail, /scheduling/i);
});
