'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexProvider, codexHomePath } = require('../server/sources/usage/providers/codex');
const { hermesDbPath, createHermesProvider } = require('../server/sources/usage/providers/hermes');
const { createUsageService } = require('../server/sources/usage');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const bounds = { since: '2026-08-01', until: '2026-08-15' };
const report = { provider: 'codex', daily: [{
            date: '2026-08-15', inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, modelBreakdowns: [{ modelName: 'gpt-5.6-sol' }]
        }] };
test('Codex fallback uses argv, explicit host home, own lane and configured timeout', async () => { const calls = []; const p = createCodexProvider({
    exec: { async run(bin, args, opts) { calls.push({ bin, args, opts }); return bin === 'codexbar' ? { ok: true, stdout: JSON.stringify(report) } : { ok: false, stderr: 'PRIVATE' }; } }, projectRoot: '/work tree', home: '/host', env: { MC_CODEXBAR_TIMEOUT_MS: '7654', CODEX_HOME: '/wrong' }, now: () => NOW
}); const data = await p.read(bounds); assert.equal(data.days[0].inputTokens, 20); assert.equal(data.days[0].billedUsd, null); assert.equal(data.coverage, 'partial'); assert.equal(calls[0].args[0], '--max-old-space-size=96'); assert.equal(calls[0].args[1], '/work tree/scripts/openclaw-usage-summary.js'); assert.equal(calls[0].opts.env.MC_CODEX_HOME, '/host/.codex'); assert.equal(calls[1].opts.timeoutMs, 7654); assert.equal(calls[1].opts.lane, 'usage_codex'); assert.deepEqual(calls[1].args.slice(0, 6), ['cost', '--format', 'json', '--provider', 'codex', '--days']); });
for (const bad of ['garbage', '{}', '{"error":"secret"}', '[{"provider":"codex","daily":[],"error":{"message":"secret"}}]'])
    test(`bad codexbar observation preserves last good (${bad.slice(0, 12)})`, async () => { let fail = false; const exec = { async run(bin) { if (bin !== 'codexbar')
            return { ok: false }; return { ok: true, stdout: fail ? bad : JSON.stringify(report) }; } }; const provider = createCodexProvider({
        exec, home: '/home', env: {}, projectRoot: '/repo', now: () => NOW
    }); const u = createUsageService({ providers: [provider], now: () => NOW }); await u.refresh(); fail = true; await u.refresh(); const body = u.codexbar(); assert.equal(body.totals.totalTokens, 120); assert.equal(body.stale, true); assert.equal(body.meta.ok, false); assert.equal(JSON.stringify(body).includes('secret'), false); });
test('cold failed scanner remains warming with null totals', async () => { const p = createCodexProvider({
    exec: { run: async () => ({ ok: false }) }, home: '/home', env: {}, projectRoot: '/repo'
}); const u = createUsageService({ providers: [p], now: () => NOW }); await u.refresh(); assert.equal(u.codexbar().totals.totalTokens, null); assert.equal(u.costs().providers[0].state, 'unavailable'); });
test('explicit missing producer paths cannot fall through to a different profile/home', () => { assert.equal(hermesDbPath({ HERMES_STATE_DB: '/missing/db' }, '/home'), '/missing/db'); assert.equal(hermesDbPath({ HERMES_PROFILE_DIR: '/missing/profile' }, '/home'), '/missing/profile/state.db'); assert.equal(codexHomePath({ MC_USER_HOME: '/user', CODEX_HOME: '/wrong' }), '/user/.codex'); });
test('Hermes uses read-only argv with short busy timeout and every model, preserving actual billing unknowns', async () => { let call; const names = ['grok-4', 'glm-5.3', 'qwen3', 'custom/qwen']; const p = createHermesProvider({
    home: '/home', env: { HERMES_STATE_DB: '/path with spaces/state.db' }, now: () => NOW, exec: { async run(bin, args, opts) { call = { bin, args, opts }; return { ok: true, stdout: JSON.stringify(names.map(model => ({
                date: '2026-08-15', provider: 'local', model, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, billedUsd: null
            }))) }; } }
}); const data = await p.read(bounds); assert.equal(data.days.length, 4); assert.equal(data.days[0].billedUsd, null); assert.deepEqual(call.args.slice(0, 5), ['-readonly', '-json', '-cmd', '.timeout 200', '/path with spaces/state.db']); assert.equal(call.opts.timeoutMs, 5000); assert.equal(call.opts.lane, 'usage_hermes'); assert.match(call.args[5], /actual_cost_usd/); assert.doesNotMatch(call.args[5], /model\s+(IN|LIKE)|system_prompt|title|billing_base_url/i); });
test('Hermes floors both time bounds and never substitutes estimated cost for billed', async () => { let sql; const p = createHermesProvider({ home: '/home', env: {}, exec: { async run(bin, args) { sql = args.at(-1); return { ok: true, stdout: '[]' }; } } }); await p.read(bounds); assert.ok(sql.includes(String(Math.floor(new Date('2026-08-15T23:59:59.999').getTime() / 1000)))); assert.doesNotMatch(sql, /estimated_cost_usd/); });
