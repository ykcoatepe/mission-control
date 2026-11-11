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
    runner: { run: async (...args) => ({ ok: true, ...await execFilePromise(...args) }) },
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

async function testRouterIsAReadOnlyBoardWrapper() {
  // The route reads the scheduled source; it never calls the Hermes CLI.
  let snapshot = { data: { marker: 'board' }, meta: { ok: true, source: 'operations.hermes' } };
  const router = buildHermesKanbanRouter({ hermesSource: { snapshot: () => snapshot } });

  assert.deepEqual(await invokeRoute(router, 'get', '/api/hermes-kanban'), {
    statusCode: 200,
    body: { marker: 'board', meta: { ok: true, source: 'operations.hermes' } },
  });
  snapshot = { data: null, meta: { ok: false, source: 'operations.hermes' } };
  await assert.rejects(invokeRoute(router, 'get', '/api/hermes-kanban'), { status: 503, code: 'hermes_kanban_unavailable' });
  assert.throws(() => buildHermesKanbanRouter({}), /hermesSource required/);
  assert.deepEqual(
    router.stack.filter((entry) => entry.route).map((entry) => `${Object.keys(entry.route.methods).join(',')} ${entry.route.path}`),
    ['get /api/hermes-kanban'],
  );
}

(async () => {
  await testBoardUsesProfileAndKeepsPayloadShape();
  await testRouterIsAReadOnlyBoardWrapper();
  console.log('hermesKanbanData tests passed');
})();
