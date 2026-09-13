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

test('health chain stops after a soft-timed-out probe instead of stacking successors', async () => {
  const { buildLiveGBrainHealth } = require('../server/routes/gbrain/liveProbes');
  const launched = [];
  const pendingProbe = async (_execFilePromise, args) => {
    launched.push(args[0]);
    return { ok: false, pending: true, stdout: '', stderr: '', error: 'gbrain call exceeded 30s and was asked to stop' };
  };

  const health = await buildLiveGBrainHealth({ probeCommand: pendingProbe });

  assert.equal(health.status, 'unavailable');
  assert.deepEqual(launched, ['call']);
});

test('stats probe returns null after a soft timeout without running the fallback', async () => {
  const { buildLiveGBrainStats } = require('../server/routes/gbrain/liveProbes');
  const launched = [];
  const pendingProbe = async (_execFilePromise, args) => {
    launched.push(args[0]);
    return { ok: false, pending: true, stdout: '', stderr: '' };
  };

  assert.equal(await buildLiveGBrainStats({ probeCommand: pendingProbe }), null);
  assert.deepEqual(launched, ['stats']);
});

test('health chain stops after a timed-out jobs probe instead of backfilling stats', async () => {
  const { buildLiveGBrainHealth } = require('../server/routes/gbrain/liveProbes');
  const launched = [];
  const probe = async (_execFilePromise, args) => {
    launched.push(args[0]);
    if (args[0] === 'call') return { ok: true, stdout: JSON.stringify({ brain_score: 100 }) };
    if (args[0] === 'jobs') return { ok: false, pending: true, stdout: '', stderr: '', error: 'gbrain jobs exceeded 30s and was asked to stop' };
    return { ok: true, stdout: '{}' };
  };

  const health = await buildLiveGBrainHealth({ probeCommand: probe });

  assert.equal(health.status, 'unavailable');
  assert.deepEqual(launched, ['call', 'jobs']);
});
