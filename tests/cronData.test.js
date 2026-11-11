const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCronService } = require('../server/services/cronData');

function makeCronServiceWithJobs(initialJobs, extra = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cron-data-'));
  const jobsDir = path.join(homeDir, '.hermes', 'profiles', 'hmudur', 'cron');
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobsFile = path.join(jobsDir, 'jobs.json');
  fs.writeFileSync(jobsFile, `${JSON.stringify({ jobs: initialJobs }, null, 2)}\n`, 'utf8');

  const service = createCronService({
    openclawExec: async () => ({ stdout: '[]', stderr: '' }),
    gatewayPort: 18789,
    gatewayToken: '',
    getOpenclawDefaultModelKey: () => '',
    calendarFile: path.join(homeDir, 'calendar.json'),
    homeDir,
    hermesProfile: 'hmudur',
    ...extra,
  });

  return { service, jobsFile, homeDir };
}

(function testHermesCodexModelRefKeepsOpenAiNamespace() {
  const { service, jobsFile } = makeCronServiceWithJobs([{
    id: 'job-1',
    provider: 'openai-codex',
    model: 'openai/gpt-5.4',
    base_url: null,
  }]);

  const updated = service.updateHermesCronJobModel('job-1', 'openai-codex/gpt-5.5');
  const persisted = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));

  assert.equal(updated.payload.model, 'openai-codex/openai/gpt-5.5');
  assert.equal(persisted.jobs[0].provider, 'openai-codex');
  assert.equal(persisted.jobs[0].model, 'openai/gpt-5.5');
})();

(function testHermesCronPatchPreservesRuntimeFields() {
  const { service, jobsFile } = makeCronServiceWithJobs([{
    id: 'job-1',
    enabled: true,
    provider: 'openai-codex',
    model: 'openai/gpt-5.5',
    last_run_at: '2026-05-24T09:01:05+03:00',
    next_run_at: '2026-05-25T09:00:00+03:00',
  }, {
    id: 'job-2',
    enabled: true,
    last_run_at: '2026-05-24T10:00:00+03:00',
  }]);

  service.updateHermesCronJobEnabled('job-1', false);
  const persisted = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));

  assert.equal(persisted.jobs[0].enabled, false);
  assert.equal(persisted.jobs[0].last_run_at, '2026-05-24T09:01:05+03:00');
  assert.equal(persisted.jobs[0].next_run_at, '2026-05-25T09:00:00+03:00');
  assert.equal(persisted.jobs[1].last_run_at, '2026-05-24T10:00:00+03:00');
})();

(function testHermesCronPatchPreservesFilePermissions() {
  const { service, jobsFile } = makeCronServiceWithJobs([{ id: 'job-1', enabled: true }]);
  fs.chmodSync(jobsFile, 0o600);

  service.updateHermesCronJobEnabled('job-1', false);

  assert.equal(fs.statSync(jobsFile).mode & 0o777, 0o600);
})();

(function testCronServiceDefaultsToConfiguredHostHome() {
  const previousHome = process.env.MC_USER_HOME;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cron-home-'));
  const jobsDir = path.join(homeDir, '.hermes', 'profiles', 'hmudur', 'cron');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'jobs.json'), `${JSON.stringify({ jobs: [{ id: 'job-1', enabled: true }] }, null, 2)}\n`, 'utf8');

  try {
    process.env.MC_USER_HOME = homeDir;
    const service = createCronService({
      openclawExec: async () => ({ stdout: '[]', stderr: '' }),
      gatewayPort: 18789,
      gatewayToken: '',
      getOpenclawDefaultModelKey: () => '',
      calendarFile: path.join(homeDir, 'calendar.json'),
      hermesProfile: 'hmudur',
    });

    service.updateHermesCronJobEnabled('job-1', false);
    const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, 'jobs.json'), 'utf8'));
    assert.equal(persisted.jobs[0].enabled, false);
  } finally {
    if (previousHome === undefined) delete process.env.MC_USER_HOME;
    else process.env.MC_USER_HOME = previousHome;
  }
})();

(async function testOperationsCronEvidenceTracksSchedulersIndependently() {
  const { service } = makeCronServiceWithJobs([{ id: 'hermes-job', enabled: true }]);
  const result = await service.fetchCronJobsForOperations();

  assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, true);
  assert.equal(result.operationsSource.schedulers.openclaw.provenance, 'openclaw-cron-cli-json');
  assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, true);
  assert.equal(result.operationsSource.schedulers.hermes.provenance, 'hermes-cron-disk');
  assert.ok(Number.isFinite(Date.parse(result.operationsSource.schedulers.openclaw.observedAt)));
  assert.ok(Number.isFinite(Date.parse(result.operationsSource.schedulers.hermes.observedAt)));
  assert.equal(result.jobs.filter((job) => job.scheduler === 'hermes').length, 1);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

