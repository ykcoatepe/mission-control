# Mission Control Shared Brain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OpenClaw-centric home screen with a Quiet Observatory Brain Map that presents independent GBrain, Hermes, and OpenClaw evidence, decisions, and safely classified GBrain triggers.

**Architecture:** Add shared Hermes and GBrain readers, then build a bounded server-side `/api/operations/overview` aggregator that preserves source freshness, caveats, conflicts, and action metadata. The React home page consumes this single contract through focused Brain Map components; specialized pages remain available through a seven-item information architecture and compatibility routes.

**Tech Stack:** Node.js 18+ CommonJS, Express 5, React 19, TypeScript 5.9, TanStack Query 5, React Router 7, CSS Modules, Vitest 4, Node's built-in test runner.

## Global Constraints

- Do not add dependencies or change either lockfile.
- Preserve all eight existing GBrain action ids; `Run System Check` is the home placement of `doctor-fast`, not a ninth action.
- R0 actions (`diagnostic`, `preview`) run directly; W1 actions (`maintenance`, `repair`) require action-scoped confirmation; W2 actions do not appear on the Brain Map.
- Do not flatten stale, unavailable, or caveated evidence into a global healthy state.
- Do not expose raw session messages, task bodies, command output, credentials, tokens, or absolute home-directory paths in `/api/operations/overview`.
- Keep GBrain, Hermes, and OpenClaw local memory ownership unchanged.
- Keep existing specialized routes reachable until their later consolidation phase.
- Use Quiet Observatory: deep navy and graphite, blue for navigation and verified relationships, semantic colors only for real state, reduced-motion support, WCAG AA text contrast.
- Live W1 validation is not authorized by this plan; use mocks or preview paths unless the user explicitly authorizes a state-changing smoke.
- Commit steps below are intended review boundaries. Do not execute a commit without explicit user authorization.

---

## File Structure

### Backend files to create

- `server/services/hermesKanbanData.js`: reusable Hermes CLI reader and existing Kanban mutations.
- `server/services/gbrainOverviewData.js`: one-shot GBrain probe snapshot shared by GBrain and Operations routes.
- `server/services/operationsOverview.js`: source timeouts, normalization, attention derivation, capability projection, and overview service.
- `server/routes/operations.js`: read-only Operations overview route.
- `tests/hermesKanbanData.test.js`: Hermes reader extraction and payload-compatibility coverage.
- `tests/operationsOverview.test.js`: pure policy and partial-failure coverage.
- `tests/operationsRoute.test.js`: HTTP route contract coverage.

### Frontend files to create

- `frontend/src/pages/brain/types.ts`: Operations API and Brain component types.
- `frontend/src/pages/brain/lib.ts`: pure state, sorting, search, layout, and action-policy helpers.
- `frontend/src/pages/brain/lib.test.ts`: deterministic frontend policy coverage.
- `frontend/src/pages/gbrain/types.ts`: shared GBrain action result type.
- `frontend/src/pages/gbrain/api.ts`: shared GBrain action POST helper that preserves error payloads.
- `frontend/src/pages/brain/SystemStatusRail.tsx`: compact three-system truth display.
- `frontend/src/pages/brain/LivingBrainMap.tsx`: accessible spatial map with list fallback semantics.
- `frontend/src/pages/brain/DecisionInbox.tsx`: ranked operator-attention list.
- `frontend/src/pages/brain/EvidenceTimeline.tsx`: latest cross-system evidence stream.
- `frontend/src/pages/brain/EvidenceDrawer.tsx`: selected proof, caveat, and action context.
- `frontend/src/pages/brain/GBrainTriggerShelf.tsx`: eight-action capability UI and confirmation handoff.
- `frontend/src/pages/brain/ActionConfirmDialog.tsx`: action-scoped W1 confirmation dialog.
- `frontend/src/pages/brain/BrainHomeState.tsx`: loading, catastrophic error, and post-action status surfaces.
- `frontend/src/pages/brain/GlobalSearch.tsx`: local evidence/destination search with GBrain Explore fallback.
- `frontend/src/pages/brain/BrainHome.module.css`: Quiet Observatory page layout and shared section styles.
- `frontend/src/pages/brain/components.test.ts`: server-rendered component contract tests.
- `frontend/src/pages/BrainHome.tsx`: query and mutation orchestrator.

### Existing files to modify

- `server/routes/hermesKanban.js`: consume the extracted Hermes service without changing responses.
- `server/routes/gbrain/constants.js`: attach safety metadata to existing action definitions.
- `server/routes/gbrain/actionsExecutor.js`: expose capability metadata from the definitions.
- `server/routes/gbrain/router.js`: consume the reusable GBrain overview service.
- `server/routes/gbrain/index.js`: export the reusable service factory.
- `server.js`: construct shared readers and mount the Operations router.
- `tests/gbrainOverview.test.js`: probe-once and no-timeline-on-Operations coverage.
- `tests/gbrainOperatorActions.regression-1.test.js`: safety metadata and eight-id stability.
- `frontend/src/appRoutes.tsx`: seven primary routes, utility placement, and compatibility aliases.
- `frontend/src/appRoutes.test.ts`: route hierarchy, module gating, and alias coverage.
- `frontend/src/components/Sidebar.tsx`: three-system status rail and primary/utility navigation.
- `frontend/src/components/Sidebar.module.css`: Quiet Observatory sidebar styling.
- `frontend/src/index.css`: Quiet Observatory tokens and reduced-motion primitives.
- `README.md` and operator/frontend reference documents: new route and verification contract.

---

### Task 1: Extract a reusable Hermes Kanban service

**Files:**
- Create: `server/services/hermesKanbanData.js`
- Modify: `server/routes/hermesKanban.js`
- Test: `tests/hermesKanbanData.test.js`

**Interfaces:**
- Consumes: `mcConfig.hermes.profile`, injected `execFilePromise`, and injected `processEnv`.
- Produces: `createHermesKanbanService({ mcConfig, execFilePromise, processEnv })` returning `{ profile, getBoard(), getTaskDetail(taskId), runAction(payload) }`.

- [ ] **Step 1: Write the failing service extraction test**

```js
const assert = require('node:assert/strict');
const { createHermesKanbanService } = require('../server/services/hermesKanbanData');

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

(async () => {
  await testBoardUsesProfileAndKeepsPayloadShape();
  console.log('hermesKanbanData tests passed');
})();
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `node --test tests/hermesKanbanData.test.js`

Expected: FAIL with `Cannot find module '../server/services/hermesKanbanData'`.

- [ ] **Step 3: Move the Hermes execution and normalization boundary into the service**

Create the service with this public shape and move the existing `findHermesBin`, epoch normalization, JSON parsing, task/detail/assignee normalization, flag-prefix guard, and action argument construction into it without changing behavior:

```js
const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done'];

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
      if (!title) throw Object.assign(new Error('title required'), { statusCode: 400 });
      args.push('create', title);
      if (payload.body) args.push('--body', String(payload.body));
      if (payload.assignee) args.push('--assignee', assertNoFlagPrefix(payload.assignee, 'assignee'));
      if (payload.workspace) args.push('--workspace', assertNoFlagPrefix(payload.workspace, 'workspace'));
      if (payload.tenant) args.push('--tenant', assertNoFlagPrefix(payload.tenant, 'tenant'));
      if (Number.isFinite(Number(payload.priority))) args.push('--priority', String(Math.trunc(Number(payload.priority))));
      if (payload.triage) args.push('--triage');
      if (Array.isArray(payload.skills)) payload.skills.filter(Boolean).forEach((skill) => args.push('--skill', assertNoFlagPrefix(skill, 'skill')));
      args.push('--created-by', 'mission-control', '--json');
    } else if (action === 'dispatch') {
      args.push('dispatch', '--max', '1', '--json');
    } else {
      if (!taskId) throw Object.assign(new Error('taskId required'), { statusCode: 400 });
      const safeTaskId = assertNoFlagPrefix(taskId, 'taskId');
      if (action === 'assign') {
        if (!payload.assignee) throw Object.assign(new Error('assignee required'), { statusCode: 400 });
        args.push('assign', safeTaskId, assertNoFlagPrefix(payload.assignee, 'assignee'));
      } else if (action === 'comment') {
        if (!payload.text) throw Object.assign(new Error('text required'), { statusCode: 400 });
        args.push('comment', '--author', 'mission-control', safeTaskId, String(payload.text));
      } else if (action === 'block') args.push('block', safeTaskId, String(payload.reason || 'Blocked from Mission Control'));
      else if (action === 'unblock') args.push('unblock', safeTaskId);
      else if (action === 'archive') args.push('archive', safeTaskId);
      else throw Object.assign(new Error(`Unsupported action: ${action}`), { statusCode: 400 });
    }
    const result = await hermes(args, { json: action === 'create' || action === 'dispatch', timeout: action === 'dispatch' ? 30000 : 15000 });
    return { ok: true, action, result };
  }

  return { profile, getBoard, getTaskDetail, runAction };
}

