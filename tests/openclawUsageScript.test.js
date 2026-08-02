const assert = require('node:assert/strict');
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

    // Hermes-owned AND the Hermes state.db is present: the same tokens live in
    // that db — excluded, loudly.
    fs.mkdirSync(path.join(home, '.hermes', 'profiles', 'hmudur'), { recursive: true });
    fs.writeFileSync(path.join(home, '.hermes', 'profiles', 'hmudur', 'state.db'), '');
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
}

runBehaviorTests()
  .then(() => console.log('openclaw usage script tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
