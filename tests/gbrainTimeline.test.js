const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  captureSnapshotIfNeeded,
  computeTrustDiff,
  createGBrainTimelineService,
  fingerprintSnapshot,
  buildTimelineIncidentBanners,
  normalizeSnapshot,
  pruneTimeline,
  readTimeline,
  sanitizeTimelineText,
} = require('../server/services/gbrainTimeline');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gbrain-timeline-'));
}

function overview(overrides = {}) {
  const capturedAt = overrides.refreshedAt || '2026-05-24T12:00:00.000Z';
  return {
    ok: true,
    mode: 'live-read-only',
    refreshedAt: capturedAt,
    trust: {
      label: overrides.trustLabel || 'Live with caveats',
      status: overrides.trustStatus || 'warning',
      score: overrides.score ?? 100,
      source: 'gbrain call get_health',
      lastVerifiedAt: capturedAt,
    },
    cockpit: {
      health: { value: overrides.health || '100/100' },
      embeddings: { value: overrides.embeddings || '100%', detail: overrides.embeddingsDetail || '0 missing' },
      queue: { value: overrides.queue || '0 / 0 / 0' },
      caveats: { value: String(overrides.caveats ?? 1) },
      bridge: { value: overrides.bridge || '2 passed' },
    },
    nodes: [
      {
        id: 'gbrain-core',
        label: 'GBrain Core',
        kind: 'core',
        status: overrides.trustStatus || 'warning',
        proof: { label: 'Live health probe', source: 'gbrain call get_health', verifiedAt: capturedAt },
      },
      {
        id: 'hermes',
        label: 'Hermes hmudur',
        kind: 'agent',
        status: overrides.hermesStatus || 'healthy',
        proof: { label: 'Read smoke passed', source: '~/bridge-smoke.json', verifiedAt: capturedAt },
      },
      {
        id: 'openclaw',
        label: 'OpenClaw',
        kind: 'agent',
        status: overrides.openclawStatus || 'healthy',
        proof: { label: 'Tool smoke passed', source: '~/bridge-smoke.json', verifiedAt: capturedAt },
      },
      {
        id: 'sources',
        label: 'Source Systems',
        kind: 'source',
        status: overrides.sourceStatus || 'warning',
        proof: { label: 'Live source probe', source: 'gbrain sources list', verifiedAt: capturedAt },
      },
    ],
    caveats: overrides.warnings || ['Official integrations doctor mismatch'],
    warnings: [],
    live: { sources: { warningCount: overrides.sourceWarnings ?? 0, freshness: { staleCount: overrides.sourceStaleCount ?? 0 } } },
  };
}

(function testSanitizeTimelineTextRedactsSensitiveValues() {
  const text = sanitizeTimelineText('Bearer abc.def /Users/me/secret sk-test "token":"abc" /home/alice/.gbrain');

  assert.doesNotMatch(text, /Bearer abc/);
  assert.doesNotMatch(text, /\/Users\/me/);
  assert.doesNotMatch(text, /\/home\/alice/);
  assert.doesNotMatch(text, /sk-test/);
  assert.match(text, /"token":"\[redacted\]"/);
  assert.match(text, /\[redacted\]/);
})();

(function testNormalizeSnapshotDoesNotStoreRawOutputOrPaths() {
  const snapshot = normalizeSnapshot(overview({
    warnings: ['failed at /Users/example/.gbrain with sk-secret'],
  }));
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.actor, 'mission-control');
  assert.ok(snapshot.bridgeProof.find((item) => item.id === 'hermes'));
  assert.doesNotMatch(serialized, /\/Users\/example/);
  assert.doesNotMatch(serialized, /sk-secret/);
})();

