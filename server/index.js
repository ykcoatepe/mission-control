'use strict';

// Process entry: load config, build the app, listen, shut down cleanly.
// server.js (the LaunchAgent's `node server.js`) only calls start().

const path = require('path');
const { loadConfig, publicView } = require('./core/config');
const { createApp } = require('./app');

const SHUTDOWN_GRACE_MS = 5_000;

function start({ rootDir = path.join(__dirname, '..'), logger = console } = {}) {
  const config = loadConfig({ rootDir });
  for (const problem of config.load.problems) logger.warn(`[config] ${problem}`);
  if (!config.gatewayTokenCheck.ok) {
    logger.error(`[startup] gateway token validation failed: ${config.gatewayTokenCheck.message}`);
  } else if (config.gatewayTokenCheck.state === 'skipped') {
    logger.warn(`[startup] ${config.gatewayTokenCheck.message}`);
  }
  if (config.guard.writeGuardMode !== 'enforce') {
    logger.warn('[guard] write guard in report-only mode: mutating /api requests without X-MC-Request: 1 are logged, not rejected');
  }

  const app = createApp({ config, logger });
  const runtime = app.locals.runtime;
  const { port, host } = config.server;

  const server = app.listen(port, host);
  let shuttingDown = false;

  function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] ${reason}: stopping scheduler, killing children, closing server`);
    try {
      runtime.dispose();
    } catch (error) {
      logger.error('[shutdown] dispose failed:', error?.message || error);
    }
    const force = setTimeout(() => {
      logger.warn('[shutdown] grace period over; closing remaining connections');
      server.closeAllConnections?.();
      process.exit(exitCode);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    // Exit only after the runner has seen every child gone (TERM, then KILL),
    // so a child that ignores SIGTERM is not left orphaned.
    const childrenGone = Promise.resolve(runtime.exec?.drain?.()).catch(() => false);
    server.close(() => {
      childrenGone.then((clean) => {
        if (clean === false) logger.warn('[shutdown] some children could not be verified as exited');
        process.exit(exitCode);
      });
    });
    server.closeIdleConnections?.();
  }

  server.on('error', (error) => {
    logger.error(`[startup] cannot listen on ${host}:${port}: ${error?.code || ''} ${error?.message || error}`);
    shutdown('listen error', 1);
  });

  server.on('listening', async () => {
    const address = server.address();
    runtime.setBoundPort(address?.port ?? port);
    logger.log(`🚀 Mission Control running at http://${host === '127.0.0.1' ? 'localhost' : host}:${address?.port ?? port}`);
    logger.log(`[config] ${JSON.stringify({ source: config.load.source, server: publicView(config).server, writeGuard: config.guard.writeGuardMode })}`);
    runtime.start();

    // Warm the heavy caches once, as before (self-requests, so the guard sees
    // a loopback Host).
    setTimeout(async () => {
      const base = `http://127.0.0.1:${address?.port ?? port}`;
      try {
        const response = await fetch(`${base}/api/costs`);
        if (response.ok) logger.log('[Startup] Pre-warmed costs cache');
      } catch {}
    }, 3000).unref();
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('[unhandledRejection]', reason?.stack || reason);
  });

  return { app, server, shutdown };
}

module.exports = { start };
