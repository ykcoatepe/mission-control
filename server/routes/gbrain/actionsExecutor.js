'use strict';

const { GBrainActionDefinitions, activeGBrainActions } = require('./constants');
const { requiresExplicitConfirmation } = require('./actionPolicy');
const {
  createGBrainExecOptions,
  sanitizeMessage,
  parseJsonFromOutput,
  summarizeCommandOutput,
  sanitizePayload,
} = require('./commandRunner');

const { createExec } = require('../../core/exec');
const GBRAIN_ACTION_EXEC_LANES = Object.freeze({ 'gbrain-action': Object.freeze({ concurrency: 1, maxQueue: 0 }) });
let defaultActionExec;

function listGBrainActions() {
  return Object.entries(GBrainActionDefinitions).map(([id, definition]) => ({
    id,
    label: definition.label,
    description: definition.description,
    kind: definition.kind,
    safetyClass: definition.safetyClass,
    requiresConfirmation: definition.requiresConfirmation,
    timeoutMs: definition.timeoutMs,
    refreshAfter: definition.refreshAfter,
    command: [`gbrain ${definition.args.join(' ')}`, definition.afterSuccessArgs ? `gbrain ${definition.afterSuccessArgs.join(' ')}` : '']
      .filter(Boolean)
      .join(' && '),
  }));
}

async function runGBrainAction(action, options = {}) {
  const definition = Object.hasOwn(GBrainActionDefinitions, action)
    ? GBrainActionDefinitions[action]
    : null;
  const checkedAt = new Date().toISOString();

  if (!definition) {
    return {
      ok: false,
      status: 'rejected',
      checkedAt,
      error: `Unsupported GBrain action: ${sanitizeMessage(action)}`,
    };
  }

  if (requiresExplicitConfirmation(definition, options)) {
    return { ok: false, action, status: 'confirmation-required', checkedAt,
      error: 'Explicit confirmation is required for this action.' };
  }

  if (activeGBrainActions.size > 0) {
    return {
      ok: false,
      status: 'busy',
      checkedAt,
      error: 'Another GBrain action is already running.',
    };
  }

  activeGBrainActions.add(action);
  try {
    const exec = options.exec || (defaultActionExec ||= createExec({ lanes: GBRAIN_ACTION_EXEC_LANES }));
    const execute = async (args) => {
      const result = await exec.run('gbrain', args, { lane: 'gbrain-action',
        timeoutMs: definition.timeoutMs, maxOutputBytes: 1024 * 1024,
        env: createGBrainExecOptions(definition.timeoutMs).env });
      const quarantined = ['kill_unverified', 'lane_quarantined'].includes(result.error?.code);
      return { ...result, pending: false, quarantined,
        error: result.ok ? '' : quarantined ? 'GBrain action lane is quarantined; command exit could not be verified.'
          : result.timedOut ? 'GBrain action timed out.' : 'GBrain action failed.' };
    };
    const result = await execute(definition.args);
    const followUpResult = result.ok && definition.afterSuccessArgs ? await execute(definition.afterSuccessArgs) : null;
    const actionOk = result.ok && (!followUpResult || followUpResult.ok);
    const payload = parseJsonFromOutput(result.stdout);
    const followUpPayload = followUpResult ? parseJsonFromOutput(followUpResult.stdout) : null;
    const responsePayload = followUpResult ? { result: payload, afterSuccess: followUpPayload } : payload;
    const summary = [result, followUpResult]
      .filter(Boolean)
      .map((item) => !item.ok && !item.stdout && !item.stderr ? item.error : summarizeCommandOutput(item.stdout, item.stderr))
      .join('\n');
    const pending = Boolean(result.pending || followUpResult?.pending);

    return {
      ok: actionOk,
      mode: 'live-write',
      action,
      label: definition.label,
      args: definition.args,
      afterSuccessArgs: definition.afterSuccessArgs,
      checkedAt,
      status: actionOk ? 'completed' : result.quarantined || followUpResult?.quarantined ? 'unavailable'
        : result.timedOut || followUpResult?.timedOut ? 'timed-out' : 'failed',
      pending,
      refreshAfter: definition.refreshAfter,
      summary,
      payload: responsePayload ? sanitizePayload(responsePayload) : null,
      error: actionOk ? '' : followUpResult?.error || result.error || summary,
    };
  } finally {
    // The core runner settles only on verified exit or bounded quarantine.
    // Quarantine keeps the native lane closed; this application lock must release.
    activeGBrainActions.delete(action);
  }
}

module.exports = { listGBrainActions, runGBrainAction, GBRAIN_ACTION_EXEC_LANES };
