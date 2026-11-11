'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGBrainVerdict, isGBrainVerdict } = require('../server/sources/gbrain/verdict');

const reader = (id, label, observation = 'configured') => ({ id, label, observation, state: observation === 'unreadable' ? 'unavailable' : 'inactive' });
const FOUR = [reader('hermes', 'Hermes'), reader('codex', 'Codex'), reader('claude-code', 'Claude Code'), reader('openclaw', 'OpenClaw')];
const okProbe = { data: {}, meta: { error: null, stale: false } };

function input(overrides = {}) {
  return {
    core: { state: 'healthy', quality: { value: 100 } },
    sources: [], sourcesState: 'healthy', queue: { state: 'healthy' },
    readers: [], readersState: 'inactive',
    live: { health: { status: 'healthy', metrics: {} } },
    probes: {}, ...overrides,
  };
}

// The live reading the owner reported: GBrain warns (quality 99), 12 chunks are overdue for embedding,
// the embed-job probe failed, one source has sync off and four readers are set up.
function liveExample() {
  return input({
    core: { state: 'warning', quality: { value: 99 } },
    live: { health: { status: 'warning', metrics: { missingEmbeddings: 12, missingEmbeddingsOverdue: 12, embedJobProbeUnavailable: true } } },
    sources: [{ id: 'projects', items: [{ id: 'tk-omc-ain', label: 'tk-omc-ain', state: 'inactive', reason: 'sync off' }] }],
    readers: FOUR, readersState: 'inactive',
    probes: { health: okProbe },
  });
}

test('the nine-line live example collapses to one thing to act on and three to know', () => {
  const verdict = buildGBrainVerdict(liveExample());
  const action = verdict.reasons.filter((r) => r.kind === 'action');
  const info = verdict.reasons.filter((r) => r.kind === 'info');
  assert.deepEqual(action.map((r) => [r.elementId, r.state, r.text]),
    [['missing-embeddings', 'warning', '12 chunks are missing embeddings past the tolerance.']]);
  assert.deepEqual(info.map((r) => r.elementId).sort(), ['embed-job-probe', 'readers', 'tk-omc-ain']);
  assert.equal(verdict.reasons.length, 4);
  assert.ok(!verdict.reasons.some((r) => r.elementId === 'gbrain-core'), 'the core line only restates the missing embeddings');
  assert.ok(!verdict.reasons.some((r) => /requires attention|quality 99|configured;|telemetry/i.test(r.text)), JSON.stringify(verdict.reasons));
  assert.equal(info.find((r) => r.elementId === 'readers').text,
    "Hermes, Codex, Claude Code and OpenClaw are set up. Live connections can't be read from this machine.");
  assert.equal(info.find((r) => r.elementId === 'embed-job-probe').text,
    "Embedding job status couldn't be read, so missing embeddings are judged by age only.");
  assert.equal(info.find((r) => r.elementId === 'embed-job-probe').state, 'unavailable');
  assert.equal(info.find((r) => r.elementId === 'tk-omc-ain').state, 'inactive');
  assert.equal(isGBrainVerdict(verdict), true);
});

test('the core line goes away but its state still counts: the verdict state is what it was', () => {
  // The core is critical, link extraction explains it at the same severity: no core line, state critical.
  const same = buildGBrainVerdict(input({
    core: { state: 'critical', quality: { value: 40 } },
    live: { health: { status: 'critical', metrics: { stalePages: 3, stalePagesOverdue: 3 } } },
  }));
  assert.equal(same.state, 'critical');
  // Link extraction is only a warning, so it does not explain a critical core: the core keeps its line.
  const worse = buildGBrainVerdict(input({
    core: { state: 'critical', quality: { value: 99 } },
    live: { health: { status: 'critical', metrics: { stalePages: 3, stalePagesOverdue: 3 } } },
  }));
  assert.equal(worse.state, 'critical');
  assert.ok(worse.reasons.some((r) => r.elementId === 'gbrain-core' && r.state === 'critical'));
  // A failed stats probe (unavailable) does not explain a critical core either.
  const failed = { data: null, meta: { error: { code: 'x' }, stale: true } };
  assert.equal(buildGBrainVerdict(input({ core: { state: 'critical', quality: { value: 10 } }, probes: { stats: failed } })).state, 'critical');
  // Inactive readers and sources never degrade it.
  const quiet = buildGBrainVerdict(input({ readers: FOUR }));
  assert.equal(quiet.state, 'healthy');
  assert.deepEqual(quiet.reasons.map((r) => r.kind), ['info']);
});

