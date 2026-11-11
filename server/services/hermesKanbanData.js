const fs = require('fs');
const os = require('os');
const { httpError } = require('../core/http');
const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done'];
const RUNNER_UNAVAILABLE = new Set(['lane_busy', 'lane_quarantined', 'shutdown', 'timeout', 'queue_timeout', 'kill_unverified', 'max_output']);

function findHermesBin(processEnv) {
  const home = processEnv.MC_USER_HOME || processEnv.HOME || os.homedir();
  return [
    processEnv.HERMES_BIN,
    `${home}/.local/bin/hermes`,
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    'hermes',
  ].filter(Boolean).find((candidate) => {
    try {
      return candidate === 'hermes' || fs.existsSync(candidate);
    } catch {
      return candidate === 'hermes';
    }
  }) || 'hermes';
}

function normalizeEpoch(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric * 1000).toISOString();
}

function parseJsonOutput(stdout, fallback) {
  const text = String(stdout || '').trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[\[{]/);
    if (start >= 0) return JSON.parse(text.slice(start));
    throw new Error(`Hermes returned non-JSON output: ${text.slice(0, 120)}`);
  }
}

function normalizeTask(task) {
  return {
    ...task,
    createdAt: normalizeEpoch(task.created_at),
    startedAt: normalizeEpoch(task.started_at),
    completedAt: normalizeEpoch(task.completed_at),
    lastHeartbeatAt: normalizeEpoch(task.last_heartbeat_at),
    skills: Array.isArray(task.skills) ? task.skills : [],
  };
}

function normalizeAssignee(row) {
  const counts = row?.counts && typeof row.counts === 'object' ? row.counts : {};
  const active = ['triage', 'todo', 'ready', 'running', 'blocked']
    .reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  return {
    name: String(row?.name || 'unknown'),
    onDisk: Boolean(row?.on_disk),
    counts,
    active,
  };
}

function buildHermesEnv(profile, processEnv) {
  const hostHome = processEnv.MC_USER_HOME || processEnv.HOME || os.homedir();
  return {
    ...processEnv,
    HOME: hostHome,
    HERMES_PROFILE: profile,
  };
}

