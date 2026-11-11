// Every detailHref the backend emits points at a screen that renders. The
// routed screens are read at test time from frontend/src/appRoutes.tsx
// (primary + utility routes), so a removed or renamed screen fails here.
// Builders are driven with fixtures for each state; fake sources only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { buildOperationsOverview, DETAIL_HREFS } = require('../server/services/operationsOverview');
const { createMloopSource } = require('../server/sources/mloop');
const { buildLoopsRouter } = require('../server/routes/loops');
const { buildSignalsRouter } = require('../server/routes/signals');
const { buildServicesRouter } = require('../server/routes/services');
const { errorHandler } = require('../server/core/http');

const generatedAt = '2026-07-10T12:00:00.000Z';
const NOW = Date.parse(generatedAt);

function routedPaths() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'appRoutes.tsx'), 'utf8');
  const paths = [];
  for (const line of source.split('\n')) {
    if (!/navPlacement:\s*'(primary|utility)'/.test(line)) continue;
    const match = line.match(/path:\s*'([^']+)'/);
    if (match) paths.push(match[1]);
  }
  assert.ok(paths.includes('/') && paths.length >= 5, `appRoutes.tsx parse found ${JSON.stringify(paths)}`);
  return new Set(paths);
}

function collectHrefs(value, out = [], where = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHrefs(item, out, `${where}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'detailHref' && item !== null) out.push({ where: `${where}.${key}`, href: item });
      collectHrefs(item, out, `${where}.${key}`);
    }
  }
  return out;
}

const proof = (provenance) => ({ sourceSucceeded: true, provenance, observedAt: generatedAt });

function healthyInput() {
  return {
    status: {
      generatedAt,
      operationsSource: proof('openclaw-status-cli'),
      agent: { activeSessions: 2, channels: ['telegram'] },
      heartbeat: { lastHeartbeat: NOW },
    },
    sessions: { generatedAt, operationsSource: proof('openclaw-sessions-cli'), sessions: [{ isActive: true }, { isActive: true }] },
    cron: {
      generatedAt,
      operationsSource: { ...proof('scheduler-readers'), schedulers: { openclaw: proof('openclaw-cron-cli'), hermes: proof('hermes-cron-disk') } },
      jobs: [{ id: 'openclaw:a', scheduler: 'openclaw' }, { id: 'hermes:a', scheduler: 'hermes' }],
    },
    hermes: { ok: true, refreshedAt: generatedAt, summary: { active: 2, running: 1, blocked: 0, total: 9 } },
    hermesGateway: { ok: true, status: 'running', observedAt: generatedAt },
    gbrain: {
      ok: true,
      trust: { status: 'healthy', score: 100, label: 'Live trusted', lastVerifiedAt: generatedAt },
      caveats: [],
      live: { sources: { freshness: { staleCount: 0 } } },
    },
  };
}

function variant(change) {
  const input = healthyInput();
  change(input);
  return input;
}

const UNREADABLE = { ok: false, unavailable: true };

const FIXTURES = {
  healthy: healthyInput(),
  nothingRead: {},
  hermesBlocked: variant((i) => { i.hermes.summary.blocked = 3; }),
  hermesStaleKanban: variant((i) => { i.hermes.stale = true; i.hermes.staleAgeMs = 120_000; }),
  hermesGatewayDown: variant((i) => { i.hermesGateway.status = 'down'; i.hermes.summary.blocked = 1; }),
  hermesGatewayStale: variant((i) => { i.hermesGateway.status = 'stale'; }),
  hermesGatewayUnverified: variant((i) => { i.hermesGateway = UNREADABLE; }),
  hermesKanbanUnavailable: variant((i) => { i.hermes = UNREADABLE; }),
  hermesOnlyGateway: variant((i) => { i.hermes = UNREADABLE; i.hermesGateway.status = 'down'; }),
  cronUnavailable: variant((i) => { i.cron = UNREADABLE; }),
  cronStale: variant((i) => { i.cron.operationsSource.schedulers.hermes.stale = true; }),
  openclawStatusUnavailable: variant((i) => { i.status = UNREADABLE; }),
  openclawSessionsUnavailable: variant((i) => { i.sessions = UNREADABLE; }),
  openclawSessionConflict: variant((i) => { i.status.agent.activeSessions = 7; }),
  openclawHeartbeatStale: variant((i) => { i.status.heartbeat.lastHeartbeat = NOW - 5 * 3600_000; }),
  gbrainLegacyCaveats: variant((i) => { i.gbrain.trust.status = 'warning'; i.gbrain.caveats = ['embeddings missing']; i.gbrain.live.sources.freshness.staleCount = 2; }),
  gbrainVerdict: variant((i) => { i.gbrain = { verdict: { state: 'warning', reasons: [{ elementId: 'queue', state: 'warning', text: 'queue backed up' }] }, meta: { observedAt: generatedAt }, trust: { label: 'x', score: 70 } }; }),
  gbrainVerdictInvalid: variant((i) => { i.gbrain = { verdict: { state: 'nope', reasons: [] } }; }),
  capabilitiesUnavailable: variant((i) => { i.capabilitiesUnavailable = true; }),
};

test('the mapping lives in one exported place and only names routed screens', () => {
  const routed = routedPaths();
  for (const [system, topics] of Object.entries(DETAIL_HREFS)) {
    for (const [topic, href] of Object.entries(topics)) assert.ok(routed.has(href), `${system}.${topic} -> ${href}`);
  }
});

test('every detailHref the overview emits, in every state, is a routed screen', () => {
  const routed = routedPaths();
  const seen = new Set();
  for (const [name, input] of Object.entries(FIXTURES)) {
    const overview = buildOperationsOverview(input, { generatedAt });
    const hrefs = collectHrefs(overview);
    assert.ok(hrefs.length > 0, `${name}: no hrefs collected`);
    for (const { where, href } of hrefs) {
      assert.ok(routed.has(href), `${name}: ${where} = ${href} is not a routed screen`);
      seen.add(href);
    }
  }
  // The fixtures reach every mapped destination.
  assert.deepEqual([...seen].sort(), ['/', '/attention', '/automations', '/services']);
});

test('Hermes links to Attention for blocked work, otherwise Services; OpenClaw Services; GBrain home; scheduling Automations', () => {
  const blocked = buildOperationsOverview(FIXTURES.hermesBlocked, { generatedAt });
  assert.equal(blocked.systems.hermes.detailHref, '/attention');
  assert.equal(blocked.attention.find((item) => item.id === 'hermes:blocked').detailHref, '/attention');
  assert.equal(blocked.evidence.find((item) => item.id === 'hermes:kanban').detailHref, '/attention');
  const down = buildOperationsOverview(FIXTURES.hermesGatewayDown, { generatedAt });
  assert.equal(down.systems.hermes.detailHref, '/services', 'a down gateway leads, so the system links to Services');
  assert.equal(down.attention.find((item) => item.id === 'hermes:blocked').detailHref, '/attention');
  const healthy = buildOperationsOverview(FIXTURES.healthy, { generatedAt });
  assert.equal(healthy.systems.hermes.detailHref, '/services');
  assert.equal(healthy.systems.openclaw.detailHref, '/services');
  assert.equal(healthy.systems.gbrain.detailHref, '/');
  const cron = buildOperationsOverview(FIXTURES.cronUnavailable, { generatedAt });
  for (const id of ['hermes:cron-unavailable', 'openclaw:cron-unavailable']) {
    assert.equal(cron.attention.find((item) => item.id === id).detailHref, '/automations');
  }
});

const empty = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: 'x' } }) };
function snapshotOf(data) {
  return { snapshot: () => ({ data, meta: { ok: true, stale: false, observedAt: generatedAt, ageMs: 0, error: null, latencyMs: 1, source: 'x' } }) };
}

test('signals, loops and services payloads emit only routed detailHrefs', async () => {
  const routed = routedPaths();
  const checkRows = [{ project: 'alpha', code: 'BINDING_DEAD', subject: 'w', severity: 'warning', detail: 'd', ts: generatedAt }];
  const exec = {
    async run(file, args) {
      const body = args[0] === 'check' ? checkRows : args[3] === 'status' ? '# alpha\n' : [];
      return { ok: true, code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
    },
  };
  const fsImpl = { async readdir() { return [{ name: 'alpha', isDirectory: () => true }]; }, async stat() { return { isFile: () => true, mtimeMs: NOW }; } };
  const loopsSource = createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now: () => NOW });
  await loopsSource.refresh();
  const launchdSource = snapshotOf({
    services: [{ label: 'x', state: 'running', identified: true }],
    counts: { total: 1, running: 1, idle: 0, down: 0, failed: 0 },
    summary: { total: 1, running: 1, idle: 0, down: 0, unidentified: 0 },
  });
  for (const [name, input] of Object.entries(FIXTURES)) {
    const overview = { async getOverview() { return { ...buildOperationsOverview(input, { generatedAt }), meta: { ok: true, stale: false, observedAt: generatedAt, ageMs: 0, error: null, latencyMs: null, source: 'operations.overview' } }; } };
    const app = express();
    app.use(buildLoopsRouter({ loopsSource, operationsOverviewService: overview }));
    app.use(buildSignalsRouter({ operationsOverviewService: overview, loopsSource, launchdSource, reachabilitySource: empty, now: () => NOW }));
    app.use(buildServicesRouter({ launchdSource, reachabilitySource: empty }));
    app.use(errorHandler({ logger: { error() {} } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const route of ['/api/signals', '/api/loops', '/api/loops/alpha', '/api/services']) {
        const body = await (await fetch(`${base}${route}`)).json();
        for (const { where, href } of collectHrefs(body)) {
          assert.ok(routed.has(href), `${name} ${route}: ${where} = ${href} is not a routed screen`);
        }
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
