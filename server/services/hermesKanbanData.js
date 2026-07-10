const fs = require('fs');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');

const defaultExecFilePromise = util.promisify(execFile);
const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done'];

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

function normalizeDetail(payload) {
  const task = normalizeTask(payload.task || {});
  const events = Array.isArray(payload.events) ? payload.events.map((event) => ({
    ...event,
    createdAt: normalizeEpoch(event.created_at),
  })) : [];
  const comments = Array.isArray(payload.comments) ? payload.comments.map((comment) => ({
    ...comment,
    createdAt: normalizeEpoch(comment.created_at),
  })) : [];
  const runs = Array.isArray(payload.runs) ? payload.runs.map((run) => ({
    ...run,
    startedAt: normalizeEpoch(run.started_at),
    endedAt: normalizeEpoch(run.ended_at),
  })) : [];
  return { ...payload, task, events, comments, runs };
}

function buildHermesEnv(profile, processEnv) {
  const hostHome = processEnv.MC_USER_HOME || processEnv.HOME || os.homedir();
  return {
    ...processEnv,
    HOME: hostHome,
    HERMES_PROFILE: profile,
  };
}

function assertNoFlagPrefix(value, label) {
  const text = String(value || '');
  if (text.startsWith('-')) {
    const error = new Error(`${label} cannot start with "-"`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function actionValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.responseBody = { error: message };
  return error;
}

function createHermesKanbanService({
  mcConfig = {},
  execFilePromise = defaultExecFilePromise,
  processEnv = process.env,
} = {}) {
  const profile = processEnv.HERMES_PROFILE || mcConfig?.hermes?.profile || 'hmudur';
  const hermesBin = processEnv.HERMES_BIN || findHermesBin(processEnv);

  async function hermes(args, { json = false, timeout = 15000 } = {}) {
    const { stdout, stderr } = await execFilePromise(
      hermesBin,
      ['--profile', profile, 'kanban', ...args],
      {
        env: buildHermesEnv(profile, processEnv),
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const out = String(stdout || '').trim();
    if (out.toLowerCase().includes('could not initialize database')) throw new Error(out);
    return json ? parseJsonOutput(out, null) : { stdout: out, stderr: String(stderr || '').trim() };
  }

  async function getBoard() {
    const columns = {};
    const [lists, stats, assignees] = await Promise.all([
      Promise.all(STATUSES.map(async (status) => {
        const tasks = await hermes(['list', '--status', status, '--json'], { json: true });
        return [status, Array.isArray(tasks) ? tasks.map(normalizeTask) : []];
      })),
      hermes(['stats', '--json'], { json: true }).catch(() => null),
      hermes(['assignees', '--json'], { json: true }).catch(() => []),
    ]);
    for (const [status, tasks] of lists) columns[status] = tasks;
    const allTasks = Object.values(columns).flat();
    const active = ['triage', 'todo', 'ready', 'running', 'blocked']
      .reduce((sum, status) => sum + columns[status].length, 0);
    return {
      ok: true,
      source: 'hermes-kanban-cli',
      profile,
      refreshedAt: new Date().toISOString(),
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

  async function getTaskDetail(taskId) {
    const payload = await hermes(['show', taskId, '--json'], { json: true });
    return { ok: true, profile, ...normalizeDetail(payload || {}) };
  }

  async function runAction(payload = {}) {
    const action = String(payload.action || '').trim();
    const taskId = String(payload.taskId || '').trim();
    const args = [];

    if (action === 'create') {
      const title = assertNoFlagPrefix(String(payload.title || '').trim(), 'title');
      if (!title) throw actionValidationError('title required');
      args.push('create', title);
      if (payload.body) args.push('--body', String(payload.body));
      if (payload.assignee) args.push('--assignee', assertNoFlagPrefix(payload.assignee, 'assignee'));
      if (payload.workspace) args.push('--workspace', assertNoFlagPrefix(payload.workspace, 'workspace'));
      if (payload.tenant) args.push('--tenant', assertNoFlagPrefix(payload.tenant, 'tenant'));
      if (Number.isFinite(Number(payload.priority))) args.push('--priority', String(Math.trunc(Number(payload.priority))));
      if (payload.triage) args.push('--triage');
      if (Array.isArray(payload.skills)) {
        payload.skills.filter(Boolean).forEach((skill) => args.push('--skill', assertNoFlagPrefix(skill, 'skill')));
      }
      args.push('--created-by', 'mission-control', '--json');
    } else {
      if (!taskId) throw actionValidationError('taskId required');
      const safeTaskId = assertNoFlagPrefix(taskId, 'taskId');
      if (action === 'assign') {
        if (!payload.assignee) throw actionValidationError('assignee required');
        args.push('assign', safeTaskId, assertNoFlagPrefix(payload.assignee, 'assignee'));
      } else if (action === 'comment') {
        if (!payload.text) throw actionValidationError('text required');
        args.push('comment', '--author', 'mission-control', safeTaskId, String(payload.text));
      } else if (action === 'block') {
        args.push('block', safeTaskId, String(payload.reason || 'Blocked from Mission Control'));
      } else if (action === 'unblock') {
        args.push('unblock', safeTaskId);
      } else if (action === 'archive') {
        args.push('archive', safeTaskId);
      } else if (action === 'dispatch') {
        args.push('dispatch', '--max', '1', '--json');
      } else {
        throw actionValidationError(`Unsupported action: ${action}`);
      }
    }

    const result = await hermes(args, {
      json: action === 'create' || action === 'dispatch',
      timeout: action === 'dispatch' ? 30000 : 15000,
    });
    return { ok: true, action, result };
  }

  return { profile, getBoard, getTaskDetail, runAction };
}

module.exports = { STATUSES, createHermesKanbanService };
