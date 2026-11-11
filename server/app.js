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
// scheduler, sources, guard, start(), dispose(), setBoundPort() }.

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
  isApiPath,
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
const { buildAwsRouter } = require('./routes/aws');
const { buildCalendarRouter } = require('./routes/calendar');
const { buildCostsRouter } = require('./routes/costs');
const { buildCouncilsRouter } = require('./routes/councils');
const { buildCronRouter } = require('./routes/cron');
const { buildGBrainRouter, listGBrainActions } = require('./routes/gbrain');
const { buildHermesKanbanRouter } = require('./routes/hermesKanban');
const { buildModelsRouter } = require('./routes/models');
const { buildOllamaRouter } = require('./routes/ollama');
const { buildOperationsRouter } = require('./routes/operations');
const { buildSessionsRouter } = require('./routes/sessions');
const { buildSettingsRouter } = require('./routes/settings');
const { buildStatusRouter } = require('./routes/status');

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

  // Every OpenClaw CLI call runs on the serialized `openclaw` lane.
  const openclawExec = createOpenclawExec({ runner: exec, bin: OPENCLAW_BIN, configPath: OPENCLAW_CONFIG_PATH });
  const openclawCli = createOpenclawCli({ runner: exec, bin: OPENCLAW_BIN, configPath: OPENCLAW_CONFIG_PATH });
  // Shell runner for the AWS cost read (GET /api/aws/costs).
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

  // Static files never answer an API path (any case, encoding or slash
  // variant): a file at frontend/dist/api/health must not shadow the route.
  const serveDist = express.static(config.paths.frontendDist);
  app.use((req, res, next) => (isApiPath(req.originalUrl || req.url) ? next() : serveDist(req, res, next)));
  app.use('/public', express.static(config.paths.publicDir));
  app.use('/data', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // --- services ----------------------------------------------------------
// gbrain area: scheduler owns all probes; the shared runner owns the gbrain lane.
  const gbrainOverviewService = services.gbrainOverviewService
    || createGBrainOverviewService({ projectRoot, mcConfig, exec, now });
  gbrainOverviewService.register?.(scheduler);
  // end gbrain area
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

  // --- runtime area: scheduled sources and additive router wiring --------
  const { createAutomationSource, AUTOMATIONS_REFRESH_INTERVAL_MS } = require('./sources/openclaw/automations');
  const { createOpenclawModelsSource, MODELS_REFRESH_INTERVAL_MS } = require('./sources/openclaw/models');
  const { createOllamaSource } = require('./sources/ollama/telemetry');
  const automationSource = deps.sources?.automations || createAutomationSource({ cronService, now, logger });
  const modelsSource = deps.sources?.models || createOpenclawModelsSource({ openclawCli, parseFirstJson, prettyModelName, settingsService, now, logger });
  const ollamaSource = deps.sources?.ollama || createOllamaSource({ runner: exec, mcConfig, fetchImpl, now, logger });
  scheduler.register(automationSource, { intervalMs: AUTOMATIONS_REFRESH_INTERVAL_MS, jitterMs: 1000 });
  scheduler.register(modelsSource, { intervalMs: MODELS_REFRESH_INTERVAL_MS, jitterMs: 1000 });
  scheduler.register(ollamaSource, { intervalMs: 5000, jitterMs: 250 });
  // Local adapters leave other authors' mount lines untouched.
  function buildCronRouter(options) { return require('./routes/cron').buildCronRouter({ ...options, automationSource }); }
  function buildCalendarRouter(options) { return require('./routes/calendar').buildCalendarRouter({ ...options, automationSource }); }
  function buildModelsRouter(options) { return require('./routes/models').buildModelsRouter({ ...options, modelsSource }); }
  function buildOllamaRouter(options) { return require('./routes/ollama').buildOllamaRouter({ ...options, ollamaSource }); }
  // --- end runtime area --------------------------------------------------

  const sessionsService = createSessionsService({
    fetchSessions,
    hiddenSessionsPath: path.join(projectRoot, 'hidden-sessions.json'),
    now,
  });
  // The visible-sessions list is a scheduled source; GET /api/sessions only
  // reads its snapshot.
  scheduler.register(sessionsService.visibleSessionsSource, { intervalMs: 30_000, jitterMs: 2000 });
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
  // --- attention area: operations sources, loops, services, signals -------
  // Every Operations reader becomes a scheduled source; the overview route
  // and /api/signals compose from memory. New routers mount here (paths are
  // distinct, all before the JSON 404).
  const attentionArea = (() => {
    const { createSource } = require('./core/source');
    const { createOperationsSources } = require('./services/operationsOverview');
    const { createMloopSource, MLOOP_REFRESH_INTERVAL_MS } = require('./sources/mloop');
    const {
      createLaunchdSource, createReachabilitySource, LAUNCHD_REFRESH_INTERVAL_MS, REACHABILITY_REFRESH_INTERVAL_MS,
    } = require('./sources/launchd');
    const { buildLoopsRouter } = require('./routes/loops');
    const { buildServicesRouter } = require('./routes/services');
    const { buildSignalsRouter, usageFromSibling } = require('./routes/signals');
    const operationsSources = createOperationsSources({
      readers: createOperationsReaders({
        statusService, sessionsService, cronService, hermesKanbanService, hermesGatewayHealthService, gbrainOverviewService,
      }),
      createSource,
      sourceTimeoutMsOverrides: { gbrain: GBRAIN_OPERATIONS_SOURCE_TIMEOUT_MS },
      now,
      logger,
    });
    const sourcesByName = Object.fromEntries(Object.entries(operationsSources).map(([name, entry]) => [name, entry.source]));
    for (const entry of Object.values(operationsSources)) {
      scheduler.register(entry.source, { intervalMs: entry.intervalMs, jitterMs: 2000 });
    }
    const overviewService = createOperationsOverviewService({
      sources: sourcesByName,
      listCapabilities: () => listGBrainActions(),
    });
    const userHome = process.env.MC_USER_HOME || process.env.HOME || os.homedir();
    const loopsSource = deps.sources?.loops || createMloopSource({ exec, now, logger, bin: path.join(userHome, 'bin', 'mloop') });
    const launchdSource = deps.sources?.launchd || createLaunchdSource({
      exec,
      now,
      logger,
      homeDir: userHome,
      labelPatterns: mcConfig.services?.launchdLabelPatterns || process.env.MC_LAUNCHD_LABELS || undefined,
    });
    const reachabilitySource = deps.sources?.reachability || createReachabilitySource({
      fetchImpl,
      now,
      logger,
      openclawGatewayPort: GATEWAY_PORT,
      hermesGatewayHealthService,
      ollamaBaseUrl: `http://${mcConfig.ollama?.host || '127.0.0.1'}:${Number(mcConfig.ollama?.port) || 11434}`,
    });
    scheduler.register(loopsSource, { intervalMs: MLOOP_REFRESH_INTERVAL_MS, jitterMs: 5000 });
    scheduler.register(launchdSource, { intervalMs: LAUNCHD_REFRESH_INTERVAL_MS, jitterMs: 2000 });
    scheduler.register(reachabilitySource, { intervalMs: REACHABILITY_REFRESH_INTERVAL_MS, jitterMs: 2000 });
    const sibling = (read) => {
      try { return read(); } catch { return null; }
    };
    app.use(buildLoopsRouter({ loopsSource }));
    app.use(buildServicesRouter({ launchdSource, reachabilitySource }));
    app.use(buildSignalsRouter({
      operationsOverviewService: overviewService,
      operationsSources: sourcesByName,
      loopsSource,
      launchdSource,
      reachabilitySource,
      automationsSnapshot: () => sibling(() => automationSource.snapshot()),
      // usageService is declared by the usage area further down; read lazily.
      usageSummary: () => usageFromSibling(sibling(() => usageService)),
      now,
    }));
    return { overviewService, sources: { ...sourcesByName, loops: loopsSource, launchd: launchdSource, reachability: reachabilitySource } };
  })();
  // The existing mount line below keeps its text; it now gets the
  // memory-only overview service.
  function buildOperationsRouter(options) {
    return require('./routes/operations').buildOperationsRouter({ ...options, operationsOverviewService: attentionArea.overviewService });
  }
  // --- end attention area -------------------------------------------------
  const DECISION_LOG_PATH = path.join(projectRoot, 'data/decision-log.json');
  const OPS_EVENTS_PATH = path.join(projectRoot, 'data/ops-events.json');

  // --- routes ------------------------------------------------------------
  let usageExec = null;
  const healthPayload = () => buildHealthPayload({
    now,
    startedAtMs,
    loop,
    scheduler,
    exec,
    usageExec,
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
  // Standalone cron search page (public/cron-search.html), reads /api/cron.
  app.get('/cron-search', (req, res) => res.sendFile(path.join(config.paths.publicDir, 'cron-search.html')));
  app.use(buildAwsRouter({
    exec: execPromise,
    AWS_ACCESS_KEY_ID: config.aws.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.aws.secretAccessKey,
    AWS_REGION: config.aws.region,
    mcConfig,
  }));
  app.use(buildModelsRouter({}));
  // usage area: isolated provider lanes, scheduler reads, and pure legacy routes.
  const usageService = services.usageService || require('./sources/usage').createUsageService({
    exec: deps.exec,
    scheduler,
    projectRoot,
    dataDir: config.paths.dataDir,
    home: config.homeDir,
    budget: () => mcConfig.budget || {},
    now,
    logger,
  });
  const killUsageAndCore = exec.killAll.bind(exec);
  exec.killAll = () => { usageService.dispose?.(); killUsageAndCore(); };
  // The usage area may own a second runner: shutdown waits for it and
  // /api/health reports its quarantine too.
  usageExec = usageService.ownedExec || null;
  if (usageExec) {
    const drainCore = exec.drain.bind(exec);
    exec.drain = async (timeoutMs) => (await Promise.all([drainCore(timeoutMs), usageExec.drain(timeoutMs)])).every(Boolean);
  }
  app.use(buildCostsRouter({ usageService, now }));
  // end usage area

  app.use(buildSessionsRouter({ sessionsService }));
  app.use(buildSettingsRouter({ settingsService, projectRoot }));
  app.use(buildOllamaRouter({}));
  app.use(buildCouncilsRouter({
    readRuntimeSnapshot,
    writeRuntimeSnapshot,
    runtimeSnapshotTtl: RUNTIME_SNAPSHOT_TTL,
    decisionLogPath: DECISION_LOG_PATH,
    opsEventsPath: OPS_EVENTS_PATH,
    readJsonFileSafe,
    writeJsonFileAtomic,
  }));

  // Unknown /api/* is a JSON 404, never the SPA shell or an HTML page.
  app.use('/api', apiNotFound());

  // SPA catch-all: serve index.html for all non-API routes.
  // Express 5 uses path-to-regexp v8 and no longer accepts bare `*`.
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    // The regex is case-sensitive; /API/... and encoded variants are API too.
    if (isApiPath(req.originalUrl || req.url)) return apiNotFound()(req, res);
    return res.sendFile('index.html', { root: config.paths.frontendDist }, (error) => {
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
