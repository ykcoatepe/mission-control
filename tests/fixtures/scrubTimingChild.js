'use strict';

// Child process for tests/scrubLinearTime.test.js. Times one function over
// the adversarial corpus and prints JSON. The parent enforces a hard timeout,
// so a catastrophic regression fails the test instead of hanging the suite.
//
//   node scrubTimingChild.js <module path> <export name> [options JSON] [corpus entry name]
// The options object, when given, is passed as the function's second argument.

const path = require('path');
const { adversarialCorpus, ordinaryText } = require('./adversarialCorpus');

const [modulePath, exportName, optionsJson, only] = process.argv.slice(2);
const target = require(path.resolve(modulePath))[exportName];
const options = optionsJson && optionsJson !== '-' ? JSON.parse(optionsJson) : undefined;
const fn = options ? (text) => target(text, options) : target;
if (typeof target !== 'function') {
  console.error(`no function ${exportName} in ${modulePath}`);
  process.exit(2);
}

function time(text) {
  const started = process.hrtime.bigint();
  fn(text);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const ordinary = ordinaryText();
for (let i = 0; i < 3; i += 1) time(ordinary); // warm up
const baselineMs = Math.min(time(ordinary), time(ordinary), time(ordinary));
const results = [];
for (const [name, text] of adversarialCorpus()) {
  if (only && name !== only) continue;
  process.stderr.write(`${name}\n`); // the parent names the entry that hung
  results.push({ name, ms: Math.round(time(text) * 100) / 100 });
}
process.stdout.write(JSON.stringify({ baselineMs, results }));
