'use strict';

// createApp(deps) builds the Express app with every route Mission Control
// serves, without listening. server/index.js listens; tests build the app on
// port 0 with injected fakes.
//
// deps (all optional):
//   rootDir     project root (mc-config.json, data/, frontend/dist)
//   config      result of loadConfig(); default loadConfig({ rootDir })
//   configStore createConfigStore({ config })
//   exec        core process runner (createExec())
//   clock       { now() } for core modules
//   fetch       fetch implementation for code wired here (sessions, Notion)
//   logger      console-like
//   services    overrides for heavy services (gbrainOverviewService,
//               hermesKanbanService, hermesGatewayHealthService,
//               notionActivity) so tests never reach a real CLI
//
// app.locals.runtime carries the core objects: { config, configStore, exec,
// scheduler, sources, guard, start(), dispose(), setBoundPort(), recoverTasks() }.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const childProcess = require('child_process');

const { loadConfig, createConfigStore } = require('./core/config');
const { createExec } = require('./core/exec');
const { createScheduler } = require('./core/scheduler');
const {
  requestContext,
  apiNotFound,
  errorHandler,
} = require('./core/http');
const { createGuard, createAuditLog, auditWrites } = require('./core/guard');
const { createEventLoopMonitor, buildHealthPayload } = require('./core/health');

const { createRuntimeSnapshotStore } = require('./services/runtimeSnapshots');
const { createOpenclawExec, createOpenclawCli } = require('./services/openclawClient');
const { createCronService, parseFirstJson } = require('./services/cronData');
const { createStatusService } = require('./services/statusData');
const { createHermesKanbanService } = require('./services/hermesKanbanData');
const { createHermesGatewayHealthService } = require('./services/hermesGatewayHealth');
const { createGBrainOverviewService } = require('./services/gbrainOverviewData');
const {
  createOperationsOverviewService,
  createOperationsReaders,
} = require('./services/operationsOverview');
const { readJsonFileSafe, writeJsonFileAtomic } = require('./services/jsonFiles');
const { createSettingsService } = require('./services/settingsData');
const { createFetchSessions, createSessionsService } = require('./services/sessionsData');
const { createNotionActivityService } = require('./services/notionActivity');
const {
  createOpenclawStatusSource,
  STATUS_REFRESH_INTERVAL_MS,
} = require('./sources/openclaw/status');
const { GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS } = require('./routes/gbrain/constants');
const { buildAgentsRouter } = require('./routes/agents');
const { buildAwsRouter } = require('./routes/aws');
const { buildCalendarRouter } = require('./routes/calendar');
const { buildChatRouter } = require('./routes/chat');
const { buildCostsRouter } = require('./routes/costs');
const { buildCouncilsRouter } = require('./routes/councils');
const { buildCronRouter } = require('./routes/cron');
const { buildDocsRouter } = require('./routes/docs');
const { buildGBrainRouter, listGBrainActions } = require('./routes/gbrain');
const { buildHermesKanbanRouter } = require('./routes/hermesKanban');
const { buildMemoryRouter } = require('./routes/memory');
const { buildModelsRouter } = require('./routes/models');
const { buildOllamaRouter } = require('./routes/ollama');
const { buildOperationsRouter } = require('./routes/operations');
const { buildOpsRouter } = require('./routes/ops');
const { buildQuickRouter } = require('./routes/quick');
const { buildScoutRouter } = require('./routes/scout');
const { buildSessionsRouter } = require('./routes/sessions');
const { buildSettingsRouter } = require('./routes/settings');
const { buildSkillsRouter } = require('./routes/skills');
const { buildStatusRouter } = require('./routes/status');
const { buildTasksRouter, recoverTasksOnStartup } = require('./routes/tasks');

