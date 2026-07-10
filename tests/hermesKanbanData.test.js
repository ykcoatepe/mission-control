const assert = require('node:assert/strict');
const { createHermesKanbanService } = require('../server/services/hermesKanbanData');
const { buildHermesKanbanRouter } = require('../server/routes/hermesKanban');

async function invokeRoute(router, method, path, req = {}) {
  const layer = router.stack.find((entry) => entry.route?.path === path);
  const routeLayer = layer.route.stack.find((entry) => entry.method === method);
  const response = { statusCode: 200, body: undefined };
  const res = {
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  await routeLayer.handle({ params: {}, body: {}, ...req }, res);
  return response;
}

async function testBoardUsesProfileAndKeepsPayloadShape() {
  const calls = [];
  const fixtures = {
    'list --status triage --json': [],
    'list --status todo --json': [{ id: 't1', status: 'todo', assignee: 'hmudur' }],
    'list --status ready --json': [],
    'list --status running --json': [{ id: 't2', status: 'running', assignee: 'hmudurcodex' }],
    'list --status blocked --json': [],
    'list --status done --json': [{ id: 't3', status: 'done' }],
    'stats --json': { total: 3 },
    'assignees --json': [{ name: 'hmudur', counts: { todo: 1 } }],
  };
  const execFilePromise = async (bin, args, options) => {
    calls.push({ bin, args, options });
    const key = args.slice(3).join(' ');
    return { stdout: JSON.stringify(fixtures[key]), stderr: '' };
  };
  const service = createHermesKanbanService({
    mcConfig: { hermes: { profile: 'hmudur' } },
    execFilePromise,
    processEnv: { HOME: '/tmp/home' },
  });
  const board = await service.getBoard();

  assert.equal(board.ok, true);
  assert.equal(board.profile, 'hmudur');
  assert.equal(board.summary.total, 3);
  assert.equal(board.summary.active, 2);
  assert.equal(board.summary.running, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ['--profile', 'hmudur', 'kanban']);
  assert.equal(calls[0].options.env.HERMES_PROFILE, 'hmudur');
  assert.equal(calls[0].options.env.HOME, '/tmp/home');
}

async function testTaskDetailKeepsNormalizedPayloadShape() {
  const execFilePromise = async (_bin, args) => {
    assert.deepEqual(args, ['--profile', 'hmudur', 'kanban', 'show', 't1', '--json']);
    return {
      stdout: JSON.stringify({
        task: { id: 't1', created_at: 1, skills: null },
        events: [{ id: 'e1', created_at: 2 }],
        comments: [{ id: 'c1', created_at: 3 }],
        runs: [{ id: 'r1', started_at: 4, ended_at: 5 }],
      }),
      stderr: '',
    };
  };
  const service = createHermesKanbanService({
    mcConfig: { hermes: { profile: 'hmudur' } },
    execFilePromise,
    processEnv: { HOME: '/tmp/home' },
  });

  const detail = await service.getTaskDetail('t1');

  assert.equal(detail.ok, true);
  assert.equal(detail.profile, 'hmudur');
  assert.equal(detail.task.createdAt, '1970-01-01T00:00:01.000Z');
  assert.deepEqual(detail.task.skills, []);
  assert.equal(detail.events[0].createdAt, '1970-01-01T00:00:02.000Z');
  assert.equal(detail.comments[0].createdAt, '1970-01-01T00:00:03.000Z');
  assert.equal(detail.runs[0].startedAt, '1970-01-01T00:00:04.000Z');
  assert.equal(detail.runs[0].endedAt, '1970-01-01T00:00:05.000Z');
}

async function testActionsKeepExistingArgumentsAndDispatchGuard() {
  const calls = [];
  const execFilePromise = async (_bin, args, options) => {
    calls.push({ args: args.slice(3), options });
    return { stdout: args.includes('--json') ? '{}' : 'ok', stderr: '' };
  };
  const service = createHermesKanbanService({
    execFilePromise,
    processEnv: { HERMES_PROFILE: 'hmudur', HOME: '/tmp/home' },
  });

  await service.runAction({
    action: 'create',
    title: 'Task title',
    body: 'Body',
    assignee: 'agent',
    workspace: '/tmp/workspace',
    tenant: 'tenant',
    priority: 2.9,
    triage: true,
    skills: ['one', '', 'two'],
  });
  await service.runAction({ action: 'assign', taskId: 't1', assignee: 'agent' });
  await service.runAction({ action: 'comment', taskId: 't1', text: 'hello' });
  await service.runAction({ action: 'block', taskId: 't1' });
  await service.runAction({ action: 'unblock', taskId: 't1' });
  await service.runAction({ action: 'archive', taskId: 't1' });
  await service.runAction({ action: 'dispatch', taskId: 'required-but-not-forwarded' });

  assert.deepEqual(calls.map((call) => call.args), [
    ['create', 'Task title', '--body', 'Body', '--assignee', 'agent', '--workspace', '/tmp/workspace', '--tenant', 'tenant', '--priority', '2', '--triage', '--skill', 'one', '--skill', 'two', '--created-by', 'mission-control', '--json'],
    ['assign', 't1', 'agent'],
    ['comment', '--author', 'mission-control', 't1', 'hello'],
    ['block', 't1', 'Blocked from Mission Control'],
    ['unblock', 't1'],
    ['archive', 't1'],
    ['dispatch', '--max', '1', '--json'],
  ]);
  assert.equal(calls[6].options.timeout, 30000);
}

async function testActionsKeepExistingValidationErrors() {
  const service = createHermesKanbanService({
    execFilePromise: async () => {
      throw new Error('validation should run before execution');
    },
    processEnv: { HOME: '/tmp/home' },
  });

  for (const [payload, message] of [
    [{ action: 'create' }, 'title required'],
    [{ action: 'assign' }, 'taskId required'],
    [{ action: 'assign', taskId: 't1' }, 'assignee required'],
    [{ action: 'comment', taskId: 't1' }, 'text required'],
    [{ action: 'dispatch' }, 'taskId required'],
    [{ action: 'unknown', taskId: 't1' }, 'Unsupported action: unknown'],
  ]) {
    await assert.rejects(service.runAction(payload), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.statusCode, 400);
      assert.deepEqual(error.responseBody, { error: message });
      return true;
    });
  }

  await assert.rejects(service.runAction({ action: 'archive', taskId: '--help' }), (error) => {
    assert.equal(error.message, 'taskId cannot start with "-"');
    assert.equal(error.statusCode, 400);
    assert.equal(error.responseBody, undefined);
    return true;
  });
}

