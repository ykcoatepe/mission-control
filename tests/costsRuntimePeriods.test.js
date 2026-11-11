'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageService } = require('../server/sources/usage');
const NOW = Date.parse('2026-08-15T12:00:00Z'), row = (date, n) => ({
    date, model: 'gpt-5.6-sol', inputTokens: n, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, billedUsd: null
});
const observation = days => ({
    days, observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'fixture'
});
function service(read) { return createUsageService({ now: () => NOW, providers: [{ id: 'test', label: 'Test', read }] }); }
test('active period projections isolate anchored months from the live month', async () => { const u = service(async () => observation([row('2026-07-10', 10), row('2026-08-10', 20)])); await u.refresh(); assert.equal(u.costs('month', '2026-07').summary.periodTokens, 19); assert.equal(u.costs().summary.periodTokens, 29); assert.equal(u.costs('month', '2026-07').summary.periodTokens, 19); });
test('scheduled history covers the oldest accepted anchor and its previous month', async () => { let bounds; const u = service(async (value) => { bounds = value; return observation([]); }); await u.refresh(); assert.ok(bounds.since <= '2024-07-01'); assert.equal(bounds.until, '2026-08-15'); });
test('month navigation cannot launch per-month scans or queue behind a refresh', async () => { let reads = 0; const u = service(async () => { reads++; return observation([row('2026-08-10', 20)]); }); await u.refresh(); for (let i = 1; i <= 12; i++)
    u.costs('month', `2025-${String(i).padStart(2, '0')}`); assert.equal(reads, 1); assert.equal(u.costs().summary.periodTokens, 29); });
test('concurrent scheduled refreshes share one producer operation', async () => { let finish, reads = 0; const u = service(() => { reads++; return new Promise(r => { finish = r; }); }); const a = u.refresh(), b = u.refresh(); await new Promise(setImmediate); assert.equal(reads, 1); finish(observation([])); await Promise.all([a, b]); });
test('failed refresh releases its slot and the next observation can recover', async () => { let fail = true; const u = service(async () => { if (fail)
    throw Error('down'); return observation([row('2026-08-10', 20)]); }); await u.refresh(); assert.equal(u.costs().summary.periodTokens, null); fail = false; await u.refresh(); assert.equal(u.costs().summary.periodTokens, 29); assert.equal(u.costs().meta.ok, true); });
test('warming historical data cannot acquire a fabricated zero or suppress recovery', async () => { let fail = true; const u = service(async () => { if (fail)
    throw Error('down'); return observation([row('2026-07-10', 10)]); }); await u.refresh(); const cold = u.costs('month', '2026-07'); assert.equal(cold.summary.periodTokens, null); assert.equal(cold.meta.state, 'warming'); fail = false; await u.refresh(); assert.equal(u.costs('month', '2026-07').summary.periodTokens, 19); });
test('failed reads preserve model token classes and API equivalents from last good data', async () => { let fail = false; const u = service(async () => { if (fail)
    throw Error('down'); return observation([row('2026-08-10', 20)]); }); await u.refresh(); const before = u.costs().dailyByModel.find(r => r.date === '2026-08-10'); fail = true; await u.refresh(); const after = u.costs().dailyByModel.find(r => r.date === '2026-08-10'); for (const suffix of ['_tokens', '_input', '_output', '_cacheRead', '_cacheWrite', '_apiEquivalentUsd'])
    assert.equal(after['Test / gpt-5.6-sol' + suffix], before['Test / gpt-5.6-sol' + suffix]); assert.equal(u.costs().meta.stale, true); });
test('previous API equivalents retain known figures while marking missing producers partial', async () => { const u = createUsageService({ now: () => NOW, providers: [{ id: 'known', label: 'Known', read: async () => observation([row('2026-07-10', 1000000)]) }, { id: 'missing', label: 'Missing', read: async () => { throw Error('down'); } }] }); await u.refresh(); assert.ok(u.costs().summary.previousPeriodApiEquivalentUsd > 0); assert.equal(u.costs().summary.previousPeriodApiEquivalentReliability, 'partial'); });
test('a wholly unread previous period remains unknown instead of a zero baseline', async () => { const u = service(async () => { throw Error('down'); }); await u.refresh(); assert.equal(u.costs().summary.previousPeriodApiEquivalentUsd, null); assert.equal(u.costs().summary.previousPeriodApiEquivalentReliability, 'unavailable'); });
test('a navigation burst reads the newest selection synchronously while producer work is pending', async () => { let finish, pending = false; const u = service(() => pending ? new Promise(r => { finish = r; }) : Promise.resolve(observation([row('2026-07-10', 10), row('2026-08-10', 20)]))); await u.refresh(); pending = true; const refresh = u.refresh(); await new Promise(setImmediate); for (let i = 1; i <= 12; i++)
    assert.equal(typeof u.costs('month', `2025-${String(i).padStart(2, '0')}`), 'object'); assert.equal(u.costs().summary.periodTokens, 29); finish(observation([row('2026-08-10', 30)])); await refresh; assert.equal(u.costs().summary.periodTokens, 39); });