function createHermesKanbanService({
  mcConfig = {},
  runner,
  processEnv = process.env,
  now = Date.now,
  maxConcurrency = 2,
  freshMs = 5 * 60 * 1000,
  maxStaleMs = 10 * 60 * 1000,
} = {}) {
  if (typeof runner?.run !== 'function') throw new TypeError('createHermesKanbanService: core runner required');
  const profile = processEnv.HERMES_PROFILE || mcConfig?.hermes?.profile || 'hmudur';
  const hermesBin = processEnv.HERMES_BIN || findHermesBin(processEnv);

  async function hermes(args, { json = false, timeout = 15000 } = {}) {
    const argv = ['--profile', profile, 'kanban', ...args];
    const result = await runner.run(
      hermesBin,
      argv,
      {
        lane: 'hermes',
        key: JSON.stringify(['hermes-kanban', hermesBin, buildHermesEnv(profile, processEnv).HOME, argv]),
        env: buildHermesEnv(profile, processEnv),
        timeoutMs: timeout,
        maxOutputBytes: 10 * 1024 * 1024,
      },
    );
    if (!result?.ok) {
      const code = typeof result?.error?.code === 'string' && /^[a-z][a-z0-9_]{1,63}$/i.test(result.error.code)
        ? result.error.code : 'hermes_kanban_unavailable';
      throw httpError(503, code, 'Hermes Kanban could not be read');
    }
    const { stdout, stderr } = result;
    const out = String(stdout || '').trim();
    if (out.toLowerCase().includes('could not initialize database')) throw httpError(503, 'hermes_kanban_unavailable', 'Hermes Kanban could not be read');
    return json ? parseJsonOutput(out, null) : { stdout: out, stderr: String(stderr || '').trim() };
  }

  // Bounded-concurrency map: ~8 parallel CLI spawns used to time out together
  // under machine load and flip the whole board to unavailable.
  async function mapLimited(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    let firstError;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await fn(items[index]);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          throw error;
        }
      }
    });
    // Keep the shared refresh in flight until every started CLI call finishes.
    // A failed worker stops the queue, but cannot detach its still-running peers.
    await Promise.allSettled(workers);
    if (failed) throw firstError;
    return results;
  }

  async function fetchBoard() {
    const columns = {};
    const calls = [
      ...STATUSES.map((status) => async () => {
        const tasks = await hermes(['list', '--status', status, '--json'], { json: true });
        return [status, Array.isArray(tasks) ? tasks.map(normalizeTask) : []];
      }),
      async () => hermes(['stats', '--json'], { json: true }).catch(error => { if (RUNNER_UNAVAILABLE.has(error.code)) throw error; return null; }),
      async () => hermes(['assignees', '--json'], { json: true }).catch(error => { if (RUNNER_UNAVAILABLE.has(error.code)) throw error; return []; }),
    ];
    const settled = await mapLimited(calls, maxConcurrency, (call) => call());
    const lists = settled.slice(0, STATUSES.length);
    const stats = settled[STATUSES.length];
    const assignees = settled[STATUSES.length + 1];
    for (const [status, tasks] of lists) columns[status] = tasks;
    const allTasks = Object.values(columns).flat();
    const active = ['triage', 'todo', 'ready', 'running', 'blocked']
      .reduce((sum, status) => sum + columns[status].length, 0);
    return {
      ok: true,
      source: 'hermes-kanban-cli',
      profile,
      refreshedAt: new Date(now()).toISOString(),
      statuses: STATUSES,
      columns,
      stats,
      assignees: Array.isArray(assignees) ? assignees.map(normalizeAssignee) : [],
      summary: {
        total: allTasks.length,
        active,
        done: columns.done.length,
        blocked: columns.blocked.length,
        running: columns.running.length,
        byAssignee: allTasks.reduce((acc, task) => {
          const key = task.assignee || 'unassigned';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      },
    };
  }

  let lastGood = null; // { board, at }
  let inFlight = null;

  function startRefresh() {
    if (!inFlight) {
      inFlight = fetchBoard()
        .then((board) => {
          lastGood = { board, at: now() };
          return board;
        })
        .finally(() => { inFlight = null; });
      inFlight.catch(() => {}); // callers handle rejection; avoid unhandled when detached
    }
    return inFlight;
  }

  function staleBoard() {
    if (!lastGood) return null;
    const ageMs = now() - lastGood.at;
    if (ageMs > maxStaleMs) return null;
    // Younger than freshMs: still fresh (a refresh merely hasn't finished within
    // the poll interval); carry the age but do not flag it stale.
    if (ageMs <= freshMs) return { ...lastGood.board, cacheAgeMs: ageMs };
    return { ...lastGood.board, stale: true, staleAgeMs: ageMs };
  }

  // Fresh board when the refresh succeeds. If it fails, or exceeds the soft
  // deadline, serve the last good board (fresh with cacheAgeMs while younger than
  // freshMs, then marked stale with staleAgeMs) until it is older than maxStaleMs. The refresh is shared and keeps running.
  async function getBoard({ softDeadlineMs } = {}) {
    const refresh = startRefresh();
    try {
      if (!softDeadlineMs) return await refresh;
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), softDeadlineMs);
        timer.unref?.();
      });
      const fresh = await Promise.race([refresh, deadline]);
      clearTimeout(timer);
      if (fresh) return fresh;
      return staleBoard() || await refresh;
    } catch (error) {
      const stale = staleBoard();
      if (stale) return { ...stale, unavailable: true, error: { code: error.code || 'hermes_kanban_unavailable', message: 'Hermes Kanban could not be read' } };
      throw error;
    }
  }

  return { profile, getBoard };
}

module.exports = { STATUSES, createHermesKanbanService };
