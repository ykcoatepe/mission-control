'use strict';

// The redaction / scrub path must be linear-time: it runs on error text,
// action diagnostics and page bodies, so one odd string must not stall the
// event loop. Each target runs over tests/fixtures/adversarialCorpus.js
// (200 KB strings) in a CHILD PROCESS with a hard timeout: a catastrophic
// regression fails this test instead of hanging the suite. The budget is
// relative to the same function on ordinary text of the same size.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { adversarialCorpus, ordinaryText, SIZE } = require('./fixtures/adversarialCorpus');
const { redactString, REDACT_MAX_CHARS } = require('../server/core/config');
const { scrubText, SCRUB_MAX_CHARS } = require('../server/core/scrub');

const CHILD = path.join(__dirname, 'fixtures', 'scrubTimingChild.js');
const HARD_TIMEOUT_MS = 30_000;
const RATIO = 40; // adversarial may cost at most 40x ordinary text...
const FLOOR_MS = 250; // ...or this, whichever is larger (noise on a busy machine)

function runTiming(modulePath, exportName, options) {
  const result = spawnSync(process.execPath, [CHILD, modulePath, exportName, options ? JSON.stringify(options) : '-'], {
    cwd: path.join(__dirname, '..'), timeout: HARD_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const lastEntry = String(result.stderr || '').trim().split('\n').pop();
  assert.equal(result.signal, null, `${exportName} did not finish within ${HARD_TIMEOUT_MS} ms; stuck on corpus entry "${lastEntry}"`);
  assert.equal(result.status, 0, `${exportName} crashed on corpus entry "${lastEntry}": ${String(result.stderr).slice(-400)}`);
  return JSON.parse(result.stdout);
}

function assertLinear(label, { baselineMs, results }) {
  assert.ok(results.length >= 80, 'the whole corpus ran');
  const budget = Math.max(RATIO * baselineMs, FLOOR_MS);
  const over = results.filter((entry) => entry.ms > budget).map((entry) => `${entry.name}: ${entry.ms} ms`);
  assert.deepEqual(over, [], `${label}: over the budget of ${budget.toFixed(0)} ms (baseline ${baselineMs.toFixed(2)} ms on ordinary text)`);
}

test('the corpus contains the reviewer reproduction and is 200 KB per entry', () => {
  const corpus = adversarialCorpus();
  assert.equal(SIZE, 204_800);
  assert.ok(corpus.some(([, text]) => text === 'a-'.repeat(102_400)), 'reviewer input "a-".repeat(102400)');
  for (const [name, text] of corpus) assert.ok(text.length >= SIZE * 0.9, `${name} is ${text.length} chars`);
});

test('counter-example: redactString stays linear on 200 KB adversarial strings', () => {
  assertLinear('redactString', runTiming('server/core/config.js', 'redactString'));
});

test('counter-example: scrubText stays linear with its default bound', () => {
  assertLinear('scrubText', runTiming('server/core/scrub.js', 'scrubText'));
});

test('counter-example: the path patterns themselves are linear (scrubText with the bound lifted to the full 200 KB)', () => {
  assertLinear('scrubText unbounded', runTiming('server/core/scrub.js', 'scrubText', { maxChars: 1_000_000 }));
});

test('input is bounded before scanning: nothing past the bound is returned, a marker says how much was dropped', () => {
  const secret = 'password=hunter2 /Users/alice/x';
  const long = `${'ordinary words '.repeat(Math.ceil(SCRUB_MAX_CHARS / 15))}`.slice(0, SCRUB_MAX_CHARS) + secret + 'TAIL'.repeat(1000);
  const out = scrubText(long);
  assert.equal(out.length < SCRUB_MAX_CHARS + 64, true);
  assert.doesNotMatch(out, /hunter2|alice|TAIL/);
  assert.match(out, new RegExp(`…\\[truncated ${long.length - SCRUB_MAX_CHARS} chars\\]$`));
  // A secret straddling the bound is cut, and its visible half is still redacted.
  const straddle = `${'x '.repeat(SCRUB_MAX_CHARS / 2).slice(0, SCRUB_MAX_CHARS - 12)}password=hunter2-and-more`;
  assert.doesNotMatch(scrubText(straddle), /hunter/);

  const big = `${ordinaryText(REDACT_MAX_CHARS)}token=A1b2C3d4E5f6A1b2C3d4E5f6 tail`;
  const redacted = redactString(big);
  assert.doesNotMatch(redacted, /A1b2C3d4|tail$/);
  assert.match(redacted, /…\[truncated \d+ chars\]$/);
  // Under the bound nothing changes: same output as before, no marker.
  assert.equal(scrubText('see /Users/alice/x and password=hunter2'), 'see ~/x and password=[redacted]');
  assert.equal(redactString(ordinaryText(1000)), ordinaryText(1000));
});

test('the settings export never carries an unscanned oversize string', () => {
  const { redact } = require('../server/core/config');
  const out = redact({ note: `${'a'.repeat(REDACT_MAX_CHARS)} password=hunter2`, ok: 'fine' });
  assert.deepEqual(out, { note: '[redacted]', ok: 'fine' });
});
