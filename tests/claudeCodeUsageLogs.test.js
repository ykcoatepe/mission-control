'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readClaudeLogs } = require('../server/sources/usage/claude-log-reader');
const bounds = { since: '2026-08-01', until: '2026-08-15' }, now = () => Date.parse('2026-08-15T12:00:00Z');
function fsFor(lines) { return { promises: { async readdir() { return [{ name: 'fixture.jsonl', isDirectory: () => false, isFile: () => true }]; } }, createReadStream() { return Readable.from([lines.map(x => JSON.stringify(x)).join('\n')]); } }; }
function entry(output = 3) { return {
    type: 'assistant', uuid: 'row', requestId: 'request', timestamp: '2026-08-15T12:00:00Z', message: {
        id: 'message', model: 'claude-fable-5', content: 'PRIVATE_TRANSCRIPT', usage: {
            input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 5
        }
    }
}; }
test('Claude local log reader whitelists count fields and keeps billing unknown', async () => { const value = await readClaudeLogs(bounds, { fs: fsFor([entry()]), home: '/home', now }); assert.equal(value.days[0].inputTokens, 10); assert.equal(value.days[0].outputTokens, 3); assert.equal(value.days[0].cacheReadTokens, 20); assert.equal(value.days[0].cacheWriteTokens, 5); assert.equal(value.days[0].billedUsd, null); assert.equal(JSON.stringify(value).includes('PRIVATE_TRANSCRIPT'), false); });
test('Claude repeated streaming snapshots and copied logs count each request once at final counts', async () => { const value = await readClaudeLogs(bounds, { fs: fsFor([entry(0), entry(3), entry(3)]), home: '/home', now }); assert.equal(value.days[0].inputTokens, 10); assert.equal(value.days[0].outputTokens, 3); });
test('missing Claude corpus throws instead of claiming observed zero', async () => { await assert.rejects(readClaudeLogs(bounds, { home: '/home', fs: { promises: { async readdir() { throw Error('missing'); } } }, now })); });
test('out-of-window Claude rows never enter an anchored month', async () => { const row = entry(); row.timestamp = '2026-09-01T00:00:00Z'; assert.deepEqual((await readClaudeLogs(bounds, { fs: fsFor([row]), home: '/home', now })).days, []); });
test('a request repeated across midnight or restored logs stays counted once on its earliest observed day', async () => {
    const early = entry(0);
    early.timestamp = '2026-08-14T23:59:59';
    const late = entry(3);
    late.timestamp = '2026-08-15T00:00:01';
    const value = await readClaudeLogs(bounds, { fs: fsFor([late, early]), home: '/home', now });
    const rows = value.days.filter(r => r.inputTokens || r.outputTokens || r.cacheReadTokens || r.cacheWriteTokens);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, '2026-08-14');
    assert.equal(rows[0].outputTokens, 3);
    assert.equal(rows[0].inputTokens, 10);
});
