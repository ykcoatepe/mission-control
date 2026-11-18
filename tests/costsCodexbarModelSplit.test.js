'use strict';
// CodexBar fallback: per-model rows, exact class totals, a typed local-failure
// reason, and rate cards that price the current model ids.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexProvider, fromCodexbar } = require('../server/sources/usage/providers/codex');
const { createUsageService } = require('../server/sources/usage');
const { validateObservation } = require('../server/sources/usage/providers/contract');
const { API_RATE_CARDS } = require('../server/services/costSanity');
const NOW = Date.parse('2026-11-18T12:00:00Z');
const bounds = { since: '2026-11-01', until: '2026-11-18' };
const CLASSES = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const day = (extra = {}) => ({ date: '2026-11-18', inputTokens: 1000, outputTokens: 101, cacheReadTokens: 700, cacheCreationTokens: 7, ...extra });
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

test('multi-model day keeps one row per model and every class sums exactly to the day', () => {
    const d = day({ modelBreakdowns: [{ modelName: 'gpt-6.2-astra', totalTokens: 3 }, { modelName: 'gpt-6.2-sol', totalTokens: 2 }, { modelName: 'gpt-6-luna', totalTokens: 2 }] });
    const out = fromCodexbar({ provider: 'codex', daily: [d] }, bounds, () => NOW);
    assert.deepEqual(out.days.map(r => r.model), ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-luna']);
    assert.equal(out.days.some(r => r.model === 'unknown'), false);
    const expected = { inputTokens: 300, outputTokens: 101, cacheReadTokens: 700, cacheWriteTokens: 7 };
    for (const k of CLASSES) assert.equal(sum(out.days, k), expected[k], k);
    for (const r of out.days) for (const k of CLASSES) assert.ok(Number.isSafeInteger(r[k]) && r[k] >= 0);
    // Larger share gets the larger slice.
    assert.ok(out.days[0].cacheReadTokens > out.days[1].cacheReadTokens);
    assert.deepEqual(out.coverageReasons, ['fallback_source']);
    assert.equal(out.coverage, 'partial');
    // The contract accepts the new reason and keeps it.
    assert.deepEqual(validateObservation(out, bounds).coverageReasons, ['fallback_source']);
});

test('same model listed twice is merged, zero-token models are dropped', () => {
    const d = day({ modelBreakdowns: [{ modelName: 'gpt-6.1-sol', totalTokens: 5 }, { modelName: 'gpt-6.1-sol', totalTokens: 5 }, { modelName: 'gpt-6-astra', totalTokens: 10 }, { modelName: 'gpt-6-luna', totalTokens: 0 }] });
    const out = fromCodexbar({ provider: 'codex', daily: [d] }, bounds, () => NOW);
    assert.deepEqual(out.days.map(r => r.model), ['gpt-6.1-sol', 'gpt-6-astra']);
    assert.equal(out.days[0].cacheReadTokens, 350);
});

test('single-model day keeps its model even without a total (previous behaviour)', () => {
    const out = fromCodexbar({ provider: 'codex', daily: [day({ modelBreakdowns: [{ modelName: 'gpt-6.2-sol' }] })] }, bounds, () => NOW);
    assert.equal(out.days.length, 1);
    assert.equal(out.days[0].model, 'gpt-6.2-sol');
    assert.equal(out.days[0].inputTokens, 300);
});

for (const [label, breakdowns] of [
    ['missing breakdowns', undefined],
    ['empty breakdowns', []],
    ['a breakdown without a total', [{ modelName: 'a', totalTokens: 1 }, { modelName: 'b' }]],
    ['a negative total', [{ modelName: 'a', totalTokens: 1 }, { modelName: 'b', totalTokens: -1 }]],
    ['a nameless breakdown', [{ modelName: 'a', totalTokens: 1 }, { totalTokens: 1 }]],
    ['all-zero totals', [{ modelName: 'a', totalTokens: 0 }, { modelName: 'b', totalTokens: 0 }]],
]) test(`no model split is invented from ${label}: the day stays one unknown row`, () => {
    const out = fromCodexbar({ provider: 'codex', daily: [day({ modelBreakdowns: breakdowns })] }, bounds, () => NOW);
    assert.equal(out.days.length, 1);
    assert.equal(out.days[0].model, 'unknown');
    assert.equal(out.days[0].cacheReadTokens, 700);
});

test('non-integer or negative day totals are rejected', () => {
    for (const bad of [{ inputTokens: 1.5 }, { outputTokens: -1 }, { cacheReadTokens: NaN }])
        assert.throws(() => fromCodexbar({ provider: 'codex', daily: [day(bad)] }, bounds, () => NOW), e => e.code === 'invalid_usage');
});

function provider({ local, logs }) {
    const report = { provider: 'codex', daily: [day({ modelBreakdowns: [{ modelName: 'gpt-6.2-astra', totalTokens: 1 }, { modelName: 'gpt-6.2-sol', totalTokens: 1 }] })] };
    const localObservation = { days: [{ date: '2026-11-18', model: 'openai/gpt-6.2-sol', inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, billedUsd: null }], observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'local' };
    return createCodexProvider({
        home: '/fake', projectRoot: '/repo', env: {}, now: () => NOW,
        logger: { warn: m => logs.push(m) },
        exec: { async run(bin) {
            if (bin === 'codexbar') return { ok: true, stdout: JSON.stringify(report) };
            return local() ? { ok: true, stdout: JSON.stringify(localObservation) } : { ok: false, timedOut: true, stderr: 'PRIVATE /Users/x/.codex' };
        } }
    });
}

test('a failed local scan is recorded by class, logged without child output, and cleared on recovery', async () => {
    const logs = []; let localOk = false;
    const p = provider({ local: () => localOk, logs });
    await p.read(bounds);
    assert.equal(p.scanStatus().usageSource, 'codexbar');
    assert.equal(p.scanStatus().localErrorClass, 'timeout');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /local log scan failed \(timeout\)/);
    assert.equal(logs.join('').includes('PRIVATE'), false);
    localOk = true;
    await p.read(bounds);
    assert.equal(p.scanStatus().usageSource, 'local_logs');
    assert.equal(p.scanStatus().localErrorClass, null);
});

