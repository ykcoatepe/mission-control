const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCronService } = require('../server/services/cronData');

function makeCronServiceWithJobs(initialJobs, extra = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cron-data-'));
  const jobsDir = path.join(homeDir, '.hermes', 'profiles', 'hmudur', 'cron');
  fs.mkdirSync(jobsDir, { recursive: true });
  const jobsFile = path.join(jobsDir, 'jobs.json');
  fs.writeFileSync(jobsFile, `${JSON.stringify({ jobs: initialJobs }, null, 2)}\n`, 'utf8');

  const runner = { run: async (_bin, argv, options) => {
    assert.equal(options.lane, 'hermes');
    assert.deepEqual(argv.slice(0, 3), ['--profile', 'hmudur', 'cron']);
    const document = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
    const job = document.jobs.find(job => job.id === argv[4]);
    if (argv[3] === 'pause' || argv[3] === 'resume') {
      job.enabled = argv[3] === 'resume'; job.state = job.enabled ? 'scheduled' : 'paused';
    }
    if (argv[3] === 'edit') for (const field of ['model', 'provider']) {
      const flag = argv.find(arg => arg.startsWith('--' + field + '='));
      if (flag) job[field] = flag.slice(field.length + 3);
    }
    if (argv[3] !== 'list') fs.writeFileSync(jobsFile, JSON.stringify(document));
    return { ok: true, stdout: 'ok', stderr: '' };
  } };
  const service = createCronService({
    runner,
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

test('testHermesCodexModelRefKeepsOpenAiNamespace via supported CLI', async () => {
  const { service, jobsFile } = makeCronServiceWithJobs([{
    id: 'job-1',
    provider: 'openai-codex',
    model: 'openai/gpt-5.4',
    base_url: null,
  }]);

  await service.updateHermesCronJobModel('job-1', 'openai-codex/gpt-5.5');
  const [updated] = await service.readCronJobsForVerification('hermes');
  const persisted = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));

  assert.equal(updated.payload.model, 'openai-codex/openai/gpt-5.5');
  assert.equal(persisted.jobs[0].provider, 'openai-codex');
  assert.equal(persisted.jobs[0].model, 'openai/gpt-5.5');
});

test('testHermesCronCommandsPreserveRuntimeFields', async () => {
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

  await service.updateHermesCronJobEnabled('job-1', false);
  const persisted = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));

  assert.equal(persisted.jobs[0].enabled, false);
  assert.equal(persisted.jobs[0].last_run_at, '2026-05-24T09:01:05+03:00');
  assert.equal(persisted.jobs[0].next_run_at, '2026-05-25T09:00:00+03:00');
  assert.equal(persisted.jobs[1].last_run_at, '2026-05-24T10:00:00+03:00');
});

test('testHermesCronCommandsPreserveFilePermissions', async () => {
  const { service, jobsFile } = makeCronServiceWithJobs([{ id: 'job-1', enabled: true }]);
  fs.chmodSync(jobsFile, 0o600);

  await service.updateHermesCronJobEnabled('job-1', false);

  assert.equal(fs.statSync(jobsFile).mode & 0o777, 0o600);
});

test('testCronServiceDefaultsToConfiguredHostHome without direct mutation', async () => {
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
      runner: { run: async (_bin, argv, options) => {
        assert.equal(options.env.HOME, homeDir); assert.equal(argv[3], 'pause');
        const doc = JSON.parse(fs.readFileSync(path.join(jobsDir, 'jobs.json'), 'utf8'));
        doc.jobs[0].enabled = false; doc.jobs[0].state = 'paused';
        fs.writeFileSync(path.join(jobsDir, 'jobs.json'), JSON.stringify(doc));
        return { ok: true, stdout: 'ok' };
      } },
    });

    await service.updateHermesCronJobEnabled('job-1', false);
    const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, 'jobs.json'), 'utf8'));
    assert.equal(persisted.jobs[0].enabled, false);
  } finally {
    if (previousHome === undefined) delete process.env.MC_USER_HOME;
    else process.env.MC_USER_HOME = previousHome;
  }
});

test('testOperationsCronEvidenceTracksSchedulersIndependently', async () => {
  const { service } = makeCronServiceWithJobs([{ id: 'hermes-job', enabled: true }]);
  const result = await service.fetchCronJobsForOperations();

  assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, true);
  assert.equal(result.operationsSource.schedulers.openclaw.provenance, 'openclaw-cron-cli-json');
  assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, true);
  assert.equal(result.operationsSource.schedulers.hermes.provenance, 'hermes-cron-disk');
  assert.ok(Number.isFinite(Date.parse(result.operationsSource.schedulers.openclaw.observedAt)));
  assert.ok(Number.isFinite(Date.parse(result.operationsSource.schedulers.hermes.observedAt)));
  assert.equal(result.jobs.filter((job) => job.scheduler === 'hermes').length, 1);
});

