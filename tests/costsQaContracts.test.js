'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createUsageService } = require('../server/sources/usage');
const { buildCostsRouter } = require('../server/routes/costs');
const { errorHandler } = require('../server/core/http');
const { createHermesProvider } = require('../server/sources/usage/providers/hermes');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const now = () => NOW;
const row = (extra = {}) => ({ date: '2026-08-15', model: 'custom/qwen', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null, ...extra });
const observation = (days = [], extra = {}) => ({ days, observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'fixture', ...extra });
const provider = (id, value) => ({ id, label: id, read: async () => value });
const service = providers => createUsageService({ providers, now });
// Optional built-in SQL engine for the supported Node >=22 line; all exec calls
// remain injected. The portable contract tests below also run on Node 20.
let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

test('QA1 empty records are not evidence of a zero bill in costs or summary', async () => {
  const u = service([provider('openclaw', observation())]); await u.refresh();
  const p = u.costs().providers[0];
  assert.equal(p.billedUsd, null); assert.equal(p.tokens, 0); assert.equal(p.hasRecords, false); assert.equal(p.billingKnown, false);
  const s = u.summary().data;
  for (const key of ['today', 'week', 'month']) { assert.equal(s[key].billedUsd, null); assert.equal(s[key].billingKnown, false); assert.equal(s[key].hasRecords, false); }
  assert.equal(s.providers[0].billingKnown, false); assert.equal(s.providers[0].hasRecords, false);
});
test('QA1 recorded zero bills differ from unknown and mixed billing', async () => {
  const u = service([provider('zero', observation([row({ billedUsd: 0 })])), provider('unknown', observation([row()])), provider('mixed', observation([row({ billedUsd: 2 }), row()]))]); await u.refresh();
  const [zero, unknown, mixed] = u.costs().providers;
  assert.equal(zero.billingKnown, true); assert.equal(zero.billedUsd, 0); assert.equal(zero.hasRecords, true);
  for (const p of [unknown, mixed]) { assert.equal(p.billingKnown, false); assert.equal(p.billedUsd, null); assert.equal(p.hasRecords, true); }
  assert.equal(u.summary().data.month.billingKnown, false);
});
test('QA2 comparison exposes actual clipped and full calendar bounds', async () => {
  const u = service([provider('p', observation([row()]))]); await u.refresh();
  const current = u.costs().period;
  assert.equal(current.previousStart, '2026-07-01'); assert.equal(current.previousEnd, '2026-07-15'); assert.equal(current.previousIsPartial, true);
  const anchored = u.costs('month', '2026-07').period;
  assert.equal(anchored.previousStart, '2026-06-01'); assert.equal(anchored.previousEnd, '2026-06-30'); assert.equal(anchored.previousIsPartial, false);
  assert.equal(u.costs('day').period.previousIsPartial, false);
  assert.equal(u.costs('7d').period.previousEnd, '2026-08-08');
});
test('QA2 missing comparison evidence remains explicitly partial', async () => {
  const u = service([provider('offline', observation())]);
  assert.equal(u.costs('month', '2026-07').period.previousIsPartial, true);
});
test('QA3 standing gaps and actual failed reads have distinct reasons without losing last-good counters', async () => {
  let failed = false;
  const u = service([{ id: 'claude_code', label: 'Claude', read: async () => { if (failed) throw Error('PRIVATE'); return observation([row()], { coverage: 'partial', skippedLines: 3, oversizedLines: 1 }); } }]);
  assert.equal(u.costs().providers[0].coverageReason, 'unread');
  assert.equal(u.costs().providers[0].skippedLines, null);
  await u.refresh(); let p = u.costs().providers[0];
  assert.equal(p.coverageReason, 'standing_gaps'); assert.equal(p.skippedLines, 3); assert.equal(p.oversizedLines, 1);
  failed = true; await u.refresh(); p = u.costs().providers[0];
  assert.equal(p.coverageReason, 'scan_failed'); assert.equal(p.skippedLines, 3);
});
test('QA3 only overlaps in the selected window get unresolved_overlap', async () => {
  const u = service([provider('codex', observation([row(), row({ date: '2025-03-02' })], { ownership: [{ owner: 'hermes', ...row({ date: '2025-03-02' }) }] })), provider('hermes', observation())]); await u.refresh();
  assert.equal(u.costs().providers[0].coverageReason, 'none');
  assert.equal(u.costs('month', '2025-03').providers[0].coverageReason, 'unresolved_overlap');
});
for (const platform of ['claude', 'codex']) test(`QA3 ${platform} diagnostics persist across unchanged, append, tail repair and rotation`, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-qa-'));
  const root = path.join(home, platform === 'claude' ? '.claude/projects' : '.codex/sessions'), cacheDir = path.join(home, 'data/usage/incremental', platform);
  fs.mkdirSync(root, { recursive: true }); const file = path.join(root, 'session.jsonl');
  const meta = platform === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id: 'qa-session', originator: 'codex_cli_rs', source: 'cli', model: 'gpt-5.6-sol' } }) + '\n' : '';
  const valid = platform === 'claude' ? JSON.stringify({ type: 'assistant', timestamp: '2026-08-15T10:00:00Z', message: { id: 'x', model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n' : JSON.stringify({ timestamp: '2026-08-15T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } }) + '\n';
  const read = () => (platform === 'claude' ? require('../server/sources/usage/claude-log-reader').readClaudeLogs : require('../server/sources/usage/codex-log-reader').readCodexLogs)({ since: '2026-08-01', until: '2026-08-15' }, { home, cacheDir, now });
  try {
    fs.writeFileSync(file, meta + valid + '{bad}\n' + 'x'.repeat(1024 * 1024 + 1) + '\n');
    for (let i = 0; i < 2; i++) { const value = await read(); assert.equal(value.skippedLines, 2); assert.equal(value.oversizedLines, 1); }
    fs.appendFileSync(file, '{bad}\n'); let value = await read(); assert.equal(value.skippedLines, 3); assert.equal(value.oversizedLines, 1);
    fs.appendFileSync(file, '{'); value = await read(); assert.equal(value.skippedLines, 4);
    fs.appendFileSync(file, '}\n'); value = await read(); assert.equal(value.skippedLines, 3);
    fs.renameSync(file, file + '.old'); fs.writeFileSync(file, meta + valid); value = await read(); assert.equal(value.skippedLines, 0); assert.equal(value.oversizedLines, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test('QA4 Hermes locality is explicit metadata, never inferred from model spelling', async () => {
  const rows = [true, null, false].map((isLocal, i) => ({ ...row(), model: ['custom/known-local', 'local/unknown', 'custom/remote'][i], provider: 'custom', isLocal, endpoint: 'PRIVATE_ENDPOINT', model_config: { api_key: 'PRIVATE' } }));
  const hermes = createHermesProvider({ home: '/fake', now, exec: { run: async () => ({ ok: true, stdout: JSON.stringify(rows) }) } });
  const u = service([hermes]); await u.refresh(); const byService = u.costs().byService;
  assert.deepEqual(byService.map(s => s.isLocal), [true, null, false]); assert.equal(JSON.stringify(u.costs()).includes('PRIVATE'), false);
});
test('QA4 mixed locality for the same model remains unknown across days and grouping', async () => {
  const u = service([provider('hermes', observation([row({ isLocal: true }), row({ isLocal: false }), row({ date: '2026-08-14' })]))]); await u.refresh();
  assert.equal(u.costs().byService[0].isLocal, null); assert.equal(u.costs().agents[0].byService[0].isLocal, null);
});
test('QA4 SQL returns only count metadata and a local boolean, never endpoint or credentials', { skip: !DatabaseSync }, async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions (model_config TEXT, started_at INTEGER, billing_provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, actual_cost_usd REAL, billing_base_url TEXT)');
  const endpoints = ['http://localhost:11434/v1', 'https://127.0.0.1/v1', 'http://[::1]:1234/v1', 'http://LOCALHOST/v1', 'https://remote.example/v1', null, '', 'http://localhost.evil/v1', 'http://localhost:123@evil.example/v1', 'http://localhost:bad/v1', 'http://localhost:999999/v1', 'http://user:PRIVATE@localhost/v1'];
  const insert = db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?)');
  endpoints.forEach((endpoint, i) => insert.run('{"api_key":"PRIVATE","codex_thread_id":"test-rollout"}', Math.floor(NOW / 1000), 'custom', `model-${i}`, 1, 2, 0, 0, null, endpoint));
  let result;
  const hermes = createHermesProvider({ home: '/fake', now, exec: { async run(_bin, argv) {
    result = db.prepare(argv.at(-1)).all();
    return { ok: true, stdout: JSON.stringify(result) };
  } } });
  try {
    const value = await hermes.read({ since: '2026-08-01', until: '2026-08-15' });
    endpoints.forEach((_endpoint, i) => assert.equal(value.days.find(row => row.model === `custom/model-${i}`).isLocal, i < 4 ? true : null));
    for (const item of result) assert.deepEqual(Object.keys(item).sort(), ['isLocal','rolloutId','date','provider','model','inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','unknownTokenRows','billedUsd'].sort());
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(value).includes('test-rollout'), false);
  } finally { db.close(); }
});
test('QA contracts survive the HTTP seam and GET never refreshes producers', async () => {
  let reads = 0; const u = service([{ id: 'openclaw', label: 'OpenClaw', read: async () => { reads++; return observation(); } }]); await u.refresh();
  const app = express(); app.use(buildCostsRouter({ usageService: u, now })); app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const c = await (await fetch(base + '/api/costs')).json(), s = await (await fetch(base + '/api/usage/summary')).json();
    assert.equal(c.providers[0].hasRecords, false); assert.equal(s.data.month.billedUsd, null); assert.equal(c.period.previousEnd, '2026-07-15'); assert.equal(reads, 1);
  } finally { await new Promise(r => server.close(r)); }
});
