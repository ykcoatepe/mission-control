// launchd + reachability sources and GET /api/services. Fake exec, fake fs and
// fake fetch only: no launchctl, no plutil, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  createLaunchdSource, createReachabilitySource, parseLaunchctlList, parsePlistValue, labelMatcher, classify, deriveState,
} = require('../server/sources/launchd');
const { buildServicesRouter } = require('../server/routes/services');
const { errorHandler } = require('../server/core/http');

const LIST = [
  'PID\tStatus\tLabel',
  '31226\t0\tai.openclaw.gateway',
  '-\t0\tai.mloop.supervisor',
  '-\t1\tcom.gbrain.brain-pull.docs',
  '-\t0\tai.hermes.gateway-hmudur',
  '96016\t-15\tai.openclaw.mission-control',
  '-\t0\tcom.apple.Safari.History',
  '-\t0\tai.argus.hermes-bridge',
  '49881\t0\tapplication.com.electron.ollama.1.2',
].join('\n');

const PLISTS = {
  'ai.openclaw.gateway': { KeepAlive: '<true/>', RunAtLoad: '<true/>', Label: '<string>ai.openclaw.gateway</string>' },
  'ai.mloop.supervisor': { StartInterval: '<integer>600</integer>' },
  'com.gbrain.brain-pull.docs': { StartCalendarInterval: '<dict><key>Hour</key><integer>3</integer></dict>' },
  'ai.hermes.gateway-hmudur': { KeepAlive: '<dict><key>SuccessfulExit</key><false/></dict>' },
  // ai.openclaw.mission-control: no plist found
};

function xml(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x">\n<plist version="1.0">\n${value}\n</plist>\n`;
}

function fakeExec({ listResult } = {}) {
  const calls = [];
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      if (file === '/bin/launchctl') return listResult || { ok: true, code: 0, stdout: LIST, stderr: '' };
      if (file === '/usr/bin/plutil') {
        const [, key, , , , , plist] = args;
        const label = plist.split('/').pop().replace(/\.plist$/, '');
        const value = PLISTS[label]?.[key];
        if (value) return { ok: true, code: 0, stdout: xml(value), stderr: '' };
        return { ok: false, code: 1, stdout: `${plist}: Could not extract value, error: No value at that key path or invalid key path: ${key}\n`, stderr: '' };
      }
      throw new Error(`unexpected command ${file}`);
    },
  };
}

function fakeFs(stamps = {}) {
  return {
    async stat(file) {
      const label = file.split('/').pop().replace(/\.plist$/, '');
      if (!file.startsWith('/home/test/Library/LaunchAgents/') || !PLISTS[label]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, mtimeMs: stamps[label] || 1, size: 100 };
    },
  };
}

function launchdSource(exec, fsImpl = fakeFs(), extra = {}) {
  return createLaunchdSource({ exec, fsImpl, homeDir: '/home/test', plistDirs: ['/home/test/Library/LaunchAgents'], ...extra });
}

test('parses launchctl list and plist values', () => {
  assert.deepEqual(parseLaunchctlList(LIST)[0], { label: 'ai.openclaw.gateway', pid: 31226, lastExitCode: 0 });
  assert.deepEqual(parseLaunchctlList('PID\tStatus\tLabel\n-\t-\tx')[0], { label: 'x', pid: null, lastExitCode: null });
  assert.throws(() => parseLaunchctlList('garbage'), { code: 'launchctl_unparsable' });
  assert.equal(parsePlistValue(xml('<true/>')), true);
  assert.equal(parsePlistValue(xml('<integer>600</integer>')), 600);
  assert.deepEqual(parsePlistValue(xml('<dict><key>a</key></dict>')), { kind: 'dict' });
  assert.equal(classify({ KeepAlive: { kind: 'dict' } }), 'keepalive');
  assert.equal(classify({ KeepAlive: false, StartInterval: 60 }), 'interval');
  assert.equal(classify({ RunAtLoad: true }), 'one-shot');
  assert.equal(classify(null), null);
  assert.equal(deriveState({ pid: null, lastExitCode: 0, kind: 'keepalive' }), 'down');
  assert.equal(deriveState({ pid: null, lastExitCode: 78, kind: 'interval' }), 'failed');
  assert.equal(deriveState({ pid: 5, lastExitCode: -15, kind: null }), 'running');
});

