'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bounds = { since: '2026-08-01', until: '2026-08-15' };
const now = () => Date.parse('2026-08-15T12:00:00Z');
const claude = (id, n = 10) => JSON.stringify({
    type: 'assistant', uuid: id, timestamp: '2026-08-15T10:00:00Z', message: {
        id, model: 'claude-fable-5', content: 'PRIVATE_TRANSCRIPT_NEVER_CACHE', usage: { input_tokens: n, output_tokens: 2 }
    }
}) + '\n';
const meta = JSON.stringify({ type: 'session_meta', payload: {
        id: 'session', originator: 'codex_exec', model: 'gpt-5.6-sol', model_provider: 'openai'
    } }) + '\n';
const codex = (id, n = 10) => JSON.stringify({ timestamp: '2026-08-15T10:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: n, output_tokens: 2, total_tokens: n + 2 }, total_token_usage: { total_tokens: id * 100 } } } }) + '\n';
for (const platform of ['claude', 'codex']) {
    async function setup(run) {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-incremental-'));
        const root = path.join(home, platform === 'claude' ? '.claude/projects' : '.codex/sessions');
        fs.mkdirSync(root, { recursive: true });
        const file = path.join(root, 'session.jsonl'), cacheDir = path.join(home, 'data/usage/incremental', platform), reads = [];
        const injected = { ...fs, createReadStream(p, options) { if (p === file)
                reads.push({ ...options }); return fs.createReadStream(p, options); } };
        const read = () => platform === 'claude' ? require('../server/sources/usage/claude-log-reader').readClaudeLogs(bounds, {
            home, fs: injected, now, cacheDir
        }) : require('../server/sources/usage/codex-log-reader').readCodexLogs(bounds, {
            home, fs: injected, now, cacheDir
        });
        const content = (id, n) => platform === 'claude' ? claude(String(id), n) : codex(id, n), initial = (platform === 'codex' ? meta : '') + content(1, 10);
        fs.writeFileSync(file, initial);
        try {
            await run({
                file, root, cacheDir, reads, read, content, initial, injected
            });
        }
        finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    }
    test(`U2 ${platform}: unchanged file is not re-read and append resumes at byte offset`, async () => setup(async ({ file, read, reads, content, initial }) => { await read(); const n = reads.length; await read(); assert.equal(reads.length, n); fs.appendFileSync(file, content(2, 20)); const x = await read(); assert.equal(reads.at(-1).start, Buffer.byteLength(initial)); assert.equal(x.days.reduce((sum, r) => sum + r.inputTokens, 0), 30); }));
    test(`U2 ${platform}: truncation and rotation replace cached counts`, async () => setup(async ({ file, read, reads, content }) => { await read(); fs.writeFileSync(file, (platform === 'codex' ? meta : '') + content(2, 3)); let x = await read(); assert.equal(reads.at(-1).start, 0); assert.equal(x.days[0].inputTokens, 3); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, (platform === 'codex' ? meta : '') + content(3, 7)); x = await read(); assert.equal(reads.at(-1).start, 0); assert.equal(x.days[0].inputTokens, 7); }));
    test(`U2 ${platform}: corrupt index is ignored; cache contains counts, never content`, async () => setup(async ({ cacheDir, read, reads }) => { await read(); fs.writeFileSync(path.join(cacheDir, 'index.json'), '{corrupt'); const n = reads.length; const x = await read(); assert.equal(reads.length, n + 1); assert.equal(x.days[0].inputTokens, 10); function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            walk(p);
        else
            assert.equal(fs.readFileSync(p, 'utf8').includes('PRIVATE_TRANSCRIPT_NEVER_CACHE'), false);
    } } walk(cacheDir); }));
    test(`U2 ${platform}: history older than requested window is not scanned`, async () => setup(async ({ file, read, reads }) => { const old = new Date('2025-01-01'); fs.utimesSync(file, old, old); const x = await read(); assert.equal(reads.length, 0); assert.deepEqual(x.days, []); }));
    test(`U2 ${platform}: an incomplete final JSON line resumes without losing or duplicating counts`, async () => setup(async ({ file, read, content, initial }) => { const tail = content(2, 20), split = Math.floor(tail.length / 2); fs.writeFileSync(file, initial + tail.slice(0, split)); const first = await read(); assert.equal(first.coverage, 'partial'); fs.appendFileSync(file, tail.slice(split)); const next = await read(); assert.equal(next.days[0].inputTokens, 30); assert.equal(next.coverage, 'complete'); }));
    test(`U2 ${platform}: corrupt normalized data triggers source re-read`, async () => setup(async ({ read, reads, cacheDir }) => { await read(); const index = JSON.parse(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8')); const entry = Object.values(index.files)[0]; fs.writeFileSync(path.join(cacheDir, entry.cache), 'not json\n'); const n = reads.length; assert.equal((await read()).days[0].inputTokens, 10); assert.equal(reads.length, n + 1); }));
    test(`U2 ${platform}: a failed count-cache write leaves the prior index intact`, { timeout: 1000 }, async () => setup(async ({ file, read, cacheDir, content, injected }) => { await read(); const previous = fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'); fs.appendFileSync(file, content(2, 20)); const { Writable } = require('node:stream'); injected.createWriteStream = () => new Writable({ write(chunk, encoding, callback) { callback(Error('disk full')); } }); await assert.rejects(read()); assert.equal(fs.readFileSync(path.join(cacheDir, 'index.json'), 'utf8'), previous); }));
}