test('testFallbackEmptyCronResultsHaveNoSyntheticObservation', async () => {
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
      runner: { run: async (_bin, argv, options) => {
        assert.equal(options.env.HOME, homeDir); assert.equal(argv[3], 'pause');
        const doc = JSON.parse(fs.readFileSync(path.join(jobsDir, 'jobs.json'), 'utf8'));
        doc.jobs[0].enabled = false; doc.jobs[0].state = 'paused';
        fs.writeFileSync(path.join(jobsDir, 'jobs.json'), JSON.stringify(doc));
        return { ok: true, stdout: 'ok' };
      } },
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
});

console.log('cronData tests passed');

function fakeClock() {
  let t = Date.parse('2026-11-11T06:00:00.000Z');
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('testHermesCronFailureWithRecentCacheStaysFresh', async () => {
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
});

test('testHermesCronFailureWithoutCacheIsUnavailable', async () => {
  const { service, jobsFile } = makeCronServiceWithJobs([{ id: 'h1' }]);
  fs.writeFileSync(jobsFile, 'not json', 'utf8');
  const result = await service.fetchCronJobsForOperations();
  assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, false);
});

async function testSlowOpenclawProbeNeverStarvesHermesCronEvidence() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], {
    openclawExec: async () => {
      await gate;
      return { stdout: '[]', stderr: '' };
    },
    operationsSoftDeadlineMs: 30,
  });
  const started = Date.now();
  try {
    const result = await service.fetchCronJobsForOperations();
    assert.ok(Date.now() - started < 2000, 'must return near the soft deadline');
    assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, true);
    assert.equal(result.operationsSource.schedulers.openclaw.sourceSucceeded, false);
    assert.equal(result.operationsSource.schedulers.openclaw.observedAt, null);
  } finally {
    release();
    await service.fetchCronJobsForOperations(); // drain the shared refresh
  }
}

async function testSlowOpenclawProbeServesCachedEvidenceAndSharesTheRefresh() {
  const clock = fakeClock();
  const cachedAt = clock.now();
  let hang = false;
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], {
    now: clock.now,
    operationsSoftDeadlineMs: 30,
    openclawExec: async () => {
      calls += 1;
      if (hang) await gate;
      return { stdout: JSON.stringify([{ id: 'o1' }]), stderr: '' };
    },
  });
  await service.fetchCronJobsForOperations();
  hang = true;
  clock.advance(20_000);
  const before = calls;
  try {
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
    for (const ageMs of [300_000, 300_001, 600_000, 600_001]) {
      clock.advance(ageMs - (clock.now() - cachedAt));
      const result = await service.fetchCronJobsForOperations();
      const proof = result.operationsSource.schedulers.openclaw;
      if (ageMs > 600_000) {
        assert.equal(proof.sourceSucceeded, false);
        assert.equal(proof.observedAt, null);
        assert.equal(result.jobs.filter((job) => job.scheduler === 'openclaw').length, 0);
      } else {
        assert.equal(proof.sourceSucceeded, true);
        assert.equal(proof.stale === true, ageMs > 300_000);
        assert.equal(ageMs > 300_000 ? proof.staleAgeMs : proof.cacheAgeMs, ageMs);
        assert.equal(result.jobs.filter((job) => job.scheduler === 'openclaw').length, 1);
      }
      assert.equal(result.operationsSource.schedulers.hermes.sourceSucceeded, true);
      assert.equal(calls - before, 1, 'all deadline reads share the same blocked probe');
    }
  } finally {
    release();
    await service.fetchCronJobsForOperations(); // drain the shared refresh
  }
}

test('slow OpenClaw probes preserve independent evidence and share cached refreshes', async () => {
  // These fakes have no subprocess handles. The interval only supplies that
  // liveness; the real, unchanged soft deadlines control the assertions.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    await testSlowOpenclawProbeNeverStarvesHermesCronEvidence();
    await testSlowOpenclawProbeServesCachedEvidenceAndSharesTheRefresh();
  } finally {
    clearInterval(keepAlive);
  }
});

test('scheduler proofs carry the cache limits a holder ages them against', async () => {
  const { service } = makeCronServiceWithJobs([{ id: 'h1', enabled: true }], { freshMs: 1_234, maxStaleMs: 5_678 });
  const result = await service.fetchCronJobsForOperations();
  for (const scheduler of ['openclaw', 'hermes']) {
    const proof = result.operationsSource.schedulers[scheduler];
    assert.equal(proof.sourceSucceeded, true);
    assert.equal(proof.freshMs, 1_234);
    assert.equal(proof.maxStaleMs, 5_678);
  }
});