(function testNormalizeSnapshotStoresIndependentEmbeddingAndCompiledTruthCounters() {
  const input = overview({ embeddingsDetail: '3 missing' });
  input.live.health = {
    ok: true,
    metrics: {
      missingEmbeddings: 3,
      stalePages: 2,
    },
  };

  const snapshot = normalizeSnapshot(input);
  const previous = {
    ...snapshot,
    metrics: { ...snapshot.metrics, missingEmbeddings: 0, stalePages: 0 },
  };

  assert.equal(snapshot.metrics.missingEmbeddings, 3);
  assert.equal(snapshot.metrics.stalePages, 2);
  assert.equal(snapshot.metrics.embeddingsDetail, '3 missing');
  assert.deepEqual(
    computeTrustDiff(snapshot, previous).changes.filter(
      ({ field }) => field === 'missingEmbeddings' || field === 'stalePages',
    ),
    [
      { field: 'missingEmbeddings', from: 0, to: 3 },
      { field: 'stalePages', from: 0, to: 2 },
    ],
  );
})();

(function testNormalizeSnapshotOmitsUnavailableCountersForLegacyFingerprintCompatibility() {
  const snapshot = normalizeSnapshot(overview());
  const legacySnapshot = {
    ...snapshot,
    metrics: { ...snapshot.metrics },
  };
  delete legacySnapshot.metrics.missingEmbeddings;
  delete legacySnapshot.metrics.stalePages;

  assert.equal(Object.hasOwn(snapshot.metrics, 'missingEmbeddings'), false);
  assert.equal(Object.hasOwn(snapshot.metrics, 'stalePages'), false);
  assert.equal(fingerprintSnapshot(snapshot), fingerprintSnapshot(legacySnapshot));
  assert.equal(computeTrustDiff(snapshot, legacySnapshot).kind, 'unchanged');
})();

(function testFingerprintIgnoresCaptureTimestamp() {
  const first = normalizeSnapshot(overview({ refreshedAt: '2026-05-24T12:00:00.000Z' }), { capturedAt: '2026-05-24T12:00:00.000Z' });
  const second = normalizeSnapshot(overview({ refreshedAt: '2026-05-24T12:00:30.000Z' }), { capturedAt: '2026-05-24T12:00:30.000Z' });

  assert.equal(fingerprintSnapshot(first), fingerprintSnapshot(second));
})();

async function testCaptureSkipsDuplicateAndWritesHeartbeat() {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'evidence-timeline.jsonl');

  const first = await captureSnapshotIfNeeded(overview(), {
    ledgerPath,
    capturedAt: '2026-05-24T12:00:00.000Z',
    heartbeatMs: 60 * 60 * 1000,
  });
  const duplicate = await captureSnapshotIfNeeded(overview(), {
    ledgerPath,
    capturedAt: '2026-05-24T12:10:00.000Z',
    heartbeatMs: 60 * 60 * 1000,
  });
  const heartbeat = await captureSnapshotIfNeeded(overview(), {
    ledgerPath,
    capturedAt: '2026-05-24T13:01:00.000Z',
    heartbeatMs: 60 * 60 * 1000,
  });
  const read = readTimeline({ ledgerPath, limit: 10 });

  assert.equal(first.captured, true);
  assert.equal(first.reason, 'changed');
  assert.equal(duplicate.captured, false);
  assert.equal(duplicate.reason, 'skipped-duplicate');
  assert.equal(heartbeat.captured, true);
  assert.equal(heartbeat.reason, 'heartbeat');
  assert.equal(read.retainedEntryCount, 2);
}

(function testMalformedLedgerReturnsValidEntriesWithWarning() {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'evidence-timeline.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(normalizeSnapshot(overview()))}\nnot-json\n`, 'utf8');

  const read = readTimeline({ ledgerPath, limit: 10 });

  assert.equal(read.entries.length, 1);
  assert.equal(read.malformedLineCount, 1);
  assert.match(read.warnings[0], /Malformed timeline line 2/);
})();