function prettyModelName(modelKey) {
  if (!modelKey) return '—';
  if (modelKey.includes('gpt-5.3-codex')) return 'GPT-5.3 Codex';
  if (modelKey.includes('gpt-5.2-codex')) return 'GPT-5.2 Codex';
  return modelKey
    .replace(/^openai-codex\//, '')
    .replace(/^openai\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^ollama\//, '')
    .replace(/_/g, '-');
}

function createApp(deps = {}) {
  const rootDir = deps.rootDir || deps.config?.rootDir || path.join(__dirname, '..');
  const logger = deps.logger || console;
  const now = deps.clock?.now || Date.now;
  const fetchImpl = deps.fetch || ((...args) => fetch(...args));
  const services = deps.services || {};
  const config = deps.config || loadConfig({ rootDir });
  const configStore = deps.configStore || createConfigStore({ config, logger });
  const exec = deps.exec || createExec({ now });
  const scheduler = deps.scheduler || createScheduler({ now, logger });

  // Legacy names kept so the wiring below reads like the old server.js.
  const projectRoot = config.rootDir;
  const mcConfig = configStore.legacyObject();
  const MC_CONFIG_PATH = config.paths.mcConfig;
  const MC_DEFAULT_CONFIG_PATH = config.paths.mcDefaultConfig;
  const OPENCLAW_CONFIG_PATH = config.paths.openclawConfig;
  const GATEWAY_PORT = config.gateway.port;
  const GATEWAY_TOKEN = config.gateway.token;
  const WORKSPACE_PATH = config.workspacePath;
  const SKILLS_PATH = config.skillsPath;
  const MEMORY_PATH = config.memoryPath;
  const OPENCLAW_BIN = config.openclawBin;

  function getOpenclawDefaultModelKey() {
    try {
      const ocConfig = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
      return ocConfig?.agents?.defaults?.model?.primary
        || ocConfig?.agents?.defaults?.model?.default
        || ocConfig?.model?.default
        || '';
    } catch {
      return '';
    }
  }

  const persistMcConfig = () => configStore.persist(mcConfig);

  // Every OpenClaw CLI call runs on the serialized `openclaw` lane.
  const openclawExec = createOpenclawExec({ runner: exec, bin: OPENCLAW_BIN, configPath: OPENCLAW_CONFIG_PATH });
  const openclawCli = createOpenclawCli({ runner: exec, bin: OPENCLAW_BIN, configPath: OPENCLAW_CONFIG_PATH });
  // Shell runner kept only for the disabled AWS module (slated for removal).
  const execPromise = util.promisify(childProcess.exec);

  const fetchSessions = createFetchSessions({
    openclawExec,
    fetchImpl,
    gatewayPort: GATEWAY_PORT,
    gatewayToken: GATEWAY_TOKEN,
    logger,
  });
  const notionActivity = services.notionActivity || createNotionActivityService({
    notionDbId: config.notion.dbId,
    notionToken: config.notion.token,
    fetchImpl,
  });

  // --- core plumbing -----------------------------------------------------
  let boundPort = null;
  const auditLog = createAuditLog({ file: config.paths.auditFile, now, logger });
  const guard = createGuard({
    bindHost: config.server.host,
    port: () => (boundPort == null ? config.server.port : boundPort),
    writeGuardMode: config.guard.writeGuardMode,
    logger,
  });
  const loop = createEventLoopMonitor();
  loop.start();
  const startedAtMs = now();

  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext({ logger, now }));
  app.use(auditWrites({ auditLog }));
  app.use(guard.middleware);
  app.use(express.json());

  app.use(express.static(config.paths.frontendDist));
  app.use('/public', express.static(config.paths.publicDir));
  app.use('/data', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // --- services ----------------------------------------------------------
  const gbrainOverviewService = services.gbrainOverviewService
    || createGBrainOverviewService({ projectRoot, mcConfig });
  const hermesKanbanService = services.hermesKanbanService || createHermesKanbanService({ mcConfig });
  const hermesGatewayHealthService = services.hermesGatewayHealthService || createHermesGatewayHealthService({
    profile: hermesKanbanService.profile,
    home: process.env.MC_USER_HOME || process.env.HOME || os.homedir(),
  });

  const settingsService = createSettingsService({
    mcConfig,
    missionControlConfigPath: MC_CONFIG_PATH,
    missionControlDefaultConfigPath: MC_DEFAULT_CONFIG_PATH,
    missionControlPackagePath: path.join(projectRoot, 'package.json'),
    missionControlRoot: projectRoot,
    gatewayPort: GATEWAY_PORT,
    gatewayToken: GATEWAY_TOKEN,
    memoryPath: MEMORY_PATH,
    skillsPath: SKILLS_PATH,
    bedrockRegion: config.aws.region,
    openclawExec,
    configStore,
  });

  const STATUS_CACHE_TTL = 60000;
  const RUNTIME_SNAPSHOT_TTL = {
    status: STATUS_CACHE_TTL,
    cron: 60000,
    councilsSummary: 15000,
    governanceScorecard: 15000,
  };
  const { readRuntimeSnapshot, writeRuntimeSnapshot } = createRuntimeSnapshotStore({
    baseDir: config.paths.runtimeDir,
  });

  const statusService = createStatusService({
    mcConfig,
    memoryPath: MEMORY_PATH,
    prettyModelName,
    getOpenclawDefaultModelKey,
    fetchNotionActivity: (pageSize) => notionActivity.fetchNotionActivity(pageSize),
    fetchSessions,
    readRuntimeSnapshot,
    writeRuntimeSnapshot,
    runtimeSnapshotTtl: RUNTIME_SNAPSHOT_TTL,
    gatewayPort: GATEWAY_PORT,
    openclawCli,
    fs,
    path,
    // The scheduler owns the status refresh; reads never start one.
    refreshOnRead: false,
  });
  const statusSource = createOpenclawStatusSource({ statusService, now, logger });
  scheduler.register(statusSource, { intervalMs: STATUS_REFRESH_INTERVAL_MS, jitterMs: 1000 });

  const CRON_CACHE_TTL = 30000;
  const cronService = createCronService({
    openclawExec: (...args) => openclawExec(...args),
    gatewayPort: GATEWAY_PORT,
    gatewayToken: GATEWAY_TOKEN,
    getOpenclawDefaultModelKey,
    calendarFile: path.join(projectRoot, 'data', 'calendar-entries.json'),
  });

  const sessionsService = createSessionsService({
    fetchSessions,
    hiddenSessionsPath: path.join(projectRoot, 'hidden-sessions.json'),
    openclawConfigPath: OPENCLAW_CONFIG_PATH,
    gatewayPort: GATEWAY_PORT,
    gatewayToken: GATEWAY_TOKEN,
    fetchImpl,
    now,
  });
  const operationsOverviewService = createOperationsOverviewService({
    readers: createOperationsReaders({
      statusService,
      sessionsService,
      cronService,
      hermesKanbanService,
      hermesGatewayHealthService,
      gbrainOverviewService,
    }),
    listCapabilities: () => listGBrainActions(),
    // GBrain probes are concurrency-bounded but routinely exceed the Operations
    // default under database pressure, and a soft-timed-out probe keeps the
    // child until the hard-kill backstop before returning. The deadline is
    // derived from the probe constants so the reader outlives the worst chain;
    // keep other sources isolated at the 10s default.
    sourceTimeoutMsOverrides: { gbrain: GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS },
  });
  const TASKS_FILE = path.join(projectRoot, 'tasks.json');
  const DECISION_LOG_PATH = path.join(projectRoot, 'data/decision-log.json');
  const OPS_EVENTS_PATH = path.join(projectRoot, 'data/ops-events.json');
  const AGENT_REGISTRY_PATH = path.join(projectRoot, 'data/agent-registry.json');

  // --- routes ------------------------------------------------------------
  const healthPayload = () => buildHealthPayload({
    now,
    startedAtMs,
    loop,
    scheduler,
    exec,
    config,
    guard,
  });
  const livenessPayload = () => ({
    ok: true,
    status: 'ok',
    service: 'mission-control',
    generatedAt: new Date(now()).toISOString(),
  });
  app.get('/api/health', (req, res) => res.json(healthPayload()));
  app.get('/healthz', (req, res) => res.json(livenessPayload()));

  app.use(buildGBrainRouter({ projectRoot, mcConfig, gbrainOverviewService }));
  app.use(buildHermesKanbanRouter({ mcConfig, hermesKanbanService }));
  app.use(buildChatRouter({ gatewayPort: GATEWAY_PORT, gatewayToken: GATEWAY_TOKEN, openclawBin: OPENCLAW_BIN }));
  app.use(buildOperationsRouter({ operationsOverviewService }));
  app.use(buildStatusRouter({ statusService, statusSource }));
  app.use(buildCronRouter({
    readRuntimeSnapshot,
    writeRuntimeSnapshot,
    runtimeSnapshotTtl: RUNTIME_SNAPSHOT_TTL,
    cronService,
    openclawExec: (...args) => openclawExec(...args),
  }));
  app.use(buildCalendarRouter({ calendarService: cronService, cronCacheTtl: CRON_CACHE_TTL }));
  app.use(buildTasksRouter({
    projectRoot,
    cronService,
    openclawExec,
    openclawBin: OPENCLAW_BIN,
    workspacePath: WORKSPACE_PATH,
    gatewayToken: GATEWAY_TOKEN,
  }));
  app.use(buildScoutRouter({ projectRoot }));
  app.use(buildAgentsRouter({
    openclawExec,
    fetchSessions,
    readJsonFileSafe,
    writeJsonFileAtomic,
    TASKS_FILE,
    mcConfig,
    workspacePath: WORKSPACE_PATH,
    persistMcConfig,
    missionControlConfigPath: MC_CONFIG_PATH,
  }));
  app.use(buildSkillsRouter({ openclawExec, parseFirstJson, settingsService }));
  app.use(buildAwsRouter({
    exec: execPromise,
    AWS_ACCESS_KEY_ID: config.aws.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.aws.secretAccessKey,
    AWS_REGION: config.aws.region,
    mcConfig,
    s3Bucket: config.aws.bucket,
  }));
  app.use(buildModelsRouter({ openclawExec, parseFirstJson, prettyModelName, settingsService }));
  app.use(buildCostsRouter({ mcConfig, projectRoot, sessionsService }));
  app.use(buildSessionsRouter({ sessionsService }));
  app.use(buildSettingsRouter({ settingsService, projectRoot }));
  app.use(buildDocsRouter({ projectRoot }));
  app.use(buildMemoryRouter({ memoryPath: MEMORY_PATH, workspacePath: WORKSPACE_PATH }));
  app.use(buildQuickRouter({ gatewayPort: GATEWAY_PORT, gatewayToken: GATEWAY_TOKEN }));
  app.use(buildOllamaRouter({
    exec: execPromise,
    openclawExec,
    mcConfig,
    missionControlConfigPath: MC_CONFIG_PATH,
    persistMcConfig,
  }));
  app.use(buildCouncilsRouter({
    readRuntimeSnapshot,
    writeRuntimeSnapshot,
    runtimeSnapshotTtl: RUNTIME_SNAPSHOT_TTL,
    decisionLogPath: DECISION_LOG_PATH,
    opsEventsPath: OPS_EVENTS_PATH,
    agentRegistryPath: AGENT_REGISTRY_PATH,
    readJsonFileSafe,
    writeJsonFileAtomic,
  }));
  app.use(buildOpsRouter({
    readJsonFileSafe,
    writeJsonFileAtomic,
    opsEventsPath: OPS_EVENTS_PATH,
    gatewayPort: GATEWAY_PORT,
  }));

  // Unknown /api/* is a JSON 404, never the SPA shell or an HTML page.
  app.use('/api', apiNotFound());

  // SPA catch-all: serve index.html for all non-API routes.
  // Express 5 uses path-to-regexp v8 and no longer accepts bare `*`.
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    res.sendFile('index.html', { root: config.paths.frontendDist }, (error) => {
      if (error) next(error);
    });
  });

  app.use(errorHandler({ logger }));

  let disposed = false;
  app.locals.runtime = {
    config,
    configStore,
    exec,
    scheduler,
    guard,
    auditLog,
    sources: { status: statusSource, sessions: sessionsService.visibleSessionsSource },
    services: { statusService, sessionsService, cronService, operationsOverviewService, settingsService },
    setBoundPort(port) {
      boundPort = Number(port);
    },
    start() {
      scheduler.start();
    },
    async recoverTasks() {
      await recoverTasksOnStartup({
        projectRoot,
        cronService,
        openclawExec,
        openclawBin: OPENCLAW_BIN,
        workspacePath: WORKSPACE_PATH,
        gatewayToken: GATEWAY_TOKEN,
      });
    },
    // Stop timers, kill children. Idempotent.
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.stop();
      loop.stop();
      exec.killAll();
    },
  };
  return app;
}

module.exports = { createApp, prettyModelName };
