'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeText, createLookups } = require('../server/sources/gbrain/lookups');
const { buildGBrainOverview } = require('../server/routes/gbrain/overview');

const secrets = [
  ['token: abc123', 'abc123'], ['pass: hunter2', 'hunter2'], ['password = hunter2', 'hunter2'],
  ['passwd: four', 'four'], ['pwd = abcd', 'abcd'], ['secret: abcd', 'abcd'],
  ['api_key: abc123', 'abc123'], ['api-key = abc123', 'abc123'], ['api key: abc123', 'abc123'],
  ['APIKEY = abc123', 'abc123'], ['api.key: abc123', 'abc123'], ['authorization: abc123', 'abc123'], ['credential = abcd', 'abcd'],
  ['{"token": "abc123"}', 'abc123'], ["pass = 'hunter2'", 'hunter2'],
  ['{\n "token":\n  "abc123"\n}', 'abc123'], ['pass:\n hunter2', 'hunter2'],
  ['- token: abc123', 'abc123'], ['secret_key = "hunter2"', 'hunter2'],
];
const prose = [
  'The secret: ship small diffs', 'secret: ship small diffs', 'password = use the password manager',
  'pass: read the documentation', 'token: a brief explanation', 'api key: see the deployment guide',
  'authorization: review the handbook', 'credential = use a local profile',
  'token: abc', 'pass = xyz', 'token_count: 12345', 'max_tokens = 4096',
  'secretary: abc123', 'mytoken: abc123', 'password_hint: readable hint',
  'authorization_policy: abc123', 'api_key_usage: 10000', 'Press any key: enter',
  'projects/mission-control', 'notes/password-policy', 'Health: 100, pages: 63273',
  'https://example.test/docs?limit=20', 'The bearer of good news arrived.',
  '{"secret": "ship small diffs"}', 'credential: "read the handbook"',
  'config.token_count: 63273', 'private_secret_note: ordinary words',
  "secret: 'ship' small diffs", 'password: "read" the handbook',
  'secret: read https://example.test/docs',
  'to ken: abc123', 'pass word: hunter2', 't_oken: abc123',
];
test('N4 complete credential keys redact single-token values of at least four characters', () => {
  for (const [input, value] of secrets) {
    const output = safeText(input, 40_000);
    assert.equal(output.includes(value), false, input); assert.match(output, /redacted/, input);
  }
});
test('N4 complete-key prose and noncredential controls remain byte-identical', () => {
  assert.ok(prose.length >= 15);
  for (const input of prose) assert.equal(safeText(input, 40_000), input, input);
});
test('N4 page and search share the complete-key rule including encoded JSON examples', async () => {
  const body = ['token: abc123', 'pass: hunter2', 'The secret: ship small diffs', JSON.stringify(JSON.stringify({ token: 'abc123' }))].join('\n');
  const lookups = createLookups({ client: { run: async (args) => args[3] === 'get_page'
    ? { slug: 'notes/example', window: { text: body } }
    : [{ slug: 'notes/example', type: 'note', chunk_text: body }] } });
  for (const response of [await lookups.page('notes/example'), await lookups.search('example')]) {
    const output = JSON.stringify(response);
    assert.doesNotMatch(output, /abc123|hunter2/); assert.match(output, /The secret: ship small diffs/);
  }
});
test('leftover memory-role tile is not a live healthy reading', () => {
  for (const state of ['healthy', 'warning', 'unavailable']) {
    const overview = buildGBrainOverview({}, { verdict: { state, reasons: [] } });
    assert.equal(overview.cockpit.memoryRole.value, 'Shared brain');
    assert.equal(overview.cockpit.memoryRole.status, 'inactive');
  }
});
test('leftover unconsumed compatibility shim is not shipped', () => {
  assert.equal(require('node:fs').existsSync(require('node:path').join(__dirname, '../server/sources/usage/compatibility.js')), false);
});
