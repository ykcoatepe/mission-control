'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { projectTrends } = require('../server/sources/gbrain/trends');
const { buildGBrainRouter } = require('../server/routes/gbrain/router');
const { errorHandler } = require('../server/core/http');

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const entry = (hoursAgo, metrics = {}, extra = {}) => ({
  capturedAt: at(hoursAgo),
  trust: { label: 'GBrain', status: 'healthy', score: 99, source: 'gbrain call get_health' },
  metrics: { health: '99/100', embeddings: '100%', queue: '0 / 0 / 0', ...metrics },
  ...extra,
});

async function serve(router, check) {
  const app = express(); app.use(router); app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  try { await check(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('trends: only readings recorded in the last 24 hours, oldest first', () => {
  const out = projectTrends([entry(1, { health: '98/100' }), entry(30, { health: '50/100' }), entry(5, { health: '100/100' })], { now: NOW });
  assert.deepEqual(out.series.quality.map((p) => p.v), [100, 98]);
  assert.ok(out.series.quality[0].t < out.series.quality[1].t);
  assert.equal(out.entryCount, 2);
});

test('trends: a reading that was not taken is left out, never drawn as zero', () => {
  const out = projectTrends([
    entry(4, { health: 'Unavailable', embeddings: 'Unavailable', queue: 'Unavailable' }, { trust: { source: 'not-read', score: 0 } }),
    entry(3, { health: '99/100' }),
    entry(2, { health: '99/100' }),
  ], { now: NOW });
  assert.equal(out.series.quality.length, 2);
  assert.ok(out.series.quality.every((p) => p.v === 99));
});

test('trends: fewer than two real readings is no series at all (no trend without data)', () => {
  const out = projectTrends([entry(1)], { now: NOW });
  assert.deepEqual(out.series, { quality: [], embeddedPercent: [], queue: [] });
  assert.deepEqual(projectTrends([], { now: NOW }).series, { quality: [], embeddedPercent: [], queue: [] });
  assert.deepEqual(projectTrends(null, { now: NOW }).series.quality, []);
});

test('trends: queue is waiting + active + stalled, embedded is the recorded percent', () => {
  const out = projectTrends([entry(3, { queue: '2 / 1 / 0', embeddings: '99%' }), entry(2, { queue: '4 / 2 / 1', embeddings: '100%' })], { now: NOW });
  assert.deepEqual(out.series.queue.map((p) => p.v), [3, 7]);
  assert.deepEqual(out.series.embeddedPercent.map((p) => p.v), [99, 100]);
});

test('trends: entries without a usable time, or dated in the future, are ignored', () => {
  const out = projectTrends([{ metrics: { health: '99/100' } }, entry(-2), entry(1), entry(2)], { now: NOW });
  assert.equal(out.series.quality.length, 2);
});

test('GET /api/gbrain/trends reads the ledger without writing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-trends-'));
  const ledger = path.join(dir, 'evidence-timeline.jsonl');
  fs.writeFileSync(ledger, [entry(3, { health: '97/100' }), entry(2, { health: '99/100' }), entry(40, { health: '10/100' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const before = fs.readFileSync(ledger, 'utf8');
  try {
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: ledger } } }), async (base) => {
      const response = await fetch(`${base}/api/gbrain/trends`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.series.quality.map((p) => p.v), [97, 99]);
      assert.equal(body.meta.ok, true);
    });
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('GET /api/gbrain/trends: an absent ledger is an empty history, an unreadable one is the 503 contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-trends-'));
  try {
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: path.join(dir, 'none.jsonl') } } }), async (base) => {
      const response = await fetch(`${base}/api/gbrain/trends`);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).series.quality, []);
    });
    // A directory where the ledger should be cannot be read.
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: dir } } }), async (base) => {
      const response = await fetch(`${base}/api/gbrain/trends`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'gbrain_timeline_unavailable');
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('GET /api/gbrain/trends reads only the tail it needs: a long ledger of old readings is not parsed whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-trends-'));
  const ledger = path.join(dir, 'evidence-timeline.jsonl');
  // 60,000 readings older than the window (several MB), then three recent ones.
  const old = JSON.stringify(entry(48, { health: '10/100' })) + '\n';
  fs.writeFileSync(ledger, old.repeat(60_000) + [entry(3, { health: '97/100' }), entry(2, { health: '98/100' }), entry(1, { health: '99/100' })].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = function counted(...args) { parsed += 1; return parse.apply(this, args); };
  try {
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: ledger } } }), async (base) => {
      const before = parsed;
      const response = await fetch(`${base}/api/gbrain/trends`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(body.series.quality.map((p) => p.v), [97, 98, 99]);
      assert.equal(body.meta.ok, true);
      assert.ok(parsed - before < 1000, `parsed ${parsed - before} ledger lines`);
    });
  } finally { JSON.parse = parse; fs.rmSync(dir, { recursive: true }); }
});

test('GET /api/gbrain/trends: a window larger than the byte cap is a typed failure in the envelope, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-trends-'));
  const ledger = path.join(dir, 'evidence-timeline.jsonl');
  // Every reading inside the window and far more of them than the cap allows.
  const padded = (hoursAgo) => JSON.stringify(entry(hoursAgo, {}, { pad: 'x'.repeat(4000) }));
  const lines = [];
  for (let i = 0; i < 3000; i += 1) lines.push(padded(23 - (i * 23) / 3000));
  fs.writeFileSync(ledger, lines.join('\n') + '\n');
  try {
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: ledger } } }), async (base) => {
      const response = await fetch(`${base}/api/gbrain/trends`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.meta.ok, false);
      assert.equal(body.meta.error.code, 'gbrain_trends_too_large');
      assert.deepEqual(body.series, { quality: [], embeddedPercent: [], queue: [] }, 'no partial trend is drawn as if it were the whole day');
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('GET /api/gbrain/trends: corrupt history is never a successful empty answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-trends-'));
  const ledger = path.join(dir, 'evidence-timeline.jsonl');
  try {
    fs.writeFileSync(ledger, '{ not json\n\u0000\u0001garbage\n[1,2\n');
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: ledger } } }), async (base) => {
      const body = await (await fetch(`${base}/api/gbrain/trends`)).json();
      assert.equal(body.meta.ok, false, 'nothing could be read: not ok');
      assert.equal(body.meta.error.code, 'gbrain_trends_corrupt');
      assert.equal(body.skippedLines, 3);
    });
    // Some lines readable, some not: the readable series with the count of skipped lines.
    fs.writeFileSync(ledger, [JSON.stringify(entry(3, { health: '97/100' })), '{ broken', JSON.stringify(entry(2, { health: '99/100' }))].join('\n') + '\n');
    await serve(buildGBrainRouter({ now: () => NOW, gbrainOverviewService: { timelineService: { enabled: true, ledgerPath: ledger } } }), async (base) => {
      const body = await (await fetch(`${base}/api/gbrain/trends`)).json();
      assert.deepEqual(body.series.quality.map((p) => p.v), [97, 99]);
      assert.equal(body.partial, true);
      assert.equal(body.skippedLines, 1);
    });
  } finally { fs.rmSync(dir, { recursive: true }); }
});
