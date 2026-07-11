const assert = require('node:assert/strict');
const test = require('node:test');

const {
  requiresExplicitConfirmation,
} = require('../server/routes/gbrain/actionPolicy');
const { runGBrainAction } = require('../server/routes/gbrain/actionsExecutor');

test('requires explicit confirmation for W1 action definitions', () => {
  const w1 = { safetyClass: 'W1', requiresConfirmation: true };
  assert.equal(requiresExplicitConfirmation(w1, {}), true);
  assert.equal(requiresExplicitConfirmation(w1, { confirmed: false }), true);
  assert.equal(requiresExplicitConfirmation(w1, { confirmed: true }), false);
});

test('does not add a confirmation gate to read-only actions', () => {
  assert.equal(requiresExplicitConfirmation({ safetyClass: 'R0', requiresConfirmation: false }, {}), false);
  assert.equal(requiresExplicitConfirmation({ safetyClass: 'W2', requiresConfirmation: true }, {}), false);
});

test('rejects inherited action names before invoking the command runner', async () => {
  let invoked = false;
  const result = await runGBrainAction('constructor', {
    execFilePromise: async () => {
      invoked = true;
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'rejected');
  assert.match(result.error, /Unsupported GBrain action/);
  assert.equal(invoked, false);
});