test('restoreScanStatus accepts older saves without localErrorClass and rejects unknown classes', () => {
    const p = provider({ local: () => true, logs: [] });
    const base = { state: 'succeeded', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: 'codexbar' };
    p.restoreScanStatus(base);
    assert.equal(p.scanStatus().usageSource, 'codexbar');
    assert.equal(p.scanStatus().localErrorClass, null);
    p.restoreScanStatus({ ...base, usageSource: 'local_logs', localErrorClass: 'stderr text' });
    assert.equal(p.scanStatus().usageSource, 'codexbar');
});

test('costs() reports fallback_source for a provider served from the backup source', async () => {
    const u = createUsageService({ providers: [provider({ local: () => false, logs: [] })], now: () => NOW });
    await u.refresh();
    const row = u.costs().providers.find(p => p.id === 'codex');
    assert.equal(row.coverageReason, 'fallback_source');
    assert.equal(row.coverage, 'partial');
});

test('current model ids hit their own rate card, specific before generic', () => {
    const match = name => API_RATE_CARDS.find(r => name.toLowerCase().includes(r.match))?.match ?? null;
    const cases = {
        'openai/gpt-6.2-astra': 'gpt-6.2-astra', 'gpt-6.2-sol': 'gpt-6.2-sol', 'openai/gpt-6.1-sol': 'gpt-6.1-sol', 'openai/gpt-6.1-terra': 'gpt-6.1-terra',
        'openai/gpt-6-astra': 'gpt-6-astra', 'openai/gpt-6-sol': 'gpt-6-sol', 'gpt-6-luna': 'gpt-6-luna',
        'claude-opus-5-5': 'claude-opus-5-5', 'claude-subscription-directsdk-experimental/claude-opus-5-5[1m]': 'claude-opus-5-5',
        'claude-sonnet-5-5': 'claude-sonnet-5-5', 'claude-haiku-5-5': 'claude-haiku-5-5',
        'claude-fable-5-2': 'claude-fable-5-2', 'claude-fable-5-1': 'claude-fable-5-1', 'claude-mythos-5-2': 'claude-mythos-5-2',
        // Older ids still reach their original cards.
        'claude-sonnet-5': 'claude-sonnet-5', 'claude-fable-5': 'claude-fable-5', 'gpt-5.6-sol': 'gpt-5.6-sol',
    };
    for (const [name, want] of Object.entries(cases)) assert.equal(match(name), want, name);
    const card = m => API_RATE_CARDS.find(r => r.match === m);
    assert.deepEqual([card('gpt-6.2-astra').input, card('gpt-6.2-astra').cachedInput, card('gpt-6.2-astra').output], [8, 0.4, 40]);
    assert.deepEqual([card('claude-opus-5-5').input, card('claude-opus-5-5').cachedInput, card('claude-opus-5-5').output], [4, 0.2, 20]);
});

