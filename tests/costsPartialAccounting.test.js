'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsageService } = require('../server/sources/usage');
const { createCodexProvider } = require('../server/sources/usage/providers/codex');
const { createHermesProvider } = require('../server/sources/usage/providers/hermes');
const NOW = Date.parse('2026-08-15T12:00:00Z');
const row = (model, inputTokens = 1000000) => ({date:'2026-08-15',model,inputTokens,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,billedUsd:null});
const reading = days => ({days,observedAt:new Date(NOW).toISOString(),coverage:'complete',note:'fixture'});
const provider = (id, days) => ({id,label:id,read:async()=>reading(days)});
const unread = id => ({id,label:id,read:async()=>{throw Error('PRIVATE_CHILD_OUTPUT');}});
const create = providers => createUsageService({providers,now:()=>NOW});

test('sum known providers: one unread provider cannot erase dollars, tokens, daily pace or projection', async () => {
 const u=create([provider('claude_code',[row('claude-fable-5')]),provider('codex',[row('gpt-5.6-sol')]),unread('openclaw')]);
 await u.refresh();const costs=u.costs('month'), summary=u.summary().data;
 assert.equal(costs.summary.periodApiEquivalentUsd,15);assert.equal(costs.summary.periodTokens,2000000);
 assert.equal(costs.summary.periodApiEquivalentUsd/costs.daily.length,1);assert.equal(costs.summary.periodApiEquivalentUsd/costs.daily.length*30,30);
 assert.equal(costs.partial,true);assert.equal(costs.apiEquivalentReliability,'partial');
 assert.deepEqual(costs.missingProviders,[{id:'openclaw',label:'openclaw',reason:'usage_unavailable'}]);
 assert.equal(costs.providers[2].tokens,null);assert.equal(costs.providers[2].apiEquivalentUsd,null);
 assert.equal(summary.month.apiEquivalentUsd,15);assert.equal(summary.today.tokens,2000000);assert.equal(summary.week.apiEquivalentUsd,15);
 assert.deepEqual(summary.missingProviders,costs.missingProviders);assert.equal(summary.partial,true);
});
test('all unknown stays null for API equivalent, tokens, pace and projection; unread is never an observed zero', async () => {
 const u=create([unread('a'),unread('b')]);await u.refresh();const costs=u.costs();
 assert.equal(costs.summary.periodApiEquivalentUsd,null);assert.equal(costs.summary.periodTokens,null);assert.equal(costs.apiEquivalentUsd,null);
 assert.equal(costs.missingProviders.length,2);assert.equal(u.summary().data,null);assert.deepEqual(u.summary().meta.missingProviders,costs.missingProviders);
 assert.equal(costs.daily.every(d=>d.apiEquivalentCost===null&&d.tokens===null),true);
});
test('Hermes estimates every observed model with unchanged exact/default rates; idle rows cannot null its figure', async () => {
 const p=createHermesProvider({home:'/fake',env:{},now:()=>NOW,exec:{run:async()=>({ok:true,stdout:JSON.stringify([
  {date:'2026-08-15',provider:'cloud',model:'gpt-5.6-sol',inputTokens:1000000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,billedUsd:null},
  {date:'2026-08-15',provider:'cloud',model:'grok-future',inputTokens:1000000,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,billedUsd:null},
  {date:'2026-08-15',provider:'cloud',model:'idle-model',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,billedUsd:null},
 ])})}});
 const u=create([p]);await u.refresh();const costs=u.costs();assert.equal(costs.providers[0].apiEquivalentUsd,7.5);assert.equal(costs.summary.periodApiEquivalentUsd,7.5);
 const exact=costs.byService.find(x=>x.name.includes('gpt-5.6-sol')),fallback=costs.byService.find(x=>x.name.includes('grok-future'));
 assert.equal(exact.apiEquivalentUsd,5);assert.equal(fallback.apiEquivalentUsd,2.5);assert.equal(exact.apiEquivalentEstimated,true);assert.equal(fallback.apiEquivalentEstimated,true);assert.equal(fallback.apiEquivalentStatus,'partial');
 assert.equal(costs.providers[0].billedUsd,null);assert.equal(u.summary().data.month.apiEquivalentUsd,7.5);
});
test('an observed empty provider contributes a known zero, unlike an unread provider',async()=>{
 const u=create([provider('empty',[]),unread('missing')]);await u.refresh();assert.equal(u.costs().summary.periodApiEquivalentUsd,0);assert.equal(u.costs().summary.periodTokens,0);assert.deepEqual(u.costs().missingProviders,[{id:'missing',label:'missing',reason:'usage_unavailable'}]);
});
const report={provider:'codex',daily:[{date:'2026-08-15',inputTokens:100,outputTokens:20,cacheReadTokens:0,modelBreakdowns:[{modelName:'gpt-5.6-sol'}]}]};
function scanner() {
 let time=NOW,fail=false,local=false;
 const p=createCodexProvider({home:'/fake',projectRoot:'/repo',env:{},now:()=>time,exec:{async run(bin){
  if(bin!=='codexbar')return local?{ok:true,stdout:JSON.stringify(reading([row('gpt-5.6-sol')]))}:{ok:false};
  return fail?{ok:false,timedOut:true,stderr:'PRIVATE_CHILD_OUTPUT'}:{ok:true,stdout:JSON.stringify(report)};
 }}});
 const u=createUsageService({providers:[p],now:()=>time});return {u,advance:()=>{time+=125000;},fail:()=>{fail=true;},local:()=>{local=true;}};
}
test('successful CodexBar scan with partial model coverage is not a failed scan',async()=>{
 const {u}=scanner();await u.refresh();const body=u.codexbar();assert.equal(body.stale,false);assert.equal(body.scanErrorClass,null);assert.equal(body.staleAgeMs,null);assert.equal(body.codexbarScan.state,'succeeded');assert.equal(body.codexbarScan.lastGoodScanAgeMs,0);assert.equal(body.meta.stale,false);assert.equal(u.costs().partial,true);
});
test('failed CodexBar scan exposes last-good age separately from a safe error class and recovers',async()=>{
 const s=scanner();await s.u.refresh();s.advance();s.fail();await s.u.refresh();let body=s.u.codexbar();assert.equal(body.stale,true);assert.equal(body.staleAgeMs,125000);assert.equal(body.scanErrorClass,'timeout');assert.equal(body.codexbarScan.lastGoodScanAgeMs,125000);assert.equal(body.staleReason,'scan_failed_served_last_good');assert.equal(JSON.stringify(body).includes('PRIVATE_CHILD_OUTPUT'),false);
 s.local();await s.u.refresh();body=s.u.codexbar();assert.equal(body.stale,false);assert.equal(body.staleAgeMs,null);assert.equal(body.codexbarScan.usageSource,'local_logs');
});
test('no CodexBar invocation means no failed-scan notice, including unrelated Claude read failures',async()=>{
 const u=create([provider('codex',[row('gpt-5.6-sol')]),unread('claude_code')]);await u.refresh();assert.equal(u.codexbar().stale,false);assert.equal(u.codexbar().codexbarScan.state,'not_run');assert.equal(u.codexbar().scanErrorClass,null);
});
test('restart preserves the real last-good CodexBar time and typed scan failure',async()=>{
 let clock=NOW,fail=false;const files=new Map();const fs={async mkdir(){},async readFile(p){if(!files.has(p))throw Error('absent');return files.get(p);},async writeFile(p,v){files.set(p,v);},async rename(a,b){files.set(b,files.get(a));files.delete(a);},async unlink(p){files.delete(p);}};
 const make=()=>createUsageService({now:()=>clock,fs,dataDir:'/cache',providers:[createCodexProvider({home:'/fake',projectRoot:'/repo',env:{},now:()=>clock,exec:{run:async(bin)=>bin!=='codexbar'?{ok:false}:fail?{ok:false,error:{code:'ENOENT'},stderr:'PRIVATE'}:{ok:true,stdout:JSON.stringify(report)}}})]});
 const first=make();await first.refresh();clock+=180000;fail=true;const restored=make();await restored.refresh();const payload=restored.codexbar();assert.equal(payload.stale,true);assert.equal(payload.staleAgeMs,180000);assert.equal(payload.scanErrorClass,'not_found');assert.equal(JSON.stringify([...files.values()]).includes('PRIVATE'),false);
});
test('partial observed windows keep known provider subtotals instead of dropping them',async()=>{
 let clock=Date.parse('2026-08-15T23:59:59');const u=createUsageService({providers:[provider('known',[row('gpt-5.6-sol')])],now:()=>clock});await u.refresh();clock=Date.parse('2026-08-16T00:00:01');
 assert.equal(u.costs('month').summary.periodApiEquivalentUsd,5);assert.equal(u.summary().data.month.tokens,1000000);assert.equal(u.summary().data.today.tokens,null);assert.equal(u.costs().partial,true);assert.deepEqual(u.costs().missingProviders,[]);assert.equal(u.costs().providers[0].coverage,'partial');
});
test('a successful rescan clears error class and failed-scan fields',async()=>{
 let fail=false,time=NOW;const p=createCodexProvider({home:'/fake',projectRoot:'/repo',env:{},now:()=>time,exec:{run:async bin=>bin!=='codexbar'?{ok:false}:fail?{ok:false,timedOut:true}:{ok:true,stdout:JSON.stringify(report)}}});const u=createUsageService({providers:[p],now:()=>time});await u.refresh();fail=true;time+=60000;await u.refresh();assert.equal(u.codexbar().stale,true);fail=false;time+=60000;await u.refresh();assert.equal(u.codexbar().stale,false);assert.equal(u.codexbar().scanErrorClass,null);assert.equal(u.codexbar().codexbarScan.state,'succeeded');assert.equal(u.codexbar().codexbarScan.lastGoodScanAgeMs,0);
});
test('Hermes comparison uses public default rates even when a different actual bill is recorded',async()=>{
 const bill={...row('cloud/unlisted-model'),billedUsd:0.1};const u=create([provider('hermes',[bill])]);await u.refresh();const p=u.costs().providers[0];assert.equal(p.apiEquivalentUsd,2.5);assert.equal(p.billedUsd,0.1);assert.equal(u.costs().byService[0].apiEquivalentStatus,'partial');
});
test('a first failed CodexBar scan exposes its class with no invented last-good age',async()=>{
 const s=scanner();s.fail();await s.u.refresh();const payload=s.u.codexbar();assert.equal(payload.codexbarScan.state,'failed');assert.equal(payload.scanErrorClass,'timeout');assert.equal(payload.codexbarScan.lastGoodScanAgeMs,null);assert.equal(payload.staleAgeMs,null);assert.equal(payload.stale,false);assert.equal(payload.totals.totalCost,null);
});
