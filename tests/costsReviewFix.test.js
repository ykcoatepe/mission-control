'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageService } = require('../server/sources/usage');
const { createHermesProvider } = require('../server/sources/usage/providers/hermes');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const day = n => ({
    date: '2026-08-15', model: 'openai/gpt-5.6-sol', inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null
});
const data = days => ({
    days, observedAt: new Date(NOW).toISOString(), coverage: 'complete', note: 'fixture'
});
const codex = () => ({ id: 'codex', label: 'Codex', read: async () => ({ ...data([day(100)]), ownership: [{ owner: 'hermes', ...day(50) }] }) });
const hermes = read => ({ id: 'hermes', label: 'Hermes', read: read || (async () => data([day(100)])) });
for (const order of [['codex', 'hermes'], ['hermes', 'codex']])
    test(`U1 compose ownership from current snapshots: ${order.join(' then ')}`, async () => {
        const u = createUsageService({ providers: [codex(), hermes()], now: () => NOW });
        for (const id of order)
            await u.registry.sources().find(s => s.id === `usage.${id}`).refresh();
        assert.equal(u.costs().summary.periodTokens, 150);
        assert.equal(u.summary().data.month.tokens, 150);
        assert.equal(u.costs().partial, false);
        assert.equal(u.costs().meta.ok, true);
    });
test('U1 missing or failed owner cannot resolve overlap or claim a complete reading', async () => {
    const u = createUsageService({ providers: [codex(), hermes(async () => { throw Error('down'); })], now: () => NOW });
    await u.refresh();
    const x = u.costs();
    assert.equal(x.partial, true);
    assert.equal(x.meta.ok, false);
    assert.ok(x.meta.unresolvedOverlaps.some(o => o.owner === 'hermes' && o.reason === 'owner_unavailable'));
});
test('U1 stale owner retains visible counts but marks overlap unresolved', async () => {
    let time = NOW;
    const u = createUsageService({ providers: [codex(), hermes()], now: () => time });
    await u.refresh();
    time += 180001;
    await u.registry.sources().find(s => s.id === 'usage.codex').refresh();
    assert.equal(u.costs().partial, true);
    assert.ok(u.costs().meta.unresolvedOverlaps.some(o => o.reason === 'owner_stale'));
});
test('U1 raw cache cannot persist an unresolved composition as complete', async () => {
    const files = new Map();
    const fs = {
        async readFile() { throw Error('absent'); }, async mkdir() { }, async writeFile(p, v) { files.set(p, v); }, async rename(a, b) { files.set(b, files.get(a)); files.delete(a); }, async unlink(p) { files.delete(p); }
    };
    const u = createUsageService({
        providers: [codex(), hermes()], now: () => NOW, fs, dataDir: '/cache'
    });
    await u.registry.sources()[0].refresh();
    const saved = JSON.parse(files.get('/cache/usage/codex.json'));
    assert.equal(saved.data.coverage, 'partial');
    assert.equal(saved.data.ownership[0].inputTokens, 50);
    await u.registry.sources()[1].refresh();
    assert.equal(u.costs().summary.periodTokens, 150);
    assert.equal(JSON.parse(files.get('/cache/usage/codex.json')).data.coverage, 'partial');
});
test('U3 NULL token rows keep known subtotals, report unknown row count and partial coverage', async () => {
    const p = createHermesProvider({
        home: '/fake', env: {}, now: () => NOW, exec: { run: async () => ({ ok: true, stdout: JSON.stringify([{
                        ...day(10), provider: 'openai', model: 'gpt-5.6-sol', unknownTokenRows: 1
                    }]) }) }
    });
    const x = await p.read({ since: '2026-08-01', until: '2026-08-15' });
    assert.equal(x.days[0].inputTokens, 10);
    assert.equal(x.coverage, 'partial');
    assert.match(x.note, /1.*unknown token/i);
});
test('U1 owner partial coverage cannot authorize dropping the duplicate candidate', async () => {
    const u = createUsageService({ providers: [codex(), hermes(async () => ({ ...data([day(100)]), coverage: 'partial' }))], now: () => NOW });
    await u.refresh();
    assert.equal(u.costs().partial, true);
    assert.ok(u.costs().meta.unresolvedOverlaps.some(x => x.reason === 'owner_partial'));
});
test('U1 duplicate day/model rows are valid and compose without negative buckets', async () => {
    const p = codex();
    p.read = async () => ({ ...data([day(50), day(50)]), ownership: [{ owner: 'hermes', ...day(75) }] });
    const u = createUsageService({ providers: [p, hermes()], now: () => NOW });
    await u.refresh();
    assert.equal(u.costs().summary.periodTokens, 125);
});
test('U1 a fresh owner snapshot older than a candidate record cannot confirm that overlap', async () => {
    let time = NOW;
    const p = codex();
    p.read = async () => ({ ...data([day(100)]), ownership: [{ owner: 'hermes', ...day(50), latestUsageAt: new Date(NOW + 1000).toISOString() }] });
    const u = createUsageService({ providers: [p, hermes()], now: () => time });
    await u.registry.sources()[1].refresh();
    time += 1000;
    await u.registry.sources()[0].refresh();
    assert.equal(u.costs().partial, true);
    assert.ok(u.costs().meta.unresolvedOverlaps.some(x => x.reason === 'owner_snapshot_older_than_usage'));
});
test('U2 large readers use independent five-minute schedules and bounded child heaps',async()=>{
 const jobs=[];const calls=[];const scheduler={register(source,options){jobs.push({source,options});}};
 const u=createUsageService({home:'/fake',projectRoot:'/repo',env:{},scheduler,now:()=>NOW,exec:{run:async(bin,args,options)=>{calls.push({bin,args,options});return {ok:true,stdout:JSON.stringify(data([]))};}}});
 assert.equal(jobs.find(j=>j.source.id==='usage.claude_code').options.intervalMs,300000);assert.equal(jobs.find(j=>j.source.id==='usage.codex').options.intervalMs,300000);
 for(const id of ['usage.claude_code','usage.codex'])await u.registry.sources().find(s=>s.id===id).refresh();
 assert.equal(calls.every(call=>call.args[0]==='--max-old-space-size=96'),true);assert.notEqual(calls[0].options.lane,calls[1].options.lane);
});
