'use strict';

// Event-loop lag and the /api/health payload.

const { monitorEventLoopDelay } = require('perf_hooks');

function createEventLoopMonitor({ resolutionMs = 20 } = {}) {
  let histogram = null;
  function start() {
    if (histogram) return;
    histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    histogram.enable();
  }
  function stop() {
    if (!histogram) return;
    histogram.disable();
    histogram = null;
  }
  // Delay figures are in nanoseconds; the resolution is subtracted so an idle
  // loop reads near zero.
  function read() {
    if (!histogram || histogram.count === 0) return { enabled: Boolean(histogram), meanMs: null, p99Ms: null, maxMs: null };
    const toMs = (ns) => Math.max(0, Math.round((ns / 1e6 - resolutionMs) * 10) / 10);
    return {
      enabled: true,
      meanMs: toMs(histogram.mean),
      p99Ms: toMs(histogram.percentile(99)),
      maxMs: toMs(histogram.max),
    };
  }
  // Rolling window: reset after each read so the figures cover the time
  // since the previous health call.
  function readAndReset() {
    const value = read();
    histogram?.reset();
    return value;
  }
  return { start, stop, read, readAndReset };
}

function buildHealthPayload({ now = Date.now, startedAtMs, loop, scheduler, exec, usageExec = null, config, guard }) {
  const nowMs = now();
  const execStatus = exec ? exec.status() : null;
  // A quarantined lane (a command whose exit could not be verified) is a
  // degraded service, not a healthy one.
  const usageExecStatus = usageExec?.status?.() || null;
  const degraded = Boolean(execStatus?.quarantined?.length || usageExecStatus?.quarantined?.length);
  return {
    ok: !degraded,
    status: degraded ? 'degraded' : 'ok',
    service: 'mission-control',
    generatedAt: new Date(nowMs).toISOString(),
    uptimeMs: startedAtMs == null ? null : nowMs - startedAtMs,
    eventLoop: loop ? loop.readAndReset() : null,
    scheduler: scheduler ? scheduler.status() : null,
    exec: execStatus,
    usageExec: usageExecStatus,
    config: config
      ? {
        source: config.load?.source || null,
        problems: config.load?.problems || [],
        gatewayToken: config.gatewayTokenCheck
          ? { state: config.gatewayTokenCheck.state, ok: config.gatewayTokenCheck.ok, message: config.gatewayTokenCheck.message }
          : null,
      }
      : null,
    guard: guard ? guard.status() : null,
  };
}

module.exports = { createEventLoopMonitor, buildHealthPayload };
