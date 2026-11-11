const test = require('node:test');
const assert = require('node:assert/strict');

const { createExec } = require('../server/core/exec');

// A controllable execFile stand-in: every call is recorded and finishes only
// when the test says so.
function fakeExecFile() {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  function execFileImpl(file, args, options, callback) {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    const call = {
      file,
      args,
      options,
      killedWith: null,
      finish(error, stdout = '', stderr = '') {
        if (call.done) return;
        call.done = true;
        running -= 1;
        callback(error, stdout, stderr);
      },
    };
    call.child = {
      pid: 1000 + calls.length,
      kill(signal) {
        call.killedWith = signal;
        const error = new Error('killed');
        error.killed = true;
        error.signal = signal;
        error.code = null;
        call.finish(error, '', '');
      },
    };
    calls.push(call);
    return call.child;
  }
  return { execFileImpl, calls, stats: () => ({ running, maxRunning }) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('openclaw lane never runs two calls at the same time', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const results = [
    exec.run('openclaw', ['sessions', '--json'], { lane: 'openclaw' }),
    exec.run('openclaw', ['system', 'heartbeat', 'last', '--json'], { lane: 'openclaw' }),
    exec.run('openclaw', ['status'], { lane: 'openclaw' }),
    exec.run('openclaw', ['cron', 'list', '--json'], { lane: 'openclaw' }),
  ];
  await tick();
  assert.equal(fake.calls.length, 1, 'only the first call may start');
  assert.equal(exec.status().lanes.openclaw.queued, 3);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(fake.stats().running, 1);
    fake.calls[index].finish(null, `out-${index}`, '');
    await tick();
  }
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map((r) => r.stdout), ['out-0', 'out-1', 'out-2', 'out-3']);
  assert.equal(fake.stats().maxRunning, 1, 'counter-example: two openclaw children overlapped');
  assert.equal(exec.status().lanes.openclaw.maxObservedRunning, 1);
});

test('lanes run independently with their own limits', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const pending = [];
  for (let i = 0; i < 3; i += 1) pending.push(exec.run('gbrain', ['x'], { lane: 'gbrain' }));
  for (let i = 0; i < 6; i += 1) pending.push(exec.run('tool', ['y']));
  pending.push(exec.run('openclaw', ['status'], { lane: 'openclaw' }));
  await tick();
  const status = exec.status().lanes;
  assert.equal(status.gbrain.running, 2);
  assert.equal(status.gbrain.queued, 1);
  assert.equal(status.default.running, 4);
  assert.equal(status.default.queued, 2);
  assert.equal(status.openclaw.running, 1);
  while (fake.calls.some((c) => !c.done)) {
    fake.calls.filter((c) => !c.done).forEach((c) => c.finish(null, '', ''));
    await tick();
  }
  await Promise.all(pending);
});

test('a non-zero exit resolves a typed failure and never throws', async () => {
  const exec = createExec();
  const result = await exec.run(process.execPath, ['-e', 'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(3)']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'partial');
  assert.equal(result.stderr, 'boom');
  assert.equal(result.timedOut, false);
  assert.equal(typeof result.latencyMs, 'number');
});

test('success returns stdout and code 0', async () => {
  const exec = createExec();
  const result = await exec.run(process.execPath, ['-e', 'console.log(JSON.stringify({a:1}))']);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { a: 1 });
  assert.equal(result.error, null);
});

test('per-call timeout kills the child and reports timedOut', async () => {
  const exec = createExec();
  const started = Date.now();
  const result = await exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('output beyond maxOutputBytes is cut and reported', async () => {
  const exec = createExec();
  const result = await exec.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000))'], { maxOutputBytes: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
  assert.equal(result.error.code, 'max_output');
});

test('a missing binary is a typed failure, not a throw', async () => {
  const exec = createExec();
  const result = await exec.run('/nonexistent/definitely-not-a-binary', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ENOENT');
});

test('argv only: shell strings, shell option and unknown lanes are rejected', () => {
  const exec = createExec({ execFileImpl: fakeExecFile().execFileImpl });
  assert.throws(() => exec.run('openclaw status 2>&1'.split(' ')[0], 'status 2>&1'), TypeError);
  assert.throws(() => exec.run('sh', ['-c', 'x'], { shell: true }), TypeError);
  assert.throws(() => exec.run('openclaw', ['status'], { lane: 'openClaw' }), /unknown lane/);
  assert.throws(() => exec.run('openclaw', [42]), TypeError);
});

test('execFile is called without a shell and with the call options', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const pending = exec.run('openclaw', ['status'], { lane: 'openclaw', timeoutMs: 1234, maxOutputBytes: 99, env: { A: '1' } });
  await tick();
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.maxBuffer, 99);
  assert.deepEqual(fake.calls[0].options.env, { A: '1' });
  fake.calls[0].finish(null, '', '');
  await pending;
});

test('single flight by key shares one child; different keys do not', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const a = exec.run('openclaw', ['sessions'], { lane: 'openclaw', key: 'sessions' });
  const b = exec.run('openclaw', ['sessions'], { lane: 'openclaw', key: 'sessions' });
  assert.equal(a, b);
  const c = exec.run('openclaw', ['status'], { lane: 'openclaw', key: 'status' });
  await tick();
  fake.calls[0].finish(null, 'S', '');
  await tick();
  fake.calls[1].finish(null, 'T', '');
  assert.equal((await a).stdout, 'S');
  assert.equal((await c).stdout, 'T');
  assert.equal(fake.calls.length, 2);
  // After settling, the key is free again.
  const d = exec.run('openclaw', ['sessions'], { lane: 'openclaw', key: 'sessions' });
  await tick();
  assert.equal(fake.calls.length, 3);
  fake.calls[2].finish(null, '', '');
  await d;
});

test('a call waiting too long for its lane fails with queue_timeout', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const first = exec.run('openclaw', ['status'], { lane: 'openclaw' });
  const second = await exec.run('openclaw', ['sessions'], { lane: 'openclaw', queueTimeoutMs: 30 });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'queue_timeout');
  assert.equal(fake.calls.length, 1, 'the queued call never started');
  fake.calls[0].finish(null, '', '');
  await first;
});

test('killAll kills running children, fails queued calls and refuses new work', async () => {
  const fake = fakeExecFile();
  const exec = createExec({ execFileImpl: fake.execFileImpl });
  const running = exec.run('openclaw', ['status'], { lane: 'openclaw' });
  const queued = exec.run('openclaw', ['sessions'], { lane: 'openclaw' });
  await tick();
  assert.equal(exec.killAll(), 1);
  assert.equal(fake.calls[0].killedWith, 'SIGTERM');
  const [r1, r2] = await Promise.all([running, queued]);
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'shutdown');
  assert.equal(r2.error.code, 'shutdown');
  const after = await exec.run('openclaw', ['status'], { lane: 'openclaw' });
  assert.equal(after.error.code, 'shutdown');
  assert.equal(fake.calls.length, 1);
});

test('a real child is killed on shutdown', async () => {
  const exec = createExec();
  const pending = exec.run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(exec.status().children, 1);
  exec.killAll();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'shutdown');
  assert.equal(exec.status().children, 0);
});
