'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageService } = require('../server/sources/usage');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const observation = (days = [], coverage = 'complete') => ({
    days, coverage, observedAt: new Date(NOW).toISOString(), note: 'fixture'
});
const row = (date, tokens = 10, cost = null) => ({
    date, model: 'grok-any', inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: cost
});
function make(providers, options = {}) { return createUsageService({ providers, now: () => NOW, ...options }); }
const p = (id, read) => ({ id, label: id, read });
test('availability is bounded newest first with sources from every registered provider', async () => { const u = make([p('hermes', async () => observation([row('2026-07-02')])), p('codex', async () => observation([row('2026-08-01')]))]); await u.refresh(); const x = u.months(); assert.equal(x.months.length, 25); assert.equal(x.currentMonth, '2026-08'); assert.deepEqual(x.months[1], { month: '2026-07', hasData: true, sources: ['hermes'] }); });
test('failure is unknown/selectable; not empty and not not_configured', async () => { const u = make([p('hermes', async () => { throw Error('missing'); })]); await u.refresh(); const x = u.months(); assert.equal(x.partial, true); assert.equal(x.sourceStatus.hermes, 'unavailable'); assert.equal(x.months[1].unknown, true); });
test('zero sessions do not count as usage but cost-only sessions do', async () => { const u = make([p('hermes', async () => observation([row('2026-07-01', 0, 0), row('2026-06-01', 0, 5)]))]); await u.refresh(); assert.equal(u.months().months[1].hasData, false); assert.equal(u.months().months[2].hasData, true); });
test('partial provider coverage cannot confirm empty historical months', async () => { const u = make([p('codex', async () => observation([], 'partial'))]); await u.refresh(); assert.equal(u.months().months[1].unknown, true); assert.equal(u.months().partial, true); });
test('confirmed empty evidence expires when source ages, and the current month is always selectable', async () => { let now = NOW; const u = make([p('test', async () => observation())], { now: () => now }); await u.refresh(); assert.equal(u.months().months[1].unknown, undefined); assert.equal(u.months().months[0].unknown, true); now += 24 * 3600 * 1000 + 1; assert.equal(u.months().months[1].unknown, true); });
test('server-month rollover during a refresh cannot label the new month confirmed empty', async () => { let now = Date.parse('2026-08-31T23:59:00'); let release; const u = make([p('test', () => new Promise(resolve => { release = resolve; }))], { now: () => now }); const pending = u.refresh(); await new Promise(setImmediate); now = Date.parse('2026-09-01T00:01:00'); release({ ...observation(), observedAt: new Date(now).toISOString() }); await pending; assert.equal(u.months().currentMonth, '2026-09'); assert.equal(u.months().months[0].unknown, true); });
test('coverage before the scan floor is never confirmed empty', async () => { const u = make([p('test', async () => observation())]); await u.refresh(); const snap = u.registry.snapshots()[0]; snap.data.since = '2026-07-15'; assert.equal(u.months().months[1].unknown, true); });
test('no provider paths or fingerprints reach client payloads', async () => { const u = make([{ ...p('test', async () => observation()), identity: '/private/path/to/profile' }]); await u.refresh(); for (const x of [u.months(), u.costs(), u.summary(), u.codexbar()])
    assert.equal(JSON.stringify(x).includes('/private/path'), false); });
test('concurrent refreshes deduplicate provider reads independently of month navigation', async () => { let calls = 0; let release; const u = make([p('test', () => { calls++; return new Promise(r => { release = r; }); })]); const a = u.refresh(), b = u.refresh(); await new Promise(setImmediate); assert.equal(calls, 1); for (let i = 0; i < 24; i++)
    u.costs('month', `2025-${String(i % 12 + 1).padStart(2, '0')}`); assert.equal(calls, 1); release(observation()); await Promise.all([a, b]); });
