'use strict';

// The attention fingerprint { rank, reasonIds, counts } through the real
// producers (operationsOverview.js, the GBrain verdict, the mloop reader's
// shapes). Property: the same underlying condition, read again and again
// while the clock, ages, durations and wording move, has ONE fingerprint.
// Negative cases: what really is worse changes it, in the named way.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOperationsOverview } = require('../server/services/operationsOverview');
const { buildGBrainVerdict } = require('../server/sources/gbrain/verdict');
const { attentionItems, countedSystems, fingerprintOf, worseThan } = require('../server/sources/mloop/attention');

const T0 = Date.parse('2026-11-12T10:00:00Z');
const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// One reading of a fixed condition at clock `ms`. Everything that only tells
// time (ages, "N minutes", timestamps, clock texts) follows `ms`; the
// condition itself is `world`.
function reading(ms, world = {}) {
  const { blocked = 4, missingOverdue = 7, stalePages = 3, staleSources = 2, stalled = 1, findingCount = 3, failedJobs = ['j1'], legacy = false, extraCaveat = false } = world;
  const minutes = Math.round((ms - T0) / MINUTE) + 5;
  const verdict = buildGBrainVerdict({
    core: { state: 'warning', quality: { value: 84 } },
    sources: [{ id: 'projects', items: [{ id: 'codex-memories', label: 'codex-memories', state: 'warning', reason: `last synced ${minutes} minutes ago` }] }],
    sourcesState: 'warning',
    queue: { state: 'warning', stalled: { value: stalled } },
    readers: [], readersState: 'inactive',
    live: { health: { status: 'warning', metrics: {
      missingEmbeddings: missingOverdue, missingEmbeddingsOverdue: missingOverdue, missingEmbeddingsOldestAgeSeconds: minutes * 60,
      missingEmbeddingsJobReasons: [`embed job waiting ${minutes}m`], embedJobProbeUnavailable: false,
      stalePages, stalePagesOverdue: stalePages,
    } } },
    probes: { health: { data: {}, meta: { error: null, stale: false } }, jobs: { data: null, meta: { error: { code: 'timeout' }, stale: true } } },
  });
  const gbrain = legacy
    ? { ok: true, trust: { status: 'warning', score: 84, label: 'Needs attention', lastVerifiedAt: iso(ms) },
      caveats: [`Embedding has been waiting ${minutes} minutes.`, ...(extraCaveat ? ['Another caveat.'] : [])],
      live: { sources: { freshness: { staleCount: staleSources } } } }
    : { ok: true, verdict, trust: { status: 'warning', score: 84, label: `Checked ${minutes}m ago`, lastVerifiedAt: iso(ms) }, meta: { observedAt: iso(ms) } };
  const overview = buildOperationsOverview({
    gbrain,
    hermes: { ok: true, refreshedAt: iso(ms - 2 * MINUTE), stale: true, staleAgeMs: minutes * MINUTE, summary: { total: 30, active: 9, running: 2, blocked } },
    hermesGateway: undefined,
    status: undefined, sessions: undefined, cron: undefined,
  }, { generatedAt: iso(ms) });
  const meta = (name, error = null) => ({ ok: !error, stale: Boolean(error), observedAt: iso(ms), ageMs: minutes * 1000, error, latencyMs: minutes, source: `operations.${name}` });
  overview.meta = { sources: { gbrain: meta('gbrain'), hermes: meta('hermes'), hermesGateway: meta('hermesGateway', { code: 'timeout', message: `Read timed out after ${minutes} ms` }), cron: meta('cron') } };
  const loops = { projects: [
    { id: 'alpha', restricted: false,
      findings: [
        { code: 'BINDING_DEAD', subject: 'BINDING_DEAD', subjectHash: null, severity: 'warning', detail: `dead for ${minutes} minutes`, at: iso(ms), count: findingCount },
        { code: 'ESCALATED_ROUNDS', subject: 'unit-7', severity: 'error', detail: `round ${minutes}`, at: iso(ms) },
        { code: 'TEYIT_STALE', subject: 'T4', severity: 'warning', detail: `overdue by ${minutes} minutes`, at: iso(ms) },
      ],
      pendingConfirmations: [{ id: 'T4', overdue: true, deadline: iso(T0 - 60 * MINUTE) }] },
  ] };
  const jobs = failedJobs.map((id) => ({ id: `openclaw:${id}`, enabled: true, status: 'failed', lastRun: iso(ms - MINUTE), consecutiveErrors: minutes, lastError: `failed ${minutes}m ago` }));
  const systems = countedSystems(overview, { now: () => ms });
  return attentionItems({ systems, loops, cronJobs: jobs, allCronJobs: jobs });
}

