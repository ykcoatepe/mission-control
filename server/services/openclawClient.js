// OpenClaw CLI access. Every call goes through the core process runner on the
// `openclaw` lane (concurrency 1): parallel OpenClaw CLI calls corrupt each
// other (`openclaw system heartbeat last` next to `openclaw sessions` puts the
// state store into "offline maintenance").

// Read verbs whose identical concurrent calls may share one child process.
// Mutating verbs are never merged: two clicks mean two invocations.
const SINGLE_FLIGHT_READS = [
  'sessions',
  'status',
  'system heartbeat last',
  'cron list',
  'models list',
  'models aliases list',
  'agents list',
  'skills list',
];

function singleFlightKey(args) {
  const joined = args.join(' ');
  return SINGLE_FLIGHT_READS.some((verb) => joined === verb || joined.startsWith(`${verb} `))
    ? joined
    : null;
}

function buildOpenclawEnv({ configPath, processEnv = process.env }) {
  const env = {
    ...processEnv,
    HOME: processEnv.HOME || '/home/ubuntu',
    USER: processEnv.USER || 'user',
    LOGNAME: processEnv.LOGNAME || processEnv.USER || 'user',
    LANG: processEnv.LANG || 'en_US.UTF-8',
    PATH: `/opt/homebrew/bin:/usr/local/bin:${processEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`,
    OPENCLAW_CONFIG_PATH: configPath,
  };
  delete env.OPENCLAW_GATEWAY_TOKEN;
  delete env.OPENCLAW_GATEWAY_REMOTE_TOKEN;
  return env;
}

// Typed access: resolves to the runner's result ({ ok, code, stdout, stderr,
// timedOut, latencyMs, error }), never throws for a failed command.
function createOpenclawCli({ runner, bin, configPath, processEnv = process.env, maxOutputBytes = 20 * 1024 * 1024 }) {
  if (typeof runner?.run !== 'function') throw new TypeError('createOpenclawCli: runner.run required');
  return function openclawCli(args, timeoutMs = 10000) {
    return runner.run(bin, args, {
      lane: 'openclaw',
      timeoutMs,
      maxOutputBytes,
      env: buildOpenclawEnv({ configPath, processEnv }),
      key: singleFlightKey(args),
    });
  };
}

// Legacy promise contract kept for existing callers: resolves { stdout,
// stderr } and rejects like child_process.execFile (error.code, .stdout,
// .stderr, .killed) when the command fails.
function createOpenclawExec({ runner, execFilePromise, bin, configPath, processEnv = process.env }) {
  if (runner) {
    const cli = createOpenclawCli({ runner, bin, configPath, processEnv });
    return async function openclawExec(args, timeout = 10000) {
      const result = await cli(args, timeout);
      if (result.ok) return { stdout: result.stdout, stderr: result.stderr };
      const error = new Error(result.error?.message || `openclaw ${args[0] || ''} exited with code ${result.code}`);
      error.code = result.code ?? result.error?.code ?? null;
      error.signal = result.signal || null;
      error.killed = Boolean(result.timedOut);
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    };
  }
  return async function openclawExec(args, timeout = 10000) {
    return execFilePromise(bin, args, {
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: buildOpenclawEnv({ configPath, processEnv }),
    });
  };
}

module.exports = {
  createOpenclawExec,
  createOpenclawCli,
  buildOpenclawEnv,
  singleFlightKey,
};
