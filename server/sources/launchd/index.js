'use strict';

// launchd services and reachability sources, both refreshed by the scheduler.
//
// launchd.services: `launchctl list` (read-only) parsed and filtered to the
// operator's agent stack. Each label is classified keepalive / interval /
// one-shot from its plist where readable. Only five keys are ever read, one
// at a time with `plutil -extract <key> xml1` (Label, KeepAlive,
// StartInterval, StartCalendarInterval, RunAtLoad); ProgramArguments and
// EnvironmentVariables are never read. Plist keys are cached by file
// mtime+size, so an unchanged plist is not re-read.
//
// services.reachability: OpenClaw gateway /health (same probe as the status
// reader), Hermes gateway liveness (hermesGatewayHealthService.getHealth, a
// file read) and Ollama /api/version. Network reads only, no process.
//
// Nothing here starts, stops, loads or kicks a service.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { createSource, SourceReadError } = require('../../core/source');

const LAUNCHD_SOURCE_ID = 'launchd.services';
const LAUNCHD_REFRESH_INTERVAL_MS = 15_000;
const REACHABILITY_SOURCE_ID = 'services.reachability';
const REACHABILITY_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_LABEL_PATTERNS = Object.freeze([
  'openclaw', 'hermes', 'gbrain', 'mission-control', 'ollama', 'mloop', 'jev', 'codex', 'claude',
]);
// Never shown, whatever the pattern list says.
const EXCLUDED_LABEL = /argus|trad(?:e|er|ing)\b|^application\./i;
const PLIST_KEYS = Object.freeze(['Label', 'KeepAlive', 'StartInterval', 'StartCalendarInterval', 'RunAtLoad']);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelMatcher(patterns = DEFAULT_LABEL_PATTERNS) {
  const list = (Array.isArray(patterns) ? patterns : String(patterns || '').split(','))
    .map((item) => String(item).trim())
    .filter((item) => /^[A-Za-z0-9._-]{1,64}$/.test(item));
  if (!list.length) throw new TypeError('launchd label patterns must name at least one valid label fragment');
  const regex = new RegExp(list.map(escapeRegex).join('|'), 'i');
  return (label) => regex.test(label) && !EXCLUDED_LABEL.test(label);
}

// `launchctl list`: "PID\tStatus\tLabel" rows. PID "-" = not running; Status
// is the last exit code (negative = killed by that signal), "-" = never ran.
function parseLaunchctlList(stdout) {
  const lines = String(stdout || '').split('\n').filter((line) => line.trim());
  if (!lines.length || !/^PID\s+Status\s+Label/i.test(lines[0])) {
    throw new SourceReadError('launchctl list output was not recognised', { code: 'launchctl_unparsable' });
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [pidText, statusText, label] = [parts[0].trim(), parts[1].trim(), parts.slice(2).join('\t').trim()];
    if (!label) continue;
    const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
    const lastExitCode = /^-?\d+$/.test(statusText) ? Number(statusText) : null;
    rows.push({ label, pid, lastExitCode });
  }
  return rows;
}

// Minimal reader for a `plutil -extract KEY xml1` document: one value only.
function parsePlistValue(xml) {
  const body = String(xml || '').replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, '').trim();
  const inner = body.replace(/^<plist[^>]*>/, '').replace(/<\/plist>$/, '').trim();
  if (/^<true\s*\/>$/.test(inner)) return true;
  if (/^<false\s*\/>$/.test(inner)) return false;
  let match = inner.match(/^<integer>(-?\d+)<\/integer>$/);
  if (match) return Number(match[1]);
  match = inner.match(/^<string>([^<]*)<\/string>$/);
  if (match) return match[1];
  if (/^<dict\s*\/>$/.test(inner) || /^<dict>/.test(inner)) return { kind: 'dict' };
  if (/^<array\s*\/>$/.test(inner) || /^<array>/.test(inner)) return { kind: 'array' };
  return undefined;
}

function classify(keys) {
  if (!keys) return null;
  const keepAlive = keys.KeepAlive;
  if (keepAlive === true || (keepAlive && typeof keepAlive === 'object')) return 'keepalive';
  if (Number.isInteger(keys.StartInterval) || keys.StartCalendarInterval !== undefined) return 'interval';
  return 'one-shot';
}