async function testRouterIsACompatibilityWrapper() {
  const validationError = new Error('title required');
  validationError.statusCode = 400;
  validationError.responseBody = { error: 'title required' };
  const flagError = new Error('taskId cannot start with "-"');
  flagError.statusCode = 400;
  const service = {
    profile: 'hmudur',
    getBoard: async () => ({ marker: 'board' }),
    getTaskDetail: async (taskId) => ({ marker: taskId }),
    runAction: async (payload) => {
      if (payload.kind === 'validation') throw validationError;
      if (payload.kind === 'flag') throw flagError;
      return { marker: payload.kind };
    },
  };
  const router = buildHermesKanbanRouter({ hermesKanbanService: service });

  assert.deepEqual(await invokeRoute(router, 'get', '/api/hermes-kanban'), {
    statusCode: 200,
    body: { marker: 'board' },
  });
  assert.deepEqual(await invokeRoute(router, 'get', '/api/hermes-kanban/tasks/:taskId', {
    params: { taskId: 't1' },
  }), {
    statusCode: 200,
    body: { marker: 't1' },
  });
  assert.deepEqual(await invokeRoute(router, 'post', '/api/hermes-kanban/actions', {
    body: { kind: 'validation' },
  }), {
    statusCode: 400,
    body: { error: 'title required' },
  });
  assert.deepEqual(await invokeRoute(router, 'post', '/api/hermes-kanban/actions', {
    body: { kind: 'flag' },
  }), {
    statusCode: 400,
    body: { ok: false, error: 'taskId cannot start with "-"' },
  });
}

(async () => {
  await testBoardUsesProfileAndKeepsPayloadShape();
  await testTaskDetailKeepsNormalizedPayloadShape();
  await testActionsKeepExistingArgumentsAndDispatchGuard();
  await testActionsKeepExistingValidationErrors();
  await testRouterIsACompatibilityWrapper();
  console.log('hermesKanbanData tests passed');
})();