module.exports = { STATUSES, createHermesKanbanService };
```

- [ ] **Step 4: Make the existing router a thin compatibility wrapper**

```js
function buildHermesKanbanRouter({ mcConfig, hermesKanbanService } = {}) {
  const router = express.Router();
  const service = hermesKanbanService || createHermesKanbanService({ mcConfig });

  router.get('/api/hermes-kanban', async (_req, res) => {
    try {
      res.json(await service.getBoard());
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error.message,
        profile: service.profile,
        columns: Object.fromEntries(STATUSES.map((status) => [status, []])),
        statuses: STATUSES,
      });
    }
  });

  router.get('/api/hermes-kanban/tasks/:taskId', async (req, res) => {
    try { res.json(await service.getTaskDetail(req.params.taskId)); }
    catch (error) { res.status(500).json({ ok: false, error: error.message, taskId: req.params.taskId }); }
  });

  router.post('/api/hermes-kanban/actions', async (req, res) => {
    try { res.json(await service.runAction(req.body || {})); }
    catch (error) { res.status(error.statusCode || 500).json({ ok: false, error: error.message }); }
  });

  return router;
}
```

- [ ] **Step 5: Run extraction and existing route checks**

Run: `node --test tests/hermesKanbanData.test.js`

Expected: PASS and `hermesKanbanData tests passed`.

Run: `node --check server/routes/hermesKanban.js && node --check server/services/hermesKanbanData.js`

Expected: both commands exit 0.

- [ ] **Step 6: Commit boundary (only when authorized)**

```bash
git add server/services/hermesKanbanData.js server/routes/hermesKanban.js tests/hermesKanbanData.test.js
git commit -m "refactor(hermes): share kanban data service"
```

---

### Task 2: Share GBrain snapshots and classify action safety

**Files:**
- Create: `server/services/gbrainOverviewData.js`
- Modify: `server/routes/gbrain/constants.js`
- Modify: `server/routes/gbrain/actionsExecutor.js`
- Modify: `server/routes/gbrain/router.js`
- Modify: `server/routes/gbrain/index.js`
- Test: `tests/gbrainOverview.test.js`
- Test: `tests/gbrainOperatorActions.regression-1.test.js`

**Interfaces:**
- Consumes: existing seven GBrain live probes, integration runtime builder, overview builder, and timeline service.
- Produces: `createGBrainOverviewService(options)` returning `{ readSnapshot(), getOverview(), buildFromSnapshot(snapshot, extra) }`; `listGBrainActions()` adds `safetyClass` and `requiresConfirmation`.

- [ ] **Step 1: Add failing action-policy assertions**

```js
const actions = listGBrainActions();
assert.equal(actions.length, 8);
assert.deepEqual(actions.map((action) => action.id), [
  'doctor-fast', 'preview-sync', 'sync-sources', 'retry-failed-sync',
  'embed-stale', 'embed-missing', 'check-resolvable', 'storage-status',
]);
assert.equal(actions.find((action) => action.id === 'doctor-fast').safetyClass, 'R0');
assert.equal(actions.find((action) => action.id === 'doctor-fast').requiresConfirmation, false);
assert.equal(actions.find((action) => action.id === 'sync-sources').safetyClass, 'W1');
assert.equal(actions.find((action) => action.id === 'sync-sources').requiresConfirmation, true);
```

- [ ] **Step 2: Run the policy regression test**

Run: `node --test tests/gbrainOperatorActions.regression-1.test.js`

Expected: FAIL because `safetyClass` and `requiresConfirmation` are undefined.

- [ ] **Step 3: Add explicit safety metadata to all eight definitions**

Add these fields to each existing action definition without changing ids, args, or timeouts:

```js
// diagnostic and preview definitions
safetyClass: 'R0',
requiresConfirmation: false,

// maintenance and repair definitions
safetyClass: 'W1',
requiresConfirmation: true,
```

Project the fields from `listGBrainActions()`:

```js
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
```

- [ ] **Step 4: Write the shared snapshot service test**

Add a test that injects counted probe functions and asserts each is called once, `readSnapshot()` does not call timeline capture, and `getOverview()` does:

```js
const counts = {};
let captureCount = 0;
const counted = (name, value) => async () => {
  counts[name] = (counts[name] || 0) + 1;
  return value;
};
const service = createGBrainOverviewService({
  probes: {
    health: counted('health', { ok: true, status: 'healthy', checkedAt }),
    sources: counted('sources', { ok: true, freshness: { status: 'healthy', staleCount: 0 } }),
    version: counted('version', { ok: true, version: '0.42.58.0' }),
    tools: counted('tools', { ok: true, tools: [] }),
    features: counted('features', { ok: true, recommendations: [] }),
    providers: counted('providers', { ok: true, providers: [] }),
    hermesProxy: counted('hermesProxy', { ok: true }),
  },
  buildIntegrationRuntime: () => ({ checkedAt, systems: {} }),
  timelineService: {
    captureOverview: async () => { captureCount += 1; return { timelineSummary: { enabled: true } }; },
  },
});
const snapshot = await service.readSnapshot();
assert.equal(captureCount, 0);
assert.equal(snapshot.overview.ok, true);
assert.deepEqual(Object.values(counts), [1, 1, 1, 1, 1, 1, 1]);
await service.getOverview();
assert.equal(captureCount, 1);
```

- [ ] **Step 5: Implement the reusable GBrain snapshot service**

```js
function createGBrainOverviewService(options = {}) {
  const probes = options.probes || {
    health: () => buildLiveGBrainHealth(options),
    sources: () => buildLiveGBrainSources(options),
    version: () => buildLiveGBrainVersion(options),
    tools: () => buildLiveGBrainTools(options),
    features: () => buildLiveGBrainFeatures(options),
    providers: () => buildLiveGBrainProviders(options),
    hermesProxy: () => buildLiveHermesProxyStatus(options),
  };
  const buildIntegrationRuntime = options.buildIntegrationRuntime
    || (() => buildLocalGBrainIntegrationRuntime(options));
  const timelineService = options.timelineService || createGBrainTimelineService({
    projectRoot: options.projectRoot,
    enabled: options.mcConfig?.modules?.gbrainTimeline !== false,
    ledgerPath: options.timelineLedgerPath,
  });

  function buildFromSnapshot(snapshot, extra = {}) {
    return buildGBrainOverview(snapshot.live, {
      integrationRuntime: snapshot.integrationRuntime,
      ...extra,
    });
  }

  async function readSnapshot() {
    const [health, sources, version, tools, features, providers, hermesProxy] = await Promise.all([
      probes.health(), probes.sources(), probes.version(), probes.tools(),
      probes.features(), probes.providers(), probes.hermesProxy(),
    ]);
    const integrationRuntime = buildIntegrationRuntime();
    const snapshot = { live: { health, sources, version, tools, features, providers, hermesProxy }, integrationRuntime };
    return { ...snapshot, overview: buildFromSnapshot(snapshot) };
  }

  async function getOverview() {
    const snapshot = await readSnapshot();
    const result = await timelineService.captureOverview(snapshot.overview);
    return buildFromSnapshot(snapshot, {
      timelineSummary: result.timelineSummary,
      incidentBanner: result.timelineSummary?.incidentBanner || null,
      incidentBanners: result.timelineSummary?.incidentBanners || [],
    });
  }

  return { readSnapshot, getOverview, buildFromSnapshot, timelineService };
}
```

- [ ] **Step 6: Inject the service into the existing GBrain router**

Replace the inline overview probe block with:

```js
const overviewService = options.gbrainOverviewService || createGBrainOverviewService(options);

router.get('/api/gbrain/overview', async (_req, res) => {
  res.json(await overviewService.getOverview());
});
```

Export `createGBrainOverviewService` from `server/routes/gbrain/index.js`.

- [ ] **Step 7: Run the focused GBrain tests**

Run: `node --test tests/gbrainOverview.test.js tests/gbrainOperatorActions.regression-1.test.js tests/gbrainTimeline.test.js`

Expected: PASS; action count remains eight and snapshot probes run once per read.

- [ ] **Step 8: Commit boundary (only when authorized)**

```bash
git add server/services/gbrainOverviewData.js server/routes/gbrain/constants.js server/routes/gbrain/actionsExecutor.js server/routes/gbrain/router.js server/routes/gbrain/index.js tests/gbrainOverview.test.js tests/gbrainOperatorActions.regression-1.test.js
git commit -m "refactor(gbrain): share overview evidence and action policy"
```

---

### Task 3: Build the Operations evidence contract

**Files:**
- Create: `server/services/operationsOverview.js`
- Test: `tests/operationsOverview.test.js`

**Interfaces:**
- Consumes: reader callbacks for status, sessions, cron, Hermes board, GBrain overview; `listCapabilities()`.
- Produces: `createOperationsOverviewService({ readers, listCapabilities, now, sourceTimeoutMs })`, `buildOperationsOverview(input, { generatedAt })`, `deriveOverallStatus(systems)`, and `buildOperationsCapabilities({ gbrainActions })`.

- [ ] **Step 1: Write failing pure contract tests**

```js
const assert = require('node:assert/strict');
const {
  buildOperationsOverview,
  buildOperationsCapabilities,
} = require('../server/services/operationsOverview');

const generatedAt = '2026-07-10T12:00:00.000Z';
const overview = buildOperationsOverview({
  status: { generatedAt, agent: { activeSessions: 0, channels: [] }, heartbeat: { lastHeartbeat: null } },
  sessions: { count: 25, sessions: [{ key: 'a', isActive: true }, { key: 'b', isActive: true }, { key: 'c', isActive: true }] },
  cron: { generatedAt, jobs: [{ id: 'openclaw:a', scheduler: 'openclaw', enabled: true }] },
  hermes: { ok: true, refreshedAt: generatedAt, summary: { active: 2, running: 1, blocked: 0, total: 63 } },
  gbrain: { ok: true, refreshedAt: generatedAt, trust: { status: 'healthy', score: 100, label: 'Live trusted', lastVerifiedAt: generatedAt }, caveats: [] },
  capabilities: buildOperationsCapabilities({ gbrainActions: [{ id: 'doctor-fast', kind: 'diagnostic', safetyClass: 'R0', requiresConfirmation: false }] }),
}, { generatedAt });

