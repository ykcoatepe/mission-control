'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { safeText, createLookups } = require('../server/sources/gbrain/lookups');
// A real Node child only: no upstream CLI/network. A regression must fail the
// assertion, never block the parent event loop or hang the entire test suite.
const childCode = String.raw`
const { safeText } = require('./server/sources/gbrain/lookups');
const { adversarialCorpus, ordinaryText, SIZE } = require('./tests/fixtures/adversarialCorpus');
const group = process.argv[1];
const groups = {
 whitespace: [['Bearer + spaces', 'Bearer'+' '.repeat(SIZE)], ['authorization + spaces', 'authorization'+' '.repeat(SIZE)]],
 quotes: [['backslash-quote', String.fromCharCode(92,34).repeat(SIZE/2)],
   ['double-backslash-quote', String.fromCharCode(92,92,34).repeat(Math.ceil(SIZE/3))]],
 depth: ['a:', 'a=', 'key=', 'key:', 'authorization: '].map((unit) => [unit, unit.repeat(Math.ceil(SIZE/unit.length))]),
};
const corpus = groups[group] || adversarialCorpus();
function time(text) { const start = performance.now(); safeText(text, 40000); return performance.now()-start; }
for(let i=0;i<3;i++)time(ordinaryText());
const baselineMs = Math.min(time(ordinaryText()),time(ordinaryText()),time(ordinaryText()));
const results=[];
for(const [name,text] of corpus) { process.stderr.write(name+'\n'); results.push({ name, ms: time(text) }); }
process.stdout.write(JSON.stringify({baselineMs,results}));
`;
const HARD_TIMEOUT_MS = 5000;
async function runTiming(group) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childCode, group], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, HARD_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(timedOut, false, `${group} exceeded hard ${HARD_TIMEOUT_MS}ms timeout; ${stderr.slice(-200)}`);
        assert.equal(signal, null, stderr.slice(-400)); assert.equal(code, 0, stderr.slice(-600));
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}
for (const group of ['whitespace', 'quotes', 'depth', 'corpus']) {
  test(`safeText linear-time counter-example: ${group}`, async (t) => {
    const { baselineMs, results } = await runTiming(group);
    const budget = Math.max(250, baselineMs * 40);
    if (group === 'corpus') assert.ok(results.length >= 80);
    assert.deepEqual(results.filter((r) => r.ms > budget), [], `budget ${budget.toFixed(2)}ms`);
    t.diagnostic(`${results.length} cases, worst ${Math.max(...results.map((r) => r.ms)).toFixed(2)}ms; baseline ${baselineMs.toFixed(2)}ms`);
  });
}
test('page redaction bounds input before scanning and marks all truncation', async () => {
  const body = 'ordinary words '.repeat(20000) + 'password=secret-tail';
  const out = safeText(body, 40000);
  assert.ok(out.length <= 40000); assert.match(out, /truncated/); assert.doesNotMatch(out, /secret-tail/);
  const lookups = createLookups({ client: { run: async () => ({ slug: 'notes/public', window: { text: body } }) } });
  const response = await lookups.page('notes/public');
  assert.equal(response.data.truncated, true); assert.match(response.data.content, /truncated/);
});
test('encoded JSON depth is bounded without leaking credentials or damaging prose', () => {
  let secret = JSON.stringify({ token: 'abc123' });
  let prose = JSON.stringify({ secret: 'ship small diffs' });
  for (let i = 0; i < 8; i++) { secret = JSON.stringify(secret); if (i < 3) prose = JSON.stringify(prose); }
  assert.doesNotMatch(safeText(secret, 40000), /abc123/);
  assert.equal(safeText(prose, 40000), prose);
});
test('caller cannot lift the scan bound or expose a credential fragment at the cut', () => {
  const head = 'password=' + 'a'.repeat(39900) + '\n';
  const value = head + ' '.repeat(40000 - head.length - 'token: abc'.length) + 'token: abcSECRETTAIL';
  const out = safeText(value, 1_000_000);
  assert.ok(out.length <= 40000); assert.match(out, /truncated/);
  assert.doesNotMatch(out, /abc|SECRETTAIL/);
});
test('single-token credentials containing assignment punctuation are still completely redacted', () => {
  for (const value of ['abc=def', 'abc:def', 'abcd:efgh==', 'a:b=c:d', 'a=b=c=d']) {
    const out = safeText(`token: ${value}`, 40000);
    assert.equal(out.includes(value), false, value); assert.match(out, /redacted/);
  }
});
test('quoted whitespace prose, encoded prose and shield-like literal characters stay byte-identical', () => {
  for (const value of ['secret: " abc "', 'password: " use the password manager "',
    'The secret: ship small diffs', "Don't rewrite ordinary prose.",
    JSON.stringify(JSON.stringify({ secret: 'ship: small=diffs please' })),
    'notes/\ue000c\ue000e', 'Title: ordinary \ue000 text', 'https://example.test/path?limit=20']) {
    assert.equal(safeText(value, 40000), value, value);
  }
});
