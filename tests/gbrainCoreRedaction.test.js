'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrubText } = require('../server/core/scrub');
const { safeText, createLookups } = require('../server/sources/gbrain/lookups');
const { withLiveLoop } = require('./helpers/liveLoop');
const reproductions = [
  ['GBRAIN_TOKEN=4f9a8b7c6d5e4f3a2b1c', '4f9a8b7c6d5e4f3a2b1c'],
  ['client_secret: 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
  ['db_password=s3cr3tvalue', 's3cr3tvalue'],
  ['aws_secret_access_key = AKIAIOSFODNN7EXAMPLEKEY', 'AKIAIOSFODNN7EXAMPLEKEY'],
  ['MY_API_KEY=abcd1234efgh', 'abcd1234efgh'],
  ['login user=bob password=hunter22 host=db1', 'hunter22'],
  ['password: hunter22 user: bob', 'hunter22'],
];
function corpus() {
  const out = reproductions.map(([text, value]) => ({ text, values: [value] }));
  const names = ['GBRAIN_TOKEN', 'client_secret', 'db_password', 'aws_secret_access_key', 'MY_API_KEY', 'password', 'secret', 'token', 'authorization'];
  for (const words of [['client','secret'], ['db','password'], ['application','token'], ['my','api','key'], ['auth','credential'], ['vendor','passphrase'], ['private','signing','key'], ['project','session','id'], ['remote','cookie']]) {
    for (const sep of ['_', '-', '.']) names.push(words.join(sep));
    names.push(words.map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join(''));
  }
  for (const name of names) for (const sep of ['=', ':', ' = ', ': ', ' : ', '= ']) {
    for (const quote of ['', '"', "'"]) for (const value of ['4f9a8b7c6d5e4f3a2b1c', 'entirelyalphabeticcredential', 'alpha5 beta6', 'correct horse battery staple']) {
      const assignment = `${name}${sep}${quote}${value}${quote}`;
      const values = [value, ...(value.includes(' ') ? value.split(' ') : [])];
      out.push({ text: assignment, values });
      out.push({ text: `user=bob ${assignment} host=db1`, values });
      out.push({ text: `${assignment} password: hunter22 next=public`, values: [...values, 'hunter22'] });
    }
  }
  return out;
}
test('core-authoritative differential corpus never exposes a credential removed by scrubText', (t) => {
  const cases = corpus(); let comparisons = 0;
  assert.ok(cases.length >= 2000);
  for (const { text, values } of cases) {
    const core = scrubText(text); const page = safeText(text, 40000);
    for (const value of values) if (!core.includes(value)) {
      comparisons++; assert.equal(page.includes(value), false, text);
    }
  }
  assert.ok(comparisons >= 2000);
  t.diagnostic(`${cases.length} generated/reproduction inputs; ${comparisons} credential comparisons`);
});
test('all seven reviewer reproductions are hidden in actual page and search projections', async () => withLiveLoop(async () => {
  const body = reproductions.map(([text]) => text).join('\n');
  const lookup = createLookups({ client: { run: async (args) => args[3] === 'get_page'
    ? { slug: 'notes/public', window: { text: body } }
    : [{ slug: 'notes/public', title: body, type: 'note', chunk_text: body }] } });
  for (const response of [await lookup.page('notes/public'), await lookup.search('public')]) {
    const serialized = JSON.stringify(response);
    for (const [, value] of reproductions) assert.equal(serialized.includes(value), false);
  }
}));
test('single prose assignments preserve sentences; a second assignment is never prose', () => {
  for (const text of ['secret: ship small diffs', 'password: use the password manager',
    'password: read the handbook before changing settings.', 'secret: this sentence describes the feature',
    '{"secret": "ship small diffs"}']) assert.equal(safeText(text, 40000), text);
  for (const text of ['password: hunter22 user: bob', 'password=hunter22 user=bob',
    'login user=bob password=hunter22 host=db1']) assert.doesNotMatch(safeText(text, 40000), /hunter22/);
});
test('short additions end values at the next assignment rather than treating a row as prose', () => {
  for (const [text, value] of [
    ['user=bob MY_API_KEY=abcd1234efgh host=db1', 'abcd1234efgh'],
    ['user:bob token:abc123 host:db1', 'abc123'],
    ['user=bob "token"="abc123" host=db1', 'abc123'],
    ['token:abc=def user=bob', 'abc=def'],
  ]) assert.equal(safeText(text, 40000).includes(value), false, text);
});
test('alphabetic credential phrases and a trailing comment are not automatically prose', () => {
  for (const [text, value] of [
    ['password: aaaa bbbb', 'aaaa'], ['password: huntertoken comment', 'huntertoken'],
    ['secret: "correct horse battery staple"', 'correct horse battery staple'],
    ['private_secret_note: huntertoken comment', 'huntertoken'],
    ['password: " abcd "', 'abcd'],
  ]) {
    assert.equal(scrubText(text).includes(value), false);
    assert.equal(safeText(text, 40000).includes(value), false, text);
  }
});
