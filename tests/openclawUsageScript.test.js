const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildForPeriod, listSessionFiles } = require('../scripts/openclaw-usage-summary');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'openclaw-usage-summary.js'), 'utf8');

assert.ok(!source.includes('loadCostUsageSummary'), 'script must not use the slow OpenClaw bundled summary path');
assert.ok(!source.includes('await usage.session('), 'script must not fan out through slow per-session OpenClaw aggregation');
assert.ok(source.includes('session JSONL fast scan'), 'script should use the bounded JSONL fast scan source');
assert.ok(source.includes("entry.name.endsWith('.trajectory.jsonl')"), 'script should skip trajectory JSONL files to avoid double counting');
assert.ok(source.includes('VALID_PERIODS'), 'script should ignore non-period flags such as --json');

// Seam contract with the router: the server resolves both homes and pins them
// into the child env; the script must not depend on inherited HOME/CODEX_HOME.
const costsSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
assert.ok(costsSource.includes('MC_CODEX_HOME: codexHomePath()'), 'router must pin the resolved codex home into the usage-script env');
assert.ok(costsSource.includes('MC_HERMES_DB_PATH: hermesProfileDbPath()'), 'router must pass the authoritative Hermes db path so the script can gate hermes-owned exclusion on availability');

// Seam contract, mechanized: the script excludes hermes-owned rollouts only for
// days its coverage probe reports, and that probe must fail (⇒ retain) whenever
// the SERVER's query would fail. That holds only while the probe references
// every sessions column hermesUsageSummary consumes. A comment cannot enforce
// it; this does.
function sliceBetween(text, startMarker, endMarker, label) {
  const from = text.indexOf(startMarker);
  assert.notEqual(from, -1, `${label}: start marker "${startMarker}" not found — update this seam test`);
  const to = text.indexOf(endMarker, from + startMarker.length);
  assert.notEqual(to, -1, `${label}: end marker "${endMarker}" not found — update this seam test`);
  return text.slice(from, to);
}

