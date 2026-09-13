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

test('Health-probe timeout constants are exported to liveProbes and Operations', () => {
  const gbrainConstants = require('../server/routes/gbrain/constants');

  assert.equal(gbrainConstants.HEALTH_PROBE_SOFT_TIMEOUT_MS, 30000);
  assert.equal(gbrainConstants.HEALTH_PROBE_HARD_KILL_DELAY_MS, 30000);
  assert.equal(gbrainConstants.GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS, 195000);
});

test('Soft-timeout path forwards suppressStartupHooks to the spawned child', async () => {
  const { runGBrainWithSoftTimeout } = require('../server/routes/gbrain/commandRunner');
  const { EventEmitter } = require('node:events');

  const captureSpawn = () => {
    const captured = { options: null, child: null };
    const spawner = (cmd, args, options) => {
      captured.options = options;
      const child = new EventEmitter();
      child.kill = () => {};
      captured.child = child;
      setImmediate(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    };
    return { captured, spawner };
  };

  const suppressed = captureSpawn();
  await runGBrainWithSoftTimeout(['health'], { suppressStartupHooks: true, softTimeoutMs: 30000 }, suppressed.spawner);
  assert.equal(suppressed.captured.options.env.GBRAIN_SKIP_STARTUP_HOOKS, '1');

  const withRails = captureSpawn();
  await runGBrainWithSoftTimeout(['health'], { softTimeoutMs: 30000 }, withRails.spawner);
  assert.equal(withRails.captured.options.env.GBRAIN_SKIP_STARTUP_HOOKS, undefined);
});

test('soft-timeout path resolves on stream close so buffered output is not truncated', async () => {
  const { runGBrainWithSoftTimeout } = require('../server/routes/gbrain/commandRunner');
  const { EventEmitter } = require('node:events');

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const spawner = () => child;

  setImmediate(() => {
    child.stdout.emit('data', '{"partial":');
    child.emit('exit', 0, null);
    setImmediate(() => {
      child.stdout.emit('data', 'true}');
      child.emit('close', 0, null);
    });
  });

  const result = await runGBrainWithSoftTimeout(['stats'], { softTimeoutMs: 30000 }, spawner);

  assert.equal(result.ok, true);
  assert.equal(result.stdout, '{"partial":true}');
});
