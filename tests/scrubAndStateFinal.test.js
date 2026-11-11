'use strict';

// Review-fix round 1 counter-examples:
//   1. every diagnostic field of every GBrain action response passes one
//      shared sanitizer (credentials + home paths);
//   2. one path policy: free text scrubs home paths (any case, percent-encoded
//      once, Windows form) but never URL paths, relative paths or prose;
//      structured path fields are canonicalised against the real home and its
//      aliases, and a home path that cannot be rewritten loses its directory;
//   3. one state ordering, declared once in server/core/state.js and equal to
//      the frontend's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { errorHandler, httpError } = require('../server/core/http');

const quietLogger = { log() {}, warn() {}, error() {} };

async function serve(build, run) {
  const app = express();
  app.use(express.json());
  build(app);
  app.use(errorHandler({ logger: quietLogger }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(base, urlPath, body) {
  const response = await fetch(`${base}${urlPath}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) };
}

// --- 1. GBrain action diagnostics ------------------------------------------

const STDERR = [
  'error: open /users/alice/.ssh/id_rsa; access=AKIAIOSFODNN7EXAMPLE',
  'retry with Authorization: Bearer abcdef0123456789abcdef',
  'db at postgres://bob:hunter2pass@db.example.com:5432/brain',
  'also %2FUsers%2Falice%2F.gbrain%2Fconfig.json and sk-proj0123456789abcdef',
].join('\n');
const SECRETS = /alice|AKIAIOSFODNN7EXAMPLE|abcdef0123456789abcdef|hunter2pass|sk-proj0123456789abcdef/;

function actionApp(execResult) {
  const { buildGBrainRouter } = require('../server/routes/gbrain');
  const exec = { run: async () => execResult };
  return (app) => app.use(buildGBrainRouter({
    gbrainOverviewService: { probeSnapshot: () => ({ data: null, meta: {} }), timelineService: { readTimeline: () => ({}) } },
    exec,
  }));
}

test('1: a failed action (502) carries no path, key, bearer value or URL password in any field', async () => {
  await serve(actionApp({ ok: false, timedOut: false, code: 1, stdout: '', stderr: STDERR }), async (base) => {
    const response = await post(base, '/api/gbrain/actions', { action: 'doctor-fast' });
    assert.equal(response.status, 502);
    assert.equal(response.json.status, 'failed');
    assert.equal(typeof response.json.summary, 'string');
    assert.ok(response.json.summary.length > 0);
    assert.doesNotMatch(response.text, SECRETS);
    assert.match(response.json.summary, /~\/\.ssh\/id_rsa/, 'the path stays useful, home-relative');
  });
});

test('1: a timed-out (504, pending fields kept) and a successful action are sanitized the same way', async () => {
  await serve(actionApp({ ok: false, timedOut: true, code: null, stdout: '', stderr: STDERR, error: { code: 'timeout' } }), async (base) => {
    const response = await post(base, '/api/gbrain/actions', { action: 'doctor-fast' });
    assert.equal(response.status, 504);
    for (const key of ['summary', 'pending', 'refreshAfter']) assert.ok(key in response.json, key);
    assert.doesNotMatch(response.text, SECRETS);
  });
  const stdout = JSON.stringify({ ok: true, path: '/Users/alice/.gbrain', note: STDERR });
  await serve(actionApp({ ok: true, code: 0, stdout, stderr: STDERR }), async (base) => {
    const response = await post(base, '/api/gbrain/actions', { action: 'doctor-fast' });
    assert.equal(response.status, 200);
    assert.equal(response.json.status, 'completed');
    assert.doesNotMatch(response.text, SECRETS);
    assert.equal(response.json.payload.path, '~/.gbrain');
  });
});

// --- 2. one path policy -----------------------------------------------------

test('2: free text — home paths scrubbed in every form; URLs, relative paths and prose untouched', () => {
  const { scrubText } = require('../server/core/scrub');
  const scrubbed = [
    ['/users/alice/.ssh/id_rsa; access=AKIAIOSFODNN7EXAMPLE', '~/.ssh/id_rsa; access=[redacted]'],
    ['%2FUsers%2Falice%2F.ssh%2Fid_rsa', '~/.ssh/id_rsa'],
    ['%2fusers%2falice', '~'],
    ['see /Users/alice/clawd/x.md now', 'see ~/clawd/x.md now'],
    ['/HOME/bob/project', '~/project'],
    ['cd /home/bob', 'cd ~'],
    ['/var/root/.ssh/known_hosts', '~/.ssh/known_hosts'],
    ['/private/var/root/x', '~/x'],
    ['/System/Volumes/Data/Users/alice/x', '~/x'],
    ["stat '/Users/alice/app/index.html'", "stat '~/app/index.html'"],
    ['file:///Users/alice/doc.txt', 'file://~/doc.txt'],
    ['C:\\Users\\alice\\AppData\\x', '~\\AppData\\x'],
    ['https://x.test/open?p=%2FUsers%2Falice%2Fy', 'https://x.test/open?p=~/y'],
  ];
  for (const [input, expected] of scrubbed) assert.equal(scrubText(input), expected, input);
  const untouched = [
    'https://example.com/home/help',
    'https://example.com/users/alice/profile',
    'http://[::1]:8080/home/x',
    'http://[fe80::1%25en0]/Users/alice',
    'docs/home/readme.md',
    './Users/alice/x',
    'src/users/list.ts',
    '/opt/homebrew/bin and /tmp/build',
    'Welcome home/ — the /home/ page, and work/home/life balance',
    'C:\\Program Files\\App',
    'plain prose without paths',
  ];
  for (const input of untouched) assert.equal(scrubText(input), input, input);
});

test('2: the error handler uses the same policy for authored messages', async () => {
  await serve((app) => {
    app.get('/api/a', () => { throw httpError(400, 'bad_thing', 'Bad file /users/alice/x and see https://example.com/home/help'); });
  }, async (base) => {
    const response = await fetch(`${base}/api/a`);
    const body = await response.json();
    assert.equal(body.error.message, 'Bad file ~/x and see https://example.com/home/help');
  });
});

test('2: structured paths — real home, its symlink alias, /private form and case variants become ~; others lose the directory', () => {
  const { homeRelativePath } = require('../server/core/scrub');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scrub-')));
  const real = path.join(tmp, 'Users', 'alice');
  fs.mkdirSync(path.join(real, 'clawd'), { recursive: true });
  const alias = path.join(tmp, 'alias-home');
  fs.symlinkSync(real, alias);
  const options = { homeDir: alias, caseInsensitive: true };
  const cases = [
    [path.join(real, 'clawd'), '~/clawd'],
    [path.join(alias, 'clawd'), '~/clawd'],
    [real, '~'],
    [path.join(real, 'clawd').replace('/Users/alice', '/users/ALICE'), '~/clawd'],
    ['/opt/skills', '/opt/skills'],
    ['relative/memory', 'relative/memory'],
    ['/Users/someoneelse/notes', 'notes'],
    ['/home/bob/work/memory', 'memory'],
    [null, null],
  ];
  if (tmp.startsWith('/private/')) cases.push([`${tmp.slice('/private'.length)}/Users/alice/clawd`, '~/clawd']);
  else cases.push([`/private${tmp}/Users/alice/clawd`, '~/clawd']);
  for (const [input, expected] of cases) assert.equal(homeRelativePath(input, options), expected, String(input));
  assert.equal(homeRelativePath(path.join(real, 'clawd').replace('/Users/alice', '/users/ALICE'), { homeDir: alias, caseInsensitive: false }), 'clawd',
    'without case folding a case variant cannot be rewritten confidently: its directory is omitted');
});

test('2: settings, setup and the Hermes board use the shared structured policy', async () => {
  const { createSettingsService } = require('../server/services/settingsData');
  const { buildHermesKanbanRouter } = require('../server/routes/hermesKanban');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scrub-svc-')));
  const real = path.join(tmp, 'Users', 'alice');
  fs.mkdirSync(path.join(real, '.openclaw'), { recursive: true });
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(real, alias);
  fs.writeFileSync(path.join(real, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { workspace: path.join(real, 'clawd') } } }));
  const service = createSettingsService({
    mcConfig: {}, homeDir: alias, memoryPath: path.join(real, 'clawd', 'memory'), skillsPath: '/Users/other/skills',
    missionControlConfigPath: path.join(tmp, 'mc.json'), missionControlDefaultConfigPath: path.join(tmp, 'd.json'),
    missionControlPackagePath: path.join(tmp, 'p.json'), gatewayPort: 1,
  });
  const payload = service.getSettingsPayload();
  assert.equal(payload.memory_path, '~/clawd/memory');
  assert.equal(payload.skills_path, 'skills');
  assert.equal((await service.getSetupStatus()).detectedConfig.workspacePath, '~/clawd');
  const board = { columns: { done: [{ workspace_path: path.join(real, 'clawd', 'x') }, { workspace_path: '/Users/other/y' }] } };
  await serve((app) => app.use(buildHermesKanbanRouter({ hermesSource: { snapshot: () => ({ data: board, meta: {} }) }, homeDir: alias })), async (base) => {
    const body = await (await fetch(`${base}/api/hermes-kanban`)).json();
    assert.deepEqual(body.columns.done.map((t) => t.workspace_path), ['~/clawd/x', 'y']);
  });
});

// --- 3. one state ordering --------------------------------------------------

test('3: the operations aggregate uses the one ordering (healthy outranks inactive)', () => {
  const { deriveOverallStatus } = require('../server/services/operationsOverview');
  assert.equal(deriveOverallStatus({ a: { state: 'healthy' }, b: { state: 'inactive' } }), 'healthy');
  assert.equal(deriveOverallStatus({ a: { state: 'unavailable' }, b: { state: 'warning' } }), 'warning');
  const { worstState, STATE_ORDER } = require('../server/core/state');
  assert.deepEqual(STATE_ORDER, ['critical', 'warning', 'unavailable', 'healthy', 'inactive']);
  assert.equal(worstState(['inactive', 'healthy']), 'healthy');
  assert.equal(worstState([]), 'unavailable');
});

test('3: no other rank table or state-order array exists under server/', () => {
  const STATES = ['critical', 'warning', 'unavailable', 'healthy', 'inactive'];
  const root = path.join(__dirname, '..', 'server');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : []));
  const offenders = [];
  for (const file of walk(root)) {
    if (file === path.join(root, 'core', 'state.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    // An object literal giving two or more state words a number.
    for (const match of text.matchAll(/\{[^{}]*\}/g)) {
      const ranked = STATES.filter((state) => new RegExp(`\\b${state}\\s*:\\s*-?\\d`).test(match[0]));
      if (ranked.length >= 2) offenders.push(`${path.relative(root, file)}: rank table ${match[0].slice(0, 60)}`);
    }
    // An array literal listing all five states (an ordering).
    for (const match of text.matchAll(/\[[^[\]]*\]/g)) {
      if (STATES.every((state) => new RegExp(`['"]${state}['"]`).test(match[0]))) {
        offenders.push(`${path.relative(root, file)}: state-order array ${match[0].slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('3: the frontend declares the same order as server/core/state.js', () => {
  const { STATE_ORDER } = require('../server/core/state');
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'lib', 'state.ts'), 'utf8');
  const block = /const SEVERITY: Record<UiState, number> = \{([^}]*)\}/.exec(source);
  assert.ok(block, 'frontend SEVERITY table found');
  const ranks = [...block[1].matchAll(/(\w+):\s*(-?\d+)/g)].map(([, state, rank]) => [state, Number(rank)]);
  const frontendOrder = ranks.sort((a, b) => b[1] - a[1]).map(([state]) => state);
  assert.deepEqual(frontendOrder, STATE_ORDER);
  assert.match(source, new RegExp(STATE_ORDER.join(' > ')));
});
