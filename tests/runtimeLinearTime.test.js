'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { regexLiterals } = require('./fixtures/runtimeRegexTimingChild');
const root = path.join(__dirname, '..');
const child = path.join(__dirname, 'fixtures/runtimeRegexTimingChild.js');
const HARD_TIMEOUT_MS = 6000;
function run(mode, file = '') {
  const result = spawnSync(process.execPath, [child, mode, file], { cwd: root, encoding: 'utf8', timeout: HARD_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  const last = String(result.stderr || '').trim().split('\n').at(-1);
  assert.equal(result.signal, null, `${mode} ${file}: timed out (${HARD_TIMEOUT_MS}ms), last corpus: ${last}`);
  assert.equal(result.status, 0, `${mode} ${file}: ${String(result.stderr).slice(-300)}`);
  const data = JSON.parse(result.stdout);
  const budget = Math.max(250, data.baselineMs * 40);
  assert.ok(data.results.length >= 90, 'all shared and runtime-specific corpora ran');
  assert.deepEqual(data.results.filter(row => row.ms > budget), [], `${mode} ${file}: budget ${budget.toFixed(1)}ms`);
  return data;
}
function ownedSources() {
  const files = ['server/services/cronData.js', 'server/services/settingsData.js', 'server/services/statusData.js'];
  function visit(dir) {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (name.endsWith('.js')) files.push(name);
    }
  }
  for (const dir of ['server/sources/openclaw', 'server/sources/ollama']) visit(dir);
  return files;
}
for (const file of ownedSources()) {
  if (!regexLiterals(fs.readFileSync(path.join(root, file), 'utf8')).length) continue;
  test(`runtime regex audit: ${file} stays linear on the 200KB corpus`, () => run('literals', file));
}
test('runtime regex audit covers the reported active-sessions pattern and dynamic ioreg pattern', () => {
  const status = regexLiterals(fs.readFileSync(path.join(root, 'server/services/statusData.js'), 'utf8'));
  assert.ok(status.some(({ regex }) => regex.source.includes('active sessions')));
  const dynamic = ownedSources().filter(file => fs.readFileSync(path.join(root, file), 'utf8').includes('new RegExp('));
  assert.deepEqual(dynamic, ['server/sources/ollama/telemetry.js'], 'every dynamic-regex module needs a caller harness');
  const gpu = fs.readFileSync(path.join(root, dynamic[0]), 'utf8');
  assert.equal((gpu.match(/new RegExp\(/g) || []).length, 1, 'the one dynamic constructor is covered by the GPU source harness');
});
test('runtime regex inventory handles return, escaped slash, character classes and template interpolations', () => {
  const source = 'return /abc/i; const x = /[a/b]+/g; f(/a\\/b/); const s = `${v.replace(/[:.]/g, "-")}`;';
  assert.deepEqual(regexLiterals(source).map(({ regex }) => regex.source), ['abc', '[a/b]+', 'a\\/b', '[:.]']);
});
test('runtime scheduled status parsing cannot stall on adversarial CLI output', () => run('status'));
test('runtime GPU source including dynamic ioreg parsing stays linear', () => run('gpu'));
test('runtime settings export including arbitrary-length URL schemes stays linear', () => run('export'));

test('status rejects oversized CLI output before parsing or writing a snapshot', async () => {
  const { createStatusService } = require('../server/services/statusData');
  const previousFetch = global.fetch; global.fetch = async () => ({ ok: false, text: async () => '' });
  let writes = 0;
  try {
    const service = createStatusService({ mcConfig: {}, memoryPath: '/unused', prettyModelName: x => x,
      getOpenclawDefaultModelKey: () => '', fetchNotionActivity: async () => [], fetchSessions: async () => ({}),
      readRuntimeSnapshot: () => null, writeRuntimeSnapshot: () => { writes++; }, runtimeSnapshotTtl: {},
      fs: { readFileSync() { throw new Error('no file'); } }, path, refreshOnRead: false,
      openclawCli: async args => ({ ok: true, stdout: args[0] === 'status' ? '2 active sessions\n' + 'x'.repeat(400000) : '{}' }),
    });
    await assert.rejects(service.readObservedStatus()); assert.equal(writes, 0);
  } finally { global.fetch = previousFetch; }
});

test('bounded status rows retain observed values and never join lines into synthetic fields', () => {
  const { parseStatusOutput, MAX_STATUS_CHARS, MAX_STATUS_LINE_CHARS } = require('../server/services/statusData');
  const parsed = parseStatusOutput('  2 active sessions\nMemory │ 46 files │ 225 chunks\n│ Agents │ 7 │\nHeartbeat │ 30m\ndefault gpt-5.4-mini\n│ Telegram │ ON │ OK │ connected │');
  assert.equal(parsed.sessionsMatch[1], '2'); assert.equal(parsed.memoryMatch[2], '225');
  assert.equal(parsed.agentsMatch[1], '7'); assert.equal(parsed.heartbeatInterval[1], '30m'); assert.equal(parsed.modelMatch[1], 'gpt-5.4-mini');
  assert.deepEqual(parsed.channels, [{ name: 'Telegram', enabled: 'ON', state: 'OK', detail: 'connected' }]);
  const split = parseStatusOutput('2\nactive sessions\nAgents\n│ 7\nMemory │ 46 files\n225 chunks\ndefault\nmodel');
  for (const field of ['sessionsMatch', 'agentsMatch', 'memoryMatch', 'modelMatch']) assert.equal(split[field], null);
  assert.equal(parseStatusOutput('2 active sessions' + ' '.repeat(MAX_STATUS_LINE_CHARS)).sessionsMatch, null);
  assert.throws(() => parseStatusOutput('x'.repeat(MAX_STATUS_CHARS + 1)), { code: 'status_output_too_large' });
  assert.doesNotThrow(() => parseStatusOutput('x'.repeat(MAX_STATUS_CHARS)));
});

test('bounded channel redaction never exposes a preview cut before its closing delimiter', () => {
  const { redactChannelDetail } = require('../server/services/statusData');
  assert.doesNotMatch(redactChannelDetail('token config (' + 'secret-sentinel '.repeat(400) + ')'), /secret-sentinel/);
  assert.doesNotMatch(redactChannelDetail('token' + ' '.repeat(100) + 'config (secret-sentinel)'), /secret-sentinel/);
});

test('settings export still redacts credential URLs beyond the core scheme-length limit', () => {
  const { createSettingsService } = require('../server/services/settingsData');
  for (const note of [
    'a'.repeat(33) + '://u:SENTINEL@host',
    'prefix ' + 'a-'.repeat(102400) + '://u:SENTINEL@host suffix',
    'a://b://' + 'a'.repeat(33) + '://u:SENTINEL@host',
    'prefix ' + 'a'.repeat(100) + '://u:p@tenant:SENTINEL@host/path',
  ]) {
    const exported = createSettingsService({ mcConfig: { note } }).getExportConfig();
    assert.equal(JSON.stringify(exported).includes('SENTINEL'), false, 'credentials must never leave the export');
  }
  assert.equal(createSettingsService({ mcConfig: { note: 'ordinary words a-'.repeat(100) } }).getExportConfig().note.includes('[redacted]'), false);
});