// Comments in the script name every column, so a comment-only "fix" would
// satisfy a naive substring check. Strip them: the guard must be CODE.
function stripJsComments(text) {
  // Only the comment tail is dropped, never the code preceding it on the same
  // line; the [^:] guard keeps "https://" inside code from looking like one.
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Column references in the consumer's SELECT: lowercase identifiers that are
// neither a function name (followed by "(") nor an alias (preceded by "AS").
// Uppercase SQL keywords never match; string literals and ${} interpolations
// are stripped first.
const SQL_NON_COLUMN_TOKENS = new Set([
  'select', 'from', 'sessions', 'where', 'and', 'or', 'not', 'null', 'is',
  'distinct', 'group', 'by', 'order', 'asc', 'desc', 'limit', 'as', 'on',
]);

function sqlColumnReferences(sql) {
  const cleaned = sql.replace(/\$\{[^}]*\}/g, ' ').replace(/'[^']*'/g, "''");
  const columns = new Set();
  const pattern = /\b[a-z][a-z0-9_]*\b/g;
  let match;
  while ((match = pattern.exec(cleaned)) !== null) {
    const token = match[0];
    if (SQL_NON_COLUMN_TOKENS.has(token)) continue;
    if (/\bas\s+$/i.test(cleaned.slice(Math.max(0, match.index - 8), match.index))) continue;
    if (/^\s*\(/.test(cleaned.slice(match.index + token.length))) continue;
    columns.add(token);
  }
  return columns;
}

function uncoveredHermesColumns(consumerSql, probeCode) {
  return [...sqlColumnReferences(consumerSql)].filter((column) => !probeCode.includes(column)).sort();
}

const hermesConsumerSql = sliceBetween(
  costsSource.slice(costsSource.indexOf('async function hermesUsageSummary')),
  'SELECT',
  'GROUP BY',
  'hermesUsageSummary query',
);
const hermesProbeCode = stripJsComments(sliceBetween(
  source,
  'const HERMES_CONSUMED_COLUMNS_GUARD',
  'function listSessionFiles',
  'hermes coverage probe',
));

// Anti-vacuous: a broken extractor returning nothing would pass everything.
const consumedColumns = sqlColumnReferences(hermesConsumerSql);
for (const column of [
  'started_at', 'billing_provider', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens',
  'actual_cost_usd', 'estimated_cost_usd', 'cost_status', 'billing_mode',
]) {
  assert.ok(consumedColumns.has(column), `column extractor must find ${column} in hermesUsageSummary's SELECT — the seam test is broken, not the guard`);
}

const uncoveredColumns = uncoveredHermesColumns(hermesConsumerSql, hermesProbeCode);
assert.deepEqual(
  uncoveredColumns,
  [],
  `hermesUsageSummary consumes column ${uncoveredColumns[0]} not covered by HERMES_CONSUMED_COLUMNS_GUARD — mirror it in scripts/openclaw-usage-summary.js`,
);

// Counter-example: the check must actually FIRE on drift, not pass vacuously.
assert.deepEqual(
  uncoveredHermesColumns(
    hermesConsumerSql.replace('FROM sessions', ', SUM(COALESCE(phantom_tokens, 0)) AS phantom FROM sessions'),
    hermesProbeCode,
  ),
  ['phantom_tokens'],
  'the seam check must report a consumer column the guard does not mirror',
);
// And a comment naming the column must NOT satisfy it.
assert.deepEqual(
  uncoveredHermesColumns(
    hermesConsumerSql.replace('FROM sessions', ', SUM(COALESCE(phantom_tokens, 0)) AS phantom FROM sessions'),
    stripJsComments(`${hermesProbeCode}\n// phantom_tokens is handled elsewhere\n`),
  ),
  ['phantom_tokens'],
  'a comment naming the column must not count as coverage',
);

async function withTempHome(fn) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openclaw-usage-'));
  const previousHome = process.env.HOME;
  // The scan follows CODEX_HOME/MC_CODEX_HOME when set; a leaked developer
  // value would point the test at the real ~/.codex corpus.
  const clearedKeys = ['CODEX_HOME', 'MC_CODEX_HOME', 'MC_HERMES_DB_PATH', 'HERMES_STATE_DB', 'HERMES_PROFILE_DIR', 'HERMES_PROFILE'];
  const previousEnv = Object.fromEntries(clearedKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = tempHome;
  for (const key of clearedKeys) delete process.env[key];
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = previousHome;
    for (const key of clearedKeys) {
      if (previousEnv[key] !== undefined) process.env[key] = previousEnv[key];
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function writeUsageLine(file, timestamp, totalTokens) {
  fs.appendFileSync(file, `${JSON.stringify({
    message: {
      timestamp,
      provider: 'openai-codex',
      model: 'gpt-test',
      usage: {
        input: totalTokens,
        output: 0,
        totalTokens,
        cost: { total: 0 },
      },
    },
  })}\n`);
}

function writeProviderOnlyUsageLine(file, timestamp, totalTokens, provider, field = 'provider') {
  fs.appendFileSync(file, `${JSON.stringify({
    message: {
      timestamp,
      [field]: provider,
      usage: {
        input: totalTokens,
        output: 0,
        totalTokens,
        cost: { total: 0 },
      },
    },
  })}\n`);
}

function writeTokenCountLine(file, timestamp, totalTokens) {
  fs.appendFileSync(file, `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: totalTokens - 1,
          output_tokens: 1,
          cached_input_tokens: 0,
          total_tokens: totalTokens,
        },
      },
    },
  })}\n`);
}

function writeTurnContextLine(file, model, modelProvider = undefined) {
  fs.appendFileSync(file, `${JSON.stringify({
    type: 'turn_context',
    payload: { model, model_provider: modelProvider },
  })}\n`);
}

// The exclusion gate mirrors the consumer (server/routes/costs.js
// hermesUsageSummary): same sessions table, same started_at window, same
// local-day bucketing. So the fixture is a REAL db whose rows decide which
// DAYS are covered — an empty placeholder file, an empty table, or rows on
// other days are all cases where the Hermes bucket represents nothing for the
// day in question and the gate must refuse to exclude.
// Mirrors the columns hermesUsageSummary SELECTs (server/routes/costs.js
// 884-902). Keep in sync with it and with the script's coverage probe.
const HERMES_SESSIONS_COLUMNS = `
  id TEXT,
  started_at REAL,
  billing_provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  actual_cost_usd REAL,
  estimated_cost_usd REAL,
  cost_status TEXT,
  billing_mode TEXT
`;

function writeHermesDbWithColumns(home, columns, startedAtSecs, profile) {
  const dir = path.join(home, '.hermes', 'profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'state.db');
  const rows = startedAtSecs
    .map((sec, index) => `; INSERT INTO sessions (id, started_at) VALUES ('s${index + 1}', ${sec})`)
    .join('');
  execFileSync('sqlite3', [dbPath, `CREATE TABLE sessions (${columns})${rows}`]);
  return dbPath;
}

function writeHermesDb(home, { startedAtSecs = [], profile = 'hmudur' } = {}) {
  return writeHermesDbWithColumns(home, HERMES_SESSIONS_COLUMNS, startedAtSecs, profile);
}

// Schema drift / partial migration: started_at survives but the columns the
// consumer aggregates do not. The server query would fail outright, so the
// probe must fail with it rather than authorize exclusion.
function writeStartedAtOnlyHermesDb(home, { startedAtSecs = [], profile = 'hmudur' } = {}) {
  return writeHermesDbWithColumns(home, 'id TEXT, started_at REAL', startedAtSecs, profile);
}

function writeCoveringHermesDb(home) {
  return writeHermesDb(home, { startedAtSecs: [Math.floor(Date.now() / 1000)] });
}

function writeCodexAuth(home, auth) {
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(auth));
}

function writeThreadSettingsLine(file, model, modelProvider = undefined) {
  fs.appendFileSync(file, `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { model, model_provider_id: modelProvider },
    },
  })}\n`);
}

async function runBehaviorTests() {
  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'rollout-test.jsonl');
    const trajectoryFile = path.join(nestedDir, 'rollout-test.trajectory.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai-codex', model: 'gpt-5.5' } })}\n`);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    writeTokenCountLine(sessionFile, yesterday.toISOString(), 7);
    writeUsageLine(sessionFile, timestamp, 11);
    writeUsageLine(sessionFile, timestamp, 13);
    writeTokenCountLine(sessionFile, timestamp, 17);
    writeUsageLine(trajectoryFile, timestamp, 999);

    const files = listSessionFiles(today.getTime() - 60_000);
    assert.equal(files.length, 1, 'nested session JSONL should be discovered and trajectory files skipped');
    assert.ok(files[0].sessionKey.includes('alpha/agent/codex-home/sessions'), 'session key should preserve nested identity');

    const summary = await buildForPeriod('day');
    assert.equal(summary.summary.recordsScanned, 3, 'usage records should come from both supported JSONL shapes');
    assert.equal(summary.summary.periodTokens, 41, 'message and token_count usage records should contribute to totals');
    assert.ok(summary.summary.previousPeriodApiEquivalentUsd > 0, 'previous-day API equivalent should be available for trend baselines');
    assert.equal(summary.byService[0].sessions, 1, 'multiple usage records in one file should count as one session');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.equal(openclawAgent.summary.periodTokens, 41, 'nested codex-home sessions belong to the OpenClaw bucket');
    assert.equal(codexAppAgent.summary.periodTokens, 0, 'nested codex-home sessions must not surface as Codex App usage');
    assert.equal(codexCliAgent.summary.periodTokens, 0, 'nested codex-home sessions must not surface as Codex CLI usage');
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'turn-context-model.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'openclaw', source: 'vscode' },
    })}\n`);
    writeThreadSettingsLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 19);
    writeTurnContextLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 23);

    const summary = await buildForPeriod('day');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.deepEqual(
      openclawAgent.byService.map((service) => [service.name, service.tokens]),
      [['openai/gpt-5.6-sol', 42]],
      'nested codex-home usage should use preceding thread settings and turn context model metadata',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'future-context.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { model_provider: 'openai', originator: 'openclaw', source: 'vscode' },
    })}\n`);
    writeTokenCountLine(sessionFile, timestamp, 19);
    writeTurnContextLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 23);

    const summary = await buildForPeriod('day');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.deepEqual(
      Object.fromEntries(openclawAgent.byService.map((service) => [service.name, service.tokens])),
      {
        'openai/gpt-5.6-sol': 23,
        'openai/unknown': 19,
      },
      'a later turn context must not retroactively relabel earlier model-less usage',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'model-transition.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { model_provider: 'openai', originator: 'openclaw', source: 'vscode' },
    })}\n`);
    writeTurnContextLine(sessionFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 11);
    writeTurnContextLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 13);
    writeThreadSettingsLine(sessionFile, undefined, 'anthropic');
    writeTokenCountLine(sessionFile, timestamp, 17);

    const summary = await buildForPeriod('day');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.deepEqual(
      Object.fromEntries(openclawAgent.byService.map((service) => [service.name, service.tokens])),
      {
        'anthropic/unknown': 17,
        'openai/gpt-5.6-sol': 13,
        'openai/gpt-5.5': 11,
      },
      'model transitions should preserve prior usage and clear stale models when the provider changes',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'provider-mismatch.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'openclaw', source: 'vscode' },
    })}\n`);
    writeTurnContextLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(sessionFile, timestamp, 23);
    writeProviderOnlyUsageLine(sessionFile, timestamp, 19, 'openai-codex');
    writeProviderOnlyUsageLine(sessionFile, timestamp, 29, 'openai-responses', 'api');
    writeTurnContextLine(sessionFile, undefined, 'openai-codex');
    writeTokenCountLine(sessionFile, timestamp, 31);
    writeProviderOnlyUsageLine(sessionFile, timestamp, 17, 'anthropic');

    const summary = await buildForPeriod('day');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.deepEqual(
      Object.fromEntries(openclawAgent.byService.map((service) => [service.name, service.tokens])),
      {
        'openai/gpt-5.6-sol': 71,
        'openai-codex/gpt-5.6-sol': 31,
        'anthropic/unknown': 17,
      },
      'equivalent OpenAI aliases should preserve context while different providers must not',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'alpha',
      'agent',
      'codex-home',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'explicit-subscription-provider.jsonl');
    const timestamp = today.toISOString();

    writeTurnContextLine(sessionFile, 'gpt-5.6-sol', 'openai');
    writeProviderOnlyUsageLine(sessionFile, timestamp, 37, 'openai-codex');

    const summary = await buildForPeriod('day');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.equal(openclawAgent.byService[0].name, 'openai/gpt-5.6-sol');
    assert.equal(
      openclawAgent.byService[0].costSource,
      'included',
      'an explicit openai-codex provider should preserve subscription billing evidence',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const nestedDir = path.join(
      home,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(nestedDir, { recursive: true });
    const sessionFile = path.join(nestedDir, 'missing-model.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai', originator: 'openclaw', source: 'vscode' } })}\n`);
    writeTokenCountLine(sessionFile, timestamp, 21);

    const summary = await buildForPeriod('day');
    assert.equal(summary.byService[0].name, 'openai/gpt-5.5', 'missing OpenClaw Codex model should land in the configured default model bucket');
    assert.equal(summary.byService[0].costSource, 'included', 'default GPT-5.5 bucket should be subscription-included, not unknown spend');
    assert.equal(summary.byService[0].tokens, 21, 'default model bucket should preserve token totals');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.equal(openclawAgent.summary.periodTokens, 21, 'direct OpenClaw sessions should stay in the OpenClaw split');
    assert.equal(codexAppAgent.summary.periodTokens, 0, 'direct OpenClaw sessions should not be counted as Codex App Sessions');
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const sessionsDir = path.join(home, '.openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, 'metered-openai.jsonl');
    const timestamp = today.toISOString();

    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: 'session_meta', payload: { model_provider: 'openai', model: 'gpt-5.5', source: 'api' } })}\n`);
    writeTokenCountLine(sessionFile, timestamp, 23);

    const summary = await buildForPeriod('day');
    assert.equal(summary.byService[0].costSource, 'unknown', 'zero persisted cost without subscription metadata must remain unknown');
    assert.equal(summary.byService[0].costStatus, 'unknown', 'unknown metered billing must not be relabeled as included');
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    // Subscription evidence: ChatGPT auth mode with no API key on this home.
    writeCodexAuth(home, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'x' } });
    const timestamp = today.toISOString();

    const desktopFile = path.join(codexDay, 'rollout-desktop.jsonl');
    fs.appendFileSync(desktopFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'Codex Desktop', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(desktopFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(desktopFile, timestamp, 29);

    const execFile = path.join(codexDay, 'rollout-exec.jsonl');
    fs.appendFileSync(execFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'codex_exec', source: 'exec', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(execFile, 'gpt-5.6-terra', 'openai');
    writeTokenCountLine(execFile, timestamp, 31);

    const files = listSessionFiles(today.getTime() - 60_000);
    assert.equal(files.length, 2, 'standalone Codex home rollouts should be discovered');
    assert.ok(
      files.every((file) => file.origin === 'codex' && file.sessionKey.startsWith('codex-sessions/')),
      'standalone Codex rollouts should carry the codex origin and a collision-safe session key prefix',
    );

    const summary = await buildForPeriod('day');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.equal(codexAppAgent.summary.periodTokens, 29, 'Codex Desktop originator sessions belong to Codex App Sessions');
    assert.equal(codexCliAgent.summary.periodTokens, 31, 'codex_exec originator sessions belong to Codex CLI');
    assert.equal(openclawAgent.summary.periodTokens, 0, 'standalone Codex rollouts must not inflate OpenClaw');
    assert.deepEqual(
      codexAppAgent.byService.map((service) => [service.name, service.tokens, service.costSource]),
      [['openai/gpt-5.6-sol', 29, 'included']],
      'Codex Desktop usage should keep model metadata and stay subscription-included',
    );
    assert.deepEqual(
      codexCliAgent.byService.map((service) => [service.name, service.tokens, service.costSource]),
      [['openai/gpt-5.6-terra', 31, 'included']],
      'Codex CLI usage should keep model metadata and stay subscription-included',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    const timestamp = today.toISOString();

    const modellessFile = path.join(codexDay, 'rollout-modelless.jsonl');
    fs.appendFileSync(modellessFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'Codex Desktop', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTokenCountLine(modellessFile, timestamp, 37);

    const summary = await buildForPeriod('day');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.deepEqual(
      codexAppAgent.byService.map((service) => [service.name, service.tokens]),
      [['openai/unknown', 37]],
      'model-less standalone Codex usage must stay openai/unknown, not inherit the OpenClaw default model',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    const timestamp = today.toISOString();

    // Second desktop install (real corpus: codex_work_desktop) → still the app.
    const workDesktopFile = path.join(codexDay, 'rollout-work-desktop.jsonl');
    fs.appendFileSync(workDesktopFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'codex_work_desktop', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(workDesktopFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(workDesktopFile, timestamp, 11);

    // Desktop originator but source exec = a codex exec run → CLI, not app.
    const desktopExecFile = path.join(codexDay, 'rollout-desktop-exec.jsonl');
    fs.appendFileSync(desktopExecFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'Codex Desktop', source: 'exec', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(desktopExecFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(desktopExecFile, timestamp, 13);

    // Hermes-owned AND the Hermes state.db holds a session covering the scan
    // window: the same tokens live in that db — excluded, loudly.
    writeCoveringHermesDb(home);
    const hermesFile = path.join(codexDay, 'rollout-hermes.jsonl');
    fs.appendFileSync(hermesFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(hermesFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(hermesFile, timestamp, 17);

    // Unknown originator: lands in Codex CLI but never silently.
    const mysteryFile = path.join(codexDay, 'rollout-mystery.jsonl');
    fs.appendFileSync(mysteryFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'codex_next_thing', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(mysteryFile, 'gpt-5.6-sol', 'openai');
    writeTokenCountLine(mysteryFile, timestamp, 19);

    const summary = await buildForPeriod('day');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.equal(codexAppAgent.summary.periodTokens, 11, 'other desktop installs classify as Codex App');
    assert.equal(codexCliAgent.summary.periodTokens, 13 + 19, 'desktop-originated exec runs and unknown originators classify as Codex CLI');
    assert.equal(summary.summary.periodTokens, 11 + 13 + 19, 'hermes-owned rollouts are excluded from the combined total');
    assert.deepEqual(
      summary.summary.hermesOwnedCodexSkipped,
      { files: 1, tokens: 17 },
      'excluded hermes-owned usage must be reported, not silently dropped',
    );
    assert.deepEqual(
      summary.summary.unrecognizedCodexOriginators,
      { codex_next_thing: 19 },
      'unknown originators must surface through the unrecognized counter',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    const timestamp = today.toISOString();

    // NO Hermes state.db anywhere: dropping these rollouts would erase the
    // tokens from every bucket, so they must be RETAINED (Codex CLI) instead.
    const hermesFile = path.join(codexDay, 'rollout-hermes-nodb.jsonl');
    fs.appendFileSync(hermesFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(hermesFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(hermesFile, timestamp, 23);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.equal(
      codexCliAgent.summary.periodTokens,
      23,
      'without an available Hermes state.db, hermes-owned rollouts must be retained in Codex CLI',
    );
    assert.equal(summary.summary.periodTokens, 23, 'retained hermes-owned tokens must reach the combined total');
    assert.deepEqual(
      summary.summary.hermesOwnedCodexSkipped,
      { files: 0, tokens: 0 },
      'nothing may be reported as skipped when the Hermes db is unavailable',
    );
    assert.deepEqual(
      summary.summary.hermesOwnedCodexRetained,
      { files: 1, tokens: 23 },
      'the retained-fallback path must be reported, not silent',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    const timestamp = today.toISOString();

    // state.db EXISTS but is not a database: the router's hermesUsageSummary
    // cannot produce these tokens either, so existence alone must not authorize
    // dropping them — otherwise they vanish from every bucket.
    fs.mkdirSync(path.join(home, '.hermes', 'profiles', 'hmudur'), { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', 'profiles', 'hmudur', 'state.db'), 'not a database');

    const hermesFile = path.join(codexDay, 'rollout-hermes-corrupt-db.jsonl');
    fs.appendFileSync(hermesFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(hermesFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(hermesFile, timestamp, 41);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.equal(
      codexCliAgent.summary.periodTokens,
      41,
      'an unqueryable Hermes state.db must retain hermes-owned rollouts in Codex CLI',
    );
    assert.equal(summary.summary.periodTokens, 41, 'retained tokens from an unqueryable db must reach the combined total');
    assert.deepEqual(
      summary.summary.hermesOwnedCodexSkipped,
      { files: 0, tokens: 0 },
      'a present-but-unqueryable db must not authorize exclusion',
    );
    assert.deepEqual(
      summary.summary.hermesOwnedCodexRetained,
      { files: 1, tokens: 41 },
      'the retained-fallback must be reported when the db exists but cannot be queried',
    );
  });

  // A queryable db is not evidence that the excluded usage is represented:
  // an empty sessions table answers the probe but contributes zero rows to
  // hermesUsageSummary, so exclusion would erase the tokens from every bucket.
  for (const [label, startedAtSecs, tokens] of [
    ['an empty sessions table', [], 53],
    ['only sessions far outside the scan window', [Math.floor(Date.now() / 1000) - 90 * 86400], 59],
  ]) {
    await withTempHome(async (home) => {
      const today = new Date();
      const codexDay = path.join(
        home,
        '.codex',
        'sessions',
        String(today.getFullYear()),
        String(today.getMonth() + 1).padStart(2, '0'),
        String(today.getDate()).padStart(2, '0'),
      );
      fs.mkdirSync(codexDay, { recursive: true });
      const timestamp = today.toISOString();

      writeHermesDb(home, { startedAtSecs });

      const hermesFile = path.join(codexDay, 'rollout-hermes-uncovered.jsonl');
      fs.appendFileSync(hermesFile, `${JSON.stringify({
        type: 'session_meta',
        payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
      })}\n`);
      writeTurnContextLine(hermesFile, 'gpt-5.5', 'openai');
      writeTokenCountLine(hermesFile, timestamp, tokens);

      const summary = await buildForPeriod('day');
      const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
      assert.equal(
        codexCliAgent.summary.periodTokens,
        tokens,
        `with ${label}, hermes-owned rollouts must be retained in Codex CLI`,
      );
      assert.equal(summary.summary.periodTokens, tokens, `tokens must survive when the db has ${label}`);
      assert.deepEqual(
        summary.summary.hermesOwnedCodexSkipped,
        { files: 0, tokens: 0 },
        `${label} must not authorize exclusion`,
      );
      assert.deepEqual(
        summary.summary.hermesOwnedCodexRetained,
        { files: 1, tokens },
        `the retained-fallback must be reported when the db has ${label}`,
      );
    });
  }

  await withTempHome(async (home) => {
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400_000);
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });

    // The Hermes bucket represents YESTERDAY only. Coverage is per-day, so a
    // row on one day inside the scan window must not authorize excluding
    // hermes-owned usage recorded on another day — that day's tokens exist in
    // no bucket at all. Both sides bucket in machine-local time.
    writeHermesDb(home, { startedAtSecs: [Math.floor(Date.now() / 1000) - 86400] });

    const coveredFile = path.join(codexDay, 'rollout-hermes-covered-day.jsonl');
    fs.appendFileSync(coveredFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(coveredFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(coveredFile, yesterday.toISOString(), 61);

    const uncoveredFile = path.join(codexDay, 'rollout-hermes-uncovered-day.jsonl');
    fs.appendFileSync(uncoveredFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(uncoveredFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(uncoveredFile, today.toISOString(), 67);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.deepEqual(
      summary.summary.hermesOwnedCodexSkipped,
      { files: 1, tokens: 61 },
      'only the day the Hermes bucket actually represents may be excluded',
    );
    assert.deepEqual(
      summary.summary.hermesOwnedCodexRetained,
      { files: 1, tokens: 67 },
      'a hermes-owned record on an uncovered day must be retained, not dropped',
    );
    assert.equal(
      codexCliAgent.summary.periodTokens,
      67,
      "today's hermes-owned usage must survive when the Hermes bucket only covers yesterday",
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    const timestamp = today.toISOString();

    // started_at is present and in-window, but the token/billing columns
    // hermesUsageSummary aggregates are gone (schema drift / partial
    // migration). The server query fails there, so the Hermes bucket is empty —
    // a probe that only reads started_at would authorize erasing these tokens.
    writeStartedAtOnlyHermesDb(home, { startedAtSecs: [Math.floor(Date.now() / 1000)] });

    const hermesFile = path.join(codexDay, 'rollout-hermes-partial-schema.jsonl');
    fs.appendFileSync(hermesFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'hermes', source: 'vscode', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(hermesFile, 'gpt-5.5', 'openai');
    writeTokenCountLine(hermesFile, timestamp, 71);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.equal(
      codexCliAgent.summary.periodTokens,
      71,
      'a sessions table missing the consumed columns must retain hermes-owned rollouts in Codex CLI',
    );
    assert.deepEqual(
      summary.summary.hermesOwnedCodexSkipped,
      { files: 0, tokens: 0 },
      'a schema the consumer cannot query must not authorize exclusion',
    );
    assert.deepEqual(
      summary.summary.hermesOwnedCodexRetained,
      { files: 1, tokens: 71 },
      'the retained-fallback must be reported on Hermes schema drift',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    // API-key auth on this codex home: metered billing evidence, so zero-cost
    // usage may NOT be claimed as subscription-included.
    writeCodexAuth(home, { OPENAI_API_KEY: 'sk-test', tokens: {} });
    const timestamp = today.toISOString();

    const execFile = path.join(codexDay, 'rollout-apikey.jsonl');
    fs.appendFileSync(execFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'codex_exec', source: 'exec', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(execFile, 'gpt-5.6-terra', 'openai');
    writeTokenCountLine(execFile, timestamp, 43);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.deepEqual(
      codexCliAgent.byService.map((service) => [service.name, service.tokens, service.costSource]),
      [['openai/gpt-5.6-terra', 43, 'unknown']],
      'API-key authenticated codex homes must not display zero-cost usage as subscription-included',
    );
  });

  await withTempHome(async (home) => {
    const today = new Date();
    const codexDay = path.join(
      home,
      '.codex',
      'sessions',
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(codexDay, { recursive: true });
    // No auth.json at all: no billing evidence either way — honest unknown.
    const timestamp = today.toISOString();

    const execFile = path.join(codexDay, 'rollout-noauth.jsonl');
    fs.appendFileSync(execFile, `${JSON.stringify({
      type: 'session_meta',
      payload: { originator: 'codex_exec', source: 'exec', model_provider: 'openai' },
    })}\n`);
    writeTurnContextLine(execFile, 'gpt-5.6-terra', 'openai');
    writeTokenCountLine(execFile, timestamp, 47);

    const summary = await buildForPeriod('day');
    const codexCliAgent = summary.agents.find((agent) => agent.key === 'codex_cli');
    assert.deepEqual(
      codexCliAgent.byService.map((service) => [service.name, service.tokens, service.costSource]),
      [['openai/gpt-5.6-terra', 47, 'unknown']],
      'without auth.json evidence, codex usage must stay unknown rather than claim subscription billing',
    );
  });
}

runBehaviorTests()
  .then(() => console.log('openclaw usage script tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
