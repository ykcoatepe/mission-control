const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  agentSessionsDir,
  resolveSessionTranscriptFile,
} = require('../server/services/sessionTranscripts');

const home = os.homedir();

test('resolves a relative transcriptPath under the owning agent sessions dir', () => {
  const file = resolveSessionTranscriptFile({
    agentId: 'qa-verifier',
    sessionId: '455e9041-0165-403e-a64d-909179a1b891',
    transcriptPath: '455e9041-0165-403e-a64d-909179a1b891.jsonl',
  });
  assert.equal(
    file,
    path.join(home, '.openclaw/agents/qa-verifier/sessions/455e9041-0165-403e-a64d-909179a1b891.jsonl'),
  );
});

test('accepts an absolute transcriptPath inside the owning agent sessions dir', () => {
  const expected = path.join(home, '.openclaw/agents/trader-assistant/sessions/abc123.jsonl');
  const file = resolveSessionTranscriptFile({ agentId: 'trader-assistant', transcriptPath: expected });
  assert.equal(file, expected);
});

test('rejects a transcriptPath that escapes the owning agent sessions dir', () => {
  assert.equal(resolveSessionTranscriptFile({ agentId: 'main', transcriptPath: '../../.ssh/id_rsa' }), null);
  assert.equal(
    resolveSessionTranscriptFile({
      agentId: 'main',
      transcriptPath: path.join(home, '.openclaw/agents/other-agent/sessions/leak.jsonl'),
    }),
    null,
  );
});

test('falls back to the <sessionId>.jsonl convention when OpenClaw omits transcriptPath', () => {
  const file = resolveSessionTranscriptFile({
    agentId: 'qa-verifier',
    sessionId: '455e9041-0165-403e-a64d-909179a1b891',
  });
  assert.equal(
    file,
    path.join(home, '.openclaw/agents/qa-verifier/sessions/455e9041-0165-403e-a64d-909179a1b891.jsonl'),
  );
});

test('treats unknown or unsafe agent ids as the main agent', () => {
  assert.equal(agentSessionsDir('main'), path.join(home, '.openclaw/agents/main/sessions'));
  assert.equal(agentSessionsDir(undefined), path.join(home, '.openclaw/agents/main/sessions'));
  assert.equal(agentSessionsDir(''), path.join(home, '.openclaw/agents/main/sessions'));
  assert.equal(agentSessionsDir('../doktor'), path.join(home, '.openclaw/agents/main/sessions'));
  assert.equal(agentSessionsDir('a/b'), path.join(home, '.openclaw/agents/main/sessions'));
});

test('returns null when there is nothing to resolve', () => {
  assert.equal(resolveSessionTranscriptFile(null), null);
  assert.equal(resolveSessionTranscriptFile({}), null);
  assert.equal(resolveSessionTranscriptFile({ agentId: 'main', transcriptPath: '   ' }), null);
  assert.equal(resolveSessionTranscriptFile({ agentId: 'main', sessionId: 'not a session id!' }), null);
});