function deriveState({ pid, lastExitCode, kind }) {
  if (pid != null) return 'running';
  if (kind === 'keepalive') return 'down';
  if (lastExitCode != null && lastExitCode !== 0) return 'failed';
  return 'idle';
}

function createLaunchdReader({
  exec,
  homeDir = process.env.MC_USER_HOME || process.env.HOME || os.homedir(),
  plistDirs,
  labelPatterns = DEFAULT_LABEL_PATTERNS,
  fsImpl = fsp,
  launchctlBin = '/bin/launchctl',
  plutilBin = '/usr/bin/plutil',
} = {}) {
  if (typeof exec?.run !== 'function') throw new TypeError('createLaunchdReader: exec.run required');
  const matches = labelMatcher(labelPatterns);
  const dirs = plistDirs || [
    path.join(homeDir, 'Library', 'LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
  ];
  const plistCache = new Map(); // path -> { stamp, keys }

  async function findPlist(label) {
    for (const dir of dirs) {
      const file = path.join(dir, `${label}.plist`);
      try {
        const stat = await fsImpl.stat(file);
        if (stat.isFile()) return { file, stamp: `${stat.mtimeMs}:${stat.size}` };
      } catch {}
    }
    return null;
  }

  async function readPlistKeys(label) {
    const found = await findPlist(label);
    if (!found) return { plist: 'not-found', keys: null };
    const cached = plistCache.get(found.file);
    if (cached && cached.stamp === found.stamp) return { plist: 'read', keys: cached.keys };
    const keys = {};
    for (const key of PLIST_KEYS) {
      const result = await exec.run(plutilBin, ['-extract', key, 'xml1', '-o', '-', '--', found.file], {
        lane: 'default', timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
      });
      if (result.ok) {
        const value = parsePlistValue(result.stdout);
        if (value !== undefined) keys[key] = value;
        continue;
      }
      // A missing key is an answer; anything else means the plist was not read.
      if (/No value at that key path/i.test(`${result.stdout}\n${result.stderr}`)) continue;
      return { plist: 'unreadable', keys: null };
    }
    plistCache.set(found.file, { stamp: found.stamp, keys });
    return { plist: 'read', keys };
  }

  async function read() {
    const result = await exec.run(launchctlBin, ['list'], { lane: 'default', timeoutMs: 5_000, key: 'launchctl list' });
    if (!result.ok) {
      throw new SourceReadError('launchctl list failed', { code: result.timedOut ? 'launchctl_timeout' : 'launchctl_failed' });
    }
    const rows = parseLaunchctlList(result.stdout).filter((row) => matches(row.label));
    const services = [];
    for (const row of rows.sort((a, b) => a.label.localeCompare(b.label))) {
      const { plist, keys } = await readPlistKeys(row.label);
      const kind = classify(keys);
      services.push({
        label: row.label,
        kind,
        pid: row.pid,
        lastExitCode: row.lastExitCode,
        state: deriveState({ ...row, kind }),
        runAtLoad: keys ? keys.RunAtLoad === true : null,
        intervalSeconds: keys && Number.isInteger(keys.StartInterval) ? keys.StartInterval : null,
        calendar: keys ? keys.StartCalendarInterval !== undefined : null,
        plist,
      });
    }
    const counts = { total: services.length, running: 0, idle: 0, down: 0, failed: 0 };
    for (const service of services) counts[service.state] += 1;
    return { services, counts };
  }

  return { read };
}

function createLaunchdSource({ exec, now = Date.now, logger = null, reader, ...options } = {}) {
  const launchd = reader || createLaunchdReader({ exec, ...options });
  return createSource({
    id: LAUNCHD_SOURCE_ID,
    read: () => launchd.read(),
    ttlMs: LAUNCHD_REFRESH_INTERVAL_MS,
    // First read may extract keys from ~20 plists; later reads hit the cache.
    timeoutMs: 60_000,
    staleAfterMs: 2 * 60_000,
    now,
    logger,
  });
}

// --- reachability --------------------------------------------------------

async function probeHttp(fetchImpl, url, { timeoutMs = 1_500, now = Date.now } = {}) {
  const startedAt = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
    try { await response.body?.cancel?.(); } catch {}
    return { reachable: Boolean(response.ok), httpStatus: response.status, latencyMs: now() - startedAt, error: response.ok ? null : 'http_error' };
  } catch (error) {
    const code = error?.cause?.code || error?.code || (error?.name === 'AbortError' ? 'timeout' : 'fetch_failed');
    // Connection refused is a definite "not listening"; a timeout is unknown.
    const refused = code === 'ECONNREFUSED';
    return { reachable: refused ? false : null, httpStatus: null, latencyMs: now() - startedAt, error: String(code).slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

function endpointState(probe) {
  if (probe.reachable === true) return 'up';
  if (probe.reachable === false) return 'down';
  return 'unknown';
}

function createReachabilityReader({
  fetchImpl = (...args) => fetch(...args),
  openclawGatewayPort,
  hermesGatewayHealthService,
  ollamaBaseUrl = 'http://127.0.0.1:11434',
  now = Date.now,
} = {}) {
  async function read() {
    const observedAt = () => new Date(now()).toISOString();
    const [openclaw, ollama, hermes] = await Promise.all([
      Number(openclawGatewayPort) > 0
        ? probeHttp(fetchImpl, `http://127.0.0.1:${Number(openclawGatewayPort)}/health`, { now })
        : Promise.resolve({ reachable: null, httpStatus: null, latencyMs: null, error: 'no_port' }),
      probeHttp(fetchImpl, `${String(ollamaBaseUrl).replace(/\/$/, '')}/api/version`, { now }),
      Promise.resolve()
        .then(() => hermesGatewayHealthService?.getHealth?.())
        .catch(() => null),
    ]);
    const hermesStatus = hermes && hermes.ok !== false && ['running', 'stale', 'down'].includes(hermes.status) ? hermes.status : null;
    const gateways = {
      openclaw: { state: endpointState(openclaw), ...openclaw, observedAt: observedAt() },
      hermes: {
        state: hermesStatus === 'running' ? 'up' : hermesStatus === 'down' ? 'down' : hermesStatus === 'stale' ? 'stale' : 'unknown',
        reachable: hermesStatus === 'running' ? true : hermesStatus === 'down' ? false : null,
        heartbeatAt: typeof hermes?.heartbeatAt === 'string' ? hermes.heartbeatAt : null,
        error: hermesStatus ? null : 'hermes_gateway_unreadable',
        observedAt: typeof hermes?.observedAt === 'string' ? hermes.observedAt : observedAt(),
      },
    };
    const ollamaState = { state: endpointState(ollama), ...ollama, observedAt: observedAt() };
    const observed = [gateways.openclaw.state, gateways.hermes.state, ollamaState.state];
    if (observed.every((state) => state === 'unknown')) {
      throw new SourceReadError('No service endpoint could be observed', { code: 'reachability_unobserved' });
    }
    return { gateways, ollama: ollamaState };
  }
  return { read };
}

function createReachabilitySource({ now = Date.now, logger = null, reader, ...options } = {}) {
  const reachability = reader || createReachabilityReader({ now, ...options });
  return createSource({
    id: REACHABILITY_SOURCE_ID,
    read: () => reachability.read(),
    ttlMs: REACHABILITY_REFRESH_INTERVAL_MS,
    timeoutMs: 10_000,
    staleAfterMs: 2 * 60_000,
    now,
    logger,
  });
}

module.exports = {
  DEFAULT_LABEL_PATTERNS,
  LAUNCHD_SOURCE_ID,
  LAUNCHD_REFRESH_INTERVAL_MS,
  REACHABILITY_SOURCE_ID,
  REACHABILITY_REFRESH_INTERVAL_MS,
  classify,
  createLaunchdReader,
  createLaunchdSource,
  createReachabilityReader,
  createReachabilitySource,
  deriveState,
  labelMatcher,
  parseLaunchctlList,
  parsePlistValue,
};
