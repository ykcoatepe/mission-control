'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildCostsRouter } = require('../server/routes/costs');
const { createUsageService } = require('../server/sources/usage');
const { errorHandler } = require('../server/core/http');
async function withRouter(run, { warm = false } = {}) {
    let reads = 0, writes = 0;
    const now = () => Date.parse('2026-08-15T12:00:00Z');
    const usage = createUsageService({
        providers: [{ id: 'fake', label: 'Fake', async read() { reads++; return {
                    days: [], observedAt: new Date(now()).toISOString(), coverage: 'complete', note: 'fixture'
                }; } }], now, fs: {
            async readFile() { throw Error(); }, async mkdir() { }, async writeFile() { writes++; }, async rename() { }
        }, dataDir: '/data'
    });
    if (warm)
        await usage.refresh();
    const initial = { reads, writes };
    const app = express();
    app.use(buildCostsRouter({ usageService: usage, now, mcConfig: { budget: { monthly: 10 } } }));
    app.use(errorHandler({ logger: { error() { } } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
        await run({ base: `http://127.0.0.1:${server.address().port}`, initial, counts: () => ({ reads, writes }) });
    }
    finally {
        await new Promise(r => server.close(r));
    }
}
for (const warm of [false, true])
    test(`all usage GETs are pure and never refresh (${warm ? 'warm' : 'cold'})`, async () => withRouter(async ({ base, initial, counts }) => { for (const endpoint of ['/api/costs', '/api/costs?period=day', '/api/costs?period=7d', '/api/costs?month=2026-03', '/api/costs/months', '/api/costs/codexbar', '/api/usage/summary']) {
        const r = await fetch(base + endpoint);
        assert.ok([200, 503].includes(r.status));
        const body = await r.json();
        if (endpoint === '/api/costs') {
            assert.ok(Array.isArray(body.daily));
            assert.ok(Array.isArray(body.byService));
            assert.ok(body.summary);
            if (!warm) {
                assert.equal(body.summary.periodTokens, null);
                assert.equal(body.meta.refreshing, true);
            }
        }
    } assert.deepEqual(counts(), initial); }, { warm }));
for (const query of ['period=bogus', 'period=month%3Bcat', 'month=2026-13', 'month=2026-09', 'month=2020-01'])
    test(`invalid query rejects before reading: ${query}`, async () => withRouter(async ({ base, counts }) => { for (const endpoint of ['/api/costs', '/api/costs/codexbar']) {
        const r = await fetch(`${base}${endpoint}?${query}`);
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error.code, 'invalid_usage_query');
    } assert.deepEqual(counts(), { reads: 0, writes: 0 }); }));
test('new summary has envelope and honest 503 cold state', async () => withRouter(async ({ base }) => { const r = await fetch(base + '/api/usage/summary'); assert.equal(r.status, 503); const body = await r.json(); assert.equal(body.data, null); assert.equal(body.meta.stale, true); }));