(async function testFallbackEmptyCronResultsHaveNoSyntheticObservation() {
  const originalFetch = global.fetch;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cron-unavailable-'));
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  try {
    const service = createCronService({
      openclawExec: async () => { throw new Error('openclaw unavailable'); },
      gatewayPort: 18789,
      gatewayToken: '',
      getOpenclawDefaultModelKey: () => '',
      calendarFile: path.join(homeDir, 'calendar.json'),
      homeDir,
      hermesProfile: 'hmudur',
    });
    const result = await service.fetchCronJobsForOperations();

    assert.deepEqual(result.jobs, []);
    assert.equal(result.operationsSource.sourceSucceeded, false);
    assert.equal(result.operationsSource.observedAt, null);
    assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, false);
    assert.equal(result.operationsSource.schedulers.openclaw.observedAt, null);
    assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, false);
    assert.equal(result.operationsSource.schedulers.hermes.observedAt, null);
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log('cronData tests passed');

function fakeClock() {
  let t = Date.parse('2026-11-11T06:00:00.000Z');
  return { now: () => t, advance: (ms) => { t += ms; } };
}

(async function testHermesCronFailureWithRecentCacheStaysFresh() {
  const clock = fakeClock();
  const { service, jobsFile } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], { now: clock.now });
  const first = await service.fetchCronJobsForOperations();
  assert.equal(first.operationsSource.schedulers.hermes.sourceSucceeded, true);

  fs.writeFileSync(jobsFile, 'not json', 'utf8');
  clock.advance(17_000);
  const second = await service.fetchCronJobsForOperations();
  const hermes = second.operationsSource.schedulers.hermes;
  assert.equal(hermes.sourceSucceeded, true);
  assert.equal(hermes.stale, undefined);
  assert.equal(hermes.cacheAgeMs, 17_000);
  assert.equal(second.jobs.filter((job) => job.scheduler === 'hermes').length, 1);

  clock.advance(6 * 60_000);
  const third = await service.fetchCronJobsForOperations();
  assert.equal(third.operationsSource.schedulers.hermes.sourceSucceeded, true);
  assert.equal(third.operationsSource.schedulers.hermes.stale, true);
  assert.ok(third.operationsSource.schedulers.hermes.staleAgeMs > 5 * 60_000);

  clock.advance(5 * 60_000);
  const fourth = await service.fetchCronJobsForOperations();
  assert.equal(fourth.operationsSource.schedulers.hermes.sourceSucceeded, false);
  assert.equal(fourth.operationsSource.schedulers.hermes.observedAt, null);
  assert.equal(fourth.jobs.filter((job) => job.scheduler === 'hermes').length, 0);
})().catch((error) => { console.error(error); process.exitCode = 1; });

(async function testHermesCronFailureWithoutCacheIsUnavailable() {
  const { service, jobsFile } = makeCronServiceWithJobs([{ id: 'h1' }]);
  fs.writeFileSync(jobsFile, 'not json', 'utf8');
  const result = await service.fetchCronJobsForOperations();
  assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, false);
})().catch((error) => { console.error(error); process.exitCode = 1; });

(async function testSlowOpenclawProbeNeverStarvesHermesCronEvidence() {
  const { service } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], {
    openclawExec: () => new Promise(() => {}),
    operationsSoftDeadlineMs: 30,
  });
  const started = Date.now();
  const result = await service.fetchCronJobsForOperations();
  assert.ok(Date.now() - started < 2000, 'must return near the soft deadline');
  assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, true);
  assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, false);
  assert.equal(result.operationsSource.schedulers.openclaw.observedAt, null);
})().catch((error) => { console.error(error); process.exitCode = 1; });

(async function testSlowOpenclawProbeServesCachedEvidenceAndSharesTheRefresh() {
  const clock = fakeClock();
  let hang = false;
  let calls = 0;
  const { service } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], {
    now: clock.now,
    operationsSoftDeadlineMs: 30,
    openclawExec: () => {
      calls += 1;
      if (hang) return new Promise(() => {});
      return Promise.resolve({ stdout: JSON.stringify([{ id: 'o1' }]), stderr: '' });
    },
  });
  await service.fetchCronJobsForOperations();
  hang = true;
  clock.advance(20_000);
  const before = calls;
  const [a, b] = await Promise.all([
    service.fetchCronJobsForOperations(),
    service.fetchCronJobsForOperations(),
  ]);
  for (const result of [a, b]) {
    assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, true);
    assert.equal(result.operationsSource.schedulers.openclaw.cacheAgeMs, 20_000);
    assert.equal(result.jobs.filter((job) => job.scheduler === 'openclaw').length, 1);
  }
  assert.equal(calls - before, 1, 'concurrent callers share one in-flight probe');
})().catch((error) => { console.error(error); process.exitCode = 1; });