const fingerprints = (current) => Object.fromEntries([...current.countable].map(([key, item]) => [key, item.fingerprint]));

for (const legacy of [false, true]) {
  test(`property: one condition, read 200 times while the clock and every age move, has one fingerprint (${legacy ? 'legacy GBrain overview' : 'GBrain verdict'})`, () => {
    const first = fingerprints(reading(T0, { legacy }));
    assert.deepEqual(Object.keys(first).sort(), [
      'confirmation:alpha:T4', 'cron:openclaw:j1', 'finding:alpha:BINDING_DEAD:' + Object.keys(first).find((key) => key.startsWith('finding:alpha:BINDING_DEAD:')).split(':')[3],
      Object.keys(first).find((key) => key.startsWith('finding:alpha:ESCALATED_ROUNDS:')), 'system:gbrain', 'system:hermes',
    ].sort(), 'every kind of item is in the reading');
    assert.ok(first['system:gbrain'].reasonIds.length >= 2 && first['system:hermes'].reasonIds.length >= 2);
    let ms = T0;
    for (let i = 1; i <= 200; i += 1) {
      ms += 1 + ((i * 7919) % (37 * MINUTE)); // uneven steps, seconds to half an hour
      const next = fingerprints(reading(ms, { legacy }));
      assert.deepEqual(next, first, `reading ${i} at +${Math.round((ms - T0) / MINUTE)}m`);
      for (const key of Object.keys(first)) assert.equal(worseThan(first[key], next[key]), null);
    }
  });
}

test('what is really worse changes the fingerprint, each in its own way; what is better never does', () => {
  const base = fingerprints(reading(T0));
  const judge = (world, key) => worseThan(base[key], fingerprints(reading(T0 + 90 * MINUTE, world))[key]);
  // A magnitude inside a stable reason.
  assert.equal(judge({ blocked: 5 }, 'system:hermes'), 'count');
  assert.equal(judge({ missingOverdue: 8 }, 'system:gbrain'), 'count');
  assert.equal(judge({ stalePages: 4 }, 'system:gbrain'), 'count');
  assert.equal(judge({ stalled: 2 }, 'system:gbrain'), 'count');
  const finding = Object.keys(base).find((key) => key.startsWith('finding:alpha:BINDING_DEAD:'));
  assert.equal(judge({ findingCount: 4 }, finding), 'count');
  // Falling is never worse.
  for (const world of [{ blocked: 1 }, { missingOverdue: 1 }, { stalePages: 1 }, { findingCount: 1 }]) {
    for (const key of Object.keys(base)) assert.equal(judge(world, key), null, `${JSON.stringify(world)} ${key}`);
  }
  // A reason that goes away is never worse; one that appears is.
  assert.equal(judge({ blocked: 0 }, 'system:hermes'), null);
  const noBlocked = fingerprints(reading(T0, { blocked: 0 }));
  assert.equal(worseThan(noBlocked['system:hermes'], base['system:hermes']), 'reason');
  // Legacy caveats: their number is the count.
  const legacy = fingerprints(reading(T0, { legacy: true }));
  assert.equal(worseThan(legacy['system:gbrain'], fingerprints(reading(T0 + MINUTE, { legacy: true, extraCaveat: true }))['system:gbrain']), 'count');
  assert.equal(worseThan(legacy['system:gbrain'], fingerprints(reading(T0 + MINUTE, { legacy: true, staleSources: 3 }))['system:gbrain']), 'count');
  // Rank.
  assert.equal(worseThan(fingerprintOf(2, { a: 1 }), fingerprintOf(3, { a: 1 })), 'rank');
  assert.equal(worseThan(fingerprintOf(3, { a: 1 }), fingerprintOf(2, { a: 1 })), null);
});

test('reason ids are stored hashed and never carry text; many reasons stay bounded and still count', () => {
  const fp = fingerprints(reading(T0))['system:gbrain'];
  assert.ok(fp.reasonIds.every((id) => /^[0-9a-f]{12}$/.test(id)));
  assert.deepEqual(Object.keys(fp.counts).sort(), fp.reasonIds);
  assert.doesNotMatch(JSON.stringify(fingerprints(reading(T0))), /minutes|waiting|codex|alpha-secret/);
  const many = (n) => fingerprintOf(2, Object.fromEntries(Array.from({ length: n }, (_, i) => [`reason:${i}`, 1])));
  assert.equal(many(400).reasonIds.length, 128);
  assert.ok(worseThan(many(400), many(401)), 'one more reason beyond the limit is still worse');
});