// --- Review round 1 (Sol 6.2): exact allocation, legacy snapshots, version-safe lookup, tiered cards.

test('allocation is exact per model, ties go to the earlier model, and huge counts stay exact', () => {
    const at = (inputTokens, weights) => fromCodexbar({ provider: 'codex', daily: [day({ inputTokens, cacheReadTokens: 0, outputTokens: 0, cacheCreationTokens: 0, modelBreakdowns: weights.map((w, i) => ({ modelName: `m${i}`, totalTokens: w })) })] }, bounds, () => NOW).days.map(r => r.inputTokens);
    assert.deepEqual(at(10, [1, 1, 1]), [4, 3, 3]);
    assert.deepEqual(at(7, [3, 2, 2]), [3, 2, 2]);
    assert.deepEqual(at(1, [1, 1]), [1, 0]);
    const big = Number.MAX_SAFE_INTEGER - 1;
    const rows = at(big, [9, 22]);
    assert.equal(rows[0] + rows[1], big);
    const B = BigInt(big), q = [B * 9n / 31n, B * 22n / 31n], r = [B * 9n % 31n, B * 22n % 31n];
    const want = r[0] >= r[1] ? [q[0] + 1n, q[1]] : [q[0], q[1] + 1n];
    assert.equal(q[0] + q[1] + 1n, B);
    assert.deepEqual(rows, want.map(Number));
});

test('weights that are not safe integers keep the day as one unknown row instead of rejecting the report', () => {
    for (const weights of [[1e308, 1e308], [1.5, 2], [Number.MAX_SAFE_INTEGER, 2]]) {
        const out = fromCodexbar({ provider: 'codex', daily: [day({ modelBreakdowns: weights.map((w, i) => ({ modelName: `m${i}`, totalTokens: w })) })] }, bounds, () => NOW);
        assert.equal(out.days.length, 1, String(weights));
        assert.equal(out.days[0].model, 'unknown');
    }
});

