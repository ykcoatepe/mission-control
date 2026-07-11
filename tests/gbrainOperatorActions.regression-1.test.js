const assert = require('node:assert/strict');

const { buildGBrainOverview, listGBrainActions } = require('../server/routes/gbrain');

// Regression: ISSUE-001 — cockpit still claimed no mutation controls after operator actions shipped.
// Found by /qa on 2026-05-28
// Report: .gstack/qa-reports/qa-report-127-0-0-1-3333-2026-05-28.md
(function testCockpitNamesAllowlistedOperatorActions() {
  const overview = buildGBrainOverview();
  const actions = listGBrainActions();

  assert.equal(actions.length, 8);
  assert.deepEqual(actions.map((action) => action.id), [
    'doctor-fast',
    'preview-sync',
    'sync-sources',
    'retry-failed-sync',
    'embed-stale',
    'embed-missing',
    'check-resolvable',
    'storage-status',
  ]);
  const expectedSafety = {
    'doctor-fast': ['R0', false],
    'preview-sync': ['R0', false],
    'sync-sources': ['W1', true],
    'retry-failed-sync': ['W1', true],
    'embed-stale': ['W1', true],
    'embed-missing': ['W1', true],
    'check-resolvable': ['R0', false],
    'storage-status': ['R0', false],
  };
  for (const action of actions) {
    assert.equal(action.safetyClass, expectedSafety[action.id][0]);
    assert.equal(action.requiresConfirmation, expectedSafety[action.id][1]);
  }
  assert.equal(overview.cockpit.autopilot.label, 'Operator actions');
  assert.equal(overview.cockpit.autopilot.value, 'Allowlisted');
  assert.match(overview.cockpit.autopilot.detail, /8 local actions/i);
  assert.doesNotMatch(overview.cockpit.autopilot.detail, /no mutation controls/i);
})();

(function testCoreNextActionPointsToAllowlistedActions() {
  const overview = buildGBrainOverview({
    health: {
      ok: true,
      mode: 'live-read-only',
      checkedAt: '2026-05-28T16:00:00.000Z',
      status: 'healthy',
      score: 100,
      metrics: {
        pages: 1,
        chunks: 1,
        embedded: 1,
        missingEmbeddings: 0,
        stalePages: 0,
        embeddingCoverage: 100,
        queue: { waiting: 0, active: 0, stalled: 0 },
      },
    },
  });
  const core = overview.nodes.find((node) => node.id === 'gbrain-core');

  assert.match(core.nextSafeAction, /allowlisted Operator Actions/i);
  assert.doesNotMatch(core.nextSafeAction, /outside this read-only surface/i);
})();

console.log('gbrainOperatorActions regression tests passed');
