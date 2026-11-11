const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createConfigStore } = require('../server/core/config');
const {
  createSettingsService,
  normalizeMonthlyBudget,
} = require('../server/services/settingsData');

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-data-'));
  const configPath = path.join(dir, 'mc-config.json');
  const defaultConfigPath = path.join(dir, 'mc-config.default.json');
  const packagePath = path.join(dir, 'package.json');
  const mcConfig = { budget: { monthly: 5 } };
  fs.writeFileSync(configPath, JSON.stringify(mcConfig, null, 2));
  fs.writeFileSync(defaultConfigPath, '{}');
  fs.writeFileSync(packagePath, JSON.stringify({ version: 'test' }));

  const configStore = createConfigStore({ config: { paths: { mcConfig: configPath }, mc: mcConfig } });
  const service = createSettingsService({
    configStore,
    homeDir: dir,
    fetchImpl: async () => { throw new Error('No network expected'); },
    mcConfig,
    missionControlConfigPath: configPath,
    missionControlDefaultConfigPath: defaultConfigPath,
    missionControlPackagePath: packagePath,
    missionControlRoot: dir,
    gatewayPort: 1,
    gatewayToken: 'test',
    memoryPath: dir,
    skillsPath: dir,
    bedrockRegion: 'us-test-1',
    openclawExec: async () => {},
  });

  return { service, configPath, configStore, dir };
}

function testMonthlyBudgetNormalization() {
  assert.equal(normalizeMonthlyBudget(12.5), 12.5);
  assert.equal(normalizeMonthlyBudget(0), 0);
  assert.equal(normalizeMonthlyBudget(null), null);
  assert.throws(() => normalizeMonthlyBudget('0'), /finite number/);
  assert.throws(() => normalizeMonthlyBudget(''), /finite number/);
  assert.throws(() => normalizeMonthlyBudget(-1), /zero or positive/);
  assert.throws(() => normalizeMonthlyBudget('not-a-number'), /zero or positive/);
}

function testUpdateBudgetRejectsNegativeValues() {
  const { service, configPath } = makeService();

  assert.throws(() => service.updateBudget(-10), /zero or positive/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).budget, { monthly: 5 });

  assert.deepEqual(service.updateBudget(42.25), { status: 'saved', budget: { monthly: 42.25 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).budget, { monthly: 42.25 });
}

function testUnknownFieldsAndCoreStore() {
  const { service, configStore } = makeService();
  assert.equal(service.getSettingsPayload().model, null);
  const { meta, ...routing } = service.getModelRouting();
  assert.deepEqual(routing, { main: null, subagent: null, heartbeat: null, mainSource: 'unreadable', subagentSource: 'unreadable', heartbeatSource: 'unreadable' });
  assert.equal(meta.ok, false);
  assert.deepEqual(service.getHeartbeatSettings(), { interval: null });
  service.updateBudget(10);
  assert.equal(configStore.status().writes, 1);
}

async function testSetupDoesNotProbeNetwork() {
  const { service } = makeService();
  const setup = await service.getSetupStatus();
  assert.equal(setup.gatewayRunning, null);
  assert.equal(setup.gatewayVersion, null);
  assert.equal(setup.detectedConfig.agentName, null);
}

function testFailedStorePreservesInMemoryConfig() {
  const mcConfig = { budget: { monthly: 1 } };
  const service = createSettingsService({ mcConfig, configStore: { persist() { throw new Error('write failed'); } } });
  assert.throws(() => service.updateBudget(9), /write failed/);
  assert.deepEqual(mcConfig, { budget: { monthly: 1 } });
}

function testMissingStoreNeverWrites() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-settings-no-store-'));
  const configPath = path.join(dir, 'mc-config.json');
  fs.writeFileSync(configPath, '{"budget":{"monthly":1}}');
  const service = createSettingsService({ mcConfig: { budget: { monthly: 1 } }, missionControlConfigPath: configPath });
  assert.throws(() => service.updateBudget(5), { code: 'config_store_unavailable' });
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"budget":{"monthly":1}}');
}

function testExportRecursivelyRedactsSecrets() {
  const service = createSettingsService({ mcConfig: {
    gateway: { token: 'sentinel-gateway' },
    nested: { api_key: 'sentinel-key', password: 'sentinel-password' },
    aws: { secretAccessKey: 'sentinel-secret' }, name: 'Console',
    databaseUrl: 'sentinel-database-url', credentials: { value: 'sentinel-credential' },
    nestedUrl: 'postgres://test:sentinel-pass@localhost/db',
  } });
  const safe = service.getExportConfig();
  assert.equal(safe.name, 'Console');
  assert.doesNotMatch(JSON.stringify(safe), /sentinel/);
  assert.equal(safe.nested.api_key, '[redacted]');
}

function testExportRedactsSecretNamedContainersBeforeDescending() {
  const containers = {
    apiKeys: ['SENTINEL_KEY'],
    tokens: { primary: 'SENTINEL_TOKEN' },
    api_keys: ['SENTINEL_SNAKE_KEY'],
    accessTokens: { current: 'SENTINEL_ACCESS_TOKEN' },
    access_tokens: ['SENTINEL_SNAKE_TOKEN'],
    clientSecret: { value: 'SENTINEL_CLIENT_SECRET' },
    client_secret: ['SENTINEL_SNAKE_SECRET'],
  };
  const service = createSettingsService({ mcConfig: { providers: containers, name: 'Console' } });
  const safe = service.getExportConfig();
  assert.equal(safe.name, 'Console');
  assert.doesNotMatch(JSON.stringify(safe), /SENTINEL/);
  for (const key of Object.keys(containers)) assert.equal(safe.providers[key], '[redacted]', key);
}

testExportRedactsSecretNamedContainersBeforeDescending();
testUnknownFieldsAndCoreStore();
testMissingStoreNeverWrites();
testFailedStorePreservesInMemoryConfig();
testExportRecursivelyRedactsSecrets();
testSetupDoesNotProbeNetwork().catch((error) => { console.error(error); process.exitCode = 1; });
testMonthlyBudgetNormalization();
testUpdateBudgetRejectsNegativeValues();
console.log('settingsData tests passed');
