const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOperationsOverview,
  buildOperationsCapabilities,
  createOperationsReaders,
  createOperationsOverviewService,
  deriveOverallStatus,
} = require('../server/services/operationsOverview');

const generatedAt = '2026-07-10T12:00:00.000Z';

function healthyInput(overrides = {}) {
  const sourceProof = (provenance) => ({
    sourceSucceeded: true,
    provenance,
    observedAt: generatedAt,
  });
  return {
    status: {
      generatedAt,
      operationsSource: sourceProof('openclaw-status-cli'),
      agent: { activeSessions: 0, channels: ['telegram'] },
      heartbeat: { lastHeartbeat: Date.parse(generatedAt) },
    },
    sessions: {
      generatedAt,
      operationsSource: sourceProof('openclaw-sessions-cli'),
      count: 25,
      sessions: [
        { key: 'a', isActive: true },
        { key: 'b', isActive: true },
        { key: 'c', isActive: true },
      ],
    },
    cron: {
      generatedAt,
      operationsSource: {
        ...sourceProof('scheduler-readers'),
        schedulers: {
          openclaw: sourceProof('openclaw-cron-cli'),
          hermes: sourceProof('hermes-cron-disk'),
        },
      },
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
      live: { sources: { freshness: { staleCount: 0 } } },
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

test('rejects shape-valid current fallback zeros without source provenance', () => {
  const overview = buildOperationsOverview(healthyInput({
    status: {
      generatedAt,
      agent: { activeSessions: 0, channels: [] },
      heartbeat: {},
    },
    sessions: {
      generatedAt,
      count: 0,
      sessions: [],
    },
    cron: {
      generatedAt,
      jobs: [],
    },
  }), { generatedAt });

  assert.equal(overview.systems.openclaw.state, 'unavailable');
  assert.equal(overview.systems.openclaw.observedAt, null);
  assert.deepEqual(overview.systems.openclaw.metrics, {});
  assert.equal(overview.systems.hermes.state, 'warning');
  assert.equal(overview.systems.hermes.metrics.cronJobs, null);
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_unavailable'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'hermes_cron_unavailable'));
});

test('keeps successful scheduler sibling evidence when the other scheduler is unavailable', () => {
  const input = healthyInput();
  input.cron.operationsSource.schedulers.openclaw = {
    sourceSucceeded: false,
    provenance: 'openclaw-cron-unavailable',
    observedAt: null,
  };

  const overview = buildOperationsOverview(input, { generatedAt });

  assert.equal(overview.systems.openclaw.state, 'warning');
  assert.equal(overview.systems.openclaw.metrics.cronJobs, null);
  assert.equal(overview.systems.hermes.metrics.cronJobs, 1);
  assert.ok(overview.evidence.some((item) => item.id === 'openclaw:cron' && item.status === 'unavailable'));
  assert.ok(overview.evidence.some((item) => item.id === 'hermes:cron' && item.status === 'healthy'));
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_cron_unavailable'));
  assert.equal(overview.attention.some((item) => item.reasonCode === 'hermes_cron_unavailable'), false);
});

test('production reader wiring preserves provenance and never timestamps fallback cron empties', async () => {
  const schedulerProof = {
    sourceSucceeded: false,
    provenance: 'scheduler-readers',
    observedAt: null,
    schedulers: {
      openclaw: { sourceSucceeded: false, provenance: 'openclaw-cron-unavailable', observedAt: null },
      hermes: { sourceSucceeded: false, provenance: 'hermes-cron-unavailable', observedAt: null },
    },
  };
  const readers = createOperationsReaders({
    statusService: { getOperationsStatusResponse: async () => ({ marker: 'status' }) },
    sessionsService: { getOperationsSessions: async (limit) => ({ marker: 'sessions', limit }) },
    cronService: {
      fetchCronJobsForOperations: async () => ({ jobs: [], operationsSource: schedulerProof }),
      mapCronJobForApi: (job) => job,
    },
    hermesKanbanService: { getBoard: async () => ({ marker: 'hermes' }) },
    gbrainOverviewService: { readSnapshot: async () => ({ overview: { marker: 'gbrain' } }) },
  });

  assert.deepEqual(await readers.status(), { marker: 'status' });
  assert.deepEqual(await readers.sessions(), { marker: 'sessions', limit: 25 });
  assert.deepEqual(await readers.cron(), { jobs: [], operationsSource: schedulerProof });
  assert.equal(Object.hasOwn(await readers.cron(), 'generatedAt'), false);
  assert.deepEqual(await readers.hermes(), { marker: 'hermes' });
  assert.deepEqual(await readers.gbrain(), { marker: 'gbrain' });
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
  assert.equal(overview.evidence.find((item) => item.id === 'openclaw:cron').observedAt, null);
  assert.equal(overview.evidence.find((item) => item.id === 'hermes:cron').observedAt, null);
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

test('rejects non-numeric and non-positive capability timeouts', () => {
  const capabilities = buildOperationsCapabilities({
    gbrainActions: [
      {
        id: 'string-timeout',
        timeoutMs: 'gbrain doctor --config /Users/example/private Bearer secret',
      },
      {
        id: 'object-timeout',
        timeoutMs: { command: 'gbrain repair', token: 'Bearer secret', path: '/Users/example/private' },
      },
      { id: 'zero-timeout', timeoutMs: 0 },
      { id: 'negative-timeout', timeoutMs: -1 },
      { id: 'valid-timeout', timeoutMs: 15_000 },
    ],
  });

  assert.deepEqual(capabilities.map((item) => item.timeoutMs), [null, null, null, null, 15_000]);
  assert.doesNotMatch(JSON.stringify(capabilities), /gbrain doctor|gbrain repair|Bearer|\/Users\//);
});

test('does not consume metrics or timestamps from fulfilled unavailable source payloads', () => {
  const failedStatus = buildOperationsOverview(healthyInput({
    status: {
      ok: false,
      generatedAt: '2099-01-01T00:00:00.000Z',
      agent: { activeSessions: 999, channels: ['secret-channel'] },
      heartbeat: { lastHeartbeat: Date.parse('2099-01-01T00:00:00.000Z') },
    },
  }), { generatedAt });

  assert.equal(failedStatus.systems.openclaw.metrics.activeSessions, 3);
  assert.equal(failedStatus.systems.openclaw.metrics.channels, 0);
  assert.equal(failedStatus.systems.openclaw.observedAt, generatedAt);
  assert.equal(failedStatus.systems.openclaw.evidence.find((item) => item.id === 'openclaw:heartbeat').observedAt, null);
  assert.doesNotMatch(JSON.stringify(failedStatus), /2099-01-01|secret-channel|999 active/);

  const failedSessions = buildOperationsOverview(healthyInput({
    sessions: {
      ok: false,
      generatedAt: '2099-01-01T00:00:00.000Z',
      count: 999,
      sessions: [{ key: 'secret', isActive: true }, { key: 'secret-2', isActive: true }],
    },
  }), { generatedAt });

  assert.equal(failedSessions.systems.openclaw.metrics.activeSessions, 0);
  assert.equal(failedSessions.systems.openclaw.observedAt, generatedAt);
  assert.equal(failedSessions.attention.some((item) => item.reasonCode === 'openclaw_session_count_conflict'), false);
  assert.doesNotMatch(JSON.stringify(failedSessions), /2099-01-01|secret-2|999/);
});

test('turns out-of-range heartbeat epochs into stale evidence without throwing', () => {
  const input = healthyInput();
  input.status.agent.activeSessions = 3;
  input.status.heartbeat.lastHeartbeat = 9e15;

  let overview;
  assert.doesNotThrow(() => {
    overview = buildOperationsOverview(input, { generatedAt });
  });

  assert.equal(overview.systems.openclaw.state, 'warning');
  assert.equal(overview.systems.openclaw.freshness, 'stale');
  assert.equal(overview.systems.openclaw.evidence.find((item) => item.id === 'openclaw:heartbeat').observedAt, null);
  assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_heartbeat_stale'));
});

test('rejects JavaScript-valid heartbeats beyond the future-skew allowance', () => {
  const input = healthyInput();
  input.status.agent.activeSessions = 3;
  input.status.heartbeat.lastHeartbeat = 1e15;

  const overview = buildOperationsOverview(input, { generatedAt });
  const heartbeat = overview.systems.openclaw.evidence.find((item) => item.id === 'openclaw:heartbeat');

  assert.equal(heartbeat.observedAt, null);
  assert.equal(heartbeat.status, 'warning');
  assert.equal(overview.systems.openclaw.freshness, 'stale');
});

test('marks shape-deficient fulfilled sources unavailable instead of fabricating healthy zeros', () => {
  const deficientOpenClaw = buildOperationsOverview(healthyInput({
    status: { ok: true, generatedAt, agent: {} },
    sessions: { ok: true },
    cron: { ok: true, jobs: [] },
  }), { generatedAt });
  assert.equal(deficientOpenClaw.systems.openclaw.state, 'unavailable');
  assert.equal(deficientOpenClaw.systems.openclaw.observedAt, null);
  assert.deepEqual(deficientOpenClaw.systems.openclaw.metrics, {});

  const numericStatusTime = buildOperationsOverview(healthyInput({
    status: { ok: true, generatedAt: 0, agent: { activeSessions: 0, channels: [] }, heartbeat: {} },
    sessions: { ok: true },
  }), { generatedAt });
  assert.equal(numericStatusTime.systems.openclaw.state, 'unavailable');
  assert.equal(numericStatusTime.systems.openclaw.observedAt, null);

  const deficientSessions = buildOperationsOverview(healthyInput({
    sessions: { ok: true, count: '0' },
  }), { generatedAt });
  assert.equal(deficientSessions.systems.openclaw.state, 'warning');
  assert.equal(deficientSessions.systems.openclaw.metrics.activeSessions, 0);
  assert.ok(deficientSessions.attention.some((item) => item.reasonCode === 'openclaw_sessions_unavailable'));

  const fractionalSessions = buildOperationsOverview(healthyInput({
    sessions: { ok: true, count: 0.5 },
  }), { generatedAt });
  assert.ok(fractionalSessions.attention.some((item) => item.reasonCode === 'openclaw_sessions_unavailable'));

  const deficientHermes = buildOperationsOverview(healthyInput({
    hermes: { ok: true, refreshedAt: generatedAt },
  }), { generatedAt });
  assert.equal(deficientHermes.systems.hermes.state, 'unavailable');
  assert.equal(deficientHermes.systems.hermes.observedAt, null);
  assert.deepEqual(deficientHermes.systems.hermes.metrics, {});

  const unobservedHermes = buildOperationsOverview(healthyInput({
    hermes: { ok: true, summary: { total: 0, active: 0, running: 0, blocked: 0 } },
  }), { generatedAt });
  assert.equal(unobservedHermes.systems.hermes.state, 'unavailable');
  assert.equal(unobservedHermes.systems.hermes.observedAt, null);

  const numericHermesTime = buildOperationsOverview(healthyInput({
    hermes: { ok: true, refreshedAt: 0, summary: { total: 0, active: 0, running: 0, blocked: 0 } },
  }), { generatedAt });
  assert.equal(numericHermesTime.systems.hermes.state, 'unavailable');

  const fractionalHermesSummary = buildOperationsOverview(healthyInput({
    hermes: { ok: true, refreshedAt: generatedAt, summary: { total: 0, active: 0.5, running: 0, blocked: 0 } },
  }), { generatedAt });
  assert.equal(fractionalHermesSummary.systems.hermes.state, 'unavailable');

  const deficientGBrain = buildOperationsOverview(healthyInput({
    gbrain: { ok: true, refreshedAt: generatedAt, trust: { status: 'healthy', score: 100, label: 'Trusted' } },
  }), { generatedAt });
  assert.equal(deficientGBrain.systems.gbrain.state, 'unavailable');
  assert.equal(deficientGBrain.systems.gbrain.observedAt, null);
  assert.deepEqual(deficientGBrain.systems.gbrain.metrics, {});

  const numericGBrainTime = buildOperationsOverview(healthyInput({
    gbrain: { ok: true, trust: { status: 'healthy', score: 100, label: 'Trusted', lastVerifiedAt: 0 } },
  }), { generatedAt });
  assert.equal(numericGBrainTime.systems.gbrain.state, 'unavailable');

  const coercibleGBrainTime = buildOperationsOverview(healthyInput({
    gbrain: { ok: true, trust: { status: 'healthy', score: 100, label: 'Trusted', lastVerifiedAt: '0' } },
  }), { generatedAt });
  assert.equal(coercibleGBrainTime.systems.gbrain.state, 'unavailable');
});

test('uses status-session and session-list evidence for session conflicts', () => {
  const overview = buildOperationsOverview(healthyInput(), { generatedAt });
  const conflict = overview.attention.find((item) => item.reasonCode === 'openclaw_session_count_conflict');
  const statusProof = overview.evidence.find((item) => item.id === 'openclaw:status-sessions');
  const sessionsProof = overview.evidence.find((item) => item.id === 'openclaw:sessions');

  assert.ok(conflict);
  assert.deepEqual(conflict.evidenceRefs, ['openclaw:status-sessions', 'openclaw:sessions']);
  assert.equal(statusProof.sourceRef, '/api/status');
  assert.match(statusProof.summary, /0 active sessions/i);
  assert.equal(sessionsProof.sourceRef, '/api/sessions');
  assert.match(sessionsProof.summary, /3 active sessions/i);
});

test('sorts valid evidence timestamps descending and null evidence last', () => {
  const input = healthyInput();
  input.status.generatedAt = '2026-07-10T11:00:00.000Z';
  input.status.agent.activeSessions = 3;
  input.status.heartbeat.lastHeartbeat = null;
  input.sessions.generatedAt = '2026-07-10T11:30:00.000Z';
  input.hermes.refreshedAt = '2026-07-10T10:00:00.000Z';
  input.gbrain.refreshedAt = '2026-07-10T11:45:00.000Z';
  input.gbrain.trust.lastVerifiedAt = '2026-07-10T11:45:00.000Z';

  const overview = buildOperationsOverview(input, { generatedAt });
  const firstNull = overview.evidence.findIndex((item) => item.observedAt === null);

  assert.ok(firstNull > 0);
  assert.ok(overview.evidence.slice(0, firstNull).every((item) => Number.isFinite(Date.parse(item.observedAt))));
  assert.ok(overview.evidence.slice(firstNull).every((item) => item.observedAt === null));
  for (let index = 1; index < firstNull; index += 1) {
    assert.ok(
      Date.parse(overview.evidence[index - 1].observedAt) >= Date.parse(overview.evidence[index].observedAt),
      `${overview.evidence[index - 1].id} should not sort before newer ${overview.evidence[index].id}`,
    );
  }
});

test('requires explicit GBrain caveats and trustworthy source freshness evidence', () => {
  const cases = [
    {
      name: 'missing caveats',
      mutate(value) { delete value.caveats; },
    },
    {
      name: 'object caveats',
      mutate(value) { value.caveats = { active: false }; },
    },
    {
      name: 'missing stale count',
      mutate(value) { value.live.sources.freshness = {}; },
    },
    {
      name: 'negative stale count',
      mutate(value) { value.live.sources.freshness.staleCount = -1; },
    },
    {
      name: 'fractional stale count',
      mutate(value) { value.live.sources.freshness.staleCount = 0.5; },
    },
  ];

  for (const entry of cases) {
    const input = healthyInput();
    entry.mutate(input.gbrain);
    const overview = buildOperationsOverview(input, { generatedAt });
    assert.equal(overview.systems.gbrain.state, 'unavailable', entry.name);
    assert.equal(overview.systems.gbrain.freshness, 'unavailable', entry.name);
    assert.equal(overview.systems.gbrain.metrics.staleSources, undefined, entry.name);
    assert.ok(overview.attention.some((item) => item.reasonCode === 'gbrain_unavailable'), entry.name);
  }
});

test('rejects normalized but semantically invalid RFC3339 calendar timestamps', () => {
  const invalidStatus = buildOperationsOverview(healthyInput({
    status: {
      generatedAt: '2026-02-30T12:00:00.000Z',
      agent: { activeSessions: 0, channels: [] },
      heartbeat: {},
    },
    sessions: { ok: true },
  }), { generatedAt });
  assert.equal(invalidStatus.systems.openclaw.state, 'unavailable');

  const invalidHermes = buildOperationsOverview(healthyInput({
    hermes: {
      ok: true,
      refreshedAt: '2026-07-10T24:00:00.000Z',
      summary: { total: 0, active: 0, running: 0, blocked: 0 },
    },
  }), { generatedAt });
  assert.equal(invalidHermes.systems.hermes.state, 'unavailable');

  const invalidGBrain = healthyInput();
  invalidGBrain.gbrain.trust.lastVerifiedAt = '2026-02-30T12:00:00.000Z';
  const invalidGBrainOverview = buildOperationsOverview(invalidGBrain, { generatedAt });
  assert.equal(invalidGBrainOverview.systems.gbrain.state, 'unavailable');

  const validOffset = healthyInput();
  validOffset.hermes.refreshedAt = '2026-07-10T14:00:00.000+03:00';
  const validOffsetOverview = buildOperationsOverview(validOffset, { generatedAt });
  assert.notEqual(validOffsetOverview.systems.hermes.state, 'unavailable');
  assert.equal(validOffsetOverview.systems.hermes.observedAt, '2026-07-10T11:00:00.000Z');

  const validMicroseconds = healthyInput();
  validMicroseconds.hermes.refreshedAt = '2026-07-10T11:00:00.123456Z';
  const validMicrosecondsOverview = buildOperationsOverview(validMicroseconds, { generatedAt });
  assert.notEqual(validMicrosecondsOverview.systems.hermes.state, 'unavailable');
  assert.equal(validMicrosecondsOverview.systems.hermes.observedAt, '2026-07-10T11:00:00.123Z');
});

test('isolates synchronous capability enumeration failure from the reader snapshot', async () => {
  const input = healthyInput();
  const service = createOperationsOverviewService({
    readers: {
      status: async () => input.status,
      sessions: async () => input.sessions,
      cron: async () => input.cron,
      hermes: async () => input.hermes,
      gbrain: async () => input.gbrain,
    },
    listCapabilities: () => {
      throw new Error('Bearer secret /Users/example/private');
    },
    now: () => new Date(generatedAt),
  });

  let overview;
  await assert.doesNotReject(async () => {
    overview = await service.getOverview();
  });
  assert.deepEqual(overview.capabilities, []);
  assert.ok(overview.attention.some((item) => item.reasonCode === 'gbrain_capabilities_unavailable'));
  assert.ok(overview.evidence.some((item) => item.id === 'gbrain:capabilities-unavailable'));
  assert.doesNotMatch(JSON.stringify(overview), /Bearer|\/Users\//);
});

test('promotes caveatless stale GBrain sources to warning with explicit proof', () => {
  const input = healthyInput();
  input.status.agent.activeSessions = 3;
  input.gbrain.caveats = [];
  input.gbrain.live.sources.freshness.staleCount = 3;

  const overview = buildOperationsOverview(input, { generatedAt });
  const staleAttention = overview.attention.find((item) => item.reasonCode === 'gbrain_stale_sources');
  const staleEvidence = overview.evidence.find((item) => item.id === 'gbrain:source-freshness');

  assert.equal(overview.systems.gbrain.state, 'warning');
  assert.equal(overview.systems.gbrain.freshness, 'stale');
  assert.equal(overview.overall.state, 'warning');
  assert.deepEqual(overview.systems.gbrain.caveats, []);
  assert.ok(staleAttention);
  assert.equal(staleAttention.detailHref, '/gbrain');
  assert.deepEqual(staleAttention.evidenceRefs, ['gbrain:source-freshness']);
  assert.ok(staleEvidence);
  assert.equal(staleEvidence.status, 'warning');
  assert.equal(staleEvidence.detailHref, '/gbrain');
  assert.match(staleEvidence.summary, /3 stale/i);
});
