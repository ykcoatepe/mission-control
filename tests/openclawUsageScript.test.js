'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createUsageReader, extractUsageRecord, classifyCodexSession, bucketForRecord, prioritizeScanFiles } = require('../scripts/openclaw-usage-summary');
const NOW = Date.parse('2026-08-15T12:00:00Z');
function fixtureFs(files, denied = new Set()) {
    const roots = new Set(['/home/.openclaw/agents', '/home/.codex/sessions']);
    const dirs = new Set(roots);
    for (const file of Object.keys(files)) {
        let dir = require('node:path').dirname(file);
        while (dir !== '/') {
            dirs.add(dir);
            dir = require('node:path').dirname(dir);
        }
    }
    return { readdirSync(dir) { if (denied.has(dir) || !dirs.has(dir))
            throw Error('denied'); return [...new Set([...dirs, ...Object.keys(files)].filter(p => require('node:path').dirname(p) === dir))].map(p => ({ name: require('node:path').basename(p), isDirectory: () => dirs.has(p), isFile: () => !dirs.has(p) })); }, statSync: () => ({ mtimeMs: NOW, birthtimeMs: NOW }), createReadStream: file => Readable.from([files[file]]) };
}
const usage = (n = 10, model = 'gpt-5.6-sol') => JSON.stringify({ timestamp: new Date(NOW).toISOString(), message: { model, provider: 'openai', usage: {
            input: n, output: 2, cacheRead: 1, totalTokens: n + 3
        } } }) + '\n';
function reader(files, platform = 'openclaw', options = {}) { return createUsageReader({
    fs: fixtureFs(files), platform, env: { HOME: '/home', MC_CODEX_HOME: '/home/.codex' }, now: () => NOW, ...options
}); }
const bounds = { since: '2026-08-01', until: '2026-08-15' };
test('bounded local scan ignores trajectory copies, with no CLI or per-session fanout', async () => {
    const data = await reader({ '/home/.openclaw/agents/a/sessions/main.jsonl': usage(), '/home/.openclaw/agents/a/sessions/main.trajectory.jsonl': usage(100) }).buildProvider(bounds);
    assert.equal(data.days[0].inputTokens, 10);
    assert.equal(data.days.length, 1);
});
test('platform readers do not scan another producer, including nested OpenClaw Codex runs', async () => {
    const files = { '/home/.openclaw/agents/a/codex-home/sessions/nested.jsonl': usage(9), '/home/.codex/sessions/standalone.jsonl': usage(20) };
    assert.equal((await reader(files).buildProvider(bounds)).days[0].inputTokens, 9);
    assert.equal((await reader(files, 'codex').buildProvider(bounds)).days[0].inputTokens, 19);
});
test('missing or unreadable root throws rather than producing observed zero', async () => {
    const fs = fixtureFs({}, new Set(['/home/.openclaw/agents']));
    await assert.rejects(reader({}, 'openclaw', { fs }).buildProvider(bounds));
});
test('malformed lines mark coverage partial; missing files never become complete empty data', async () => {
    const data = await reader({ '/home/.openclaw/agents/a/sessions/main.jsonl': '{broken}\n' + usage() }).buildProvider(bounds);
    assert.equal(data.coverage, 'partial');
});
test('file cap produces a visible partial reading', async () => {
    const data = await reader({ '/home/.openclaw/agents/a/sessions/1.jsonl': usage(), '/home/.openclaw/agents/a/sessions/2.jsonl': usage() }, 'openclaw', { env: { HOME: '/home', MC_OPENCLAW_USAGE_MAX_FILES: '1' } }).buildProvider(bounds);
    assert.equal(data.coverage, 'partial');
    assert.match(data.note, /truncated/);
});
test('Hermes-owned Codex is retained with ownership metadata regardless of read-time coverage', async () => {
    const meta = JSON.stringify({ type: 'session_meta', payload: { originator: 'hermes', model: 'gpt-5.6-sol', model_provider: 'openai' } }) + '\n';
    const files = { '/home/.codex/sessions/a.jsonl': meta + usage() };
    const retained = await reader(files, 'codex').buildProvider(bounds);
    assert.equal(retained.coverage, 'partial');
    assert.equal(retained.days.length, 1);
    const independent=await reader(files, 'codex', { coveredDays: ['2026-08-15'] }).buildProvider(bounds);
    assert.deepEqual(independent.days,retained.days);assert.equal(independent.ownership[0].owner,'hermes');
    assert.equal((await reader(files, 'codex', { coveredDays: ['2026-08-14'] }).buildProvider(bounds)).days.length, 1);
});
test('Codex repeated cumulative token snapshots count once and cache is not counted twice', async () => {
    const event = JSON.stringify({ timestamp: new Date(NOW).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {
                    input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, total_tokens: 120
                }, total_token_usage: { total_tokens: 120 } } } }) + '\n';
    const data = await reader({ '/home/.codex/sessions/a.jsonl': event + event }, 'codex').buildProvider(bounds);
    assert.equal(data.days[0].inputTokens, 20);
    assert.equal(data.days[0].cacheReadTokens, 80);
    assert.equal(data.days[0].outputTokens, 20);
    assert.equal(data.days[0].billedUsd, null);
});
test('usage metadata stays whitelisted; message content never enters observations', async () => {
    const row = JSON.parse(usage());
    row.message.content = 'PRIVATE_TRANSCRIPT';
    const data = await reader({ '/home/.openclaw/agents/a/sessions/a.jsonl': JSON.stringify(row) + '\n' }).buildProvider(bounds);
    assert.equal(JSON.stringify(data).includes('PRIVATE_TRANSCRIPT'), false);
});
test('model context is updated without leaking a previous provider model', () => {
    const row = { timestamp: new Date(NOW).toISOString(), message: { provider: 'anthropic', usage: { input: 2, output: 3 } } };
    assert.equal(extractUsageRecord(row, NOW, 'id', { provider: 'openai', model: 'gpt-5' }).model, 'unknown');
});
for (const [origin, source, expected] of [['Codex Desktop', 'vscode', 'codex_app'], ['Codex Desktop', 'exec', 'codex_cli'], ['codex_cli_rs', 'exec', 'codex_cli'], ['hermes', 'vscode', 'hermes_owned'], ['future', 'vscode', 'unrecognized']])
    test(`origin ${origin}/${source} preserves bucket contract`, () => assert.equal(classifyCodexSession(origin, source), expected));
test('OpenClaw owns nested runs irrespective of originator', () => assert.equal(bucketForRecord({ origin: 'openclaw', codexClass: 'codex_app' }).key, 'openclaw'));
test('copied files with new birthtimes stay eligible when ranking an anchor scan', () => {
    const files = [{ path: 'old', mtimeMs: 20, birthtimeMs: 10000 }, { path: 'new', mtimeMs: 1000, birthtimeMs: 10000 }];
    assert.equal(prioritizeScanFiles(files, { endMs: 30 }, 1)[0].path, 'new');
});
module.exports = { fixtureFs };