test('label filter is configurable and never admits Argus/trading or app-instance labels', () => {
  const match = labelMatcher();
  assert.equal(match('ai.openclaw.gateway'), true);
  assert.equal(match('com.apple.Safari.History'), false);
  assert.equal(match('ai.argus.hermes-bridge'), false);
  assert.equal(match('com.yordam.trader.hermes'), false);
  assert.equal(match('application.com.electron.ollama.1'), false);
  const custom = labelMatcher('mloop, gbrain');
  assert.equal(custom('ai.openclaw.gateway'), false);
  assert.equal(custom('ai.mloop.supervisor'), true);
  assert.throws(() => labelMatcher([]), TypeError);
});

test('launchd source classifies the agent stack and reads only the five whitelisted plist keys', async () => {
  const exec = fakeExec();
  const source = launchdSource(exec);
  await source.refresh();
  const { data, meta } = source.snapshot();
  assert.equal(meta.ok, true);
  assert.deepEqual(data.services.map((s) => [s.label, s.kind, s.state, s.pid, s.lastExitCode, s.plist]), [
    ['ai.hermes.gateway-hmudur', 'keepalive', 'down', null, 0, 'read'],
    ['ai.mloop.supervisor', 'interval', 'idle', null, 0, 'read'],
    ['ai.openclaw.gateway', 'keepalive', 'running', 31226, 0, 'read'],
    ['ai.openclaw.mission-control', null, 'running', 96016, -15, 'not-found'],
    ['com.gbrain.brain-pull.docs', 'interval', 'failed', null, 1, 'read'],
  ]);
  assert.deepEqual(data.counts, { total: 5, running: 2, idle: 1, down: 1, failed: 1 });
  assert.equal(data.services.find((s) => s.label === 'ai.mloop.supervisor').intervalSeconds, 600);

  // Read-only: only `launchctl list` and `plutil -extract <whitelisted key>`.
  for (const [file, ...args] of exec.calls) {
    if (file === '/bin/launchctl') {
      assert.deepEqual(args, ['list']);
    } else {
      assert.equal(file, '/usr/bin/plutil');
      assert.equal(args[0], '-extract');
      assert.ok(['Label', 'KeepAlive', 'StartInterval', 'StartCalendarInterval', 'RunAtLoad'].includes(args[1]), `read key ${args[1]}`);
    }
  }
  assert.equal(exec.calls.some((call) => call.some((arg) => /kickstart|bootout|bootstrap|enable|disable|load|ProgramArguments|EnvironmentVariables/.test(arg))), false);
  assert.equal(exec.calls.some((call) => call.some((arg) => /argus/i.test(arg))), false);

  // Unchanged plists are not re-read.
  const plutilCalls = exec.calls.filter(([file]) => file === '/usr/bin/plutil').length;
  await source.refresh();
  assert.equal(exec.calls.filter(([file]) => file === '/usr/bin/plutil').length, plutilCalls);
});

test('a failed launchctl read keeps last-good services and never returns an empty list', async () => {
  let fail = false;
  const exec = fakeExec();
  const wrapped = {
    calls: exec.calls,
    run: (file, args, opts) => (fail && file === '/bin/launchctl'
      ? Promise.resolve({ ok: false, code: 1, stdout: '', stderr: 'boom', timedOut: false })
      : exec.run(file, args, opts)),
  };
  const fresh = launchdSource(wrapped);
  fail = true;
  await fresh.refresh();
  assert.equal(fresh.snapshot().data, null);
  assert.equal(fresh.snapshot().meta.error.code, 'launchctl_failed');

  fail = false;
  const source = launchdSource(wrapped);
  await source.refresh();
  const good = source.snapshot().data;
  fail = true;
  await source.refresh();
  assert.equal(source.snapshot().data, good);
  assert.equal(source.snapshot().meta.stale, true);
});

