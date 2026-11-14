const assert = require('node:assert/strict');
const test = require('node:test');

const { runGBrainAction } = require('../server/routes/gbrain/actionsExecutor');

function fakeExec(result) {
  return { run: async () => ({ stdout: '', stderr: '', ...result }) };
}

test('a failed GBrain action logs the scrubbed tail of the command output', async () => {
  const lines = [];
  const stderr = [
    '[embed.pages] start',
    'x'.repeat(400),
    'Error [lock_held]: brain lock is held by another writer (pid 4242)',
    'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked',
  ].join('\n');
  const result = await runGBrainAction('embed-missing', {
    confirmed: true,
    exec: fakeExec({ ok: false, code: 1, stderr }),
    logFailure: (line) => lines.push(line),
  });

  assert.equal(result.status, 'failed');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'gbrain_action_failed');
  assert.equal(entry.action, 'embed-missing');
  assert.equal(entry.status, 'failed');
  assert.equal(entry.code, 1);
  // The tail is what names the cause; the head is progress noise.
  assert.match(entry.output, /lock_held/);
  assert.doesNotMatch(entry.output, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/);
  assert.ok(entry.output.length <= 800);
});

test('a completed GBrain action logs nothing', async () => {
  const lines = [];
  const result = await runGBrainAction('embed-missing', {
    confirmed: true,
    exec: fakeExec({ ok: true, code: 0, stdout: 'Embedded 2 chunks across 2 pages' }),
    logFailure: (line) => lines.push(line),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(lines, []);
});

test('a timed-out GBrain action is logged with its status', async () => {
  const lines = [];
  await runGBrainAction('embed-missing', {
    confirmed: true,
    exec: fakeExec({ ok: false, timedOut: true, stderr: 'still embedding' }),
    logFailure: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.status, 'timed-out');
  assert.equal(entry.timedOut, true);
});