test('a core nothing else explains still gets a line that names the cause', () => {
  const low = buildGBrainVerdict(input({ core: { state: 'warning', quality: { value: 72 } }, live: { health: { status: 'warning', metrics: {} } } }));
  assert.equal(low.state, 'warning');
  assert.deepEqual(low.reasons.map((r) => [r.elementId, r.kind, r.text]), [['gbrain-core', 'action', "GBrain's quality score is 72/100."]]);
  // Quality is fine (99): the line must not blame it.
  const status = buildGBrainVerdict(input({ core: { state: 'warning', quality: { value: 99 } }, live: { health: { status: 'warning', metrics: {} } } }));
  assert.equal(status.reasons.length, 1);
  assert.equal(status.reasons[0].text, "GBrain's own health check reports warning.");
  assert.doesNotMatch(status.reasons[0].text, /quality|requires attention/);
  // A partial reading with a healthy status names that instead.
  const partial = buildGBrainVerdict(input({ core: { state: 'warning', quality: { value: 99 } } }));
  assert.equal(partial.reasons[0].text, 'Some GBrain core readings were not reported.');
  // An unread core says it was not read.
  const unread = buildGBrainVerdict(input({ core: { state: 'unavailable', quality: { value: null } } }));
  assert.equal(unread.state, 'unavailable');
  assert.equal(unread.reasons[0].text, 'GBrain core reading unavailable.');
});

test('a failed health probe explains an unavailable core; a stale one explains a warning core', () => {
  const failed = { data: null, meta: { error: { code: 'x' }, stale: true } };
  const down = buildGBrainVerdict(input({ core: { state: 'unavailable', quality: { value: null } }, probes: { health: failed } }));
  assert.deepEqual(down.reasons.map((r) => r.elementId), ['gbrain.health']);
  assert.equal(down.state, 'unavailable');
  const stale = buildGBrainVerdict(input({ core: { state: 'warning', quality: { value: 99 } }, probes: { stats: { data: {}, meta: { error: null, stale: true } } } }));
  assert.deepEqual(stale.reasons.map((r) => r.elementId), ['gbrain.stats']);
  assert.equal(stale.state, 'warning');
});

test('a reader that is not set up, or has a real state, keeps its own line', () => {
  const verdict = buildGBrainVerdict(input({
    readers: [reader('hermes', 'Hermes'), reader('codex', 'Codex', 'not_configured'),
      { id: 'claude-code', label: 'Claude Code', observation: 'observed', state: 'warning' },
      reader('openclaw', 'OpenClaw', 'unreadable')],
  }));
  const byId = Object.fromEntries(verdict.reasons.map((r) => [r.elementId, r]));
  assert.equal(byId.readers.text, "Hermes is set up. Live connections can't be read from this machine.");
  assert.equal(byId.readers.kind, 'info');
  assert.equal(byId.codex.text, 'Codex: integration not configured.');
  assert.equal(byId.codex.state, 'inactive');
  assert.equal(byId.codex.kind, 'info');
  assert.equal(byId['claude-code'].text, 'Claude Code: integration warning.');
  assert.equal(byId['claude-code'].kind, 'action');
  assert.equal(byId.openclaw.kind, 'action');
  assert.equal(verdict.state, 'warning');
});

test('kind is one rule: inactive and the embed-job limitation are info, every other reason is action', () => {
  const verdict = buildGBrainVerdict(liveExample());
  for (const r of verdict.reasons) {
    assert.equal(r.kind, r.state === 'inactive' || r.elementId === 'embed-job-probe' ? 'info' : 'action', r.elementId);
  }
  const bad = { ...verdict, reasons: [{ ...verdict.reasons[0], kind: 'loud' }] };
  assert.equal(isGBrainVerdict(bad), false);
  // A verdict stored before `kind` existed is still a verdict.
  assert.equal(isGBrainVerdict({ state: 'warning', reasons: [{ elementId: 'queue', state: 'warning', text: 'Queue requires attention.' }] }), true);
});