test('a saved CodexBar snapshot from before the reason existed still reports fallback_source', async () => {
    const files = new Map();
    const fs = { async readFile(f) { if (!files.has(f)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(f); }, async writeFile(f, b) { files.set(f, b); }, async mkdir() {}, async rename(a, b) { files.set(b, files.get(a)); files.delete(a); }, async rm() {}, async unlink(f) { files.delete(f); } };
    const legacy = { days: [{ date: '2026-11-18', model: 'unknown', inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, billedUsd: null }], observedAt: new Date(NOW).toISOString(), coverage: 'partial', note: 'CodexBar fallback; model breakdown and historical coverage may be incomplete; billing unknown', since: '2024-10-01', until: '2026-11-18' };
    const p = createCodexProvider({ home: '/fake', projectRoot: '/repo', env: {}, now: () => NOW, exec: { async run() { return { ok: false, timedOut: true }; } } });
    files.set('/cache/usage/codex.json', JSON.stringify({ version: 1, identity: p.identity, data: legacy, diagnostics: { state: 'succeeded', lastAttemptAt: legacy.observedAt, lastSuccessAt: legacy.observedAt, errorClass: null, usageSource: 'codexbar' } }));
    const u = createUsageService({ providers: [p], now: () => NOW, fs, dataDir: '/cache' });
    await u.refresh();
    const row = u.costs().providers.find(x => x.id === 'codex');
    assert.ok(row, 'restored codex row');
    assert.ok(['fallback_source', 'scan_failed'].includes(row.coverageReason), row.coverageReason);
    assert.notEqual(row.coverageReason, 'standing_gaps');
});

test('rate lookup: dotted Claude ids hit their card and longer versions do not match shorter cards', () => {
    const { lookupApiRateCard } = require('../server/services/costSanity');
    const m = n => lookupApiRateCard(n)?.match ?? null;
    assert.equal(m('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5');
    assert.equal(m('claude-opus-5.5'), 'claude-opus-5-5');
    assert.equal(m('claude-mythos-5-10'), 'claude-mythos-5');
    assert.equal(m('claude-fable-5-12'), 'claude-fable-5');
    assert.equal(m('gpt-6.20-sol'), null);
    assert.equal(m('openai/gpt-6.2-sol'), 'gpt-6.2-sol');
    assert.equal(m('claude-opus-5-5[1m]'), 'claude-opus-5-5');
    assert.equal(m('claude-opus-4-6-20250929'), 'claude-opus-4-6');
});

test('a tiered card (Haiku 5.5) is priced at its base tier but marked partial', () => {
    const { estimateApiEquivalentCost } = require('../server/services/costSanity');
    const haiku = estimateApiEquivalentCost({ name: 'claude-haiku-5-5', input: 200000, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 200000 });
    assert.equal(haiku.status, 'partial');
    assert.equal(haiku.source, 'official_rate_card');
    const sonnet = estimateApiEquivalentCost({ name: 'claude-sonnet-5-5', input: 200000, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 200000 });
    assert.equal(sonnet.status, 'estimated');
    assert.equal(sonnet.usd, 0.4);
});

// --- Review round 2 (Sol 6.2): restore-time legacy reason, family cards, codexbar endpoint pricing.

test('a family card standing in for an unlisted version is partial; a date suffix is not a version', () => {
    const { estimateApiEquivalentCost } = require('../server/services/costSanity');
    const est = n => estimateApiEquivalentCost({ name: n, input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 1000 });
    assert.equal(est('claude-mythos-5-10').status, 'partial');
    assert.equal(est('claude-fable-5-3').status, 'partial');
    assert.equal(est('claude-mythos-5-2').status, 'estimated');
    assert.equal(est('claude-opus-4-6-20250929').status, 'estimated');
    assert.equal(est('openai/gpt-6.2-sol').status, 'estimated');
});

test('the codexbar endpoint reports partial pricing for a tiered or family-priced row', async () => {
    const obs = model => ({ days: [{ date: '2026-11-18', model, inputTokens: 200000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null }], observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'local' });
    const mk = model => ({ id: 'codex', label: 'Codex', identity: 'codex', intervalMs: 60000, async read() { return validateObservation(obs(model), bounds); }, scanStatus: () => ({ state: 'succeeded', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: 'local_logs' }) });
    const priced = createUsageService({ providers: [mk('openai/gpt-6.2-sol')], now: () => NOW });
    await priced.refresh();
    const tiered = createUsageService({ providers: [mk('claude-haiku-5-5')], now: () => NOW });
    await tiered.refresh();
    assert.equal(tiered.codexbar().partial, true);
    assert.equal(priced.codexbar().partial, priced.costs().partial);
});

test('the reason follows the saved rows, not the provider\'s live scan status', async () => {
    const memFs = () => { const files = new Map(); return { files, async readFile(f) { if (!files.has(f)) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return files.get(f); }, async writeFile(f, b) { files.set(f, b); }, async mkdir() {}, async rename(a, b) { files.set(b, files.get(a)); files.delete(a); }, async rm() {}, async unlink(f) { files.delete(f); } }; };
    const rows = { days: [{ date: '2026-11-18', model: 'unknown', inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, billedUsd: null }], observedAt: new Date(NOW).toISOString(), since: '2024-10-01', until: '2026-11-18' };
    const run = async (savedSource, liveSource, coverage) => {
        const fs = memFs();
        const p = { id: 'codex', label: 'Codex', identity: 'codex', intervalMs: 60000, async read() { throw Object.assign(new Error('x'), { code: 'timeout' }); }, restoreScanStatus() {}, scanStatus: () => ({ state: 'succeeded', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: liveSource }) };
        fs.files.set('/cache/usage/codex.json', JSON.stringify({ version: 1, identity: 'codex', data: { ...rows, coverage, note: 'saved' }, diagnostics: { state: 'succeeded', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: savedSource } }));
        const u = createUsageService({ providers: [p], now: () => NOW, fs, dataDir: '/cache' });
        await u.refresh();
        return u.costs().providers.find(x => x.id === 'codex').coverageReason;
    };
    // Saved CodexBar rows stay fallback_source even when the live status now says local logs.
    assert.equal(await run('codexbar', 'local_logs', 'partial'), 'fallback_source');
    // Saved local rows are never relabelled by a live CodexBar status.
    assert.notEqual(await run('local_logs', 'codexbar', 'complete'), 'fallback_source');
});
