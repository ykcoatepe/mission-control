'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createUsageService } = require('../server/sources/usage');
const { readClaudeLogs } = require('../server/sources/usage/claude-log-reader');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const day = (date, n) => ({
    date, model: 'openai/gpt-5.6-sol', inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null
});
const observation = days => ({
    days, observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'fixture'
});
function usage(codex, hermes) { return createUsageService({ now: () => NOW, providers: [{ id: 'codex', label: 'Codex', read: async () => codex }, { id: 'hermes', label: 'Hermes', read: async () => hermes }] }); }
test('N1 midnight ownership resolves against the Hermes start day exactly once', async () => {
    const u = usage({ ...observation([day('2026-08-15', 100)]), ownership: [{ owner: 'hermes', ...day('2026-08-15', 50) }] }, observation([day('2026-08-14', 100)]));
    await u.refresh();
    for (let i = 0; i < 2; i++) {
        assert.equal(u.costs('month').summary.periodTokens, 150);
        assert.equal(u.costs('day').summary.periodTokens, 50);
        assert.equal(u.costs('month').partial, false);
    }
});
test('N1 stable session identity resolves a long session and prevents using another session', async () => {
    const id = 'a'.repeat(64), other = 'b'.repeat(64), owned = { owner: 'hermes', ...day('2026-08-15', 50), sessionId: id };
    const c = { ...observation([day('2026-08-15', 100)]), ownership: [owned] };
    const h = { ...observation([day('2026-08-01', 100)]), sessions: [{ ...day('2026-08-01', 100), sessionId: id }] };
    const u = usage(c, h);
    await u.refresh();
    assert.equal(u.costs().summary.periodTokens, 150);
    assert.equal(u.costs().partial, false);
    const mismatch = usage(c, { ...h, days: [day('2026-08-15', 100)], sessions: [{ ...day('2026-08-15', 100), sessionId: other }] });
    await mismatch.refresh();
    assert.equal(mismatch.costs().partial, true);
});
test('N1 old unresolved overlap taints only its containing window', async () => {
    const u = usage({ ...observation([day('2025-03-02', 50), day('2026-08-15', 10)]), ownership: [{ owner: 'hermes', ...day('2025-03-02', 50) }] }, observation([day('2026-08-15', 20)]));
    await u.refresh();
    for (const period of ['day', '7d', 'month']) {
        const x = u.costs(period);
        assert.equal(x.partial, false, period);
        assert.equal(x.meta.ok, true, period);
        assert.deepEqual(x.meta.unresolvedOverlaps, []);
    }
    const historical = u.costs('month', '2025-03');
    assert.equal(historical.partial, true);
    assert.equal(historical.meta.ok, false);
    assert.equal(historical.meta.unresolvedOverlaps[0].date, '2025-03-02');
    const s = u.summary();
    for (const p of ['today', 'week', 'month'])
        assert.equal(s.data[p].partial, false, p);
    assert.equal(s.meta.ok, true);
});
test('N1 owner count capacity cannot confirm the same tokens twice across midnight', async () => {
    const c = { ...observation([day('2026-08-14', 75), day('2026-08-15', 75)]), ownership: [{ owner: 'hermes', ...day('2026-08-14', 75) }, { owner: 'hermes', ...day('2026-08-15', 75) }] };
    const u = usage(c, observation([day('2026-08-14', 100)]));
    await u.refresh();
    assert.equal(u.costs().summary.periodTokens, 175);
    assert.equal(u.costs().partial, true);
});
async function cacheFixture(run) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-final-cache-')); const root = path.join(home, '.claude/projects'); fs.mkdirSync(root, { recursive: true }); const cacheDir = path.join(home, 'data/usage/incremental/claude'); fs.mkdirSync(cacheDir, { recursive: true }); const file = path.join(root, 'f.jsonl'); fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-08-15T10:00:00Z', message: { id: 'x', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 2 } } }) + '\n'); const read = options => readClaudeLogs({ since: '2026-08-01', until: '2026-08-15' }, {
    home, cacheDir, now: () => NOW, ...options
}); try {
    await run({ cacheDir, file, read });
}
finally {
    fs.rmSync(home, { recursive: true, force: true });
} }
test('N6 startup removes only stale owned scratch and unreferenced count caches', async () => cacheFixture(async ({ cacheDir, read }) => {
    const old = 'run-999999-0123456789abcdef.jsonl', recent = 'run-999998-0123456789abcdef.jsonl', orphan = 'c'.repeat(64) + '.jsonl', foreign = 'keep-me.txt';
    for (const name of [old, recent, orphan, foreign])
        fs.writeFileSync(path.join(cacheDir, name), 'unchanged');
    for (const name of [old, orphan, foreign])
        fs.utimesSync(path.join(cacheDir, name), new Date(NOW - 7200000), new Date(NOW - 7200000));
    fs.utimesSync(path.join(cacheDir, recent), new Date(NOW), new Date(NOW));
    await read();
    assert.equal(fs.existsSync(path.join(cacheDir, old)), false);
    assert.equal(fs.existsSync(path.join(cacheDir, orphan)), false);
    assert.equal(fs.existsSync(path.join(cacheDir, recent)), true);
    assert.equal(fs.existsSync(path.join(cacheDir, foreign)), true);
}));
test('N6 cache budget rejects growth without replacing the last good index', async () => cacheFixture(async ({ cacheDir, file, read }) => {
    await read();
    const index = fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8');
    const bytes = fs.readdirSync(cacheDir).reduce((sum, n) => sum + fs.statSync(path.join(cacheDir, n)).size, 0);
    fs.appendFileSync(file, Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: 'assistant', timestamp: '2026-08-15T10:00:00Z', message: { id: String(i), model: 'claude-fable-5', usage: { input_tokens: 100, output_tokens: 1 } } })).join('\n') + '\n');
    await assert.rejects(read({ maxCacheBytes: bytes + 1024 }), e => e.code === 'usage_cache_capacity');
    assert.equal(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'), index);
}));
test('Leftover Costs router loads without any compatibility module', () => {
    const Module = require('node:module'), original = Module._load, route = require.resolve('../server/routes/costs');
    delete require.cache[route];
    Module._load = function (request, ...args) { if (request.includes('compatibility'))
        throw Error('Compatibility dependency forbidden'); return original.call(this, request, ...args); };
    try {
        const { buildCostsRouter, parseMonthAnchor } = require(route);
        assert.equal(typeof buildCostsRouter, 'function');
        assert.deepEqual(parseMonthAnchor('2026-07', new Date(NOW)), { ok: true, anchor: '2026-07' });
    }
    finally {
        Module._load = original;
        delete require.cache[route];
    }
});
test('N6 preserves active scratch, symlinks and foreign files', async () => cacheFixture(async ({ cacheDir, read }) => {
    const active = `run-${process.pid}-abcdef0123456789.jsonl`, target = path.join(cacheDir, 'foreign-target.txt'), link = path.join(cacheDir, 'd'.repeat(64) + '.jsonl');
    fs.writeFileSync(path.join(cacheDir, active), 'active');
    fs.utimesSync(path.join(cacheDir, active), new Date(NOW - 7200000), new Date(NOW - 7200000));
    fs.writeFileSync(target, 'KEEP');
    fs.symlinkSync(target, link);
    await read();
    assert.equal(fs.existsSync(path.join(cacheDir, active)), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'KEEP');
}));
test('N6 budget failure cleans current scratch and permits a later retry', async () => cacheFixture(async ({ cacheDir, file, read }) => {
    await read();
    const before = fs.readdirSync(cacheDir).reduce((sum, n) => sum + fs.statSync(path.join(cacheDir, n)).size, 0), limit = before + 100;
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: '2026-08-15T10:00:00Z', message: { id: 'retry', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
    await assert.rejects(read({ maxCacheBytes: limit }), e => e.code === 'usage_cache_capacity');
    const bytes = fs.readdirSync(cacheDir).reduce((sum, n) => sum + fs.statSync(path.join(cacheDir, n)).size, 0);
    assert.ok(bytes <= limit);
    assert.equal((await read()).days[0].inputTokens, 11);
}));
test('N1 producer seam shares only hashed rollout identity across midnight', async () => cacheFixture(async ({ cacheDir, file, read }) => {
    const { createHermesProvider } = require('../server/sources/usage/providers/hermes'), { readCodexLogs } = require('../server/sources/usage/codex-log-reader');
    const root = path.join(path.dirname(path.dirname(path.dirname(file))), '.codex', 'sessions');
    fs.mkdirSync(root, { recursive: true });
    const write = (name, id, originator, n) => fs.writeFileSync(path.join(root, name), JSON.stringify({ type: 'session_meta', payload: {
            id, originator, model: 'gpt-5.6-sol', model_provider: 'openai'
        } }) + '\n' + JSON.stringify({ timestamp: '2026-08-15T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n, output_tokens: 0, total_tokens: n }, total_token_usage: { total_tokens: n } } } }) + '\n');
    write('owned.jsonl', 'rollout-shared', 'hermes', 50);
    write('native.jsonl', 'native', 'codex_cli', 50);
    const c = await readCodexLogs({ since: '2026-08-01', until: '2026-08-15' }, { codexHome: path.dirname(root), now: () => NOW, cacheDir: path.join(cacheDir, '..', 'codex') });
    const h = await createHermesProvider({
        home: '/fake', env: {}, now: () => NOW, exec: { run: async () => ({ ok: true, stdout: JSON.stringify([{
                        ...day('2026-08-14', 100), model: 'gpt-5.6-sol', provider: 'openai', rolloutId: 'rollout-shared', unknownTokenRows: 0
                    }]) }) }
    }).read({ since: '2026-08-01', until: '2026-08-15' });
    assert.equal(c.ownership[0].sessionId, h.sessions[0].sessionId);
    assert.equal(JSON.stringify(h).includes('rollout-shared'), false);
    const u = usage(c, h);
    await u.refresh();
    assert.equal(u.costs().summary.periodTokens, 150);
    assert.equal(u.costs().partial, false);
}));
test('N6 manifest writes are included in the cache byte budget', async () => cacheFixture(async ({ file, read }) => { fs.truncateSync(file, 0); await assert.rejects(read({ maxCacheBytes: 64 }), e => e.code === 'usage_cache_capacity'); }));
test('N6 malformed manifest entries are ignored during startup cleanup', async () => cacheFixture(async ({ cacheDir, read }) => { await read(); const file = path.join(cacheDir, 'index.json'), index = JSON.parse(fs.readFileSync(file, 'utf8')); index.files[Object.keys(index.files)[0]] = null; fs.writeFileSync(file, JSON.stringify(index)); assert.equal((await read()).days[0].inputTokens, 1); }));
test('N6 cleanup does not follow a cache-directory symlink outside data/usage', async () => cacheFixture(async ({ cacheDir }) => {
    const { createCacheBudget } = require('../server/sources/usage/cache-budget');
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-foreign-'));
    try {
        const name = 'run-999999-abcdef0123456789.jsonl';
        fs.writeFileSync(path.join(foreign, name), 'KEEP');
        fs.utimesSync(path.join(foreign, name), new Date(NOW - 7200000), new Date(NOW - 7200000));
        const link = path.join(cacheDir, 'escape');
        fs.symlinkSync(foreign, link);
        await createCacheBudget({
            fs, cacheDir: link, index: { files: {} }, now: () => NOW
        });
        assert.equal(fs.readFileSync(path.join(foreign, name), 'utf8'), 'KEEP');
    }
    finally {
        fs.rmSync(foreign, { recursive: true, force: true });
    }
}));
test('N6 startup cleanup still runs when upstream logs are unavailable',async()=>cacheFixture(async({cacheDir,file,read})=>{const old=path.join(cacheDir,'run-999999-1123456789abcdef.jsonl');fs.writeFileSync(old,'old');fs.utimesSync(old,new Date(NOW-7200000),new Date(NOW-7200000));fs.rmSync(path.dirname(file),{recursive:true});await assert.rejects(read());assert.equal(fs.existsSync(old),false);}));