test('reachability: refused is down, timeout is unknown, hermes from its gateway reader', async () => {
  const fetchImpl = async (url) => {
    if (url.includes(':18789/health')) return { ok: true, status: 200, body: null };
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  };
  const source = createReachabilitySource({
    fetchImpl,
    openclawGatewayPort: 18789,
    hermesGatewayHealthService: { getHealth: async () => ({ ok: true, status: 'stale', observedAt: '2026-11-11T10:00:00.000Z', heartbeatAt: '2026-11-11T09:50:00.000Z', pid: 9 }) },
  });
  await source.refresh();
  const { data } = source.snapshot();
  assert.equal(data.gateways.openclaw.state, 'up');
  assert.equal(data.gateways.openclaw.reachable, true);
  assert.equal(data.gateways.hermes.state, 'stale');
  assert.equal(data.gateways.hermes.reachable, null);
  assert.equal(data.ollama.state, 'down');
  assert.equal(data.ollama.reachable, false);
  assert.equal('pid' in data.gateways.hermes, false);

  const blind = createReachabilitySource({
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
    openclawGatewayPort: 18789,
    hermesGatewayHealthService: { getHealth: async () => ({ ok: false, unavailable: true }) },
  });
  await blind.refresh();
  assert.equal(blind.snapshot().data, null, 'nothing observed is not reported as reachable or down');
  assert.equal(blind.snapshot().meta.error.code, 'reachability_unobserved');
});

test('GET /api/services composes both sources from memory and spawns nothing', async () => {
  const exec = fakeExec();
  const launchd = launchdSource(exec);
  const reachability = createReachabilitySource({
    fetchImpl: async () => ({ ok: true, status: 200 }),
    openclawGatewayPort: 18789,
    hermesGatewayHealthService: { getHealth: async () => ({ ok: true, status: 'running', observedAt: new Date().toISOString() }) },
  });
  const app = express();
  app.use(buildServicesRouter({ launchdSource: launchd, reachabilitySource: reachability }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cold = await fetch(`${base}/api/services`);
    assert.equal(cold.status, 503);
    assert.equal(exec.calls.length, 0, 'a GET started launchctl');

    await launchd.refresh();
    const partial = await (await fetch(`${base}/api/services`)).json();
    assert.equal(partial.data.gateways, null);
    assert.equal(partial.meta.ok, false);
    assert.equal(partial.meta.error.code, 'partial');

    await reachability.refresh();
    const calls = exec.calls.length;
    const full = await (await fetch(`${base}/api/services`)).json();
    assert.equal(exec.calls.length, calls);
    assert.equal(full.meta.ok, true);
    assert.equal(full.data.services.length, 5);
    assert.equal(full.data.gateways.hermes.state, 'up');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a service without a readable definition says so; the summary is computed server-side', async () => {
  const exec = fakeExec();
  const source = launchdSource(exec);
  await source.refresh();
  const { data } = source.snapshot();
  const unknown = data.services.find((s) => s.label === 'ai.openclaw.mission-control');
  assert.equal(unknown.kind, null);
  assert.equal(unknown.identified, false);
  assert.ok(data.services.filter((s) => s.label !== 'ai.openclaw.mission-control').every((s) => s.identified === true));
  // down includes failed launchd services; unidentified = no readable plist.
  assert.deepEqual(data.summary, { total: 5, running: 2, idle: 1, down: 2, unidentified: 1 });

  const app = express();
  const reachability = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: 'r' } }) };
  app.use(buildServicesRouter({ launchdSource: source, reachabilitySource: reachability }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/services`)).json();
    assert.deepEqual(body.data.summary, { total: 5, running: 2, idle: 1, down: 2, unidentified: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
