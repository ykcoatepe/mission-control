const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLiveGBrainSources,
  createProbeCommandRunner,
} = require('../server/routes/gbrain/liveProbes');

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

test('source snapshot maps authoritative fields and excludes disabled freshness', async () => {
  const calls = [];
  const execFilePromise = async (bin, args) => {
    assert.equal(bin, 'gbrain');
    calls.push(args.join(' '));
    assert.deepEqual(args, ['call', '--source', '__all__', 'get_status_snapshot']);
    return {
      stdout: JSON.stringify({
        sync: {
          sources: [
            {
              source_id: 'tk-omc-ain',
              name: 'TK OM-C AIN',
              sync_enabled: false,
              local_path: '/private/disabled',
              last_sync_at: '2000-01-01T00:00:00.000Z',
              pages: 7,
              chunks_total: 11,
            },
            {
              source_id: 'mission-control',
              sync_enabled: true,
              local_path: '/private/enabled',
              last_sync_at: '2000-01-01T00:00:00.000Z',
              pages: 3,
              chunks_total: 5,
            },
            {
              source_id: 'unknown-flag',
              local_path: '/private/unknown',
              last_sync_at: '2000-01-01T00:00:00.000Z',
              pages: 2,
              chunks_total: 4,
            },
          ],
        },
      }),
      stderr: '',
    };
  };

  const sources = await buildLiveGBrainSources({ execFilePromise });
  const disabled = sources.sources.find((source) => source.id === 'tk-omc-ain');
  const enabled = sources.sources.find((source) => source.id === 'mission-control');
  const unknownFlag = sources.sources.find((source) => source.id === 'unknown-flag');

  assert.deepEqual(calls, ['call --source __all__ get_status_snapshot']);
  assert.equal(disabled.chunks, 11);
  assert.equal(disabled.syncEnabled, false);
  assert.equal(disabled.freshness.status, 'inactive');
  assert.equal(disabled.freshness.syncTracked, false);
  assert.match(disabled.freshness.label, /not applicable/i);
  assert.equal(enabled.freshness.status, 'warning');
  assert.equal(enabled.freshness.syncTracked, true);
  assert.equal(unknownFlag.syncEnabled, null);
  assert.equal(unknownFlag.freshness.status, 'warning');
  assert.equal(unknownFlag.freshness.syncTracked, true);
  assert.equal(sources.freshness.staleCount, 2);
  assert.equal(sources.freshness.untrackedCount, 1);
  assert.doesNotMatch(JSON.stringify(sources), /\/private\//);
});

test('source probe falls back to sources list JSON when snapshot is malformed', async () => {
  const calls = [];
  const execFilePromise = async (_bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'call') return { stdout: JSON.stringify({ sync: { sources: 'bad' } }), stderr: '' };
    if (args.join(' ') === 'sources list --json') {
      return {
        stdout: JSON.stringify({
          sources: [{ id: 'legacy-source', sync_enabled: true, last_sync_at: '2000-01-01T00:00:00.000Z' }],
        }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };

  const sources = await buildLiveGBrainSources({ execFilePromise });

  assert.deepEqual(calls, [
    'call --source __all__ get_status_snapshot',
    'sources list --json',
  ]);
  assert.equal(sources.ok, true);
  assert.equal(sources.sources[0].id, 'legacy-source');
  assert.equal(sources.sources[0].freshness.syncTracked, true);
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
