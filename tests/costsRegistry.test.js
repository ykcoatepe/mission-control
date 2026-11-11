'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageRegistry } = require('../server/sources/usage/registry');
const { createUsageService } = require('../server/sources/usage');
const { withLiveLoop } = require('./helpers/liveLoop');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const day = (model = 'gpt-5.6-sol', tokens = 100, billedUsd = null, date = '2026-08-15') => ({
    date, model, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd
});
const result = (days = [day()], coverage = 'complete') => ({
    days, observedAt: new Date(NOW).toISOString(), coverage, note: 'fixture'
});
const provider = (id, read = async () => result()) => ({ id, label: id, read });
function memoryFs() {
    const files = new Map();
    const writes = [];
    return {
        files, writes, async mkdir() { }, async readFile(p) { if (!files.has(p))
            throw Error('absent'); return files.get(p); }, async writeFile(p, v) { writes.push(p); files.set(p, v); }, async rename(a, b) { files.set(b, files.get(a)); files.delete(a); }, async unlink(p) { files.delete(p); }
    };
}
function service(providers, options = {}) { return createUsageService({
    providers, now: () => NOW, fs: memoryFs(), dataDir: '/data', ...options
}); }
test('one fake provider registration participates without platform-specific aggregation code', async () => {
    const usage = service([]);
    usage.registry.register(provider('future'));
    await usage.registry.sources()[0].refresh();
    assert.equal(usage.costs('month').providers[0].id, 'future');
    assert.equal(usage.costs('month').summary.periodTokens, 100);
});
test('unread provider has null numbers and partial totals, never fabricated zero', () => {
    const usage = service([provider('offline')]);
    const data = usage.costs('month');
    assert.equal(data.providers[0].state, 'unavailable');
    assert.equal(data.providers[0].tokens, null);
    assert.equal(data.providers[0].apiEquivalentUsd, null);
    assert.equal(data.summary.periodTokens, null);
    assert.equal(data.partial, true);
    assert.equal(data.meta.refreshing, true);
});
test('failed read preserves last good tokens AND cost-only rows with stale evidence', async () => {
    let fail = false;
    const usage = service([provider('hermes', async () => { if (fail)
            throw Error('private child text'); return result([day('grok-test', 0, 5)]); })]);
    await usage.refresh();
    fail = true;
    await usage.refresh();
    const data = usage.costs('month');
    assert.equal(data.providers[0].state, 'stale');
    assert.equal(data.providers[0].billedUsd, 5);
    assert.equal(data.summary.periodUsd, 5);
    assert.equal(data.partial, true);
    assert.equal(JSON.stringify(data).includes('private child text'), false);
});
test('unknown billing stays null while observed zero is preserved', async () => {
    const usage = service([provider('known', async () => result([day('local/qwen', 10, 0)])), provider('unknown')]);
    await usage.refresh();
    const data = usage.costs('month');
    assert.equal(data.providers[0].billedUsd, 0);
    assert.equal(data.providers[1].billedUsd, null);
    assert.equal(data.billedUsd, null);
    assert.equal(data.summary.periodTokens, 110);
});
test('source timeout isolates a hung producer; fast provider finishes independently', async () => {
    const registry = createUsageRegistry({ providers: [provider('slow', () => new Promise(() => { })), provider('fast')], timeoutMs: 15, now: () => NOW });
    // The hung producer has no handle; only the source's unref'd timeout settles it.
    await withLiveLoop(async () => {
        const pending = registry.sources()[0].refresh();
        await registry.sources()[1].refresh();
        assert.equal(registry.snapshots()[1].data.days[0].inputTokens, 100);
        await pending;
    });
    assert.equal(registry.snapshots()[0].meta.error.code, 'timeout');
});
test('malformed observations cannot poison last-good or invent empty usage', async () => {
    let value = result();
    const usage = service([provider('test', async () => value)]);
    await usage.refresh();
    for (const bad of [{}, { days: [] }, result([{ ...day(), inputTokens: -1 }]), result([{ ...day(), outputTokens: null }]), result([{ ...day(), date: '2026-02-30' }])]) {
        value = bad;
        await usage.refresh();
        assert.equal(usage.costs('month').summary.periodTokens, 100);
        assert.equal(usage.costs('month').partial, true);
    }
});
test('cache writes occur during refresh atomically under app data; GET projections write nothing', async () => {
    const fs = memoryFs();
    const usage = service([provider('test')], { fs });
    usage.costs('month');
    usage.months();
    usage.codexbar();
    usage.summary();
    assert.equal(fs.writes.length, 0);
    await usage.refresh();
    assert.ok(fs.files.has('/data/usage/test.json'));
    assert.ok(fs.writes.every(p => p.startsWith('/data/usage/') && p.includes('.tmp-')));
    const count = fs.writes.length;
    usage.costs('month');
    usage.months();
    usage.codexbar();
    usage.summary();
    assert.equal(fs.writes.length, count);
});
test('past month never falls back to live session totals and cold partial keeps polling', async () => {
    const usage = service([provider('test')]);
    await usage.refresh();
    const data = usage.costs('month', '2026-03');
    assert.equal(data.summary.periodTokens, 0);
    assert.equal(data.period.anchor, '2026-03');
    const cold = service([provider('test')]).costs('month', '2026-03');
    assert.equal(cold.summary.periodTokens, null);
    assert.equal(cold.meta.stale, true);
});
test('summary is bounded, derives today/week/month, and reports billing budget only when known', async () => {
    const usage = service([provider('test', async () => result([day('gpt-5.6-sol', 100, 5), day('gpt-5.6-sol', 20, 2, '2026-08-10'), day('gpt-5.6-sol', 30, 3, '2026-08-01')]))], { budget: { monthly: 20 } });
    await usage.refresh();
    const snap = usage.summary();
    assert.equal(snap.data.today.tokens, 100);
    assert.equal(snap.data.week.tokens, 120);
    assert.equal(snap.data.month.tokens, 150);
    assert.deepEqual(snap.data.budget, { monthly: 20, usedPct: 50 });
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) < 1500);
});
test('months confirm empty only with fresh complete coverage; current and uncovered months remain selectable', async () => {
    const usage = service([provider('test', async () => result([]))]);
    await usage.refresh();
    const data = usage.months();
    assert.equal(data.months.length, 25);
    assert.equal(data.months[0].unknown, true);
    assert.equal(data.months[1].hasData, false);
    assert.equal(data.months[1].unknown, undefined);
});
module.exports = {
    NOW, day, result, provider, memoryFs, service
};
test('registered sources join scheduler immediately, including a future provider', () => {
    const targets = [];
    const usage = service([], { scheduler: { register(source, options) { targets.push({ source, options }); } } });
    usage.registry.register(provider('future'));
    assert.equal(targets[0].source.id, 'usage.future');
    assert.equal(targets[0].options.intervalMs, 60000);
});
test('disk cache reload is stale, bounded in age, and bound to producer identity', async () => {
    const fs = memoryFs();
    let stamp = NOW;
    const good = { ...provider('test'), identity: '/producer/A' };
    const first = service([good], { fs, now: () => stamp });
    await first.refresh();
    const failed = identity => ({ ...provider('test', async () => { throw Error('down'); }), identity });
    const restored = service([failed('/producer/A')], { fs, now: () => stamp });
    await restored.refresh();
    assert.equal(restored.costs().summary.periodTokens, 100);
    assert.equal(restored.costs().providers[0].state, 'stale');
    const wrong = service([failed('/producer/B')], { fs, now: () => stamp });
    await wrong.refresh();
    assert.equal(wrong.costs().summary.periodTokens, null);
    stamp += 86400001;
    const expired = service([failed('/producer/A')], { fs, now: () => stamp });
    await expired.refresh();
    assert.equal(expired.costs().summary.periodTokens, null);
});
test('failed atomic persistence never corrupts a last-good cache and GET never retries a write', async () => {
    const fs = memoryFs();
    const u = service([provider('test')], { fs });
    await u.refresh();
    const original = fs.files.get('/data/usage/test.json');
    fs.rename = async () => { throw Error('disk full'); };
    await u.refresh();
    assert.equal(fs.files.get('/data/usage/test.json'), original);
    assert.equal([...fs.files.keys()].some(p => p.includes('.tmp-')), false);
    const writes = fs.writes.length;
    u.costs();
    assert.equal(fs.writes.length, writes);
});
test('late producer result after timeout cannot persist or replace memory', async () => {
    const fs = memoryFs();
    let finish;
    const registry = createUsageRegistry({
        providers: [provider('slow', () => new Promise(r => { finish = r; }))], fs, dataDir: '/data', timeoutMs: 5, now: () => NOW
    });
    await withLiveLoop(async () => {
        await registry.sources()[0].refresh();
        finish(result());
        await new Promise(setImmediate);
    });
    assert.equal(registry.snapshots()[0].data, null);
    assert.equal(fs.writes.length, 0);
});
test('budget changes and rate-review metadata are read from memory on the next GET', async () => {
    let budget = { monthly: 20 };
    const u = service([provider('test', async () => result([day('gpt-5.6-sol', 100, 5)]))], { budget: () => budget });
    await u.refresh();
    assert.equal(u.summary().data.budget.usedPct, 25);
    budget = { monthly: 10 };
    assert.equal(u.summary().data.budget.usedPct, 50);
    assert.equal(u.costs().budget.monthly, 10);
    assert.equal(u.summary().meta.rateCardLastReviewed, '2026-09-13');
});
test('midnight cannot turn an unobserved new day into zero tokens or zero billed spend', async () => {
    let clock = Date.parse('2026-08-15T23:59:59');
    const u = service([provider('test')], { now: () => clock });
    await u.refresh();
    clock = Date.parse('2026-08-16T00:00:01');
    assert.equal(u.summary().data.today.tokens, null);
    assert.equal(u.summary().data.today.billedUsd, null);
    assert.equal(u.costs('day').providers[0].state, 'unavailable');
    assert.equal(u.costs('day').providers[0].tokens, null);
    assert.equal(u.summary().data.partial, true);
});
