const assert = require('node:assert/strict');
const test = require('node:test');

const { createGBrainExecOptions } = require('../server/routes/gbrain/commandRunner');

test('Mission Control read-only probes suppress interactive GBrain startup hooks', () => {
  const options = createGBrainExecOptions(1000, { suppressStartupHooks: true });

  assert.equal(options.env.GBRAIN_SKIP_STARTUP_HOOKS, '1');
});

test('Maintenance actions preserve GBrain startup rails', () => {
  const inherited = process.env.GBRAIN_SKIP_STARTUP_HOOKS;
  delete process.env.GBRAIN_SKIP_STARTUP_HOOKS;
  try {
    const options = createGBrainExecOptions(1000);

    assert.equal(options.env.GBRAIN_SKIP_STARTUP_HOOKS, undefined);
  } finally {
    if (inherited !== undefined) process.env.GBRAIN_SKIP_STARTUP_HOOKS = inherited;
  }
});
