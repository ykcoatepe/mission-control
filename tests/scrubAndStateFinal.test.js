'use strict';

// Review-fix round 1 counter-examples:
//   1. every diagnostic field of every GBrain action response passes one
//      shared sanitizer (credentials + home paths);
//   2. one path policy: free text scrubs home paths (any case, percent-encoded
//      once, Windows form) but never URL paths, relative paths or prose;
//      structured path fields are canonicalised against the real home and its
//      aliases, and a home path that cannot be rewritten loses its directory;
//   3. one state ordering: every backend consumer and the frontend execute
//      against one fixture of pairwise results (tests/fixtures/state-order.json).

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

// Review round 2 (P2): diagnostics often carry JSON, where "\" is doubled per
// nesting level and "/" may be written "\/" or "\u002f".
const R = String.raw;
const ESCAPED_PATHS = [
  // the reviewer's reproductions
  [R`{"path":"C:\\Users\\alice\\x"}`, R`{"path":"~\\x"}`],
  [R`{"path":"C:\\Users/alice\\x"}`, R`{"path":"~\\x"}`],
  [R`{"path":"C:\/Users\/alice\/x"}`, R`{"path":"~\/x"}`],
  // every Windows form, raw
  [R`C:\Users\alice\x`, R`~\x`],
  [R`C:/Users/alice/x`, '~/x'],
  [R`\\?\C:\Users\alice\x`, R`~\x`],
  [R`C:\Users/alice\AppData/Local`, R`~\AppData/Local`],
  [R`C:/Users\alice/x`, '~/x'],
  [R`d:\users\ALICE`, '~'],
  [R`open C:\Users\alice\notes.txt: denied`, R`open ~\notes.txt: denied`],
  [R`C:\Users\müdür\x`, R`~\x`],
  // JSON-escaped once
  [R`{"p":"\\\\?\\C:\\Users\\alice\\x"}`, R`{"p":"~\\x"}`],
  [R`{"p":"C:\\Users\\alice"}`, R`{"p":"~"}`],
  [R`{"p":"\/Users\/alice\/.ssh\/id_rsa"}`, R`{"p":"~\/.ssh\/id_rsa"}`],
  [R`{"p":"\u002fUsers\u002falice\u002fx"}`, R`{"p":"~\u002fx"}`],
  [R`{"p":"C:\u005cUsers\u005calice\u005cx"}`, R`{"p":"~\u005cx"}`],
  [R`{"p":"\/home\/bob"}`, R`{"p":"~"}`],
  [R`{"msg":"failed:\n/Users/alice/x\n"}`, R`{"msg":"failed:\n~/x\n"}`],
  [R`{"msg":"at\tC:\\Users\\alice\\x"}`, R`{"msg":"at\t~\\x"}`],
  // nested JSON strings (two and three levels)
  [JSON.stringify(JSON.stringify({ path: R`C:\Users\alice\x` })), JSON.stringify(JSON.stringify({ path: R`~\x` }))],
  [JSON.stringify(JSON.stringify(JSON.stringify({ path: R`C:\Users\alice\x`, home: '/Users/alice/y' }))),
    JSON.stringify(JSON.stringify(JSON.stringify({ path: R`~\x`, home: '~/y' })))],
  [JSON.stringify(JSON.stringify({ path: R`\\?\C:\Users\alice\x` })), JSON.stringify(JSON.stringify({ path: R`~\x` }))],
  [JSON.stringify({ stderr: JSON.stringify({ file: 'C:/Users/alice/x', other: R`C:\Users/alice\y` }) }),
    JSON.stringify({ stderr: JSON.stringify({ file: '~/x', other: R`~\y` }) })],
];
const ESCAPED_NEGATIVES = [
  R`C:\Program Files\App`,
  R`C:\Program Files\Users Guide\readme.txt`,
  R`{"p":"C:\\Program Files\\App"}`,
  R`C:\Windows\System32\drivers\etc\hosts`,
  R`D:\data\users.csv`,
  R`C:\Users`,
  R`C:\Users\ `,
  R`the C: drive and the Users folder`,
  R`ratio 3:/Users are welcome`.replace('3:/Users are', '3:1 users are'),
  'https://example.com/C:/Users/alice/x',
  'https://example.com/users/alice?next=%2Fhome',
  R`https:\/\/example.com\/users\/alice`,
  R`{"url":"https:\/\/example.com\/home\/help"}`,
  R`^[A-Z]:\\Users\\\w+$`,
  R`/\/users\/(\w+)/`,
  R`/^\/home\/[^/]+$/`,
  R`\d+:\s*\w+`,
  R`s/\\/\//g`,
  R`src\users\list.ts`,
  R`docs\/home\/readme.md`,
  R`line one\nline two\ttabbed`,
  R`{"a":"b\\c","d":"e\/f","g":"\u00fc"}`,
  R`\\server\share\Users\alice`,
];

test('2 (P2): Windows and JSON-escaped home paths are scrubbed at every escape depth; lookalikes are untouched', () => {
  const { scrubText } = require('../server/core/scrub');
  for (const [input, expected] of ESCAPED_PATHS) {
    const output = scrubText(input);
    assert.equal(output, expected, input);
    assert.doesNotMatch(output, /alice|ALICE|müdür|bob/, input);
    assert.equal(scrubText(output), output, `idempotent: ${input}`);
  }
  for (const input of ESCAPED_NEGATIVES) assert.equal(scrubText(input), input, input);
  // Valid JSON in, valid JSON out.
  for (const [input] of ESCAPED_PATHS.filter(([text]) => text.startsWith('{') || text.startsWith('"'))) {
    assert.doesNotThrow(() => JSON.parse(scrubText(input)), input);
  }
});

