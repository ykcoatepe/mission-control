const test = require('node:test');
const assert = require('node:assert/strict');

const { createSource } = require('../server/core/source');

function clock(start = Date.parse('2026-11-11T10:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('a good read is held as data with a full envelope', async () => {
  const c = clock();
  const source = createSource({ id: 'demo', read: async () => ({ n: 1 }), ttlMs: 1000, now: c.now });
  const before = source.snapshot();
  assert.equal(before.data, null);
  assert.equal(before.meta.ok, false);
  assert.equal(before.meta.observedAt, null);

  const snap = await source.refresh();
  assert.deepEqual(snap.data, { n: 1 });
  assert.deepEqual(Object.keys(snap.meta).sort(), ['ageMs', 'error', 'latencyMs', 'observedAt', 'ok', 'source', 'stale']);
  assert.equal(snap.meta.ok, true);
  assert.equal(snap.meta.stale, false);
  assert.equal(snap.meta.source, 'demo');
  assert.equal(snap.meta.observedAt, '2026-11-11T10:00:00.000Z');
  c.advance(250);
  assert.equal(source.snapshot().meta.ageMs, 250);
});

test('counter-example: a failed read never replaces last-good data', async () => {
  let fail = false;
  const source = createSource({
    id: 'sessions',
    read: async () => {
      if (fail) throw Object.assign(new Error('openclaw sessions failed'), { code: 'cli_failed' });
      return { sessions: ['a', 'b'] };
    },
  });
  await source.refresh();
  fail = true;
  const snap = await source.refresh();
  assert.deepEqual(snap.data, { sessions: ['a', 'b'] }, 'last-good data must survive a failed read');
  assert.equal(snap.meta.ok, false);
  assert.equal(snap.meta.stale, true);
  assert.deepEqual(snap.meta.error, { code: 'cli_failed', message: 'openclaw sessions failed' });
  fail = false;
  const recovered = await source.refresh();
  assert.equal(recovered.meta.ok, true);
  assert.equal(recovered.meta.error, null);
});

test('counter-example: with no good read, data stays null (never a default)', async () => {
  for (const read of [
    async () => { throw new Error('down'); },
    async () => undefined,
    async () => null,
  ]) {
    const source = createSource({ id: 'x', read });
    const snap = await source.refresh();
    assert.equal(snap.data, null);
    assert.equal(snap.meta.ok, false);
    assert.ok(snap.meta.error, 'the failure is reported');
  }
});

test('an empty read does not erase last-good data', async () => {
  let value = { v: 1 };
  const source = createSource({ id: 'x', read: async () => value });
  await source.refresh();
  value = undefined;
  const snap = await source.refresh();
  assert.deepEqual(snap.data, { v: 1 });
  assert.equal(snap.meta.error.code, 'empty_read');
});

test('refresh is single-flight', async () => {
  let reads = 0;
  let release;
  const source = createSource({
    id: 'x',
    read: () => {
      reads += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const a = source.refresh();
  const b = source.refresh();
  assert.equal(a, b);
  await new Promise((r) => setImmediate(r));
  release({ ok: true });
  await a;
  assert.equal(reads, 1);
});

test('a timed-out read is a failure, keeps its slot until it settles, and its late result is discarded', async () => {
  let reads = 0;
  let release;
  let first = true;
  const source = createSource({
    id: 'slow',
    timeoutMs: 20,
    read: () => {
      reads += 1;
      if (first) {
        first = false;
        return Promise.resolve({ v: 'good' });
      }
      return new Promise((resolve) => { release = resolve; });
    },
  });
  await source.refresh();
  const snap = await source.refresh();
  assert.equal(snap.meta.error.code, 'timeout');
  assert.deepEqual(snap.data, { v: 'good' });
  // While the hung read is still running, no new read starts.
  await source.refresh();
  assert.equal(reads, 2);
  release({ v: 'late' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(source.snapshot().data, { v: 'good' }, 'late result must not be applied');
  await source.refresh();
  assert.equal(reads, 3);
});

test('data ages into stale after staleAfterMs', async () => {
  const c = clock();
  const source = createSource({ id: 'x', read: async () => 1, ttlMs: 100, staleAfterMs: 500, now: c.now });
  await source.refresh();
  c.advance(400);
  assert.equal(source.snapshot().meta.stale, false);
  c.advance(200);
  const snap = source.snapshot();
  assert.equal(snap.meta.stale, true);
  assert.equal(snap.meta.ok, true, 'ok describes the last read; stale describes age');
});

test('get() serves memory and refreshes in the background only when expired', async () => {
  const c = clock();
  let reads = 0;
  const source = createSource({ id: 'x', read: async () => { reads += 1; return reads; }, ttlMs: 1000, now: c.now });
  source.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  source.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1, 'fresh data: no read');
  c.advance(1500);
  const snap = source.get();
  assert.equal(snap.data, 1, 'returns the held value immediately');
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
});

test('get() does not hammer a failing upstream', async () => {
  const c = clock();
  let reads = 0;
  const source = createSource({ id: 'x', read: async () => { reads += 1; throw new Error('down'); }, ttlMs: 60_000, now: c.now });
  source.get();
  await new Promise((r) => setImmediate(r));
  source.get();
  source.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  c.advance(6000);
  source.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
});

test('status() reports counters for /api/health', async () => {
  const source = createSource({ id: 'x', read: async () => { throw new Error('no'); } });
  await source.refresh();
  const status = source.status();
  assert.equal(status.id, 'x');
  assert.equal(status.reads, 1);
  assert.equal(status.failures, 1);
  assert.equal(status.refreshing, false);
});
