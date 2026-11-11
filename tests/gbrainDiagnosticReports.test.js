'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { buildGBrainRouter } = require('../server/routes/gbrain/router');
const { runGBrainAction } = require('../server/routes/gbrain/actionsExecutor');
const { GBrainActionDefinitions, activeGBrainActions } = require('../server/routes/gbrain/constants');
const { errorHandler } = require('../server/core/http');
const { withLiveLoop } = require('./helpers/liveLoop');
const doctor = (clean = false) => ({ schema_version: 2, status: clean ? 'healthy' : 'unhealthy',
  health_score: clean ? 100 : 45, brain_checks_score: 100, category_scores: { resolver: clean ? 100 : 0 },
  checks: [{ name: 'resolver_health', status: clean ? 'pass' : 'fail',
    message: clean ? 'No issues' : '110 issue(s): 39 error(s), 71 warning(s)',
    issues: clean ? [] : [{ severity: 'error', message: 'Routing unavailable' }] }] });
function execResult(report, extra = {}) {
  return { ok: false, code: 1, signal: null, error: null, timedOut: false, truncated: false,
    stdout: JSON.stringify(report), stderr: '', latencyMs: 581, ...extra };
}
async function withApi(exec, fn) {
  return withLiveLoop(async () => {
    const app = express(); app.use(express.json());
    app.use(buildGBrainRouter({ exec, gbrainOverviewService: {} }));
    app.use(errorHandler({ logger: { error() {} } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    try { await fn(async (action, confirmed) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/gbrain/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, confirmed }) });
      return { code: r.status, body: await r.json() };
    }); } finally { await new Promise((resolve) => server.close(resolve)); }
  });
}
test('real doctor findings report completes with HTTP 200 and readable structured findings', async () => {
  await withApi({ run: async () => execResult(doctor()) }, async (post) => {
    const { code, body } = await post('doctor-fast');
    assert.equal(code, 200); assert.equal(body.status, 'completed'); assert.equal(body.ok, true);
    assert.equal(body.outcome, 'findings'); assert.equal(body.result.reportStatus, 'unhealthy');
    assert.equal(body.result.healthScore, 45); assert.deepEqual(body.result.failing, [
      { name: 'resolver_health', status: 'fail', message: '110 issue(s): 39 error(s), 71 warning(s)' }]);
    assert.deepEqual(body.result.warning, []); assert.equal(body.result.counts.failing, 1);
    assert.match(body.summary, /Check finished: unhealthy \(45\/100\)/);
    assert.match(body.summary, /1 check failed: resolver_health/); assert.match(body.summary, /110 issues \(39 errors, 71 warnings\)/);
    assert.doesNotMatch(body.summary, /schema_version|\{"/);
    // The HTTP 200 reaches the existing frontend onSuccess path, which uses
    // refreshAfter (not outcome) to call refreshReadings / startVerifying.
    assert.equal(body.refreshAfter, true); assert.equal(body.pending, false); assert.equal('error' in body, false);
  });
});
test('a clean diagnostic report completes with outcome clean', async () => {
  await withApi({ run: async () => execResult(doctor(true), { ok: true, code: 0 }) }, async (post) => {
    const { code, body } = await post('doctor-fast');
    assert.equal(code, 200); assert.equal(body.outcome, 'clean'); assert.equal(body.result.healthScore, 100);
    assert.deepEqual(body.result.failing, []); assert.equal(body.result.counts.checks, 1);
  });
});
test('garbage or wrong-schema nonzero reports keep 502 rather than manufacturing success', async () => {
  for (const stdout of ['not JSON', '{}', '{"status":"unhealthy"}', '{"schema_version":2,"status":"unhealthy","checks":"broken"}']) {
    await withApi({ run: async () => execResult(null, { stdout }) }, async (post) => {
      const { code, body } = await post('doctor-fast');
      assert.equal(code, 502); assert.equal(body.status, 'failed'); assert.equal(body.error.code, 'gbrain_action_failed');
      assert.equal('outcome' in body, false);
    });
  }
});
test('operational failures never become completed because stdout happens to contain a report', async () => {
  for (const [extra, expected] of [
    [{ code: null, error: { code: 'ENOENT' } }, 502],
    [{ code: 1, timedOut: true, error: { code: 'timeout' } }, 504],
    [{ code: null, error: { code: 'lane_busy' } }, 502],
    [{ code: 1, error: { code: 'lane_quarantined' } }, 503],
    [{ code: 1, error: { code: 'kill_unverified' } }, 503],
    [{ code: 1, truncated: true, error: { code: 'max_output' } }, 502],
    [{ code: 1, signal: 'SIGTERM', error: { code: 'shutdown' } }, 502],
  ]) await withApi({ run: async () => execResult(doctor(), extra) }, async (post) => {
    const { code, body } = await post('doctor-fast'); assert.equal(code, expected);
    assert.notEqual(body.status, 'completed'); assert.equal('outcome' in body, false);
  });
});
test('skill routing and storage schemas get findings/clean without inventing a health score', async () => {
  const cases = [
    ['check-resolvable', { ok: false, report: { ok: false, errors: [{ type: 'unreachable', severity: 'error', skill: 'router', message: 'Unreachable' }], warnings: [], issues: [{ severity: 'error' }], summary: { total_skills: 1 } } }, 'findings'],
    ['check-resolvable', { ok: true, report: { ok: true, errors: [], warnings: [], issues: [], summary: { total_skills: 1 } } }, 'clean'],
    ['storage-status', { totalPages: 4, pagesByTier: { db_tracked: 4 }, diskUsageByTier: {}, missingFiles: ['notes/lost.md'], warnings: ['Tier file missing'] }, 'findings'],
    ['storage-status', { totalPages: 4, pagesByTier: { db_tracked: 4 }, diskUsageByTier: {}, missingFiles: [], warnings: [] }, 'clean'],
  ];
  for (const [action, payload, outcome] of cases) await withApi({ run: async () => execResult(payload, { ok: outcome === 'clean', code: outcome === 'clean' ? 0 : 1 }) }, async (post) => {
    const { code, body } = await post(action);
    assert.equal(code, 200, action); assert.equal(body.outcome, outcome); assert.equal(body.result.healthScore, null);
    assert.equal(body.result.reportStatus, null); assert.equal(body.refreshAfter, false);
  });
});
test('diagnostic payloads whitelist and scrub fields, cap issues and disclose the remainder', async () => withLiveLoop(async () => {
  const report = doctor();
  report.token = 'should-never-leave';
  report.checks[0].issues = Array.from({ length: 100 }, (_, i) => ({ severity: 'error', message: `Issue ${i} password=hunter22 /Users/alice/notes`, transcript: 'should-never-leave' }));
  const result = await runGBrainAction('doctor-fast', { exec: { run: async () => execResult(report) } });
  assert.equal(result.status, 'completed'); assert.ok(result.payload.checks[0].issues.length < 100);
  assert.equal(result.payload.checks[0].issuesOmitted, 100 - result.payload.checks[0].issues.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= 32768);
  assert.doesNotMatch(JSON.stringify(result), /hunter22|\/Users\/alice|should-never-leave/);
  assert.equal(activeGBrainActions.size, 0);
}));
test('preview and W1 nonzero report paths remain failures and W1 confirmation/argv are unchanged', async () => withLiveLoop(async () => {
  const before = JSON.stringify(GBrainActionDefinitions); let calls = 0;
  const exec = { run: async (_bin, args, options) => {
    calls++; assert.equal(options.lane, 'gbrain-action');
    assert.deepEqual(args, calls === 1 ? GBrainActionDefinitions['preview-sync'].args : GBrainActionDefinitions['sync-sources'].args);
    return execResult(doctor());
  } };
  assert.equal((await runGBrainAction('preview-sync', { exec })).status, 'failed');
  const blocked = await runGBrainAction('sync-sources', { exec, confirmed: 'true' });
  assert.equal(blocked.status, 'confirmation-required'); assert.equal(calls, 1);
  const result = await runGBrainAction('sync-sources', { exec, confirmed: true });
  assert.equal(result.status, 'failed'); assert.equal('outcome' in result, false); assert.equal(calls, 2);
  assert.equal(JSON.stringify(GBrainActionDefinitions), before); assert.equal(activeGBrainActions.size, 0);
}));
test('a storage refusal is not relabelled as an invented missing-file count', async () => withLiveLoop(async () => {
  const payload = { totalPages: 4, pagesByTier: {}, diskUsageByTier: {}, missingFiles: [], warnings: [],
    restoreRefusal: { code: 'not_restorable', message: 'No restore candidate' } };
  const r = await runGBrainAction('storage-status', { exec: { run: async () => execResult(payload) } });
  assert.equal(r.status, 'completed'); assert.equal(r.result.counts.missingFiles, 0);
  assert.equal(r.result.counts.failing, 1); assert.doesNotMatch(r.summary, /1 missing file/);
  assert.match(r.summary, /1 restore refusal/);
}));
test('absent scores stay null and warning-only reports are completed findings', async () => withLiveLoop(async () => {
  const payload = doctor(true); delete payload.health_score;
  payload.checks[0].status = 'warn'; payload.checks[0].message = 'Review resolver warnings';
  const r = await runGBrainAction('doctor-fast', { exec: { run: async () => execResult(payload, { ok: true, code: 0 }) } });
  assert.equal(r.result.healthScore, null); assert.doesNotMatch(r.summary, /100\/100/);
  assert.equal(r.outcome, 'findings'); assert.equal(r.result.counts.warning, 1); assert.equal(r.refreshAfter, true);
}));
test('large diagnostic reports keep bounded detail and exact omitted counts', async () => withLiveLoop(async () => {
  const payload = doctor();
  payload.checks = Array.from({ length: 60 }, (_, i) => ({ name: `check_${i}`, status: 'fail', message: 'A'.repeat(1000),
    issues: Array.from({ length: 100 }, () => ({ name: 'N'.repeat(200), severity: 'error', message: 'M'.repeat(1000), action: 'R'.repeat(1000) })) }));
  const r = await runGBrainAction('doctor-fast', { exec: { run: async () => execResult(payload) } });
  assert.equal(r.status, 'completed'); assert.ok(Buffer.byteLength(JSON.stringify(r.payload)) <= 32768);
  assert.equal(r.result.counts.checks, 60); assert.equal(r.result.counts.failing, 60);
  assert.equal(r.result.counts.failingOmitted, 60 - r.result.failing.length);
  assert.equal(r.payload.checksOmitted, 60 - r.payload.checks.length);
  for (const c of r.payload.checks) assert.equal(c.issuesOmitted, 100 - c.issues.length);
}));
test('routing report issue counts are errors, not fabricated failed-check counts', async () => withLiveLoop(async () => {
  const payload = { ok: false, report: { ok: false, errors: [{ skill: 'router', severity: 'error', message: 'Unreachable' }], warnings: [], issues: [], summary: {} } };
  const r = await runGBrainAction('check-resolvable', { exec: { run: async () => execResult(payload) } });
  assert.match(r.summary, /1 error/); assert.doesNotMatch(r.summary, /1 check failed/);
}));
