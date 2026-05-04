const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

function createTaskBoardHelpers({ tasksFile, cronService, openclawExec, openclawBin, workspacePath, gatewayToken = '' }) {
  let activityCache = null;
  let activityCacheTime = 0;
  const activityCacheTtl = 30000;

  function readTasksBoardSafe() {
    const raw = fs.readFileSync(tasksFile, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.columns = parsed.columns || {};
    parsed.columns.queue = parsed.columns.queue || [];
    parsed.columns.inProgress = parsed.columns.inProgress || [];
    parsed.columns.blocked = parsed.columns.blocked || [];
    parsed.columns.done = parsed.columns.done || [];
    return parsed;
  }

  function normalizeTaskExecutionPath(task = {}, column = 'queue') {
    const explicit = String(task.executionPath || '').trim().toLowerCase();
    if (['direct', 'task-path', 'automation'].includes(explicit)) return explicit;
    if (String(task.source || '').toLowerCase() === 'automation') return 'automation';
    if (column === 'queue' || column === 'inProgress' || column === 'done' || column === 'blocked') return 'task-path';
    return 'direct';
  }

  function normalizeTaskRecord(task = {}, column = 'queue') {
    const executionPath = normalizeTaskExecutionPath(task, column);
    const structuredTaskRequired = typeof task.structuredTaskRequired === 'boolean'
      ? task.structuredTaskRequired
      : executionPath === 'task-path';
    const routingReason = String(task.routingReason || '').trim()
      || (String(task.source || '').toLowerCase() === 'scout'
        ? 'scout-originated formal task'
        : (executionPath === 'task-path' ? 'workshop formal execution' : 'direct task'));
    const deliveryMode = String(task.deliveryMode || '').trim()
      || (executionPath === 'automation' ? 'scheduled' : (column === 'done' ? 'result-ready' : 'workshop'));
    const managerDecision = String(task.managerDecision || '').trim()
      || (executionPath === 'task-path' ? 'queued-for-formal-execution' : 'direct-response-eligible');
    return {
      ...task,
      executionPath,
      routingReason,
      structuredTaskRequired,
      deliveryMode,
      managerDecision,
    };
  }

  function normalizeTasksBoard(board = {}) {
    const columns = board?.columns || {};
    const nextColumns = {};
    for (const column of ['queue', 'inProgress', 'blocked', 'done']) {
      nextColumns[column] = (columns[column] || []).map((task) => normalizeTaskRecord(task, column));
    }
    return { ...board, columns: nextColumns };
  }

  function cleanupStaleBlockedCanaryTasks(board, options = {}) {
    const nextBoard = normalizeTasksBoard(board || { columns: {} });
    const tasks = nextBoard.columns || {};
    tasks.blocked = tasks.blocked || [];
    tasks.done = tasks.done || [];

    const nowMs = Number(options.nowMs || Date.now());
    const thresholdMs = Number(options.thresholdMs || (6 * 60 * 60 * 1000));
    const reason = String(options.reason || 'stale_canary_cleanup');
    const archived = [];
    const keep = [];

    for (const task of tasks.blocked) {
      const title = String(task.title || '').toLowerCase();
      const source = String(task.source || '').toLowerCase();
      const tags = Array.isArray(task.tags) ? task.tags.map((tag) => String(tag || '').toLowerCase()) : [];
      const taskReason = String(task.reason || '').toLowerCase();
      const isCanary = title.includes('canary') || tags.includes('canary');
      const isCanarySource = source === 'mission_control_canary_preflight' || source === 'manual';
      const isCleanupEligible = isCanary && isCanarySource
        && ['cli_agent_failed', 'execute_timeout_reconciled', 'execute_process_missing_reconciled', 'spawn_failed'].includes(taskReason);

      const ageRefMs = toMs(task.settledAt) || toMs(task.completed) || toMs(task.startedAt) || toMs(task.created);
      const ageMs = ageRefMs > 0 ? Math.max(0, nowMs - ageRefMs) : 0;

      if (!isCleanupEligible || ageMs < thresholdMs) {
        keep.push(task);
        continue;
      }

      const head = String(task.error || task.result || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      archived.push({
        ...task,
        status: 'done',
        archivedAt: new Date(nowMs).toISOString(),
        archivedReason: reason,
        result: `AUTO-CLEANUP archived stale blocked canary (${Math.round(ageMs / 60000)}m old): ${head || 'no error text captured'}`,
        transitionHistory: [
          {
            at: new Date(nowMs).toISOString(),
            from: 'blocked',
            to: 'done',
            reason,
            runId: task.executionRunId || '',
            attempt: Number(task.executionAttempt || 1),
          },
          ...(Array.isArray(task.transitionHistory) ? task.transitionHistory : []),
        ],
      });
    }

    if (archived.length === 0) {
      return { board: nextBoard, archived: [] };
    }

    tasks.blocked = keep;
    tasks.done = [...archived, ...tasks.done];
    return { board: nextBoard, archived };
  }

  function writeTasksBoardWithRetry(board, retries = 2) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        fs.writeFileSync(tasksFile, JSON.stringify(board, null, 2));
        return { ok: true, attempt };
      } catch (error) {
        lastErr = error;
      }
    }
    return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : 'write_failed' };
  }

  function settleTask(taskId, targetColumn, patch = {}, meta = {}) {
    try {
      const board = readTasksBoardSafe();
      const columns = board.columns;
      const fromOrder = ['inProgress', 'queue', 'blocked', 'done'];

      let task = null;
      let fromColumn = null;
      for (const column of fromOrder) {
        const index = columns[column].findIndex((item) => item.id === taskId);
        if (index >= 0) {
          task = columns[column].splice(index, 1)[0];
          fromColumn = column;
          break;
        }
      }

      if (!task) {
        return { ok: false, code: 'not_found' };
      }

      if (fromColumn === 'done' || fromColumn === 'blocked') {
        if (fromColumn === targetColumn) {
          Object.assign(task, patch || {});
          columns[fromColumn].unshift(task);
        } else {
          columns[fromColumn].unshift(task);
        }
        const writeResult = writeTasksBoardWithRetry(board, 1);
        return { ok: true, alreadyTerminal: true, column: fromColumn, write: writeResult };
      }

      const nowIso = new Date().toISOString();
      const normalized = targetColumn === 'done' ? 'done' : 'blocked';
      const status = normalized === 'done' ? 'done' : (patch.status || 'blocked');

      const transition = {
        at: nowIso,
        from: fromColumn,
        to: normalized,
        reason: patch.reason || meta.reason || 'settled',
        runId: meta.runId || task.executionRunId || '',
        attempt: Number(meta.attempt || 1),
      };

      task.transitionHistory = Array.isArray(task.transitionHistory) ? task.transitionHistory : [];
      task.transitionHistory.unshift(transition);

      Object.assign(task, patch || {});
      task.status = status;
      task.completed = task.completed || nowIso;
      task.settledAt = nowIso;

      columns[normalized].unshift(task);
      const writeResult = writeTasksBoardWithRetry(board, 2);
      if (!writeResult.ok) {
        return { ok: false, code: 'write_failed', error: writeResult.error };
      }

      console.log('[Task Transition]', JSON.stringify({
        taskId,
        runId: transition.runId,
        attempt: transition.attempt,
        from: transition.from,
        to: transition.to,
        status: task.status,
        reason: transition.reason,
        writeAttempt: writeResult.attempt,
      }));

      return { ok: true, column: normalized, write: writeResult };
    } catch (error) {
      return { ok: false, code: 'exception', error: error.message };
    }
  }

  function patchInProgressTask(taskId, patch = {}, meta = {}) {
    try {
      const board = readTasksBoardSafe();
      const index = board.columns.inProgress.findIndex((task) => task.id === taskId);
      if (index < 0) return { ok: false, code: 'not_in_progress' };

      const task = board.columns.inProgress[index];
      Object.assign(task, patch || {});
      task.executionAttempt = Number(meta.attempt || task.executionAttempt || 1);
      task.executionRunId = meta.runId || task.executionRunId || '';

      const writeResult = writeTasksBoardWithRetry(board, 1);
      if (!writeResult.ok) return { ok: false, code: 'write_failed', error: writeResult.error };

      console.log('[Task Transition]', JSON.stringify({
        taskId,
        runId: task.executionRunId,
        attempt: task.executionAttempt,
        from: 'inProgress',
        to: 'inProgress',
        status: task.status || 'executing',
        reason: meta.reason || 'heartbeat',
        writeAttempt: writeResult.attempt,
      }));

      return { ok: true };
    } catch (error) {
      return { ok: false, code: 'exception', error: error.message };
    }
  }

  function computeReconcileTimeoutMs(task = {}) {
    const envDefault = Number(process.env.MC_EXECUTE_RECONCILE_TIMEOUT_MS || 120000);
    const minMs = Number(process.env.MC_EXECUTE_RECONCILE_MIN_MS || 30000);
    const maxMs = Number(process.env.MC_EXECUTE_RECONCILE_MAX_MS || 300000);
    const explicit = Number(task.reconcileTimeoutMs || task.executionTimeoutMs || 0);

    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.max(minMs, Math.min(explicit, maxMs));
    }

    const title = String(task.title || '').toLowerCase();
    const desc = String(task.description || '').toLowerCase();
    const tags = Array.isArray(task.tags) ? task.tags.map((tag) => String(tag || '').toLowerCase()) : [];
    const source = String(task.source || '').toLowerCase();
    const priority = String(task.priority || '').toLowerCase();

    if (title.includes('canary') || desc.includes('canary') || tags.includes('canary')) {
      return Math.max(minMs, Math.min(35000, maxMs));
    }

    let timeout = envDefault;
    const sizeScore = Math.min(60000, (title.length + desc.length) * 120);
    timeout += sizeScore;

    if (source === 'scout') timeout += 30000;
    if (['high', 'urgent', 'p0'].includes(priority)) timeout += 30000;
    if (tags.some((tag) => ['research', 'analysis', 'longrun', 'deep'].includes(tag))) timeout += 45000;

    return Math.max(minMs, Math.min(timeout, maxMs));
  }

  function parseLocalCliPid(childSessionKey = '') {
    const match = String(childSessionKey || '').trim().match(/^local-cli:(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  function findTaskInColumns(columns, taskId) {
    const cols = columns || {};
    for (const [column, tasks] of Object.entries(cols)) {
      if (!Array.isArray(tasks)) continue;
      const task = tasks.find((item) => String(item?.id || '') === String(taskId || ''));
      if (task) {
        return { column, task };
      }
    }
    return { column: '', task: null };
  }

  function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function toMs(value) {
    if (value === undefined || value === null || value === '') return 0;
    if (typeof value === 'number') return value > 10000000000 ? value : value * 1000;
    const ms = new Date(String(value)).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  function reconcileStaleWorkshopTasks(board, options = {}) {
    const nextBoard = normalizeTasksBoard(board || { columns: {} });
    const tasks = nextBoard.columns || {};
    tasks.queue = tasks.queue || [];
    tasks.inProgress = tasks.inProgress || [];
    tasks.blocked = tasks.blocked || [];
    tasks.done = tasks.done || [];

    const nowMs = Number(options.nowMs || Date.now());
    const reason = String(options.reason || 'stale_reconcile');
    const reconcileGraceMs = Number(process.env.MC_EXECUTE_RECONCILE_GRACE_MS || 15000);
    const stale = [];
    const keep = [];

    for (const task of tasks.inProgress) {
      const status = String(task.status || '').trim().toLowerCase();
      const pid = parseLocalCliPid(task.childSessionKey);
      const childAlive = pid !== null && isProcessAlive(pid);
      const startedMs = toMs(task.startedAt) || toMs(task.lastHeartbeatAt) || toMs(task.created);
      const timeoutMs = computeReconcileTimeoutMs(task);
      const ageMs = startedMs > 0 ? Math.max(0, nowMs - startedMs) : timeoutMs + 1;
      const graceWindowMs = Math.max(0, Number.isFinite(reconcileGraceMs) ? reconcileGraceMs : 0);
      const timedOut = ageMs > (timeoutMs + graceWindowMs);
      const processMissing = pid !== null && !isProcessAlive(pid);
      const orphanedExecuting = status === 'executing' && !String(task.childSessionKey || '').trim();

      if (timedOut || processMissing || orphanedExecuting) {
        stale.push({
          ...task,
          status: 'blocked',
          reason: processMissing ? 'execute_process_missing_reconciled' : 'execute_timeout_reconciled',
          error: processMissing
            ? `Execution process is no longer running (pid=${pid}); task was auto-reconciled after restart.`
            : `Task remained in progress past reconcile budget (${Math.round(timeoutMs / 1000)}s); auto-reconciled.`,
          result: processMissing
            ? 'Execution process disappeared before terminal state was persisted. Task was moved to blocked for deterministic recovery.'
            : 'Task did not settle before the reconcile timeout. Task was moved to blocked for deterministic recovery.',
          completed: task.completed || new Date(nowMs).toISOString(),
          settledAt: new Date(nowMs).toISOString(),
          transitionHistory: [
            {
              at: new Date(nowMs).toISOString(),
              from: 'inProgress',
              to: 'blocked',
              reason,
              runId: task.executionRunId || '',
              attempt: Number(task.executionAttempt || 1),
            },
            ...(Array.isArray(task.transitionHistory) ? task.transitionHistory : []),
          ],
        });
      } else {
        keep.push(task);
      }
    }

    if (stale.length === 0) {
      return { board: nextBoard, recovered: [] };
    }

    tasks.inProgress = keep;
    tasks.blocked = [...stale, ...tasks.blocked];
    return { board: nextBoard, recovered: stale };
  }

  function flattenTasksBoard(board = {}) {
    const flat = [];
    const columns = board.columns || {};
    for (const column of ['queue', 'inProgress', 'blocked', 'done']) {
      for (const task of columns[column] || []) {
        flat.push({
          ...task,
          column,
          status: task.status || (column === 'inProgress' ? 'inProgress' : column),
        });
      }
    }
    return flat;
  }

  function resolveTaskPlacement(rawValue = 'queue') {
    const raw = String(rawValue || '').trim().toLowerCase();
    if (['inprogress', 'in_progress', 'running'].includes(raw)) return { column: 'inProgress', status: 'inProgress' };
    if (raw === 'executing') return { column: 'inProgress', status: 'executing' };
    if (raw === 'blocked') return { column: 'blocked', status: 'blocked' };
    if (['done', 'completed'].includes(raw)) return { column: 'done', status: 'done' };
    return { column: 'queue', status: 'queue' };
  }

  function upsertTaskCalendarEntry(task = {}, options = {}) {
    return cronService.upsertTaskCalendarEntry(task, options);
  }

  function readTaskCountsByAssignee() {
    const counts = {};
    try {
      const raw = fs.readFileSync(tasksFile, 'utf8');
      const parsed = normalizeTasksBoard(JSON.parse(raw || '{}'));
      const columns = parsed?.columns || {};
      const columnsList = ['queue', 'inProgress', 'blocked', 'done'];
      for (const column of columnsList) {
        for (const task of columns[column] || []) {
          const assignee = String(task?.assignee || task?.owner || task?.agentId || task?.agent || '').trim();
          if (!assignee) continue;
          if (!counts[assignee]) counts[assignee] = { open: 0, running: 0, done: 0, paths: { direct: 0, taskPath: 0, automation: 0 }, lastExecutionPath: null };
          if (column === 'inProgress') counts[assignee].running += 1;
          else if (column === 'done') counts[assignee].done += 1;
          else counts[assignee].open += 1;
          const executionPath = String(task?.executionPath || '').trim().toLowerCase();
          if (executionPath === 'direct') counts[assignee].paths.direct += 1;
          else if (executionPath === 'automation') counts[assignee].paths.automation += 1;
          else counts[assignee].paths.taskPath += 1;
          counts[assignee].lastExecutionPath = executionPath || counts[assignee].lastExecutionPath || null;
        }
      }
    } catch {}
    return counts;
  }

  async function getActivityFeed() {
    if (activityCache && Date.now() - activityCacheTime < activityCacheTtl) {
      return activityCache;
    }

    const feed = [];

    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      for (const task of (tasks.columns.done || []).slice(0, 15)) {
        feed.push({
          id: `task-${task.id}`,
          type: 'task_completed',
          icon: 'check',
          title: task.title,
          detail: task.result ? task.result.substring(0, 200) : 'Completed',
          time: task.completed || task.created,
          priority: task.priority,
          source: task.source || 'manual',
          taskId: task.id,
          actionable: !!task.childSessionKey,
          actionLabel: task.childSessionKey ? 'Continue Chat' : 'View',
          actionUrl: `/workshop?task=${task.id}`,
        });
      }
      for (const task of (tasks.columns.inProgress || [])) {
        feed.push({
          id: `task-prog-${task.id}`,
          type: 'task_running',
          icon: 'loader',
          title: `Working: ${task.title}`,
          detail: 'Sub-agent executing...',
          time: task.startedAt || task.created,
          priority: task.priority,
          source: task.source || 'manual',
          taskId: task.id,
          actionable: true,
          actionLabel: 'View',
          actionUrl: `/workshop?task=${task.id}`,
        });
      }
    } catch {}

    try {
      const scoutFile = path.join(path.dirname(tasksFile), 'scout-results.json');
      if (fs.existsSync(scoutFile)) {
        const scout = JSON.parse(fs.readFileSync(scoutFile, 'utf8'));
        for (const opportunity of (scout.opportunities || []).filter((item) => item.status !== 'dismissed').slice(0, 10)) {
          feed.push({
            id: `scout-${opportunity.id}`,
            type: opportunity.status === 'deployed' ? 'scout_deployed' : 'scout_found',
            icon: 'search',
            title: opportunity.title,
            detail: opportunity.summary ? opportunity.summary.substring(0, 150) : '',
            time: opportunity.found,
            score: opportunity.score,
            source: opportunity.source,
            category: opportunity.category,
            actionable: opportunity.status !== 'deployed',
            actionLabel: 'Deploy',
            actionUrl: '/scout',
          });
        }
      }
    } catch {}

    try {
      const cronOutput = (await openclawExec(['cron', 'list', '--json', '--all'], 10000)).stdout || '{}';
      const crons = JSON.parse(cronOutput);
      for (const job of (Array.isArray(crons) ? crons : crons.jobs || [])) {
        if (job.lastRun || job.lastRunAt) {
          feed.push({
            id: `cron-${job.id || job.jobId}`,
            type: 'cron_run',
            icon: 'clock',
            title: `Cron: ${job.name || job.id || 'unnamed'}`,
            detail: job.lastRunStatus === 'ok' ? 'Completed successfully' : `Status: ${job.lastRunStatus || 'unknown'}`,
            time: job.lastRun || job.lastRunAt,
            actionable: false,
          });
        }
      }
    } catch {}

    feed.sort((left, right) => {
      const leftTime = left.time ? new Date(left.time).getTime() : 0;
      const rightTime = right.time ? new Date(right.time).getTime() : 0;
      return rightTime - leftTime;
    });

    const result = { feed: feed.slice(0, 30), generated: new Date().toISOString() };
    activityCache = result;
    activityCacheTime = Date.now();
    return result;
  }

  async function recoverTasksOnStartup() {
    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      const sessionsFile = path.join(os.homedir(), '.openclaw/agents/main/sessions/sessions.json');
      const sessions = fs.existsSync(sessionsFile) ? JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) : {};

      let recovered = 0;
      for (const task of [...tasks.columns.inProgress]) {
        const childKey = task.childSessionKey || '';
        const sessionInfo = sessions[childKey] || {};
        const sessionId = sessionInfo.sessionId || '';

        if (!sessionId) continue;

        const transcriptPath = path.join(os.homedir(), '.openclaw/agents/main/sessions', `${sessionId}.jsonl`);
        if (!fs.existsSync(transcriptPath)) continue;

        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        let resultText = '';
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const evt = JSON.parse(lines[index]);
            if (evt.type === 'message' && evt.message?.role === 'assistant') {
              const content = evt.message.content;
              resultText = Array.isArray(content)
                ? content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
                : typeof content === 'string' ? content : '';
              if (resultText) break;
            }
          } catch {}
        }

        if (resultText) {
          const index = tasks.columns.inProgress.indexOf(task);
          if (index >= 0) tasks.columns.inProgress.splice(index, 1);
          task.status = 'done';
          task.completed = new Date().toISOString();
          task.result = resultText.substring(0, 3000);
          tasks.columns.done.unshift(task);
          recovered += 1;
        }
      }

      if (recovered > 0) {
        fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
        console.log(`🔄 Recovered ${recovered} stuck inProgress tasks on startup`);
      }
    } catch (error) {
      console.error('[Startup recovery]', error.message);
    }

    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      const reconciled = reconcileStaleWorkshopTasks(tasks, { reason: 'startup_stale_reconcile' });
      if (reconciled.recovered.length > 0) {
        const writeResult = writeTasksBoardWithRetry(reconciled.board, 2);
        if (!writeResult.ok) {
          console.error('[Startup stale reconcile] Failed to persist task recovery:', writeResult.error);
        } else {
          console.log(`🔄 Reconciled ${reconciled.recovered.length} stale inProgress task(s) on startup`);
        }
      }
    } catch (error) {
      console.error('[Startup stale reconcile]', error.message);
    }
  }

  function clearActivityCache() {
    activityCache = null;
    activityCacheTime = 0;
  }

  return {
    readTasksBoardSafe,
    normalizeTaskRecord,
    normalizeTasksBoard,
    cleanupStaleBlockedCanaryTasks,
    writeTasksBoardWithRetry,
    settleTask,
    patchInProgressTask,
    computeReconcileTimeoutMs,
    findTaskInColumns,
    reconcileStaleWorkshopTasks,
    flattenTasksBoard,
    resolveTaskPlacement,
    upsertTaskCalendarEntry,
    readTaskCountsByAssignee,
    getActivityFeed,
    recoverTasksOnStartup,
    clearActivityCache,
  };
}

