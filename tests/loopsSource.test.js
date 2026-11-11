// Manager-loop source and /api/loops routes. Fake exec and fake fs only: no
// real mloop, no real ledger.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createMloopSource, loopsView, loopDetailView, parseMloopJson } = require('../server/sources/mloop');
const { buildLoopsRouter } = require('../server/routes/loops');
const { errorHandler } = require('../server/core/http');

const NOW = Date.parse('2026-11-11T10:00:00Z');
const LEDGER = '/fake/mloop';
const SECRET = 'ARGUS-SECRET';

function ok(body) {
  return { ok: true, code: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', timedOut: false };
}
function fail(stderrBody, code = 2) {
  return { ok: false, code, stdout: '', stderr: JSON.stringify(stderrBody), timedOut: false, error: { code: String(code), message: 'exit' } };
}

const CHECK_ROWS = [
  { project: 'gbrain-maint', code: 'TEYIT_STALE', subject: 'TEYIT_STALE', severity: 'warning', detail: 'count=2; Bearer abc.def', ts: '2026-11-10T02:00:00Z', count: 2 },
  { project: 'gbrain-maint', code: 'BINDING_DEAD', subject: 'old-worker', severity: 'warning', detail: 'silent since /Users/someone/x', ts: '2026-11-09T00:00:00Z' },
  { project: 'mloop-maint', code: 'ESCALATED_ROUNDS', subject: 'P59', severity: 'error', detail: 'ROUND_CAP', ts: '2026-11-11T07:00:00Z' },
  { project: 'argus-live', code: 'TEYIT_STALE', subject: `${SECRET}-subject`, severity: 'error', detail: `${SECRET} order detail`, ts: '2026-11-11T01:00:00Z', count: 3 },
  { project: 'argus-live', code: 'BINDING_DEAD', subject: `${SECRET}-trader-bot`, severity: 'warning', detail: `${SECRET} participant`, ts: '2026-11-11T01:00:00Z' },
  { project: 'argus-live', code: 'DEPLOYED_UNCONFIRMED', subject: 'P9', severity: 'warning', detail: `${SECRET} phase`, ts: '2026-11-11T01:00:00Z' },
];

function fakeFs({ dirs = ['gbrain-maint', 'mloop-maint', 'argus-live', 'disguised', 'no-ledger'], touched = [] } = {}) {
  return {
    touched,
    async readdir(dir) {
      assert.equal(dir, LEDGER);
      return [...dirs.map((name) => ({ name, isDirectory: () => true })), { name: 'bindings.json', isDirectory: () => false }];
    },
    async stat(file) {
      touched.push(file);
      if (file.includes('no-ledger')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true, mtimeMs: NOW - 60_000 };
    },
  };
}

function statusFor(project) {
  if (project === 'disguised') return `# disguised\nOutcome: ${SECRET} Argus trading desk\n`;
  return `# ${project}\nOutcome: keep ${project} healthy\n\n## Acceptance criteria\n- K1 met\n`;
}

function fakeExec({ checkResult = ok(CHECK_ROWS), calls = [] } = {}) {
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args]);
      if (args[0] === 'check') return typeof checkResult === 'function' ? checkResult() : checkResult;
      const project = args[1];
      const command = args[3];
      if (command === 'status') return ok(JSON.stringify(statusFor(project)));
      if (command === 'teyit') {
        return ok([
          { id: 'T1', unit: 'sync cron', how: 'jobs.json last_status', deadline: '2026-11-10T00:00:00Z', state: 'open', closed: false, kind: 'live_confirmation', source_line: 'raw line never shown' },
          { id: 'T2', unit: 'future check', how: 'look', deadline: '2026-12-01T00:00:00Z', state: 'open', closed: false },
          { id: 'T3', unit: 'done', how: 'x', deadline: null, state: 'closed', closed: true },
        ]);
      }
      if (command === 'participants') {
        return ok([
          { name: 'manager', role: 'manager', host: 'claude', contact: true, session: 'secret-session-id' },
          { name: 'old-worker', role: 'implementer', host: 'codex', contact: false },
        ]);
      }
      return fail({ code: 'CLI_USAGE', message: 'unexpected' });
    },
  };
}

function makeSource(options = {}) {
  const exec = options.exec || fakeExec();
  const fsImpl = options.fsImpl || fakeFs();
  const source = createMloopSource({ exec, fsImpl, ledgerDir: LEDGER, bin: '/fake/bin/mloop', now: () => NOW });
  return { source, exec, fsImpl };
}