test('2 (P2): an action summary built from JSON stderr carries no escaped home path (reviewer reproduction)', async () => {
  const stderr = [R`{"path":"C:\\Users\\alice\\x"}`, R`{"path":"C:\\Users/alice\\y","alt":"\/Users\/alice\/z"}`,
    JSON.stringify(JSON.stringify({ path: R`C:\Users\alice\w` }))].join('\n');
  await serve(actionApp({ ok: false, timedOut: false, code: 1, stdout: '', stderr }), async (base) => {
    const response = await post(base, '/api/gbrain/actions', { action: 'doctor-fast' });
    assert.equal(response.status, 502);
    assert.ok(response.json.summary.length > 0);
    assert.doesNotMatch(response.text, /alice/i);
    assert.match(response.json.summary, /~/);
  });
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

// Review round 2 (P3): the ordering guard is BEHAVIOUR, not source text. A
// static table of expected pairwise results (tests/fixtures/state-order.json)
// is executed against every backend consumer's real aggregation here, and
// against the frontend's real worstState in frontend/src/lib/state.test.ts.
const ORDER = require('./fixtures/state-order.json');
const expectedWorst = new Map(ORDER.pairs.map(([a, b, worst]) => [`${a}|${b}`, worst]));
const worstOf = (a, b) => expectedWorst.get(`${a}|${b}`);
const strictlyWorse = (a, b) => a !== b && worstOf(a, b) === a; // a is worse than b

test('3: the fixture is complete and self-consistent', () => {
  assert.equal(ORDER.states.length, 5);
  assert.equal(ORDER.pairs.length, 25);
  for (const a of ORDER.states) {
    assert.equal(worstOf(a, a), a);
    for (const b of ORDER.states) {
      assert.ok([a, b].includes(worstOf(a, b)), `${a}|${b}`);
      assert.equal(worstOf(a, b), worstOf(b, a), `symmetric ${a}|${b}`);
    }
  }
});

test('3: core worstState / stateRank / bySeverity give the fixture result for every pair and list', () => {
  const { worstState, stateRank, bySeverity } = require('../server/core/state');
  for (const [a, b, worst] of ORDER.pairs) {
    assert.equal(worstState([a, b]), worst, `worstState([${a}, ${b}])`);
    assert.equal(Math.sign(stateRank(a) - stateRank(b)), strictlyWorse(a, b) ? 1 : strictlyWorse(b, a) ? -1 : 0, `stateRank ${a} vs ${b}`);
    assert.equal([a, b].sort(bySeverity)[0], worst, `bySeverity puts the worst first: ${a}, ${b}`);
  }
  for (const [list, worst] of ORDER.lists) assert.equal(worstState(list), worst, JSON.stringify(list));
  assert.equal(worstState([]), ORDER.empty);
});

test('3: the Operations aggregate gives the fixture result for every pair of system states', () => {
  const { deriveOverallStatus } = require('../server/services/operationsOverview');
  for (const [a, b, worst] of ORDER.pairs) {
    assert.equal(deriveOverallStatus({ one: { state: a }, two: { state: b } }), worst, `${a} + ${b}`);
  }
});

test('3: the GBrain state helper and verdict give the fixture result for every pair', () => {
  const gbrainState = require('../server/sources/gbrain/state');
  const { buildGBrainVerdict } = require('../server/sources/gbrain/verdict');
  for (const [a, b, worst] of ORDER.pairs) {
    assert.equal(gbrainState.worstState([a, b]), worst, `gbrain worstState([${a}, ${b}])`);
    // Two readers in states a and b. The verdict starts from healthy and
    // never lets an inactive reason degrade it.
    const verdict = buildGBrainVerdict({
      core: { state: 'healthy', quality: { value: 100 } },
      sources: [], sourcesState: 'healthy', queue: { state: 'inactive' },
      readers: [{ id: 'r1', label: 'One', state: a }, { id: 'r2', label: 'Two', state: b }],
      readersState: 'healthy', live: {},
    });
    const counted = [a, b].map((state) => (state === 'inactive' ? 'healthy' : state));
    assert.equal(verdict.state, worstOf(worstOf('healthy', counted[0]), counted[1]), `verdict for readers ${a} + ${b}`);
  }
});

test('3: the signals attention aggregate gives the fixture result for every pair', () => {
  const { needsOperator } = require('../server/sources/mloop/attention');
  for (const [a, b, worst] of ORDER.pairs) {
    const signal = needsOperator({ systemsAttention: [{ severity: a }, { severity: b }] });
    assert.equal(signal.worst, worst, `attention ${a} + ${b}`);
  }
});

test('3: the timeline reports a trust change exactly when the fixture says the new state is worse', () => {
  const { buildIncidentBanner } = require('../server/services/gbrainTimeline');
  for (const previous of ORDER.states) {
    for (const current of ORDER.states) {
      const banner = buildIncidentBanner({ trust: { status: current }, metrics: {} }, { trust: { status: previous }, metrics: {} });
      const reported = /Trust changed from/.test(banner?.detail || '');
      assert.equal(reported, strictlyWorse(current, previous), `${previous} -> ${current}`);
    }
  }
});
