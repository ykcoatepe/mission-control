const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  const service = createSettingsService({
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

  return { service, configPath };
}

function testMonthlyBudgetNormalization() {
  assert.equal(normalizeMonthlyBudget(12.5), 12.5);
  assert.equal(normalizeMonthlyBudget('0'), 0);
  assert.equal(normalizeMonthlyBudget(''), 0);
  assert.throws(() => normalizeMonthlyBudget(-1), /zero or positive/);
  assert.throws(() => normalizeMonthlyBudget('not-a-number'), /zero or positive/);
}

function testUpdateBudgetRejectsNegativeValues() {
  const { service, configPath } = makeService();

  assert.throws(() => service.updateBudget(-10), /zero or positive/);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).budget, { monthly: 5 });

  assert.deepEqual(service.updateBudget('42.25'), { status: 'saved', budget: { monthly: 42.25 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).budget, { monthly: 42.25 });
}

testMonthlyBudgetNormalization();
testUpdateBudgetRejectsNegativeValues();
console.log('settingsData tests passed');
