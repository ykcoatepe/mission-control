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

async function withTempHome(fn) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-openclaw-usage-'));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    process.env.HOME = previousHome;
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

function writeProviderOnlyUsageLine(file, timestamp, totalTokens, provider) {
  fs.appendFileSync(file, `${JSON.stringify({
    message: {
      timestamp,
      provider,
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
    const openclawAgent = summary.agents.find((agent) => agent.key === 'openclaw');
    assert.equal(codexAppAgent.summary.periodTokens, 41, 'nested codex-home sessions should be split into Codex App Sessions');
    assert.equal(openclawAgent.summary.periodTokens, 0, 'nested codex-home sessions should not inflate direct OpenClaw usage');
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
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.deepEqual(
      codexAppAgent.byService.map((service) => [service.name, service.tokens]),
      [['openai/gpt-5.6-sol', 42]],
      'Codex App usage should use preceding thread settings and turn context model metadata',
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
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.deepEqual(
      Object.fromEntries(codexAppAgent.byService.map((service) => [service.name, service.tokens])),
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
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.deepEqual(
      Object.fromEntries(codexAppAgent.byService.map((service) => [service.name, service.tokens])),
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
    writeProviderOnlyUsageLine(sessionFile, timestamp, 17, 'anthropic');

    const summary = await buildForPeriod('day');
    const codexAppAgent = summary.agents.find((agent) => agent.key === 'codex_app');
    assert.deepEqual(
      Object.fromEntries(codexAppAgent.byService.map((service) => [service.name, service.tokens])),
      {
        'openai/gpt-5.6-sol': 23,
        'anthropic/unknown': 17,
      },
      'an explicit provider must not inherit a contextual model from another provider',
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
}

runBehaviorTests()
  .then(() => console.log('openclaw usage script tests passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
