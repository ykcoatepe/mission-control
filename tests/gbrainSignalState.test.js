'use strict';

// The top-bar GBrain signal follows the GBrain verdict STATE, through the app factory (real
// GBrain overview service with fake probes, real Operations and signals wiring). Information
// (a limitation of the reading) may be a caveat, never the state; a reading that really failed is
// unavailable; something to act on is a warning.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../server/app');
const { loadConfig } = require('../server/core/config');
const { createGBrainOverviewService } = require('../server/services/gbrainOverviewData');
const { normalizeSourcesPayload } = require('../server/routes/gbrain/liveProbes');
const { EMBED_JOB_PROBE_TEXT } = require('../server/sources/gbrain/verdict');

const AT = '2026-11-12T10:00:00.000Z';
const silent = { log() {}, warn() {}, error() {}, info() {} };
const emptySource = (id) => ({
  id, refresh: async () => {}, status: () => ({ id }),
  snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: id } }),
});

async function signalsFor({ metrics = {}, failHealth = false }) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-signal-'));
  fs.writeFileSync(path.join(rootDir, 'mc-config.json'), JSON.stringify({ name: 'Signal Test', gateway: { port: 1, token: '' }, modules: {} }));
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{"version":"test"}');
  const service = createGBrainOverviewService({
    now: () => Date.parse(AT),
    probes: {
      health: async () => {
        if (failHealth) throw new Error('health probe failed');
        return { ok: true, status: 'healthy', score: 100, checkedAt: AT, metrics: { missingEmbeddings: 0, stalePages: 0, ...metrics } };
      },
      sources: async () => normalizeSourcesPayload([{ source_id: 'project', sync_enabled: true, last_sync_at: AT }], AT),
      version: async () => ({ ok: true, version: '1.2.3' }),
      stats: async () => ({ pages: 12, chunks: 34, embedded: 34 }),
      jobs: async () => ({ waiting: 0, active: 0, stalled: 0 }),
    },
    buildIntegrationRuntime: () => ({ readers: [] }),
    timelineService: { captureOverview: async () => ({}), readTimeline: () => ({ entries: [] }) },
  });
  await service.refresh();
  const app = createApp({
    config: loadConfig({ rootDir, homeDir: rootDir, env: { PORT: '0' } }),
    exec: { run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false }), killAll() {}, drain: async () => true, status: () => ({ lanes: {}, children: 0, quarantined: [] }) },
    clock: { now: () => Date.parse(AT) },
    fetch: async () => { throw new Error('No network'); },
    logger: silent,
    scheduler: { register() {}, start() {}, stop() {}, status: () => ({ jobs: [] }) },
    services: { gbrainOverviewService: service, usageService: { summary: () => ({ data: null, meta: {} }), dispose() {} } },
    sources: {
      loops: emptySource('mloop.loops'), automations: emptySource('openclaw.automations'),
      launchd: emptySource('launchd.services'), reachability: emptySource('services.reachability'),
      calendar: emptySource('openclaw.calendar'), models: emptySource('openclaw.models'),
      ollama: emptySource('ollama.telemetry'), awsCosts: emptySource('aws.costs'),
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  app.locals.runtime.setBoundPort(server.address().port);
  try {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/signals' }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    return { signals: body.data, synoptic: service.synopticSnapshot().data };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('healthy verdict with only an information reason: the signal is healthy', async () => {
  const { signals, synoptic } = await signalsFor({ metrics: { embedJobProbeUnavailable: true } });
  const reason = synoptic.verdict.reasons.find((r) => r.elementId === 'embed-job-probe');
  assert.equal(reason.kind, 'info');
  assert.equal(reason.text, EMBED_JOB_PROBE_TEXT);
  assert.equal(synoptic.verdict.state, 'healthy');
  assert.equal(signals.systems.gbrain.state, 'healthy');
});

test('verdict warning with a reason to act on: the signal is warning, with that reason', async () => {
  const { signals, synoptic } = await signalsFor({ metrics: { missingEmbeddings: 12, missingEmbeddingsOverdue: 12, embedJobProbeUnavailable: true } });
  assert.equal(synoptic.verdict.state, 'warning');
  assert.equal(signals.systems.gbrain.state, 'warning');
  assert.match(signals.systems.gbrain.reason, /12 chunks are missing embeddings/);
});

test('verdict unavailable because the reading itself failed: the signal is unavailable', async () => {
  const { signals, synoptic } = await signalsFor({ failHealth: true });
  assert.equal(synoptic.verdict.state, 'unavailable');
  assert.equal(signals.systems.gbrain.state, 'unavailable');
});
