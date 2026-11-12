'use strict';
const os = require('os');
const { createExec } = require('../../core/exec');
const { SourceReadError } = require('../../core/source');

function readError(code = 'gbrain_read_failed') {
  return new SourceReadError('GBrain reading unavailable', { code });
}
function createGBrainClient({ exec = createExec(), bin = 'gbrain', processEnv = process.env } = {}) {
  // deadlineMs (optional): one bound for the lane wait and the run together.
  async function run(args, { json = true, timeoutMs = 45_000, lane = 'gbrain', deadlineMs } = {}) {
    const deadline = Number(deadlineMs) > 0 ? Number(deadlineMs) : null;
    const result = await exec.run(bin, args, {
      lane, key: `gbrain:${JSON.stringify(args)}`, timeoutMs: Math.min(timeoutMs, 60_000, deadline ?? Infinity),
      queueTimeoutMs: Math.min(10_000, deadline ?? Infinity), ...(deadline ? { deadlineMs: deadline } : {}), maxOutputBytes: 2 * 1024 * 1024,
      env: { ...processEnv, GBRAIN_SKIP_STARTUP_HOOKS: '1',
        PATH: [`${os.homedir()}/.bun/bin`, '/opt/homebrew/bin', '/usr/local/bin', processEnv.PATH || ''].join(':') },
    });
    if (result.error?.code === 'lane_busy') throw readError('gbrain_lookup_busy');
    if (['lane_quarantined', 'kill_unverified'].includes(result.error?.code)) throw readError('gbrain_lookup_quarantined');
    if (result.error?.code === 'queue_timeout') throw readError('gbrain_timeout');
    if (!result.ok || result.truncated) throw readError(result.timedOut ? 'gbrain_timeout' : 'gbrain_read_failed');
    if (!json) return String(result.stdout || '').trim();
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { throw readError('gbrain_invalid_payload'); }
    if (payload == null || typeof payload !== 'object' || payload.error || payload.ok === false) throw readError('gbrain_invalid_payload');
    return payload;
  }
  return { run };
}
module.exports = { createGBrainClient, readError };
