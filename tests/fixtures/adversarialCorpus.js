'use strict';

// Adversarial inputs for the redaction / scrub path. Every entry is built to
// SIZE characters. A backtracking pattern that rescans a long run from many
// start positions goes quadratic on at least one of them.

const SIZE = 200 * 1024;

function fill(unit, size = SIZE) {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

const UNITS = {
  'a-': 'a-',
  '=': '=',
  ':': ':',
  '@': '@',
  '/': '/',
  '%2F': '%2F',
  backslash: '\\',
  'escaped backslash': '\\\\',
  'escaped slash': '\\/',
  space: ' ',
  quote: '"',
  'alternating quotes': '"\'',
  'quote word': '"a\'b',
  'word_sep': 'word_',
  'word.sep': 'word.',
  'word-word_ run': 'alpha-beta_gamma.',
  'a:': 'a:',
  'a=': 'a=',
  'a@': 'a@',
  'a/': 'a/',
  'a.b': 'a.b',
  digits: '123456-',
  'digits:': '1234567:',
  'sk-': 'sk-',
  'sk-a': 'sk-aaaaaaaaaaaaaaaa-',
  eyJ: 'eyJaaaaaaaa-',
  'eyJ.': 'eyJaaaaaaaa.aaaaaaaa-',
  'ghp_': 'ghp_',
  'xoxb-': 'xoxb-',
  'AKIA': 'AKIA',
  'Bearer ': 'Bearer ',
  'bearer spaces': 'bearer    ',
  'authorization ': 'authorization ',
  'authorization:': 'authorization: ',
  'key=': 'key=',
  'key:': 'key:',
  'key="': 'key="',
  "key='": "key='",
  'key="a b ': 'key="a b ',
  'token=a,': 'token=a,',
  'password=': 'password=',
  'password="': 'password="',
  'pwd:"\'': 'pwd:"\'',
  'http://': 'http://',
  'a://': 'a://',
  'a://b@': 'a://b:c@',
  'http://a:b': 'http://a:b',
  'scheme run': 'a+b.c-',
  '/Users/': '/Users/',
  '/Users/a': '/Users/a',
  '/Users/a/': '/Users/a/',
  '@/Users/a.': '@/Users/a.',
  '%2fusers%2f': '%2fusers%2f',
  '%2fusers%2fa': '%2fusers%2fa',
  '/private': '/private',
  '/var/root': '/var/root',
  'C:\\Users\\': 'C:\\Users\\',
  'C:\\Users\\a': 'C:\\Users\\a',
  'C:\\\\Users\\\\a': 'C:\\\\Users\\\\a',
  '\\\\?\\C:': '\\\\?\\C:\\Users\\',
  '-----BEGIN ': '-----BEGIN ',
  'BEGIN A ': '-----BEGIN A A A A A A ',
  'BEGIN PRIVATE KEY': '-----BEGIN PRIVATE KEY-----a',
  '${A': '${A',
  '\\u0041': '\\u0041',
  '\\u': '\\u',
  '{"a":"': '{"a":"',
  '\\"': '\\"',
  '%': '%',
  '%2': '%2',
  '~': '~',
  'x x': 'x ',
  newline: '\n',
  tab: 'a\t',
  unicode: 'ü—🚀',
};

// One very long run with a single trigger at the front and none at the end:
// catches "scan to the end, fail, backtrack" patterns.
const LONG_RUNS = {
  'key= + blob + :': `key=${'k='.repeat(SIZE / 2)}`.slice(0, SIZE - 1) + ':',
  'sk- + letters': `sk-${'a'.repeat(SIZE)}`.slice(0, SIZE),
  'eyJ + letters': `eyJ${'a'.repeat(SIZE)}`.slice(0, SIZE),
  'http:// + letters': `http://${'a'.repeat(SIZE)}`.slice(0, SIZE),
  'http://u: + letters': `http://u:${'a'.repeat(SIZE)}`.slice(0, SIZE),
  '/Users/ + letters': `/Users/${'a'.repeat(SIZE)}`.slice(0, SIZE),
  'password=" + letters': `password="${'a'.repeat(SIZE)}`.slice(0, SIZE),
  'letters': 'a'.repeat(SIZE),
  'letters + =': `${'a'.repeat(SIZE - 1)}=`,
  'Bearer + spaces': `Bearer${' '.repeat(SIZE)}`.slice(0, SIZE),
  'authorization + spaces': `authorization${' '.repeat(SIZE)}`.slice(0, SIZE),
  'json string of backslashes': JSON.stringify('\\'.repeat(SIZE / 2)).slice(0, SIZE),
  'nested json': JSON.stringify(JSON.stringify(JSON.stringify({ p: 'C:\\Users\\alice\\x '.repeat(SIZE / 30) }))).slice(0, SIZE),
};

function ordinaryText(size = SIZE) {
  const line = 'The scheduler refreshed 14 sources in 320 ms; gbrain doctor reported health 97 and 63273 pages (see docs/runbook.md, https://example.com/help?id=42).\n';
  return fill(line, size);
}

function adversarialCorpus() {
  const out = [];
  for (const [name, unit] of Object.entries(UNITS)) out.push([`repeat ${name}`, fill(unit)]);
  for (const [name, text] of Object.entries(LONG_RUNS)) out.push([name, text]);
  return out;
}

module.exports = { SIZE, adversarialCorpus, ordinaryText, fill };