function buildTasksRouter({ projectRoot, cronService, openclawExec, openclawBin, workspacePath, gatewayToken }) {
  const router = express.Router();
  const tasksFile = path.join(projectRoot, 'tasks.json');
  const helpers = createTaskBoardHelpers({
    tasksFile,
    cronService,
    openclawExec,
    openclawBin,
    workspacePath,
    gatewayToken,
  });

  router.get('/api/activity', async (req, res) => {
    try {
      return res.json(await helpers.getActivityFeed());
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/tasks', (req, res) => {
    try {
      const raw = fs.readFileSync(tasksFile, 'utf8');
      const data = JSON.parse(raw);
      const reconciled = helpers.reconcileStaleWorkshopTasks(data, { reason: 'tasks_api_read_reconcile' });
      const cleaned = helpers.cleanupStaleBlockedCanaryTasks(reconciled.board, { reason: 'tasks_api_canary_cleanup' });
      if (reconciled.recovered.length > 0 || cleaned.archived.length > 0) {
        const writeResult = helpers.writeTasksBoardWithRetry(cleaned.board, 2);
        if (!writeResult.ok) {
          console.error('[Tasks API] Failed to persist task board maintenance:', writeResult.error);
        } else {
          if (reconciled.recovered.length > 0) {
            console.log(`[Tasks API] Reconciled ${reconciled.recovered.length} stale inProgress task(s) during board read`);
          }
          if (cleaned.archived.length > 0) {
            console.log(`[Tasks API] Archived ${cleaned.archived.length} stale blocked canary task(s) during board read`);
          }
        }
      }
      return res.json(cleaned.board);
    } catch (error) {
      console.error('[Tasks API] Failed to read tasks.json:', error.message);
      return res.json({ columns: { queue: [], inProgress: [], blocked: [], done: [] } });
    }
  });

  router.get('/api/tasks/board', (req, res) => {
    try {
      const reconciled = helpers.reconcileStaleWorkshopTasks(helpers.readTasksBoardSafe(), { reason: 'tasks_board_read_reconcile' });
      const cleaned = helpers.cleanupStaleBlockedCanaryTasks(reconciled.board, { reason: 'tasks_board_canary_cleanup' });
      if (reconciled.recovered.length > 0 || cleaned.archived.length > 0) {
        const writeResult = helpers.writeTasksBoardWithRetry(cleaned.board, 2);
        if (!writeResult.ok) {
          console.error('[Tasks Board API] Failed to persist task board maintenance:', writeResult.error);
        }
      }
      return res.json({ tasks: helpers.flattenTasksBoard(cleaned.board), columns: cleaned.board.columns });
    } catch (error) {
      return res.status(500).json({ error: error.message, tasks: [], columns: { queue: [], inProgress: [], blocked: [], done: [] } });
    }
  });

  router.get('/api/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const board = helpers.readTasksBoardSafe();
      const { column, task } = helpers.findTaskInColumns(board.columns || {}, taskId);
      if (!task) {
        return res.status(404).json({ error: 'Task not found', taskId, column: '' });
      }
      return res.json({ ...task, column });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/tasks', (req, res) => {
    try {
      const data = req.body;
      if (!data || !data.columns) {
        return res.status(400).json({ error: 'Invalid format. Expected { columns: { queue, inProgress, done, ... } }' });
      }
      fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
      return res.json({ ok: true, message: 'Tasks updated' });
    } catch (error) {
      console.error('[Tasks POST]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/tasks/add', (req, res) => {
    try {
      const {
        title,
        description,
        priority,
        tags,
        assignee,
        source,
        scheduleAt,
        schedule,
        linkedJobId,
        calendarStatus,
        reconcileTimeoutMs,
        executionTimeoutMs,
      } = req.body;
      if (!title) return res.status(400).json({ error: 'title required' });

      const tasks = helpers.readTasksBoardSafe();
      const task = helpers.normalizeTaskRecord({
        id: `task-${Date.now()}`,
        title,
        description: description || '',
        assignee: assignee || 'Mudur',
        priority: priority || 'medium',
        created: new Date().toISOString(),
        tags: tags || [],
        source: source || 'manual',
        scheduleAt: scheduleAt || null,
        schedule: schedule || '',
        linkedJobId: linkedJobId || null,
        calendarStatus: calendarStatus || 'scheduled',
        ...(Number.isFinite(Number(reconcileTimeoutMs)) && Number(reconcileTimeoutMs) > 0
          ? { reconcileTimeoutMs: Math.trunc(Number(reconcileTimeoutMs)) }
          : {}),
        ...(Number.isFinite(Number(executionTimeoutMs)) && Number(executionTimeoutMs) > 0
          ? { executionTimeoutMs: Math.trunc(Number(executionTimeoutMs)) }
          : {}),
        executionPath: 'task-path',
        routingReason: 'manual workshop task',
        structuredTaskRequired: true,
        deliveryMode: 'workshop',
        managerDecision: 'manual-queue',
      }, 'queue');
      tasks.columns.queue.unshift(task);
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      const calendarEntry = helpers.upsertTaskCalendarEntry(task, {
        startsAt: scheduleAt,
        schedule,
        calendarStatus,
      });
      return res.json({ ok: true, task, calendarEntry });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/tasks/assistant', (req, res) => {
    try {
      const {
        title,
        description,
        priority,
        tags,
        assignee,
        source,
        scheduleAt,
        schedule,
        linkedJobId,
        status,
        calendarStatus,
        reconcileTimeoutMs,
        executionTimeoutMs,
      } = req.body || {};
      if (!title) return res.status(400).json({ error: 'title required' });

      const tasks = helpers.readTasksBoardSafe();
      const placement = helpers.resolveTaskPlacement(status || 'queue');
      const task = helpers.normalizeTaskRecord({
        id: `task-${Date.now()}`,
        title,
        description: description || '',
        assignee: assignee || 'Mudur',
        priority: priority || 'medium',
        created: new Date().toISOString(),
        tags: tags || [],
        source: source || 'assistant',
        scheduleAt: scheduleAt || null,
        schedule: schedule || '',
        linkedJobId: linkedJobId || null,
        calendarStatus: calendarStatus || 'scheduled',
        ...(Number.isFinite(Number(reconcileTimeoutMs)) && Number(reconcileTimeoutMs) > 0
          ? { reconcileTimeoutMs: Math.trunc(Number(reconcileTimeoutMs)) }
          : {}),
        ...(Number.isFinite(Number(executionTimeoutMs)) && Number(executionTimeoutMs) > 0
          ? { executionTimeoutMs: Math.trunc(Number(executionTimeoutMs)) }
          : {}),
        status: placement.status,
        executionPath: 'task-path',
        routingReason: 'assistant-created task',
        structuredTaskRequired: true,
        deliveryMode: 'workshop',
        managerDecision: 'assistant-queued',
      }, placement.column);

      tasks.columns[placement.column].unshift(task);
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      const calendarEntry = helpers.upsertTaskCalendarEntry(task, {
        startsAt: scheduleAt,
        schedule,
        calendarStatus,
      });
      return res.json({ ok: true, task, column: placement.column, calendarEntry });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.patch('/api/tasks/:taskId', (req, res) => {
    try {
      const { taskId } = req.params;
      const board = helpers.readTasksBoardSafe();
      const columns = board.columns || {};
      const payload = req.body || {};

      let currentColumn = null;
      let task = null;
      for (const column of ['queue', 'inProgress', 'blocked', 'done']) {
        const index = (columns[column] || []).findIndex((item) => item.id === taskId);
        if (index >= 0) {
          currentColumn = column;
          task = columns[column].splice(index, 1)[0];
          break;
        }
      }

      if (!task || !currentColumn) return res.status(404).json({ error: 'Task not found' });

      const placement = helpers.resolveTaskPlacement(payload.column || payload.status || currentColumn);
      const updated = helpers.normalizeTaskRecord({
        ...task,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
        ...(payload.assignee !== undefined ? { assignee: payload.assignee } : {}),
        ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
        ...(payload.result !== undefined ? { result: payload.result } : {}),
        ...(payload.error !== undefined ? { error: payload.error } : {}),
        ...(payload.reconcileTimeoutMs !== undefined ? { reconcileTimeoutMs: payload.reconcileTimeoutMs } : {}),
        ...(payload.scheduleAt !== undefined ? { scheduleAt: payload.scheduleAt } : {}),
        ...(payload.schedule !== undefined ? { schedule: payload.schedule } : {}),
        ...(payload.linkedJobId !== undefined ? { linkedJobId: payload.linkedJobId } : {}),
        ...(payload.calendarStatus !== undefined ? { calendarStatus: payload.calendarStatus } : {}),
        status: placement.status,
        updatedAt: new Date().toISOString(),
      }, placement.column);

      columns[placement.column].unshift(updated);
      fs.writeFileSync(tasksFile, JSON.stringify(board, null, 2));
      const calendarEntry = helpers.upsertTaskCalendarEntry(updated, {
        startsAt: payload.scheduleAt,
        schedule: payload.schedule,
        calendarStatus: payload.calendarStatus,
      });
      return res.json({ ok: true, task: updated, column: placement.column, calendarEntry });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/tasks/:taskId', (req, res) => {
    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      const { taskId } = req.params;
      let found = false;
      for (const column of Object.keys(tasks.columns)) {
        const index = tasks.columns[column].findIndex((task) => task.id === taskId);
        if (index !== -1) {
          tasks.columns[column].splice(index, 1);
          found = true;
          break;
        }
      }
      if (!found) return res.status(404).json({ error: 'Task not found' });
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
      helpers.clearActivityCache();
      return res.json({ ok: true, deleted: taskId });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/tasks/:taskId/execute', async (req, res) => {
    try {
      const { taskId } = req.params;
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const runAttempt = 1;
      const tasks = helpers.readTasksBoardSafe();

      let task = null;
      let fromColumn = 'queue';
      for (const [column, items] of Object.entries(tasks.columns)) {
        const index = items.findIndex((item) => item.id === taskId);
        if (index >= 0) {
          task = items[index];
          items.splice(index, 1);
          fromColumn = column;
          break;
        }
      }

      if (!task) return res.status(404).json({ error: 'Task not found' });

      task = helpers.normalizeTaskRecord(task, 'inProgress');
      task.startedAt = new Date().toISOString();
      task.status = 'executing';
      task.executionRunId = runId;
      task.executionAttempt = runAttempt;
      task.lastHeartbeatAt = new Date().toISOString();
      tasks.columns.inProgress.unshift(task);
      const writeStart = helpers.writeTasksBoardWithRetry(tasks, 2);
      if (!writeStart.ok) return res.status(500).json({ error: `Failed to persist task start: ${writeStart.error}` });

      console.log('[Task Transition]', JSON.stringify({
        taskId,
        runId,
        attempt: runAttempt,
        from: fromColumn,
        to: 'inProgress',
        status: 'executing',
        reason: 'execute_requested',
        writeAttempt: writeStart.attempt,
      }));

      const configPath = path.join(os.homedir(), '.openclaw/openclaw.json');
      const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};

      const title = task.title || '';
      const description = task.description || '';
      const fullText = `${title} ${description}`.toLowerCase();

      let taskPrompt;
      if (task.source === 'scout' && (fullText.includes('skill') || fullText.includes('plugin'))) {
        taskPrompt = `RESEARCH TASK: A new OpenClaw skill/plugin was found by the Scout engine.

Title: ${task.title}
Details: ${task.description}

Your job:
1. Visit the URL mentioned and read about this skill
2. Summarize what it does, who made it, and key features
3. Check if it's compatible with our setup (OpenClaw on AWS EC2, Ubuntu)
4. Give a clear recommendation: INSTALL (with instructions) or SKIP (with reason)
5. Rate usefulness 1-10 for our use case

Be thorough but concise. This report will be shown to the user.`;
      } else if (task.source === 'scout' && (fullText.includes('bounty') || fullText.includes('hackerone') || fullText.includes('bugcrowd'))) {
        taskPrompt = `BUG BOUNTY RESEARCH: The Scout engine found a potential bounty opportunity.

Title: ${task.title}
Details: ${task.description}

Your job:
1. Research this program/target — what's the scope, payout range, platform
2. Check if it's a new program or new scope addition
3. Identify the most promising attack surfaces
4. Estimate difficulty and potential payout
5. Give a GO/SKIP recommendation with reasoning

Be specific and actionable.`;
      } else if (task.source === 'scout' && (fullText.includes('freelance') || fullText.includes('job') || fullText.includes('hiring') || fullText.includes('looking for'))) {
        taskPrompt = `JOB/FREELANCE RESEARCH: The Scout engine found a potential opportunity.

Title: ${task.title}
Details: ${task.description}

Your job:
1. Research this opportunity — who's hiring, what they need, compensation
2. Check if it matches our skills (React, Next.js, Supabase, AI/ML, Python)
3. Draft a brief pitch/response if it's a good fit
4. Give an APPLY/SKIP recommendation

Be practical — focus on fit and potential earnings.`;
      } else if (task.source === 'scout' && (fullText.includes('grant') || fullText.includes('funding') || fullText.includes('competition'))) {
        taskPrompt = `FUNDING RESEARCH: The Scout engine found a potential grant/funding opportunity.

Title: ${task.title}
Details: ${task.description}

Your job:
1. Research eligibility, deadlines, and requirements
2. Check if Tale Forge / Kevin El-Zarka qualifies
3. Summarize the application process
4. Give an APPLY/SKIP recommendation with deadline

Be specific about requirements and timeline.`;
      } else {
        taskPrompt = `TASK EXECUTION:

Title: ${task.title}
Description: ${task.description}

Your job:
1. Analyze what needs to be done
2. Do the work — research, write, code, whatever is needed
3. If the task requires external actions (sending emails, deploying code), describe exactly what should be done but don't do it without explicit permission
4. Provide a clear, detailed summary of results and any next steps

Be thorough. Your output will be shown directly to the user as the task result.`;
      }

      const reconcileTimeoutMs = helpers.computeReconcileTimeoutMs(task);
      const reconcileGraceMs = Number(process.env.MC_EXECUTE_RECONCILE_GRACE_MS || 15000);
      const isDeterministicCanary = String(task.source || '').toLowerCase() === 'mission_control_canary_preflight'
        || [String(task.title || ''), String(task.description || ''), Array.isArray(task.tags) ? task.tags.join(' ') : '']
          .some((text) => String(text || '').toLowerCase().includes('canary'));
      let reconcileTimer = null;
      let graceTimer = null;

      const clearReconcileTimers = () => {
        if (reconcileTimer) {
          clearTimeout(reconcileTimer);
          reconcileTimer = null;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      };

      const attemptReconcile = () => {
        const board = helpers.readTasksBoardSafe();
        const { column, task: taskRow } = helpers.findTaskInColumns(board.columns || {}, taskId);
        if (!taskRow || column !== 'inProgress') {
          return clearReconcileTimers();
        }

        const pid = helpers.findTaskInColumns ? parseLocalCliPid(taskRow.childSessionKey) : null;
        const childAlive = pid !== null && process.kill ? (() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })() : false;
        const startedMs = toMs(taskRow.startedAt) || toMs(taskRow.lastHeartbeatAt) || toMs(taskRow.created);
        const canWaitUntil = (Number.isFinite(startedMs) ? startedMs : 0) + reconcileTimeoutMs + Math.max(0, Number.isFinite(reconcileGraceMs) ? reconcileGraceMs : 15000);

        if (childAlive && Date.now() < canWaitUntil) {
          clearReconcileTimers();
          const delayMs = Math.max(500, Math.min(3000, Math.round((reconcileGraceMs || 15000) / 5)));
          graceTimer = setTimeout(attemptReconcile, delayMs);
          return;
        }

        const settled = helpers.settleTask(taskId, 'blocked', {
          status: 'blocked',
          reason: childAlive ? 'execute_timeout_reconciled' : 'execute_process_missing_reconciled',
          error: `Task transition timeout after ${Math.round(reconcileTimeoutMs / 1000)}s`,
          result: childAlive
            ? 'Execution timed out, child process still running; blocking for deterministic recovery after grace window.'
            : 'Execution process disappeared before terminal state was persisted; moved to blocked for deterministic recovery.',
        }, { runId, attempt: runAttempt, reason: 'timeout_reconcile' });

        clearReconcileTimers();
        if (!settled.ok) {
          console.error('[Task Reconcile] Failed', JSON.stringify({ taskId, runId, attempt: runAttempt, ...settled }));
        }
      };

      reconcileTimer = setTimeout(attemptReconcile, reconcileTimeoutMs);

      try {
        const spawnBin = isDeterministicCanary ? process.execPath : openclawBin;
        const spawnArgs = isDeterministicCanary
          ? ['-e', `process.stdout.write(JSON.stringify({message:${JSON.stringify(`CANARY_OK ${taskId}`)},summary:${JSON.stringify(`Deterministic canary execution completed for ${taskId}`)}}))`]
          : ['agent', '--agent', 'main', '--message', taskPrompt, '--json', '--timeout', String(Math.max(120, Math.ceil(reconcileTimeoutMs / 1000) + 5))];
        const child = spawn(spawnBin, spawnArgs, {
          cwd: workspacePath,
          env: process.env,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const childKey = `local-cli:${child.pid || 'na'}`;
        helpers.patchInProgressTask(taskId, {
          childSessionKey: childKey,
          lastHeartbeatAt: new Date().toISOString(),
          status: 'executing',
        }, { runId, attempt: runAttempt, reason: 'cli_agent_started' });

        let out = '';
        let err = '';

        child.stdout.on('data', (chunk) => {
          out += chunk.toString();
          helpers.patchInProgressTask(taskId, { lastHeartbeatAt: new Date().toISOString(), status: 'executing' }, { runId, attempt: runAttempt, reason: 'stdout_heartbeat' });
        });
        child.stderr.on('data', (chunk) => {
          err += chunk.toString();
        });

        child.on('close', (code) => {
          clearReconcileTimers();

          const collectText = (items) => Array.isArray(items)
            ? items.map((item) => String(item?.text || '').trim()).filter(Boolean).join('\n').trim()
            : '';

          const extractResultText = (parsed) => {
            const candidates = [
              collectText(parsed?.result?.payloads),
              collectText(parsed?.payloads),
              collectText(parsed?.result?.content),
              collectText(parsed?.content),
              parsed?.result?.message,
              parsed?.message,
              parsed?.summary,
            ];
            return String(candidates.find((value) => String(value || '').trim()) || '').trim();
          };

          let resultText = '';
          try {
            const trimmed = (out || '').trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
              const parsed = JSON.parse(trimmed);
              resultText = extractResultText(parsed);
            } else {
              const match = trimmed.match(/\{[\s\S]*\}$/);
              if (match) {
                const parsed = JSON.parse(match[0]);
                resultText = extractResultText(parsed);
              }
            }
          } catch {}

          const completionText = String(resultText || out || '').trim();
          const cliSoftFailure = code === 0 && (
            !completionText
            || completionText.includes("Agent couldn't generate a response")
            || completionText.includes('Task completed (no output captured)')
          );

          if (cliSoftFailure) {
            const failText = `CLI agent exited 0 but produced no usable result. ${completionText || String(err || out || '').substring(0, 800)}`.trim();
            const settled = helpers.settleTask(taskId, 'blocked', {
              status: 'blocked',
              reason: 'cli_agent_empty_result',
              error: failText,
              result: failText,
            }, { runId, attempt: runAttempt, reason: 'completion_cli_soft_failed' });
            if (!settled.ok) console.error('[Task Soft Fail CLI] Failed to settle', JSON.stringify({ taskId, runId, ...settled }));
            return;
          }

          if (code === 0) {
            const settled = helpers.settleTask(taskId, 'done', {
              status: 'done',
              reason: isDeterministicCanary ? 'execute_completed_canary' : 'execute_completed_cli',
              result: completionText.substring(0, 3000),
            }, { runId, attempt: runAttempt, reason: 'completion_cli' });
            if (!settled.ok) console.error('[Task Complete CLI] Failed to settle', JSON.stringify({ taskId, runId, ...settled }));
            return;
          }

          const failText = `CLI agent failed (exit=${code}). ${String(err || out || '').substring(0, 800)}`;
          const settled = helpers.settleTask(taskId, 'blocked', {
            status: 'blocked',
            reason: 'cli_agent_failed',
            error: failText,
            result: failText,
          }, { runId, attempt: runAttempt, reason: 'completion_cli_failed' });
          if (!settled.ok) console.error('[Task Fail CLI] Failed to settle', JSON.stringify({ taskId, runId, ...settled }));
        });

        return res.json({ ok: true, message: 'Task execution started', taskId, childKey, runId, reconcileTimeoutMs, executionMode: 'cli-agent' });
      } catch (spawnErr) {
        clearReconcileTimers();
        helpers.settleTask(taskId, 'blocked', {
          status: 'blocked',
          reason: 'spawn_failed',
          error: spawnErr.message,
          result: `Task execution could not start: ${spawnErr.message}`,
        }, { runId, attempt: runAttempt, reason: 'spawn_error' });
        return res.json({ ok: true, message: 'Task execution accepted; reconciled to blocked after spawn error', error: spawnErr.message, taskId, runId });
      }
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

async function recoverTasksOnStartup({ projectRoot, cronService, openclawExec, openclawBin, workspacePath, gatewayToken }) {
  const tasksFile = path.join(projectRoot, 'tasks.json');
  const helpers = createTaskBoardHelpers({ tasksFile, cronService, openclawExec, openclawBin, workspacePath, gatewayToken });
  await helpers.recoverTasksOnStartup();
}

function readTaskCountsByAssignee({ projectRoot }) {
  const tasksFile = path.join(projectRoot, 'tasks.json');
  const helpers = createTaskBoardHelpers({ tasksFile, cronService: { upsertTaskCalendarEntry: () => null }, openclawExec: async () => ({ stdout: '{}' }), openclawBin: process.execPath, workspacePath: projectRoot });
  return helpers.readTaskCountsByAssignee();
}

module.exports = {
  buildTasksRouter,
  recoverTasksOnStartup,
  readTaskCountsByAssignee,
};
