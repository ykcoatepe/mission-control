const assert = require('node:assert/strict');
const test = require('node:test');

const { createHermesGatewayHealthService } = require('../server/services/hermesGatewayHealth');

const NOW = Date.parse('2026-11-11T06:11:00.000Z');

function state(overrides = {}) {
  return JSON.stringify({
    pid: 77135,
    kind: 'hermes-gateway',
    gateway_state: 'running',
    updated_at: '2026-11-11T06:10:32.382178+00:00',
    ...overrides,
  });
}

function service({ file, alive = () => true, name = 'gateway_state.json' } = {}) {
  const reads = [];
  return {
    reads,
    svc: createHermesGatewayHealthService({
      profile: 'hmudur',
      home: '/home/u',
      now: () => NOW,
      readFile: async (p) => {
        reads.push(p);
        if (file instanceof Error) throw file;
        return file;
      },
      isPidAlive: alive,
    }),
  };
}

test('running gateway with live pid and fresh heartbeat is running', async () => {
  const { svc, reads } = service({ file: state() });
  const h = await svc.getHealth();
  assert.equal(h.ok, true);
  assert.equal(h.status, 'running');
  assert.equal(h.pid, 77135);
  assert.equal(h.heartbeatAt, '2026-11-11T06:10:32.382Z');
  assert.equal(h.observedAt, new Date(NOW).toISOString());
  assert.deepEqual(reads, ['/home/u/.hermes/profiles/hmudur/gateway_state.json']);
});

test('dead pid means down regardless of what the state file claims', async () => {
  const { svc } = service({ file: state(), alive: () => false });
  const h = await svc.getHealth();
  assert.equal(h.status, 'down');
  assert.match(h.reason, /not running/);
});

test('state other than running means down', async () => {
  const { svc } = service({ file: state({ gateway_state: 'stopped', exit_reason: 'x' }) });
  assert.equal((await svc.getHealth()).status, 'down');
});

test('live pid but old heartbeat is stale', async () => {
  const { svc } = service({ file: state({ updated_at: '2026-11-11T05:50:00+00:00' }) });
  assert.equal((await svc.getHealth()).status, 'stale');
});

test('missing or corrupt state file is unverified, never running', async () => {
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  for (const file of [missing, '{not json', state({ pid: 'x' })]) {
    const { svc } = service({ file });
    const h = await svc.getHealth();
    assert.equal(h.ok, false);
    assert.equal(h.unavailable, true);
  }
});
