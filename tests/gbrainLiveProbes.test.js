const assert = require('node:assert/strict');
const test = require('node:test');

const { createProbeCommandRunner } = require('../server/routes/gbrain/liveProbes');

test('probe runner holds the next command until a timed-out child is reaped', async () => {
  let releaseCleanup;
  let cleanupResolved = false;
  const cleanup = new Promise((resolve) => {
    releaseCleanup = () => {
      cleanupResolved = true;
      resolve();
    };
  });

  const starts = [];
  const fakeRunGBrain = async (_execFilePromise, args) => {
    starts.push({ arg: args[0], cleanupResolved });
    return { ok: false, pending: true, cleanup };
  };

  const runProbeCommand = createProbeCommandRunner(fakeRunGBrain);
  // Mirrors the liveProbes call-site pattern: successor launched only after
  // the previous probe fully returns (including any pending cleanup).
  const flow = (async () => {
    await runProbeCommand(null, ['first'], {});
    await runProbeCommand(null, ['second'], {});
  })();

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.map((entry) => entry.arg), ['first']);

  releaseCleanup();
  await flow;

  assert.equal(starts[1].arg, 'second');
  assert.equal(starts[1].cleanupResolved, true);
});

test('probe runner passes results through untouched when no cleanup is pending', async () => {
  const fakeRunGBrain = async () => ({ ok: true, stdout: '{}' });
  const runProbeCommand = createProbeCommandRunner(fakeRunGBrain);

  const result = await runProbeCommand(null, ['stats'], {});

  assert.deepEqual(result, { ok: true, stdout: '{}' });
});
