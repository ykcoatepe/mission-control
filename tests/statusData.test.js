const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStatusService,
  heartbeatEventToPayload,
  heartbeatValueToSeconds,
  mergeHeartbeatPayloads,
  normalizeHeartbeatPayload,
} = require('../server/services/statusData');

function makeService(overrides = {}) {
  let snapshot = null;
  const memoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-status-data-'));
  const service = createStatusService({
    mcConfig: { name: 'Mission Control' },
    memoryPath,
    prettyModelName: (model) => model || 'Unknown',
    getOpenclawDefaultModelKey: () => 'fallback-model',
    fetchNotionActivity: async () => [],
    fetchSessions: async () => ({ count: 0, sessions: [] }),
    readRuntimeSnapshot: () => snapshot,
    writeRuntimeSnapshot: (_name, value) => {
      snapshot = value;
    },
    runtimeSnapshotTtl: { status: 60_000 },
    fs,
    path,
    processEnv: { HOME: memoryPath },
    ...overrides,
  });
  return { service, readSnapshot: () => snapshot, memoryPath };
}

async function testGatewayHealthDoesNotReplaceFullStatusParserInput() {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
    ok: true,
    text: async () => JSON.stringify({ ok: true, status: 'live' }),
    };
  };

  try {
    const { service, readSnapshot } = makeService({
      gatewayPort: 19999,
      execSync: () => [
        'OpenClaw Control',
        '2 active sessions',
        'default gpt-5.4-mini',
        'Memory │ 46 files │ 225 chunks',
        'Heartbeat │ 30m',
        'Agents │ 7',
        '│ Telegram │ ON │ OK │ connected │',
      ].join('\n'),
    });

    await service.refreshStatusCache();
    const status = readSnapshot();

    assert.equal(requestedUrl, 'http://127.0.0.1:19999/health');
    assert.equal(status.agent.activeSessions, 2);
    assert.equal(status.agent.model, 'gpt-5.4-mini');
    assert.equal(status.agent.totalAgents, 7);
    assert.equal(status.agent.memoryFiles, 46);
    assert.equal(status.agent.memoryChunks, 225);
    assert.equal(status.agent.heartbeatInterval, '30m');
    assert.deepEqual(status.agent.channels, [
      { name: 'Telegram', enabled: 'ON', state: 'OK', detail: 'connected' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testGatewayHealthIsFallbackWhenFullStatusFails() {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
    ok: true,
    text: async () => JSON.stringify({ ok: true, status: 'live' }),
    };
  };

  try {
    const { service, readSnapshot } = makeService({
      mcConfig: { name: 'Mission Control', gateway: { port: 19999 } },
      execSync: () => {
        const error = new Error('openclaw status failed');
        error.stdout = '';
        throw error;
      },
    });

    await service.refreshStatusCache();
    const status = readSnapshot();

    assert.equal(requestedUrl, 'http://127.0.0.1:19999/health');
    assert.equal(status.agent.activeSessions, 0);
    assert.equal(status.agent.totalAgents, 1);
    assert.equal(status.agent.channels.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
}

function testHeartbeatTimestampNormalization() {
  assert.equal(heartbeatValueToSeconds('2026-06-16T10:27:00Z'), 1781605620);
  assert.equal(heartbeatValueToSeconds(1781605620123), 1781605620);
  assert.equal(heartbeatValueToSeconds(1781605620), 1781605620);
  assert.equal(heartbeatValueToSeconds('not-a-date'), null);

  assert.deepEqual(
    normalizeHeartbeatPayload({
      lastHeartbeat: 1781605620123,
      lastHeartbeatAt: '2026-06-16T10:27:00Z',
      lastChecks: { heartbeat: '2026-06-16T10:27:00Z' },
    }),
    {
      lastHeartbeat: 1781605620,
      lastHeartbeatAt: '2026-06-16T10:27:00Z',
      lastChecks: { heartbeat: '2026-06-16T10:27:00Z' },
    },
  );

  assert.deepEqual(
    normalizeHeartbeatPayload({
      lastHeartbeatAt: '2026-06-16T10:27:00Z',
      lastChecks: { heartbeat: '2026-06-16T10:27:00Z' },
    }),
    {
      lastHeartbeatAt: '2026-06-16T10:27:00Z',
      lastChecks: { heartbeat: '2026-06-16T10:27:00Z' },
      lastHeartbeat: 1781605620,
    },
  );
}

function testHeartbeatEventRejectsFutureClockSkew() {
  const nowMs = Date.parse('2026-07-11T02:10:00Z');
  assert.deepEqual(
    heartbeatEventToPayload({ ts: nowMs + 365 * 24 * 60 * 60 * 1000, status: 'sent' }, {
      now: () => nowMs,
    }),
    {},
  );
  assert.equal(
    heartbeatEventToPayload({ ts: nowMs + 4 * 60 * 1000, status: 'sent' }, {
      now: () => nowMs,
    }).lastHeartbeat,
    Math.floor((nowMs + 4 * 60 * 1000) / 1000),
  );
}

function testHeartbeatMergeKeepsEventMetadataWithWinningTimestamp() {
  const olderEvent = {
    lastHeartbeat: 100,
    lastEventStatus: 'skipped',
    lastEventReason: 'empty-heartbeat-file',
    lastEventDurationMs: 4,
  };
  const newerLegacy = { lastHeartbeat: 200, lastChecks: { email: 150 } };
  assert.deepEqual(mergeHeartbeatPayloads(newerLegacy, olderEvent), newerLegacy);

  const newerEvent = { ...olderEvent, lastHeartbeat: 300 };
  assert.deepEqual(mergeHeartbeatPayloads(newerEvent, newerLegacy), {
    ...newerLegacy,
    ...newerEvent,
  });
}

async function testSnapshotHeartbeatIsNormalizedForLegacyDashboard() {
  const snapshot = {
    agent: { name: 'Mission Control' },
    heartbeat: {
      lastHeartbeatAt: '2026-06-16T10:27:00Z',
      lastChecks: { heartbeat: '2026-06-16T10:27:00Z' },
    },
    recentActivity: [],
    tokenUsage: { used: 0 },
  };
  const { service } = makeService({
    readRuntimeSnapshot: () => snapshot,
  });

  const status = await service.getStatusResponse();

  assert.equal(status.heartbeat.lastHeartbeat, 1781605620);
  assert.equal(status.heartbeat.lastHeartbeatAt, '2026-06-16T10:27:00Z');
}

async function testOperationsStatusRequiresObservedCliEvidence() {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => '{"ok":true}' });
  try {
    const successful = makeService({
      execSync: () => '0 active sessions\nAgents │ 1\n',
    });
    const observed = await successful.service.getOperationsStatusResponse();
    assert.equal(observed.operationsSource.sourceSucceeded, true);
    assert.equal(observed.operationsSource.provenance, 'openclaw-status-cli');
    assert.ok(Number.isFinite(Date.parse(observed.operationsSource.observedAt)));
    assert.equal(Object.hasOwn(successful.readSnapshot(), 'operationsSource'), false);

    const fallback = makeService({
      execSync: () => {
        const error = new Error('openclaw unavailable');
        error.stdout = '';
        throw error;
      },
    });
    const unavailable = await fallback.service.getOperationsStatusResponse();
    assert.deepEqual(unavailable.operationsSource, {
      sourceSucceeded: false,
      provenance: 'openclaw-status-unavailable',
      observedAt: null,
    });
    assert.equal(Object.hasOwn(fallback.readSnapshot(), 'operationsSource'), false);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testLiveHeartbeatEventBackfillsLegacyState() {
  const eventTs = Date.parse('2026-07-11T02:10:00Z');
  const { service, readSnapshot } = makeService({
    execSync: (command) => {
      if (String(command).includes('system heartbeat last')) {
        return JSON.stringify({
          ts: eventTs,
          status: 'skipped',
          reason: 'empty-heartbeat-file',
          durationMs: 4,
        });
      }
      return '1 active sessions\nHeartbeat │ 1h\nAgents │ 31\n';
    },
  });

  await service.refreshStatusCache();
  const status = readSnapshot();

  assert.equal(status.heartbeat.lastHeartbeat, Math.floor(eventTs / 1000));
  assert.equal(status.heartbeat.lastHeartbeatAt, '2026-07-11T02:10:00.000Z');
  assert.equal(status.heartbeat.lastEventStatus, 'skipped');
  assert.equal(status.heartbeat.lastEventReason, 'empty-heartbeat-file');
  assert.equal(status.heartbeat.lastEventDurationMs, 4);
}

(async () => {
  testHeartbeatTimestampNormalization();
  testHeartbeatEventRejectsFutureClockSkew();
  testHeartbeatMergeKeepsEventMetadataWithWinningTimestamp();
  await testSnapshotHeartbeatIsNormalizedForLegacyDashboard();
  await testGatewayHealthDoesNotReplaceFullStatusParserInput();
  await testGatewayHealthIsFallbackWhenFullStatusFails();
  await testOperationsStatusRequiresObservedCliEvidence();
  await testLiveHeartbeatEventBackfillsLegacyState();
  console.log('statusData tests passed');
})();