assert.equal(overview.schemaVersion, '1');
assert.equal(overview.systems.openclaw.metrics.activeSessions, 3);
assert.equal(overview.systems.hermes.metrics.running, 1);
assert.equal(overview.systems.gbrain.state, 'healthy');
assert.ok(overview.attention.some((item) => item.reasonCode === 'openclaw_session_count_conflict'));
assert.equal(overview.capabilities[0].safetyClass, 'R0');
assert.doesNotMatch(JSON.stringify(overview), /session message|task body|Bearer|\/Users\//);
```

Add separate assertions for a failed reader becoming `unavailable`, an active GBrain caveat staying visible at score 100, a blocked Hermes task outranking warnings, and zero/missing data not becoming healthy.

- [ ] **Step 2: Run the contract test**

Run: `node --test tests/operationsOverview.test.js`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement stable states, evidence, attention, and capabilities**

Use the exact public contract below:

```js
const STATE_RANK = { critical: 5, warning: 4, unavailable: 3, inactive: 2, healthy: 1 };

function deriveOverallStatus(systems) {
  return Object.values(systems).reduce((worst, system) =>
    STATE_RANK[system.state] > STATE_RANK[worst] ? system.state : worst,
  'healthy');
}

function buildOperationsCapabilities({ gbrainActions = [] } = {}) {
  return gbrainActions.map((action) => ({
    id: action.id,
    system: 'gbrain',
    label: action.label,
    description: action.description,
    kind: action.kind,
    safetyClass: action.safetyClass,
    requiresConfirmation: Boolean(action.requiresConfirmation),
    timeoutMs: action.timeoutMs || null,
    refreshAfter: Boolean(action.refreshAfter),
    enabled: true,
    disabledReason: '',
    actionEndpoint: '/api/gbrain/actions',
  }));
}

function buildOperationsOverview(input, { generatedAt = new Date().toISOString() } = {}) {
  const adapted = {
    openclaw: adaptOpenClaw(input.status, input.sessions, input.cron, generatedAt),
    hermes: adaptHermes(input.hermes, input.cron, generatedAt),
    gbrain: adaptGBrain(input.gbrain, generatedAt),
  };
  const systems = Object.fromEntries(Object.entries(adapted).map(([id, value]) => [id, value.system]));
  const evidence = Object.values(systems)
    .flatMap((system) => system.evidence)
    .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  const attention = Object.values(adapted).flatMap((value) => value.attention)
    .sort((a, b) => STATE_RANK[b.severity] - STATE_RANK[a.severity] || a.id.localeCompare(b.id));
  const state = deriveOverallStatus(systems);
  return {
    ok: true,
    schemaVersion: '1',
    generatedAt,
    mode: 'live-read-first',
    overall: { state, reasonCodes: attention.map((item) => item.reasonCode) },
    systems,
    attention,
    evidence,
    capabilities: input.capabilities || [],
  };
}
```

Implement the adapters and attention projection explicitly:

```js
function observedAt(value, fallback) {
  const parsed = value && Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function evidence(id, system, kind, status, at, summary, sourceRef, detailHref) {
  return { id, system, kind, status, observedAt: at, summary, sourceRef, detailHref };
}

function unavailableSystem(id, label, detailHref, at, message) {
  return {
    system: { id, label, state: 'unavailable', observedAt: null, freshness: 'unavailable', caveats: [message], metrics: {}, evidence: [evidence(`${id}:unavailable`, id, 'availability', 'unavailable', at, message, `${id} reader`, detailHref)], detailHref },
    attention: [{ id: `${id}:unavailable`, system: id, severity: 'unavailable', reasonCode: `${id}_unavailable`, title: `${label} evidence unavailable`, detail: message, detailHref, evidenceRefs: [`${id}:unavailable`] }],
  };
}

function adaptOpenClaw(status, sessions, cron, generatedAt) {
  if (status?.unavailable && sessions?.unavailable) return unavailableSystem('openclaw', 'OpenClaw', '/systems', generatedAt, 'OpenClaw status and sessions could not be read.');
  const at = observedAt(status?.generatedAt || sessions?.generatedAt || cron?.generatedAt, generatedAt);
  const activeSessions = Array.isArray(sessions?.sessions)
    ? sessions.sessions.filter((session) => session?.isActive).length
    : Number(sessions?.count || 0);
  const statusSessions = Number(status?.agent?.activeSessions || 0);
  const sessionConflict = !status?.unavailable && !sessions?.unavailable && statusSessions !== activeSessions;
  const heartbeatValue = Number(status?.heartbeat?.lastHeartbeat || 0);
  const heartbeatAt = heartbeatValue > 0 ? new Date((heartbeatValue > 1e12 ? heartbeatValue : heartbeatValue * 1000)).toISOString() : null;
  const heartbeatStale = !heartbeatAt || (Date.parse(generatedAt) - Date.parse(heartbeatAt)) > 2 * 60 * 60 * 1000;
  const caveats = [
    ...(sessionConflict ? [`Status reports ${statusSessions} active sessions while the session reader reports ${activeSessions}.`] : []),
    ...(heartbeatStale ? ['Heartbeat proof is stale or unavailable.'] : []),
  ];
  const openclawEvidence = [
    evidence('openclaw:sessions', 'openclaw', 'sessions', sessionConflict ? 'warning' : 'healthy', at, `${activeSessions} active sessions`, '/api/sessions', '/sessions'),
    evidence('openclaw:heartbeat', 'openclaw', 'heartbeat', heartbeatStale ? 'warning' : 'healthy', heartbeatAt, heartbeatStale ? 'Heartbeat stale or unavailable' : 'Heartbeat current', '/api/status', '/systems'),
  ];
  const attention = [];
  if (sessionConflict) attention.push({ id: 'openclaw:session-conflict', system: 'openclaw', severity: 'warning', reasonCode: 'openclaw_session_count_conflict', title: 'OpenClaw session evidence conflicts', detail: caveats[0], detailHref: '/sessions', evidenceRefs: ['openclaw:sessions', 'openclaw:heartbeat'] });
  if (heartbeatStale) attention.push({ id: 'openclaw:heartbeat-stale', system: 'openclaw', severity: 'warning', reasonCode: 'openclaw_heartbeat_stale', title: 'OpenClaw heartbeat needs fresh proof', detail: 'The last verified heartbeat is older than two hours or unavailable.', detailHref: '/systems', evidenceRefs: ['openclaw:heartbeat'] });
  return {
    system: { id: 'openclaw', label: 'OpenClaw', state: caveats.length ? 'warning' : 'healthy', observedAt: at, freshness: heartbeatStale ? 'stale' : 'fresh', caveats, metrics: { activeSessions, channels: Array.isArray(status?.agent?.channels) ? status.agent.channels.length : 0, cronJobs: Array.isArray(cron?.jobs) ? cron.jobs.filter((job) => job.scheduler !== 'hermes').length : null }, evidence: openclawEvidence, detailHref: '/systems' },
    attention,
  };
}

function adaptHermes(board, cron, generatedAt) {
  if (board?.unavailable || board?.ok === false) return unavailableSystem('hermes', 'Hermes', '/work', generatedAt, 'Hermes Kanban could not be read.');
  const at = observedAt(board?.refreshedAt, generatedAt);
  const blocked = Number(board?.summary?.blocked || 0);
  const running = Number(board?.summary?.running || 0);
  const state = blocked > 0 ? 'critical' : 'healthy';
  const proof = evidence('hermes:kanban', 'hermes', 'work', state, at, `${running} running, ${blocked} blocked`, '/api/hermes-kanban', '/work');
  return {
    system: { id: 'hermes', label: 'Hermes', state, observedAt: at, freshness: 'fresh', caveats: blocked > 0 ? [`${blocked} Hermes tasks are blocked.`] : [], metrics: { total: Number(board?.summary?.total || 0), active: Number(board?.summary?.active || 0), running, blocked, cronJobs: Array.isArray(cron?.jobs) ? cron.jobs.filter((job) => job.scheduler === 'hermes').length : null }, evidence: [proof], detailHref: '/work' },
    attention: blocked > 0 ? [{ id: 'hermes:blocked', system: 'hermes', severity: 'critical', reasonCode: 'hermes_tasks_blocked', title: 'Hermes work is blocked', detail: `${blocked} tasks require operator review.`, detailHref: '/work', evidenceRefs: [proof.id] }] : [],
  };
}

function adaptGBrain(overview, generatedAt) {
  if (overview?.unavailable || overview?.ok === false) return unavailableSystem('gbrain', 'GBrain', '/gbrain', generatedAt, 'GBrain overview could not be read.');
  const at = observedAt(overview?.trust?.lastVerifiedAt || overview?.refreshedAt, generatedAt);
  const trustState = ['healthy', 'warning', 'critical', 'inactive'].includes(overview?.trust?.status) ? overview.trust.status : 'unavailable';
  const caveats = Array.isArray(overview?.caveats) ? overview.caveats.map(String) : [];
  const sourceStale = Number(overview?.live?.sources?.freshness?.staleCount || 0) > 0;
  const state = trustState === 'healthy' && caveats.length ? 'warning' : trustState;
  const proof = evidence('gbrain:trust', 'gbrain', 'trust', state, at, `${overview?.trust?.label || 'GBrain trust unavailable'} · ${Number(overview?.trust?.score || 0)}/100`, '/api/gbrain/overview', '/gbrain');
  return {
    system: { id: 'gbrain', label: 'GBrain', state, observedAt: at, freshness: sourceStale ? 'stale' : 'fresh', caveats, metrics: { trustScore: Number(overview?.trust?.score || 0), staleSources: Number(overview?.live?.sources?.freshness?.staleCount || 0), caveats: caveats.length }, evidence: [proof], detailHref: '/gbrain' },
    attention: caveats.map((detail, index) => ({ id: `gbrain:caveat:${index}`, system: 'gbrain', severity: state === 'critical' ? 'critical' : 'warning', reasonCode: 'gbrain_active_caveat', title: 'GBrain has an active caveat', detail, detailHref: '/gbrain', evidenceRefs: [proof.id] })),
  };
}
```

- [ ] **Step 4: Implement bounded partial reads**

```js
function withTimeout(reader, timeoutMs, source) {
  return Promise.race([
    Promise.resolve().then(reader),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${source} timed out`)), timeoutMs)),
  ]);
}

function createOperationsOverviewService({
  readers,
  listCapabilities = () => [],
  now = () => new Date(),
  sourceTimeoutMs = 10_000,
}) {
  async function getOverview() {
    const names = ['status', 'sessions', 'cron', 'hermes', 'gbrain'];
    const results = await Promise.allSettled(names.map((name) =>
      withTimeout(readers[name], sourceTimeoutMs, name)));
    const input = Object.fromEntries(results.map((result, index) => [
      names[index],
      result.status === 'fulfilled'
        ? result.value
        : { ok: false, unavailable: true, error: result.reason?.message || `${names[index]} unavailable` },
    ]));
    input.capabilities = listCapabilities();
    return buildOperationsOverview(input, { generatedAt: now().toISOString() });
  }
  return { getOverview };
}
```

The adapters must only copy allowlisted summary fields. Never spread source payloads into the overview.

- [ ] **Step 5: Run Operations policy tests**

Run: `node --test tests/operationsOverview.test.js`

Expected: PASS for conflict, partial failure, caveat, severity, capability, and redaction cases.

- [ ] **Step 6: Commit boundary (only when authorized)**

```bash
git add server/services/operationsOverview.js tests/operationsOverview.test.js
git commit -m "feat(operations): add shared evidence contract"
```

---

### Task 4: Mount the read-only Operations route

**Files:**
- Create: `server/routes/operations.js`
- Modify: `server.js`
- Test: `tests/operationsRoute.test.js`

**Interfaces:**
- Consumes: the service factories from Tasks 1-3 and existing status, sessions, and cron service methods.
- Produces: `GET /api/operations/overview`; no POST, PATCH, or DELETE route.

- [ ] **Step 1: Write the failing HTTP route test**

```js
const assert = require('node:assert/strict');
const express = require('express');
const { buildOperationsRouter } = require('../server/routes/operations');

async function withServer(service, test) {
  const app = express();
  app.use(buildOperationsRouter({ operationsOverviewService: service }));
  const server = app.listen(0);
  try {
    const { port } = server.address();
    await test(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testOverviewGetAndNoMutationRoute() {
  await withServer({ getOverview: async () => ({ ok: true, schemaVersion: '1', systems: {} }) }, async (base) => {
    const getResponse = await fetch(`${base}/api/operations/overview`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).schemaVersion, '1');
    const postResponse = await fetch(`${base}/api/operations/overview`, { method: 'POST' });
    assert.equal(postResponse.status, 404);
  });
}

(async () => {
  await testOverviewGetAndNoMutationRoute();
  console.log('operations route tests passed');
})();
```

- [ ] **Step 2: Run the route test**

Run: `node --test tests/operationsRoute.test.js`

Expected: FAIL with missing route module.

- [ ] **Step 3: Add the route with explicit catastrophic-failure handling**

```js
const express = require('express');

function buildOperationsRouter({ operationsOverviewService }) {
  if (!operationsOverviewService?.getOverview) throw new Error('operationsOverviewService.getOverview required');
  const router = express.Router();
  router.get('/api/operations/overview', async (_req, res) => {
    try { return res.json(await operationsOverviewService.getOverview()); }
    catch (error) { return res.status(500).json({ ok: false, error: 'Operations overview unavailable' }); }
  });
  return router;
}

module.exports = { buildOperationsRouter };
```

- [ ] **Step 4: Wire one instance of each shared reader in `server.js`**

Add imports:

```js
const { createHermesKanbanService } = require('./server/services/hermesKanbanData');
const { createGBrainOverviewService } = require('./server/services/gbrainOverviewData');
const { createOperationsOverviewService, buildOperationsCapabilities } = require('./server/services/operationsOverview');
const { buildOperationsRouter } = require('./server/routes/operations');
const { listGBrainActions } = require('./server/routes/gbrain');
```

Construct shared instances and pass them to existing routers:

```js
const hermesKanbanService = createHermesKanbanService({ mcConfig });
const gbrainOverviewService = createGBrainOverviewService({ projectRoot: __dirname, mcConfig });

app.use(buildGBrainRouter({ projectRoot: __dirname, mcConfig, gbrainOverviewService }));
app.use(buildHermesKanbanRouter({ mcConfig, hermesKanbanService }));
```

After `statusService`, `cronService`, and `sessionsService` exist, mount Operations:

```js
const operationsOverviewService = createOperationsOverviewService({
  readers: {
    status: () => statusService.getStatusResponse(),
    sessions: () => sessionsService.listVisibleSessions(25),
    cron: async () => {
      const parsed = await cronService.fetchCronJobsLive();
      const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs || [];
      return { generatedAt: new Date().toISOString(), jobs: jobs.map(cronService.mapCronJobForApi) };
    },
    hermes: () => hermesKanbanService.getBoard(),
    gbrain: async () => (await gbrainOverviewService.readSnapshot()).overview,
  },
  listCapabilities: () => buildOperationsCapabilities({ gbrainActions: listGBrainActions() }),
});
app.use(buildOperationsRouter({ operationsOverviewService }));
```

- [ ] **Step 5: Run backend integration checks**

Run: `node --test tests/operationsOverview.test.js tests/operationsRoute.test.js tests/hermesKanbanData.test.js tests/gbrainOverview.test.js tests/gbrainOperatorActions.regression-1.test.js tests/statusData.test.js tests/cronData.test.js tests/cronRoute.test.js`

Expected: all tests pass.

Run: `node --check server.js`

Expected: exit 0.

- [ ] **Step 6: Commit boundary (only when authorized)**

```bash
git add server/routes/operations.js server.js tests/operationsRoute.test.js
git commit -m "feat(operations): expose shared overview route"
```

---

### Task 5: Define the frontend Operations model and policies

**Files:**
- Create: `frontend/src/pages/brain/types.ts`
- Create: `frontend/src/pages/brain/lib.ts`
- Create: `frontend/src/pages/brain/lib.test.ts`
- Create: `frontend/src/pages/gbrain/types.ts`
- Create: `frontend/src/pages/gbrain/api.ts`
- Modify: `frontend/src/pages/GBrain.tsx`

**Interfaces:**
- Consumes: the `/api/operations/overview` contract and `/api/gbrain/actions` result body.
- Produces: `OperationsOverview`, `OperationSystem`, `AttentionItem`, `EvidenceItem`, `OperationCapability`, `sortAttention`, `findSearchResults`, `selectionFromSystem`, `selectionFromAttention`, `selectionFromEvidence`, `actionNeedsConfirmation`, and `postGBrainAction`.

- [ ] **Step 1: Write failing frontend policy tests**

```ts
import { describe, expect, it } from 'vitest'
import { actionNeedsConfirmation, findSearchResults, sortAttention } from './lib'

describe('brain policies', () => {
  it('sorts critical before warning and remains stable by id', () => {
    const result = sortAttention([
      { id: 'b', severity: 'warning' },
      { id: 'c', severity: 'critical' },
      { id: 'a', severity: 'warning' },
    ] as never)
    expect(result.map((item) => item.id)).toEqual(['c', 'a', 'b'])
  })

  it('requires confirmation only for W1', () => {
    expect(actionNeedsConfirmation({ safetyClass: 'R0', requiresConfirmation: false } as never)).toBe(false)
    expect(actionNeedsConfirmation({ safetyClass: 'W1', requiresConfirmation: true } as never)).toBe(true)
  })

  it('searches evidence, attention, and destinations without triggering actions', () => {
    const results = findSearchResults('hermes', {
      attention: [{ id: 'a', system: 'hermes', title: 'Hermes blocker', detail: '', detailHref: '/work' }],
      evidence: [],
    } as never)
    expect(results[0]).toMatchObject({ label: 'Hermes blocker', href: '/work', system: 'hermes' })
  })
})
```

- [ ] **Step 2: Run the frontend policy test**

Run: `npm --prefix frontend test -- src/pages/brain/lib.test.ts`

Expected: FAIL because the new module does not exist.

- [ ] **Step 3: Define the exact API types**

```ts
export type OperationSystemId = 'gbrain' | 'hermes' | 'openclaw'
export type OperationState = 'healthy' | 'warning' | 'critical' | 'inactive' | 'unavailable'
export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'unavailable'
export type SafetyClass = 'R0' | 'W1' | 'W2'

export interface EvidenceItem {
  id: string
  system: OperationSystemId
  kind: string
  status: OperationState
  observedAt: string | null
  summary: string
  sourceRef: string
  detailHref: string
}

export interface AttentionItem {
  id: string
  system: OperationSystemId
  severity: OperationState
  reasonCode: string
  title: string
  detail: string
  detailHref: string
  evidenceRefs: string[]
}

export interface OperationSystem {
  id: OperationSystemId
  label: string
  state: OperationState
  observedAt: string | null
  freshness: FreshnessState
  caveats: string[]
  metrics: Record<string, string | number | null>
  evidence: EvidenceItem[]
  detailHref: string
}

export interface OperationCapability {
  id: string
  system: 'gbrain'
  label: string
  description: string
  kind: string
  safetyClass: SafetyClass
  requiresConfirmation: boolean
  timeoutMs: number | null
  refreshAfter: boolean
  enabled: boolean
  disabledReason: string
  actionEndpoint: '/api/gbrain/actions'
}

export interface OperationsOverview {
  ok: boolean
  schemaVersion: '1'
  generatedAt: string
  mode: 'live-read-first'
  overall: { state: OperationState; reasonCodes: string[] }
  systems: Record<OperationSystemId, OperationSystem>
  attention: AttentionItem[]
  evidence: EvidenceItem[]
  capabilities: OperationCapability[]
}
```

Create `frontend/src/pages/gbrain/types.ts` with:

```ts
export interface GBrainActionResult {
  ok: boolean
  action?: string
  label?: string
  status: string
  summary?: string
  error?: string
  checkedAt: string
  refreshAfter?: boolean
}
```

Keep `DrawerSelection` and `ActionStatus` in `frontend/src/pages/brain/types.ts`:

```ts

export type DrawerSelection = {
  system: OperationSystemId
  title: string
  detail: string
  detailHref: string
  caveats: string[]
  evidence: EvidenceItem[]
}

export type ActionStatus = {
  state: 'running' | 'verifying' | 'verified' | 'pending-proof' | 'failed' | 'complete'
  message: string
}
```

- [ ] **Step 4: Implement pure UI helpers and safe action POST**

```ts
const severityRank: Record<OperationState, number> = {
  critical: 5, warning: 4, unavailable: 3, inactive: 2, healthy: 1,
}

export function sortAttention(items: AttentionItem[]) {
  return [...items].sort((a, b) =>
    severityRank[b.severity] - severityRank[a.severity] || a.id.localeCompare(b.id))
}

export function actionNeedsConfirmation(action: OperationCapability) {
  return action.safetyClass === 'W1' && action.requiresConfirmation
}

export function findSearchResults(query: string, overview: OperationsOverview) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const destinations = [
    { id: 'brain', label: 'Brain', detail: 'Shared evidence and decisions', href: '/', system: 'gbrain' },
    { id: 'work', label: 'Work', detail: 'Hermes work and handoffs', href: '/work', system: 'hermes' },
    { id: 'automations', label: 'Automations', detail: 'OpenClaw and Hermes schedules', href: '/automations', system: 'openclaw' },
    { id: 'sessions', label: 'Sessions', detail: 'OpenClaw sessions', href: '/sessions', system: 'openclaw' },
    { id: 'gbrain', label: 'Explore', detail: 'GBrain sources and memory', href: '/gbrain', system: 'gbrain' },
    { id: 'usage', label: 'Usage', detail: 'Spend and model mix', href: '/usage', system: 'openclaw' },
    { id: 'systems', label: 'Systems', detail: 'Agents, models, integrations', href: '/systems', system: 'openclaw' },
  ]
  const dynamic = [
    ...overview.attention.map((item) => ({ id: item.id, label: item.title, detail: item.detail, href: item.detailHref, system: item.system })),
    ...overview.evidence.map((item) => ({ id: item.id, label: item.summary, detail: item.sourceRef, href: item.detailHref, system: item.system })),
  ]
  return [...destinations, ...dynamic].filter((item) =>
    `${item.label} ${item.detail} ${item.system}`.toLowerCase().includes(needle)).slice(0, 8)
}

export function selectionFromSystem(system: OperationSystem): DrawerSelection {
  return { system: system.id, title: system.label, detail: `${system.state} · ${system.freshness}`, detailHref: system.detailHref, caveats: system.caveats, evidence: system.evidence }
}

export function selectionFromAttention(item: AttentionItem, evidence: EvidenceItem[]): DrawerSelection {
  return { system: item.system, title: item.title, detail: item.detail, detailHref: item.detailHref, caveats: [], evidence: evidence.filter((proof) => item.evidenceRefs.includes(proof.id)) }
}

export function selectionFromEvidence(item: EvidenceItem): DrawerSelection {
  return { system: item.system, title: item.summary, detail: item.sourceRef, detailHref: item.detailHref, caveats: item.status === 'healthy' ? [] : [item.summary], evidence: [item] }
}
```

```ts
export async function postGBrainAction(action: string): Promise<GBrainActionResult> {
  const response = await fetch('/api/gbrain/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const payload = await response.json() as GBrainActionResult
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { payload })
  return payload
}
```

Replace the manual `fetch('/api/gbrain/actions', ...)` block in `GBrain.tsx` with the same shared handler used by Brain Home:

```ts
const data = await postGBrainAction(action)
setActionResult(data)
if (data.refreshAfter) {
  await Promise.all([refetch(), refetchTimeline()])
}
```

- [ ] **Step 5: Run frontend policy tests**

Run: `npm --prefix frontend test -- src/pages/brain/lib.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit boundary (only when authorized)**

```bash
git add frontend/src/pages/brain/types.ts frontend/src/pages/brain/lib.ts frontend/src/pages/brain/lib.test.ts frontend/src/pages/gbrain/types.ts frontend/src/pages/gbrain/api.ts frontend/src/pages/GBrain.tsx
git commit -m "feat(ui): define shared brain view model"
```

---

### Task 6: Build the Brain Map truth components

**Files:**
- Create: `frontend/src/pages/brain/SystemStatusRail.tsx`
- Create: `frontend/src/pages/brain/LivingBrainMap.tsx`
- Create: `frontend/src/pages/brain/DecisionInbox.tsx`
- Create: `frontend/src/pages/brain/EvidenceTimeline.tsx`
- Create: `frontend/src/pages/brain/BrainHome.module.css`
- Test: `frontend/src/pages/brain/components.test.ts`

**Interfaces:**
- Consumes: `OperationsOverview`, `OperationSystem`, `AttentionItem`, and `EvidenceItem` from Task 5.
- Produces: presentational components with no network calls or mutations.

- [ ] **Step 1: Write a failing server-render smoke test**

```ts
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SystemStatusRail } from './SystemStatusRail'

describe('brain truth components', () => {
  it('renders all three systems without reducing caveats to color only', () => {
    const html = renderToStaticMarkup(createElement(SystemStatusRail, {
      systems: [
        { id: 'gbrain', label: 'GBrain', state: 'healthy', freshness: 'fresh', observedAt: '2026-07-10T12:00:00Z', caveats: [], metrics: {}, evidence: [], detailHref: '/gbrain' },
        { id: 'hermes', label: 'Hermes', state: 'healthy', freshness: 'fresh', observedAt: '2026-07-10T12:00:00Z', caveats: [], metrics: {}, evidence: [], detailHref: '/work' },
        { id: 'openclaw', label: 'OpenClaw', state: 'warning', freshness: 'stale', observedAt: null, caveats: ['Heartbeat unavailable'], metrics: {}, evidence: [], detailHref: '/systems' },
      ],
    }))
    expect(html).toContain('GBrain')
    expect(html).toContain('Hermes')
    expect(html).toContain('OpenClaw')
    expect(html).toContain('Heartbeat unavailable')
    expect(html).toContain('stale')
  })
})
```

- [ ] **Step 2: Run the component smoke test**

Run: `npm --prefix frontend test -- src/pages/brain/components.test.ts`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the status rail and Decision Inbox**

```tsx
export function SystemStatusRail({ systems }: { systems: OperationSystem[] }) {
  return <section className={styles.statusRail} aria-label="System evidence status">
    {systems.map((system) => <Link key={system.id} to={system.detailHref} className={styles.statusCard} data-state={system.state}>
      <span className={styles.statusIdentity}><span aria-hidden="true" className={styles.statusDot} />{system.label}</span>
      <strong>{system.state}</strong>
      <span>{system.freshness}{system.observedAt ? ` · ${timeAgo(system.observedAt)}` : ' · no current proof'}</span>
      {system.caveats[0] ? <small>{system.caveats[0]}</small> : null}
    </Link>)}
  </section>
}
```

```tsx
export function DecisionInbox({ items, onSelect }: { items: AttentionItem[]; onSelect: (item: AttentionItem) => void }) {
  const sorted = sortAttention(items)
  return <section className={styles.inbox} aria-labelledby="decision-inbox-title">
    <header><h2 id="decision-inbox-title">Decision Inbox</h2><span>{sorted.length} need attention</span></header>
    {sorted.length === 0
      ? <p className={styles.empty}>No operator decision needs attention. Review system freshness before treating this as globally healthy.</p>
      : sorted.map((item) => <button key={item.id} type="button" data-severity={item.severity} onClick={() => onSelect(item)}>
          <span>{item.system}</span><strong>{item.title}</strong><p>{item.detail}</p>
        </button>)}
  </section>
}
```

- [ ] **Step 4: Implement the accessible map and evidence stream**

```tsx
const positions = {
  gbrain: { x: 50, y: 50 }, hermes: { x: 18, y: 28 }, openclaw: { x: 82, y: 28 },
  sources: { x: 18, y: 74 }, triggers: { x: 82, y: 74 },
} as const

export function LivingBrainMap({ overview, onSelectSystem }: {
  overview: OperationsOverview
  onSelectSystem: (system: OperationSystem) => void
}) {
  const systems = [overview.systems.gbrain, overview.systems.hermes, overview.systems.openclaw]
  return <section className={styles.mapPanel} aria-labelledby="brain-map-title">
    <header><h2 id="brain-map-title">Living Brain Map</h2><span>live · read-first</span></header>
    <div className={styles.mapCanvas}>
      {systems.map((system) => <button
        key={system.id}
        type="button"
        className={styles.mapNode}
        data-system={system.id}
        data-state={system.state}
        style={{ '--node-x': `${positions[system.id].x}%`, '--node-y': `${positions[system.id].y}%` } as CSSProperties}
        aria-label={`${system.label}: ${system.state}, ${system.freshness}`}
        onClick={() => onSelectSystem(system)}
      ><strong>{system.label}</strong><span>{system.state}</span></button>)}
      <Link className={styles.domainNode} style={{ '--node-x': '18%', '--node-y': '74%' } as CSSProperties} to="/gbrain?tab=sources">Sources</Link>
      <a className={styles.domainNode} style={{ '--node-x': '82%', '--node-y': '74%' } as CSSProperties} href="#gbrain-triggers">Triggers</a>
    </div>
  </section>
}
```

```tsx
export function EvidenceTimeline({ evidence, onSelect }: { evidence: EvidenceItem[]; onSelect: (item: EvidenceItem) => void }) {
  return <section className={styles.timeline} aria-labelledby="evidence-title">
    <header><h2 id="evidence-title">Evidence Timeline</h2><span>latest cross-stack proof</span></header>
    <ol>{evidence.slice(0, 8).map((item) => <li key={item.id}>
      <button type="button" onClick={() => onSelect(item)}><span>{item.system}</span><strong>{item.summary}</strong><time>{item.observedAt ? timeAgo(item.observedAt) : 'unknown'}</time></button>
    </li>)}</ol>
  </section>
}
```

- [ ] **Step 5: Add Quiet Observatory component styles**

In `BrainHome.module.css`, define static layout and data-state selectors. Runtime state is passed through `data-state`, not inline colors:

```css
.statusRail { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.statusCard,.inbox,.mapPanel,.timeline { border:1px solid var(--obs-border); background:var(--obs-panel); border-radius:12px; }
.statusCard[data-state='healthy'] .statusDot { background:var(--state-healthy); }
.statusCard[data-state='warning'] .statusDot { background:var(--state-warning); }
.statusCard[data-state='critical'] .statusDot { background:var(--state-critical); }
.statusCard[data-state='unavailable'] .statusDot { background:var(--state-unavailable); }
.mapCanvas { position:relative; min-height:440px; background:radial-gradient(circle at 50% 50%,rgba(46,126,181,.14),transparent 42%); }
.mapNode,.domainNode { position:absolute; left:var(--node-x); top:var(--node-y); transform:translate(-50%,-50%); }
@media (max-width:900px) { .statusRail { grid-template-columns:1fr; } .mapCanvas { min-height:360px; } }
@media (prefers-reduced-motion:reduce) { .mapNode,.domainNode { transition:none; animation:none; } }
```

- [ ] **Step 6: Run component and policy tests**

Run: `npm --prefix frontend test -- src/pages/brain/lib.test.ts src/pages/brain/components.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit boundary (only when authorized)**

```bash
git add frontend/src/pages/brain/SystemStatusRail.tsx frontend/src/pages/brain/LivingBrainMap.tsx frontend/src/pages/brain/DecisionInbox.tsx frontend/src/pages/brain/EvidenceTimeline.tsx frontend/src/pages/brain/BrainHome.module.css frontend/src/pages/brain/components.test.ts
git commit -m "feat(ui): add shared brain evidence components"
```

---

### Task 7: Add the Evidence Drawer and safe GBrain triggers

**Files:**
- Create: `frontend/src/pages/brain/EvidenceDrawer.tsx`
- Create: `frontend/src/pages/brain/GBrainTriggerShelf.tsx`
- Create: `frontend/src/pages/brain/ActionConfirmDialog.tsx`
- Modify: `frontend/src/pages/brain/BrainHome.module.css`
- Test: `frontend/src/pages/brain/components.test.ts`

**Interfaces:**
- Consumes: selected system, attention, or evidence; `OperationCapability[]`; `onRun(action)` callback.
- Produces: action-scoped confirmation UI; no W2 rendering.

- [ ] **Step 1: Add failing trigger-policy rendering assertions**

```ts
it('shows R0 directly, W1 as confirm-required, and omits W2', () => {
  const html = renderToStaticMarkup(createElement(GBrainTriggerShelf, {
    actions: [
      { id: 'doctor-fast', label: 'Run fast doctor', safetyClass: 'R0', requiresConfirmation: false, enabled: true },
      { id: 'sync-sources', label: 'Sync local sources', safetyClass: 'W1', requiresConfirmation: true, enabled: true },
      { id: 'danger', label: 'Delete storage', safetyClass: 'W2', requiresConfirmation: true, enabled: true },
    ],
    runningAction: null,
    onRequestRun: () => undefined,
  } as never))
  expect(html).toContain('Run fast doctor')
  expect(html).toContain('Sync local sources')
  expect(html).toContain('Confirmation required')
  expect(html).not.toContain('Delete storage')
})
```

- [ ] **Step 2: Run the focused component test**

Run: `npm --prefix frontend test -- src/pages/brain/components.test.ts`

Expected: FAIL because the new components do not exist.

- [ ] **Step 3: Implement Evidence Drawer content order**

```tsx
export function EvidenceDrawer({ selection, onClose }: { selection: DrawerSelection | null; onClose: () => void }) {
  if (!selection) return null
  return <aside className={styles.drawer} aria-labelledby="evidence-drawer-title">
    <header><div><span>{selection.system}</span><h2 id="evidence-drawer-title">{selection.title}</h2></div><button type="button" onClick={onClose} aria-label="Close evidence drawer">×</button></header>
    <section><h3>Current conclusion</h3><p>{selection.detail}</p></section>
    <section><h3>Evidence</h3>{selection.evidence.map((item) => <article key={item.id}><strong>{item.summary}</strong><span>{item.sourceRef}</span><time>{item.observedAt || 'Observation time unavailable'}</time></article>)}</section>
    {selection.caveats.length ? <section><h3>Caveats</h3><ul>{selection.caveats.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}
    <Link to={selection.detailHref}>Open specialized detail</Link>
  </aside>
}
```

- [ ] **Step 4: Implement trigger shelf and action-scoped confirmation**

```tsx
export function GBrainTriggerShelf({ actions, runningAction, onRequestRun }: Props) {
  const visible = actions.filter((action) => action.safetyClass !== 'W2')
  return <section id="gbrain-triggers" className={styles.triggerShelf} aria-labelledby="trigger-title">
    <header><h2 id="trigger-title">GBrain Triggers</h2><span>{visible.length} allowlisted actions</span></header>
    <div className={styles.triggerGrid}>{visible.map((action) => <button
      key={action.id}
      type="button"
      disabled={!action.enabled || Boolean(runningAction)}
      data-safety={action.safetyClass}
      onClick={(event) => onRequestRun(action, event.currentTarget)}
    ><span>{action.safetyClass}</span><strong>{action.label}</strong><p>{action.description}</p><small>{action.enabled ? (action.requiresConfirmation ? 'Confirmation required' : 'Runs diagnostic directly') : action.disabledReason}</small></button>)}</div>
  </section>
}
```

Define `Props` directly above the component:

```ts
interface Props {
  actions: OperationCapability[]
  runningAction: string | null
  onRequestRun: (action: OperationCapability, trigger: HTMLButtonElement) => void
}
```

The parent confirmation dialog must render the selected action label, safety class, current proof summary, expected duration, and a single exact action button. It must not offer bulk approval.

```tsx
export function ActionConfirmDialog({ action, proof, onCancel, onConfirm, returnFocusRef }: {
  action: OperationCapability | null
  proof: OperationSystem
  onCancel: () => void
  onConfirm: () => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!action) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKeyDown)
    confirmRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      returnFocusRef.current?.focus()
    }
  }, [action, onCancel, returnFocusRef])
  if (!action) return null
  return <div className={styles.confirmBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
    <div className={styles.confirmDialog} role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <span>{action.safetyClass} · GBrain</span><h2 id="confirm-title">{action.label}</h2><p>{action.description}</p>
      <dl><div><dt>Current proof</dt><dd>{proof.state} · {proof.freshness}</dd></div><div><dt>Expected duration</dt><dd>{action.timeoutMs ? `${Math.ceil(action.timeoutMs / 60000)} minutes` : 'Not specified'}</dd></div></dl>
      <div className={styles.confirmActions}><button type="button" onClick={onCancel}>Cancel</button><button ref={confirmRef} type="button" onClick={onConfirm}>Run {action.label}</button></div>
    </div>
  </div>
}
```

- [ ] **Step 5: Add drawer, confirmation, focus, and state styles**

```css
.drawer { position:fixed; inset:0 0 0 auto; z-index:220; width:min(460px,100vw); overflow:auto; border-left:1px solid var(--obs-border); background:var(--obs-elevated); box-shadow:-24px 0 60px rgba(0,0,0,.42); }
.triggerGrid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.triggerGrid button[data-safety='W1'] { border-color:color-mix(in srgb,var(--state-warning) 42%,var(--obs-border)); }
.confirmBackdrop { position:fixed; inset:0; z-index:230; display:grid; place-items:center; background:rgba(2,7,12,.72); }
.confirmDialog { width:min(520px,calc(100vw - 32px)); border:1px solid var(--obs-border-strong); border-radius:14px; background:var(--obs-elevated); }
@media (max-width:900px) { .triggerGrid { grid-template-columns:1fr 1fr; } }
@media (max-width:560px) { .triggerGrid { grid-template-columns:1fr; } }
```

- [ ] **Step 6: Run component tests**

Run: `npm --prefix frontend test -- src/pages/brain/components.test.ts`

Expected: PASS for R0, W1, W2, drawer, and empty selection cases.

- [ ] **Step 7: Commit boundary (only when authorized)**

```bash
git add frontend/src/pages/brain/EvidenceDrawer.tsx frontend/src/pages/brain/GBrainTriggerShelf.tsx frontend/src/pages/brain/ActionConfirmDialog.tsx frontend/src/pages/brain/BrainHome.module.css frontend/src/pages/brain/components.test.ts
git commit -m "feat(ui): add evidence drawer and guarded triggers"
```

---

### Task 8: Compose Brain Home, search, and post-action verification

**Files:**
- Create: `frontend/src/pages/brain/GlobalSearch.tsx`
- Create: `frontend/src/pages/brain/BrainHomeState.tsx`
- Create: `frontend/src/pages/BrainHome.tsx`
- Modify: `frontend/src/pages/brain/BrainHome.module.css`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `useApi<OperationsOverview>('/api/operations/overview', 30000)`, Task 5 action helper, and Tasks 6-7 components.
- Produces: the complete home page and post-action `running → verifying → verified/pending-proof` state machine.

- [ ] **Step 1: Implement local search with Explore fallback**

```tsx
export function GlobalSearch({ overview }: { overview: OperationsOverview }) {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const results = findSearchResults(query, overview)
  return <form className={styles.search} onSubmit={(event) => {
    event.preventDefault()
    if (results[0]) navigate(results[0].href)
    else if (query.trim()) navigate(`/gbrain?q=${encodeURIComponent(query.trim())}`)
  }}>
    <Search size={15} aria-hidden="true" />
    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory, evidence, work, or systems" aria-label="Search Mission Control" />
    {query ? <ul>{results.map((result) => <li key={result.id}><button type="button" onClick={() => navigate(result.href)}><span>{result.system}</span><strong>{result.label}</strong><small>{result.detail}</small></button></li>)}</ul> : null}
  </form>
}
```

- [ ] **Step 2: Compose the home query and selection state**

```tsx
export default function BrainHome() {
  const queryClient = useQueryClient()
  const { data, loading, error, refetch } = useApi<OperationsOverview>('/api/operations/overview', 30000)
  const [selection, setSelection] = useState<DrawerSelection | null>(null)
  const [pendingAction, setPendingAction] = useState<OperationCapability | null>(null)
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)

  const actionMutation = useMutation({
    mutationFn: (action: string) => postGBrainAction(action),
    onMutate: (action) => { setRunningAction(action); setActionStatus({ state: 'running', message: 'Action running' }) },
    onSuccess: async (result) => {
      const previousProofAt = data?.systems.gbrain.observedAt || null
      setActionStatus({ state: result.refreshAfter ? 'verifying' : 'complete', message: result.summary || 'Action completed' })
      await queryClient.invalidateQueries({ queryKey: ['api', '/api/operations/overview'] })
      await queryClient.invalidateQueries({ queryKey: ['api', '/api/gbrain/overview'] })
      const refreshed = await refetch()
      const nextGBrain = refreshed.data?.systems.gbrain
      const proofAdvanced = Boolean(nextGBrain?.observedAt && nextGBrain.observedAt !== previousProofAt && nextGBrain.freshness === 'fresh')
      setActionStatus({ state: proofAdvanced ? 'verified' : 'pending-proof', message: proofAdvanced ? 'Action completed and fresh proof loaded' : 'Action completed; proof pending or unavailable' })
    },
    onError: (error) => setActionStatus({ state: 'failed', message: error.message }),
    onSettled: () => { setRunningAction(null); setPendingAction(null) },
  })

  if (loading) return <BrainHomeSkeleton />
  if (error || !data) return <BrainHomeError message={error || 'Overview unavailable'} onRetry={() => refetch()} />

  return <PageTransition><div className={styles.page}>
    <header className={styles.pageHeader}><div><span>Mission Control</span><h1>Shared Brain</h1><p>OpenClaw, Hermes, and GBrain evidence in one read-first surface.</p></div><GlobalSearch overview={data} /></header>
    <SystemStatusRail systems={[data.systems.gbrain, data.systems.hermes, data.systems.openclaw]} />
    <div className={styles.primaryGrid}><LivingBrainMap overview={data} onSelectSystem={(system) => setSelection(selectionFromSystem(system))} /><DecisionInbox items={data.attention} onSelect={(item) => setSelection(selectionFromAttention(item, data.evidence))} /></div>
    <GBrainTriggerShelf actions={data.capabilities} runningAction={runningAction} onRequestRun={(action, trigger) => { returnFocusRef.current = trigger; actionNeedsConfirmation(action) ? setPendingAction(action) : actionMutation.mutate(action.id) }} />
    <EvidenceTimeline evidence={data.evidence} onSelect={(item) => setSelection(selectionFromEvidence(item))} />
    <EvidenceDrawer selection={selection} onClose={() => setSelection(null)} />
    <ActionConfirmDialog action={pendingAction} proof={data.systems.gbrain} returnFocusRef={returnFocusRef} onCancel={() => setPendingAction(null)} onConfirm={() => pendingAction && actionMutation.mutate(pendingAction.id)} />
    {actionStatus ? <ActionStatusBanner status={actionStatus} /> : null}
  </div></PageTransition>
}
```

Create the explicit page states used above:

```tsx
export function BrainHomeSkeleton() {
  return <div className={styles.skeleton} aria-label="Loading shared brain evidence"><div /><div /><div /></div>
}

export function BrainHomeError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className={styles.errorState}><h1>Shared Brain unavailable</h1><p>{message}</p><button type="button" onClick={onRetry}>Retry evidence read</button></section>
}

export function ActionStatusBanner({ status }: { status: ActionStatus }) {
  return <div className={styles.actionStatus} data-state={status.state} role="status"><strong>{status.state}</strong><span>{status.message}</span></div>
}
```

- [ ] **Step 3: Add Quiet Observatory global tokens and responsive composition**

Add to `index.css`:

```css
:root {
  --obs-bg:#081018; --obs-sidebar:#0d1721; --obs-panel:#101b26; --obs-elevated:#111d29;
  --obs-border:#263a4c; --obs-border-strong:#356080; --obs-blue:#58b5f5;
  --state-healthy:#39d982; --state-warning:#ffbd59; --state-critical:#ff6969; --state-unavailable:#8291a0;
}
```

Add to `BrainHome.module.css`:

```css
.page { max-width:1560px; margin:0 auto; display:flex; flex-direction:column; gap:14px; }
.pageHeader { display:flex; align-items:center; justify-content:space-between; gap:18px; }
.primaryGrid { display:grid; grid-template-columns:minmax(0,1.55fr) minmax(300px,.72fr); gap:14px; }
@media (max-width:1000px) { .pageHeader { align-items:stretch; flex-direction:column; } .primaryGrid { grid-template-columns:1fr; } }
```

- [ ] **Step 4: Run frontend tests, lint, and build**

Run: `npm --prefix frontend test -- src/pages/brain/lib.test.ts src/pages/brain/components.test.ts`

Expected: PASS.

Run: `npm --prefix frontend run lint`

Expected: exit 0 with no React hook errors.

Run: `npm --prefix frontend run build`

Expected: TypeScript and Vite build pass and `frontend/dist/index.html` is generated.

- [ ] **Step 5: Commit boundary (only when authorized)**

```bash
git add frontend/src/pages/brain/GlobalSearch.tsx frontend/src/pages/brain/BrainHomeState.tsx frontend/src/pages/BrainHome.tsx frontend/src/pages/brain/BrainHome.module.css frontend/src/index.css
git commit -m "feat(ui): compose shared brain home"
```

---

### Task 9: Replace the fifteen-item navigation with seven primary destinations

**Files:**
- Modify: `frontend/src/appRoutes.tsx`
- Modify: `frontend/src/appRoutes.test.ts`
- Modify: `frontend/src/components/Sidebar.tsx`
- Modify: `frontend/src/components/Sidebar.module.css`

**Interfaces:**
- Consumes: `BrainHome` and the existing specialized page components.
- Produces: `primarySidebarRoutes`, `utilitySidebarRoutes`, compatibility redirects, and three-system sidebar status.

- [ ] **Step 1: Write failing route hierarchy assertions**

```ts
import { appRoutes, primarySidebarRoutes, utilitySidebarRoutes } from './appRoutes'

it('exposes exactly seven primary destinations', () => {
  expect(primarySidebarRoutes.map((route) => route.path)).toEqual([
    '/', '/work', '/automations', '/sessions', '/gbrain', '/usage', '/systems',
  ])
})

it('keeps settings and governance in utility navigation', () => {
  expect(utilitySidebarRoutes.map((route) => route.path)).toEqual(['/settings', '/councils'])
})

it('keeps source-specific Phase 2 pages hidden but reachable', () => {
  for (const path of ['/workshop', '/calendar', '/office', '/team', '/ollama']) {
    expect(appRoutes.find((route) => route.path === path)?.nav).toBe(false)
  }
})

it('decouples GBrain from the docs module flag', () => {
  expect(appRoutes.find((route) => route.path === '/gbrain')?.module).toBe('gbrain')
})
```

- [ ] **Step 2: Run the route test**

Run: `npm --prefix frontend test -- src/appRoutes.test.ts`

Expected: FAIL because primary and utility route exports do not exist.

- [ ] **Step 3: Define canonical Phase 1 routes and compatibility redirects**

Extend `AppRouteDefinition`:

```ts
navPlacement?: 'primary' | 'utility'
section?: 'core' | 'intelligence' | 'system' | 'operate' | 'audit'
```

Use these canonical routes:

```ts
{ path: '/', label: 'Brain', module: 'dashboard', component: BrainHome, icon: BrainCircuit, navPlacement: 'primary', section: 'core', description: 'Shared evidence' },
{ path: '/work', label: 'Work', module: 'workshop', component: HermesKanban, icon: Kanban, navPlacement: 'primary', section: 'core', description: 'Hermes work · Phase 1' },
{ path: '/automations', label: 'Automations', module: 'cron', component: Cron, icon: Clock, navPlacement: 'primary', section: 'core', description: 'Cron list · Phase 1' },
{ path: '/sessions', label: 'Sessions', module: 'chat', component: Chat, icon: MessageCircle, navPlacement: 'primary', section: 'core', description: 'OpenClaw sessions' },
{ path: '/gbrain', label: 'Explore', module: 'gbrain', component: GBrain, icon: Search, navPlacement: 'primary', section: 'intelligence', description: 'Memory and sources' },
{ path: '/usage', label: 'Usage', module: 'costs', component: Costs, icon: DollarSign, navPlacement: 'primary', section: 'intelligence', description: 'Spend and model mix' },
{ path: '/systems', label: 'Systems', module: 'agents', component: Agents, icon: Network, navPlacement: 'primary', section: 'system', description: 'Agents · Phase 1' },
{ path: '/settings', label: 'Settings', module: 'settings', component: SettingsPage, icon: Settings, navPlacement: 'utility' },
{ path: '/councils', label: 'Audit', module: 'councils', component: Councils, icon: Landmark, navPlacement: 'utility' },
```

Add safe one-to-one redirects: `/kanban → /work`, `/cron → /automations`, `/conversations → /sessions`, `/costs → /usage`, and `/agents → /systems`. Keep `/workshop`, `/calendar`, `/office`, `/team`, and `/ollama` hidden but directly reachable until Phase 2.

Use the existing lazy redirect pattern:

```tsx
const RedirectKanban = lazy(() => Promise.resolve({ default: () => <Navigate replace to="/work" /> }))
const RedirectCron = lazy(() => Promise.resolve({ default: () => <Navigate replace to="/automations" /> }))
const RedirectConversations = lazy(() => Promise.resolve({ default: () => <Navigate replace to="/sessions" /> }))
const RedirectCosts = lazy(() => Promise.resolve({ default: () => <Navigate replace to="/usage" /> }))
const RedirectAgents = lazy(() => Promise.resolve({ default: () => <Navigate replace to="/systems" /> }))
```

```ts
export const primarySidebarRoutes = appRoutes.filter((route) => route.navPlacement === 'primary' && route.icon)
export const utilitySidebarRoutes = appRoutes.filter((route) => route.navPlacement === 'utility' && route.icon)
```

- [ ] **Step 4: Replace single-runtime sidebar state with three-system truth**

Use one `useApi<OperationsOverview>('/api/operations/overview', 30000)` query. Render GBrain, Hermes, and OpenClaw rows with text state and freshness; do not calculate status from a separate heartbeat parser.

```tsx
<NavLink to="/" className={styles.systemStack} aria-label="Open shared brain status">
  {(['gbrain', 'hermes', 'openclaw'] as const).map((id) => {
    const system = overview?.systems[id]
    return <span key={id} className={styles.systemRow} data-state={system?.state || 'unavailable'}>
      <span><i className={styles.systemDot} />{system?.label || id}</span>
      <strong>{system?.state || 'unavailable'}</strong>
    </span>
  })}
</NavLink>
```

Render `primarySidebarRoutes` in Core, Intelligence, and System groups, then `utilitySidebarRoutes` at the bottom. Remove the duplicate footer session count.

- [ ] **Step 5: Add compact sidebar styles and run route tests**

```css
.systemStack { display:grid; gap:7px; border:1px solid var(--obs-border); border-radius:10px; padding:10px; background:var(--obs-panel); }
.systemRow { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--text-secondary); font-size:10px; }
.systemRow > span { display:flex; align-items:center; gap:7px; }
.systemDot { width:7px; height:7px; border-radius:50%; background:var(--state-unavailable); }
.systemRow[data-state='healthy'] .systemDot { background:var(--state-healthy); }
.systemRow[data-state='warning'] .systemDot { background:var(--state-warning); }
.systemRow[data-state='critical'] .systemDot { background:var(--state-critical); }
```

Run: `npm --prefix frontend test -- src/appRoutes.test.ts src/pages/brain/lib.test.ts src/pages/brain/components.test.ts`

Expected: PASS and exactly seven primary routes.

- [ ] **Step 6: Commit boundary (only when authorized)**

```bash
git add frontend/src/appRoutes.tsx frontend/src/appRoutes.test.ts frontend/src/components/Sidebar.tsx frontend/src/components/Sidebar.module.css
git commit -m "feat(ui): simplify mission control navigation"
```

---

### Task 10: Update operator documentation and run full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/reference-operator-surfaces.md`
- Modify: `docs/how-to-verify-operator-surfaces.md`
- Modify: `docs/tutorial-first-operator-check.md`
- Modify: `docs/reference-frontend-conventions.md`

**Interfaces:**
- Consumes: final route names, overview contract, action policy, and verification commands.
- Produces: operator documentation matching the implemented application.

- [ ] **Step 1: Update the documented route and safety tables**

Document exactly:

```markdown
| Surface | Route | Purpose |
| --- | --- | --- |
| Brain | `/` | Shared GBrain, Hermes, and OpenClaw evidence, decisions, and safe GBrain triggers |
| Work | `/work` | Hermes work in Phase 1; cross-system merge follows in Phase 2 |
| Automations | `/automations` | Cron list in Phase 1; schedule view follows in Phase 2 |
| Sessions | `/sessions` | OpenClaw sessions and handoffs |
| Explore | `/gbrain` | GBrain health, sources, memory, triggers, and timeline |
| Usage | `/usage` | Spend and model mix |
| Systems | `/systems` | Live agents and system inventory |
```

Add the R0/W1/W2 table and state that a `100/100` GBrain score does not hide active caveats or stale evidence.

- [ ] **Step 2: Run all focused backend tests**

Run:

```bash
node --test \
  tests/operationsOverview.test.js \
  tests/operationsRoute.test.js \
  tests/hermesKanbanData.test.js \
  tests/gbrainOverview.test.js \
  tests/gbrainRuntimeContractInstaller.test.js \
  tests/gbrainTimeline.test.js \
  tests/gbrainOperatorActions.regression-1.test.js \
  tests/statusData.test.js \
  tests/cronData.test.js \
  tests/cronRoute.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Run frontend tests, lint, and build**

Run:

```bash
npm --prefix frontend test -- \
  src/appRoutes.test.ts \
  src/pages/brain/lib.test.ts \
  src/pages/brain/components.test.ts
npm --prefix frontend run lint
npm --prefix frontend run build
```

Expected: all tests pass, ESLint exits 0, and Vite production build succeeds.

- [ ] **Step 4: Run repository-wide checks**

Run: `npm test`

Expected: the full Node test suite passes.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Verify the live read-only truth surface**

Start or reload the local application through the project's existing workflow, then run:

```bash
curl -sS http://127.0.0.1:3333/api/operations/overview | jq '{schemaVersion,generatedAt,overall,systems,attentionCount:(.attention|length),capabilities:(.capabilities|map({id,safetyClass,requiresConfirmation}))}'
```

Expected: HTTP 200; `schemaVersion` is `1`; all three systems exist; evidence timestamps are present or explicitly unavailable; eight GBrain capabilities are listed; no raw messages, task bodies, tokens, or absolute home paths appear.

- [ ] **Step 6: Verify the rendered Brain Map**

Use the project browser workflow to inspect `/` at 1440×960, 768×1024, and 375×812. Verify:

- seven primary navigation destinations and two utility links;
- three independent system states;
- accessible map nodes and mobile ordered-list fallback;
- Decision Inbox empty, warning, and critical states;
- R0 direct action presentation;
- W1 confirmation dialog and cancel path using mocks or preview-only behavior;
- reduced-motion behavior;
- no console errors or failed application requests.

- [ ] **Step 7: Commit boundary (only when authorized)**

```bash
git add README.md docs/reference-operator-surfaces.md docs/how-to-verify-operator-surfaces.md docs/tutorial-first-operator-check.md docs/reference-frontend-conventions.md
git commit -m "docs: document shared brain operations center"
```

---

## Spec Coverage Index

- Shared source readers and probe reuse: Tasks 1-2.
- Unified evidence contract, freshness, conflicts, attention, and redaction: Tasks 3-4.
- Frontend contract, local search, and safe action client: Task 5.
- Brain Map, independent status, Decision Inbox, and Evidence Timeline: Task 6.
- Evidence Drawer, all eight GBrain actions, R0/W1/W2, confirmation, and focus restoration: Task 7.
- Quiet Observatory composition, loading/error states, and post-action proof: Task 8.
- Seven primary destinations, utility navigation, legacy reachability, and three-system sidebar truth: Task 9.
- Documentation, responsive/accessibility checks, full tests, live read-only smoke, and rendered QA: Task 10.
- Phase 2 surface merging and Phase 3 removal remain intentionally outside this Phase 1 plan.

No approved Phase 1 requirement is left without an implementation or verification task.

## Final Review Checklist

- [ ] The home page is Brain Map, not Operator Briefing.
- [ ] GBrain, Hermes, and OpenClaw retain independent truth and freshness.
- [ ] Active GBrain caveats remain visible at `100/100`.
- [ ] Session-count conflicts produce attention rather than silent override.
- [ ] Exactly eight stable GBrain action ids remain.
- [ ] R0 actions run directly; W1 actions require scoped confirmation; W2 is absent.
- [ ] Post-action success is not called verified before fresh proof arrives.
- [ ] Exactly seven primary and two utility navigation destinations render.
- [ ] Hidden Phase 2 pages remain reachable.
- [ ] No new dependency or lockfile change exists.
- [ ] Focused tests, full tests, lint, build, live read-only smoke, and rendered responsive QA pass.