(function testReadTimelineRedactsLegacyLedgerEntries() {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'evidence-timeline.jsonl');
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    ...normalizeSnapshot(overview()),
    trust: { source: '/Users/alice/.gbrain sk-secret "token":"abc"' },
    warnings: ['Bearer abc.def at /home/alice/.gbrain'],
  })}\n`, 'utf8');

  const serialized = JSON.stringify(readTimeline({ ledgerPath, limit: 10 }));

  assert.doesNotMatch(serialized, /\/Users\/alice/);
  assert.doesNotMatch(serialized, /\/home\/alice/);
  assert.doesNotMatch(serialized, /sk-secret/);
  assert.doesNotMatch(serialized, /Bearer abc/);
  assert.match(serialized, /\[redacted\]/);
})();

function testPruneTimelineKeepsNewestEntries() {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'evidence-timeline.jsonl');
  for (const refreshedAt of [
    '2026-05-24T12:00:00.000Z',
    '2026-05-24T12:01:00.000Z',
    '2026-05-24T12:02:00.000Z',
  ]) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, `${JSON.stringify(normalizeSnapshot(overview({ refreshedAt })))}\n`, 'utf8');
  }

  const pruned = pruneTimeline({ ledgerPath, retention: 2 });

  assert.equal(pruned.retainedEntryCount, 2);
  assert.equal(pruned.entries[0].capturedAt, '2026-05-24T12:02:00.000Z');
  assert.equal(pruned.entries[1].capturedAt, '2026-05-24T12:01:00.000Z');
}

async function testCaptureFailureIsWarningNotThrow() {
  const dir = tempDir();
  const ledgerPath = path.join(dir, 'ledger-as-directory');
  fs.mkdirSync(ledgerPath);

  const result = await captureSnapshotIfNeeded(overview(), { ledgerPath });

  assert.equal(result.captured, false);
  assert.equal(result.reason, 'failed');
  assert.match(result.warning, /Timeline capture failed/);
}

async function testServiceDisabledContract() {
  const service = createGBrainTimelineService({ enabled: false, projectRoot: tempDir() });
  const captured = await service.captureOverview(overview());
  const timeline = service.readTimeline({ limit: 1000 });

  assert.equal(captured.timelineSummary.enabled, false);
  assert.equal(captured.timelineSummary.lastCaptureReason, 'disabled');
  assert.equal(timeline.enabled, false);
  assert.deepEqual(timeline.entries, []);
  assert.equal(timeline.limit, 200);
}

async function testServiceSummaryDiffAndIncident() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Trusted',
    score: 100,
    caveats: 1,
    refreshedAt: '2026-05-24T12:00:00.000Z',
  }));
  const degraded = await service.captureOverview(overview({
    trustStatus: 'critical',
    trustLabel: 'Live check unavailable',
    score: 0,
    caveats: 3,
    queue: '0 / 0 / 1',
    refreshedAt: '2026-05-24T12:00:01.000Z',
  }));
  const timeline = service.readTimeline({ limit: 50 });

  assert.equal(degraded.timelineSummary.status, 'healthy');
  assert.equal(timeline.entries.length, 2);
  assert.equal(timeline.diff.kind, 'changed');
  assert.ok(timeline.diff.changes.length >= 1);
  assert.equal(timeline.incidentBanner.status, 'critical');
  assert.match(timeline.incidentBanner.detail, /Trust changed/);
}

async function testWorstRecentRegressionSurvivesCleanSnapshot() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Live data stale',
    embeddingsDetail: '1,084 missing',
    caveats: 4,
    warnings: ['8 sources exceeded freshness thresholds.'],
    refreshedAt: '2026-06-10T08:29:31.341Z',
  }));
  const recovered = await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Live trusted',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T08:30:47.445Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });

  assert.equal(timeline.entries[0].trust.status, 'healthy');
  assert.equal(timeline.incidentBanner.title, 'Worst recent regression still needs acknowledgement');
  assert.match(timeline.incidentBanner.detail, /1,084 missing embeddings/);
  assert.match(timeline.incidentBanner.detail, /8 stale sources/);
  assert.equal(timeline.incidentBanner.snapshotId, timeline.entries[1].fingerprint);
  assert.equal(recovered.timelineSummary.incidentBanner.snapshotId, timeline.entries[1].fingerprint);
}

async function testSourceWarningsAreNotReportedAsStaleSources() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Live source warning',
    caveats: 1,
    sourceWarnings: 7,
    warnings: ['7 live sources reported a warning status.'],
    refreshedAt: '2026-06-10T08:29:31.341Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Live trusted',
    caveats: 0,
    sourceWarnings: 0,
    warnings: [],
    refreshedAt: '2026-06-10T08:30:47.445Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });

  assert.equal(timeline.incidentBanner.title, 'Worst recent regression still needs acknowledgement');
  assert.match(timeline.incidentBanner.detail, /1 caveat/);
  assert.doesNotMatch(timeline.incidentBanner.detail, /stale source/i);
}

async function testRegressionAcknowledgementKeySurvivesHeartbeat() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 60 * 60 * 1000 });

  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Live data stale',
    embeddingsDetail: '2 missing',
    caveats: 1,
    refreshedAt: '2026-06-10T08:00:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Live data stale',
    embeddingsDetail: '2 missing',
    caveats: 1,
    refreshedAt: '2026-06-10T09:01:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Live trusted',
    embeddingsDetail: '0 missing',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T09:02:00.000Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });
  const regressionEntries = timeline.entries.filter((entry) => entry.trust.status === 'warning');

  assert.equal(regressionEntries.length, 2);
  assert.notEqual(regressionEntries[0].id, regressionEntries[1].id);
  assert.equal(regressionEntries[0].fingerprint, regressionEntries[1].fingerprint);
  assert.equal(timeline.incidentBanner.snapshotId, regressionEntries[0].fingerprint);
}

async function testCurrentRegressionIsNotAcknowledgeableHistory() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Still degraded',
    embeddingsDetail: '2 missing',
    caveats: 1,
    refreshedAt: '2026-06-10T08:00:00.000Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });

  assert.equal(timeline.incidentBanner.title, 'Current regression needs attention');
  assert.equal(timeline.incidentBanner.kind, 'active-regression');
  assert.match(timeline.incidentBanner.detail, /2 missing embeddings/);
  assert.equal(timeline.incidentBanners.length, 1);
}

async function testRecoveredRegressionListKeepsLaterIncidentsVisible() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Older severe regression',
    embeddingsDetail: '20 missing',
    caveats: 5,
    refreshedAt: '2026-06-10T08:00:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Recovered',
    embeddingsDetail: '0 missing',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T08:01:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'warning',
    trustLabel: 'Newer smaller regression',
    embeddingsDetail: '1 missing',
    caveats: 1,
    refreshedAt: '2026-06-10T09:00:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Recovered again',
    embeddingsDetail: '0 missing',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T09:01:00.000Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });
  const banners = buildTimelineIncidentBanners(timeline.entries);

  assert.equal(timeline.incidentBanners.length, 2);
  assert.equal(banners.length, 2);
  assert.match(timeline.incidentBanners[0].detail, /20 missing embeddings/);
  assert.match(timeline.incidentBanners[1].detail, /1 missing embedding/);
}

async function testRecoveredQueueRegressionStaysAcknowledgeable() {
  const dir = tempDir();
  const service = createGBrainTimelineService({ projectRoot: dir, heartbeatMs: 1 });

  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Queue stalled',
    queue: '0 / 0 / 1',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T08:00:00.000Z',
  }));
  await service.captureOverview(overview({
    trustStatus: 'healthy',
    trustLabel: 'Queue recovered',
    queue: '0 / 0 / 0',
    caveats: 0,
    warnings: [],
    refreshedAt: '2026-06-10T08:01:00.000Z',
  }));

  const timeline = service.readTimeline({ limit: 50 });

  assert.equal(timeline.incidentBanner.kind, 'recent-regression');
  assert.match(timeline.incidentBanner.detail, /queue 0 \/ 0 \/ 1/);
}

(async () => {
  await testCaptureSkipsDuplicateAndWritesHeartbeat();
  testPruneTimelineKeepsNewestEntries();
  await testCaptureFailureIsWarningNotThrow();
  await testServiceDisabledContract();
  await testServiceSummaryDiffAndIncident();
  await testWorstRecentRegressionSurvivesCleanSnapshot();
  await testSourceWarningsAreNotReportedAsStaleSources();
  await testRegressionAcknowledgementKeySurvivesHeartbeat();
  await testCurrentRegressionIsNotAcknowledgeableHistory();
  await testRecoveredRegressionListKeepsLaterIncidentsVisible();
  await testRecoveredQueueRegressionStaysAcknowledgeable();

  console.log('gbrainTimeline tests passed');
})();
