'use strict';

const { GBrainActionDefinitions, activeGBrainActions } = require('./constants');
const {
  defaultExecFilePromise,
  sanitizeMessage,
  parseJsonFromOutput,
  runGBrain,
  summarizeCommandOutput,
  sanitizePayload,
} = require('./commandRunner');

function listGBrainActions() {
  return Object.entries(GBrainActionDefinitions).map(([id, definition]) => ({
    id,
    label: definition.label,
    description: definition.description,
    kind: definition.kind,
    timeoutMs: definition.timeoutMs,
    refreshAfter: definition.refreshAfter,
    command: [`gbrain ${definition.args.join(' ')}`, definition.afterSuccessArgs ? `gbrain ${definition.afterSuccessArgs.join(' ')}` : '']
      .filter(Boolean)
      .join(' && '),
  }));
}

async function runGBrainAction(action, options = {}) {
  const definition = GBrainActionDefinitions[action];
  const checkedAt = new Date().toISOString();

  if (!definition) {
    return {
      ok: false,
      status: 'rejected',
      checkedAt,
      error: `Unsupported GBrain action: ${sanitizeMessage(action)}`,
    };
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
  const pendingCleanups = [];
  try {
    const execFilePromise = options.execFilePromise || defaultExecFilePromise;
    const result = await runGBrain(execFilePromise, definition.args, {
      softTimeoutMs: definition.softTimeoutMs,
      hardKillDelayMs: definition.hardKillDelayMs,
      timeoutMs: definition.timeoutMs,
    });
    if (result.cleanup) pendingCleanups.push(result.cleanup);
    const followUpResult = result.ok && definition.afterSuccessArgs
      ? await runGBrain(execFilePromise, definition.afterSuccessArgs, { timeoutMs: definition.timeoutMs })
      : null;
    if (followUpResult?.cleanup) pendingCleanups.push(followUpResult.cleanup);
    const actionOk = result.ok && (!followUpResult || followUpResult.ok);
    const payload = parseJsonFromOutput(result.stdout);
    const followUpPayload = followUpResult ? parseJsonFromOutput(followUpResult.stdout) : null;
    const responsePayload = followUpResult ? { result: payload, afterSuccess: followUpPayload } : payload;
    const summary = [result, followUpResult]
      .filter(Boolean)
      .map((item) => summarizeCommandOutput(item.stdout, item.stderr))
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
      status: actionOk ? 'completed' : pending ? 'timed-out' : 'failed',
      pending,
      refreshAfter: definition.refreshAfter,
      summary,
      payload: responsePayload ? sanitizePayload(responsePayload) : null,
      error: actionOk ? '' : followUpResult?.error || result.error || summary,
    };
  } finally {
    if (pendingCleanups.length) {
      Promise.allSettled(pendingCleanups).finally(() => activeGBrainActions.delete(action));
    } else {
      activeGBrainActions.delete(action);
    }
  }
}

module.exports = { listGBrainActions, runGBrainAction };