async function withRouter(source, run) {
  const app = express();
  app.use(buildLoopsRouter({ loopsSource: source }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('mloop source builds whitelisted projects, pending confirmations and a ranked attention list', async () => {
  const { source } = makeSource();
  await source.refresh();
  const snap = source.snapshot();
  assert.equal(snap.meta.ok, true);
  const view = loopsView(snap.data);
  const ids = view.projects.map((p) => p.id);
  assert.deepEqual(ids, ['argus-live', 'disguised', 'gbrain-maint', 'mloop-maint'], 'no-ledger dir (no events.jsonl) is not a project');

  const gbrain = view.projects.find((p) => p.id === 'gbrain-maint');
  assert.equal(gbrain.title, 'gbrain-maint');
  assert.equal(gbrain.outcome, 'keep gbrain-maint healthy');
  assert.deepEqual(gbrain.openFindings.byCode, { TEYIT_STALE: 1, BINDING_DEAD: 1 });
  assert.deepEqual(gbrain.pendingConfirmations.map((c) => [c.id, c.unit, c.verification, c.overdue]), [
    ['T1', 'sync cron', 'jobs.json last_status', true],
    ['T2', 'future check', 'look', false],
  ]);
  assert.deepEqual(gbrain.participants, [
    { name: 'manager', role: 'manager', host: 'claude', alive: true },
    { name: 'old-worker', role: 'implementer', host: 'codex', alive: false },
  ]);
  assert.equal(gbrain.lastActivityAt, new Date(NOW - 60_000).toISOString());
  const raw = JSON.stringify(view);
  assert.doesNotMatch(raw, /secret-session-id|raw line never shown|Bearer abc|\/Users\/someone/);

  // Ranked: error first, then warnings oldest first.
  assert.equal(view.attention[0].severity, 'error');
  assert.deepEqual(view.attention.slice(0, 2).map((a) => a.project).sort(), ['argus-live', 'mloop-maint']);
  const warnings = view.attention.filter((a) => a.severity === 'warning' && !a.restricted);
  assert.deepEqual(warnings.map((a) => a.code), ['BINDING_DEAD', 'TEYIT_STALE']);
  assert.equal(view.totals.projects, 4);
});

test('Argus counter-example: restricted projects expose counts only and are never queried', async () => {
  const { source, exec, fsImpl } = makeSource();
  await source.refresh();
  const data = source.snapshot().data;

  // No per-project command and no file access for an Argus project.
  assert.equal(exec.calls.some((call) => call.some((arg) => /argus/i.test(arg))), false, 'an argus-specific mloop command ran');
  assert.equal(fsImpl.touched.some((file) => /argus/i.test(file)), false, 'an Argus ledger file was touched');
  // A project whose title turns out to match is cut off before teyit/participants.
  assert.equal(exec.calls.some((call) => call.includes('disguised') && (call.includes('teyit') || call.includes('participants'))), false);

  const view = loopsView(data);
  const argus = view.projects.find((p) => p.id === 'argus-live');
  assert.deepEqual(argus, {
    id: 'argus-live', restricted: true, openFindings: 3, pendingConfirmations: 4, overdueConfirmations: 3,
    operatorFindings: 2, worstSeverity: 'error', countsBasis: 'mloop-check',
  });
  const disguised = view.projects.find((p) => p.id === 'disguised');
  assert.equal(disguised.restricted, true);
  assert.equal('title' in disguised || 'participants' in disguised || 'statusMarkdown' in disguised, false);
  const argusAttention = view.attention.filter((a) => a.project === 'argus-live');
  assert.deepEqual(argusAttention, [{ project: 'argus-live', kind: 'restricted', restricted: true, severity: 'error', count: 3 }]);

  // Neither endpoint ever carries the restricted titles, text or participants.
  await withRouter(source, async (base) => {
    const list = await fetch(`${base}/api/loops`);
    const detail = await fetch(`${base}/api/loops/argus-live`);
    const disguisedDetail = await fetch(`${base}/api/loops/disguised`);
    assert.equal(list.status, 200);
    assert.equal(detail.status, 200);
    for (const body of [await list.text(), await detail.text(), await disguisedDetail.text()]) {
      assert.doesNotMatch(body, new RegExp(SECRET));
      assert.doesNotMatch(body, /trader-bot|order detail|trading desk/);
    }
  });
  // Not even memory holds them.
  assert.doesNotMatch(JSON.stringify(data), new RegExp(SECRET));
});

test('detail route returns status markdown; unknown or invalid ids are client errors', async () => {
  const { source } = makeSource();
  await source.refresh();
  await withRouter(source, async (base) => {
    const detail = await (await fetch(`${base}/api/loops/gbrain-maint`)).json();
    assert.match(detail.data.statusMarkdown, /## Acceptance criteria/);
    assert.equal(detail.data.findings.length, 2);
    assert.equal(detail.meta.source, 'mloop.loops');
    const missing = await fetch(`${base}/api/loops/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'loop_project_not_found', message: 'No manager-loop project with that id' } });
    const bad = await fetch(`${base}/api/loops/${encodeURIComponent('../etc')}`);
    assert.equal(bad.status, 400);
  });
});

test('rc=0 with a {code,message} body is an error, never data', async () => {
  assert.throws(() => parseMloopJson(ok({ code: 'NOT_FOUND', message: 'no project' }), 'status'), { code: 'mloop_error_body' });
  assert.throws(() => parseMloopJson(fail({ code: 'CLI_USAGE', message: 'bad' }), 'check'), { code: 'mloop_cli_usage' });
  assert.throws(() => parseMloopJson(ok('not json'), 'check'), { code: 'mloop_unparsable' });

  const { source } = makeSource({ exec: fakeExec({ checkResult: ok({ code: 'LEDGER_CORRUPT', message: 'x' }) }) });
  await source.refresh();
  const snap = source.snapshot();
  assert.equal(snap.data, null, 'no fabricated empty project list');
  assert.equal(snap.meta.error.code, 'mloop_error_body');
  await withRouter(source, async (base) => {
    const res = await fetch(`${base}/api/loops`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).data, null);
  });
});

test('a failed refresh keeps the last good ledger view and marks it stale', async () => {
  let mode = 'ok';
  const exec = fakeExec({ checkResult: () => (mode === 'ok' ? ok(CHECK_ROWS) : { ok: false, code: null, stdout: '', stderr: '', timedOut: true, error: { code: 'timeout' } }) });
  const { source } = makeSource({ exec });
  await source.refresh();
  const first = source.snapshot().data;
  mode = 'down';
  await source.refresh();
  const snap = source.snapshot();
  assert.equal(snap.data, first);
  assert.equal(snap.meta.stale, true);
  assert.equal(snap.meta.error.code, 'mloop_timeout');
});

test('a failed per-project part is reported as an error and null, not an empty list', async () => {
  const base = fakeExec();
  const exec = {
    calls: [],
    async run(file, args) {
      if (args[3] === 'participants') return fail({ code: 'LEDGER_LOCKED', message: 'busy' });
      return base.run(file, args);
    },
  };
  const { source } = makeSource({ exec });
  await source.refresh();
  const gbrain = loopDetailView(source.snapshot().data, 'gbrain-maint');
  assert.equal(gbrain.participants, null);
  assert.deepEqual(gbrain.errors, [{ part: 'participants', code: 'mloop_ledger_locked' }]);
});

test('GET /api/loops never runs mloop', async () => {
  const { source, exec } = makeSource();
  await source.refresh();
  const before = exec.calls.length;
  await withRouter(source, async (base) => {
    await fetch(`${base}/api/loops`);
    await fetch(`${base}/api/loops/gbrain-maint`);
  });
  assert.equal(exec.calls.length, before);
});

test('status markdown and finding text go through the shared scrubber; detail is full, summary is bounded', async () => {
  const longDetail = `open at twice its deadline window: ${'keep or kill this confirmation; '.repeat(20)}see /var/root/notes and %2FUsers%2Falice%2Fprivate`;
  const exec = {
    calls: [],
    async run(file, args) {
      if (args[0] === 'check') {
        return ok([{ project: 'gbrain-maint', code: 'TEYIT_KEEP_KILL', subject: 'r10', severity: 'warning', detail: longDetail, ts: '2026-11-10T00:00:00Z' }]);
      }
      const command = args[3];
      if (command === 'status') {
        return ok(JSON.stringify('# gbrain-maint\nOutcome: ok\n- evidence: /System/Volumes/Data/Users/alice/gbr/k8.md\n- C:\\Users\\alice\\x\n- /var/root/.ssh/id\n'));
      }
      return ok([]);
    },
  };
  const { source } = makeSource({ exec, fsImpl: fakeFs({ dirs: ['gbrain-maint'] }) });
  await source.refresh();
  const data = source.snapshot().data;
  const detail = loopDetailView(data, 'gbrain-maint');
  assert.doesNotMatch(detail.statusMarkdown, /alice|\/var\/root/i);
  assert.match(detail.statusMarkdown, /evidence: ~\/gbr\/k8\.md/);
  const [item] = loopsView(data).attention;
  for (const text of [item.detail, detail.findings[0].detail]) {
    assert.doesNotMatch(text, /alice|\/var\/root|%2FUsers/i);
    assert.doesNotMatch(text, /…$/, 'detail is not cut with an ellipsis');
    assert.match(text, /see ~\/notes and ~\/private$/);
  }
  assert.ok(item.detail.length > 300);
  assert.equal(typeof item.summary, 'string');
  assert.ok(item.summary.length <= 160, `summary is ${item.summary.length} chars`);
  assert.ok(item.detail.startsWith(item.summary.replace(/…$/, '')));
  assert.equal(detail.findings[0].summary, item.summary);
});
