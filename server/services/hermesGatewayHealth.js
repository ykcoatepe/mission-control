const fs = require('fs');
const os = require('os');
const path = require('path');

// Heartbeat: the gateway rewrites gateway_state.json (updated_at) about once a
// minute. A live pid with a heartbeat older than this is a wedged gateway.
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function unavailable(error) {
  return { ok: false, unavailable: true, error };
}

// Read-only gateway liveness. Proof = the gateway's own state file
// (gateway_state=running, pid, heartbeat) corroborated by a live pid. It does
// not spawn the Hermes CLI, so it stays cheap and stable under machine load.
function createHermesGatewayHealthService({
  profile = 'hmudur',
  home = os.homedir(),
  now = Date.now,
  readFile = (file) => fs.promises.readFile(file, 'utf8'),
  isPidAlive = defaultIsPidAlive,
  heartbeatStaleMs = HEARTBEAT_STALE_MS,
} = {}) {
  const stateFile = path.join(home, '.hermes', 'profiles', profile, 'gateway_state.json');

  async function getHealth() {
    const observedAt = new Date(now()).toISOString();
    let state;
    try {
      state = JSON.parse(await readFile(stateFile));
    } catch {
      return unavailable('Hermes gateway state could not be read');
    }
    const pid = Number(state?.pid);
    if (!state || typeof state !== 'object' || !Number.isInteger(pid) || pid <= 0) {
      return unavailable('Hermes gateway state is malformed');
    }
    const heartbeatMs = Date.parse(state.updated_at);
    const heartbeatAt = Number.isFinite(heartbeatMs) ? new Date(heartbeatMs).toISOString() : null;
    const base = { ok: true, pid, observedAt, heartbeatAt };

    if (state.gateway_state !== 'running') {
      return { ...base, status: 'down', reason: `gateway state is ${String(state.gateway_state || 'unknown')}` };
    }
    if (!isPidAlive(pid)) {
      return { ...base, status: 'down', reason: 'gateway process not running' };
    }
    if (heartbeatMs === undefined || !Number.isFinite(heartbeatMs) || now() - heartbeatMs > heartbeatStaleMs) {
      return { ...base, status: 'stale', reason: 'gateway heartbeat is stale' };
    }
    return { ...base, status: 'running' };
  }

  return { getHealth, stateFile };
}

module.exports = { HEARTBEAT_STALE_MS, createHermesGatewayHealthService };
