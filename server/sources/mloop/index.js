'use strict';

// Manager-loop ledger source (`mloop`, ~/bin/mloop).
//
// One scheduled read (about every 60 s) runs only read-only mloop commands
// through the core exec runner:
//   mloop check --all-projects --json            findings across every project
//   mloop --project P --json status              status markdown (rendered text)
//   mloop --project P --json teyit list          pending live confirmations
//   mloop --project P --json participants        bound participants
// Projects are the ledger directories that hold an events.jsonl.
//
// Argus rule (hard boundary): a project whose id or title matches /argus/i is
// "restricted". For it no per-project command ever runs and no file under its
// directory is read or stat'ed; only counts derived from the all-projects
// check are kept (open findings, confirmation findings, overdue). Its finding
// subjects, details and codes never enter memory beyond the counting loop.
//
// Every field is whitelisted. mloop exits non-zero with a {code,message} body
// on errors; rc=0 with such a body is treated as an error too.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { createSource, SourceReadError } = require('../../core/source');

const MLOOP_SOURCE_ID = 'mloop.loops';
const MLOOP_REFRESH_INTERVAL_MS = 60_000;
const RESTRICTED_PATTERN = /argus/i;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
// Findings that stand for a pending live confirmation (counted for restricted
// projects, where the TEYİT ledger itself is never read).
const CONFIRMATION_CODES = new Set([
  'TEYIT_DUE', 'TEYIT_STALE', 'TEYIT_UNRESOLVED', 'DEPLOYED_UNCONFIRMED', 'ACCEPTED_NOT_LIVE',
]);
// TEYIT_STALE = deadline passed (aggregated rows carry `count`).
const OVERDUE_CODES = new Set(['TEYIT_STALE']);
const PARTICIPANT_DEAD_CODES = new Set(['BINDING_DEAD', 'MANAGER_SILENT']);
const MAX_TEXT = 300;
const MAX_STATUS_CHARS = 16_000;

function isRestrictedText(value) {
  return typeof value === 'string' && RESTRICTED_PATTERN.test(value);
}

function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function isoOrNull(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readError(code, message) {
  return new SourceReadError(message, { code });
}

// Parse one mloop --json result. Throws on a non-zero exit, unparsable
// output, or an rc=0 {code,message} error body.
function parseMloopJson(result, what) {
  if (!result || typeof result !== 'object') throw readError('mloop_unavailable', `mloop ${what} did not run`);
  if (!result.ok) {
    let code = result.timedOut ? 'mloop_timeout' : 'mloop_failed';
    for (const text of [result.stderr, result.stdout]) {
      try {
        const body = JSON.parse(String(text || '').trim());
        if (body && typeof body.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(body.code)) code = `mloop_${body.code.toLowerCase()}`;
        break;
      } catch {}
    }
    throw readError(code, `mloop ${what} failed`);
  }
  let body;
  try {
    body = JSON.parse(String(result.stdout || '').trim());
  } catch {
    throw readError('mloop_unparsable', `mloop ${what} returned non-JSON output`);
  }
  if (body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.code === 'string' && typeof body.message === 'string') {
    throw readError('mloop_error_body', `mloop ${what} returned an error body`);
  }
  return body;
}

function findingCount(row) {
  return Number.isInteger(row?.count) && row.count > 0 ? row.count : 1;
}

function emptyCounts() {
  return { total: 0, bySeverity: { error: 0, warning: 0, info: 0 }, byCode: {} };
}

// Split the all-projects check into per-project buckets. Restricted projects
// keep counts only; everything else keeps whitelisted rows.
function groupFindings(rows) {
  if (!Array.isArray(rows)) throw readError('mloop_unparsable', 'mloop check did not return a list');
  const open = new Map();
  const restricted = new Map();
  for (const row of rows) {
    const project = typeof row?.project === 'string' ? row.project : null;
    if (!project || !PROJECT_ID_PATTERN.test(project)) continue;
    const severity = SEVERITY_RANK[row.severity] ? row.severity : 'warning';
    if (isRestrictedText(project)) {
      const counts = restricted.get(project) || { openFindings: 0, pendingConfirmations: 0, overdue: 0, worst: null };
      counts.openFindings += 1;
      if (CONFIRMATION_CODES.has(row.code)) counts.pendingConfirmations += findingCount(row);
      if (OVERDUE_CODES.has(row.code)) counts.overdue += findingCount(row);
      if (!counts.worst || SEVERITY_RANK[severity] > SEVERITY_RANK[counts.worst]) counts.worst = severity;
      restricted.set(project, counts);
      continue;
    }
    const list = open.get(project) || [];
    list.push({
      code: typeof row.code === 'string' ? row.code.slice(0, 64) : 'UNKNOWN',
      subject: cleanText(row.subject, 160),
      severity,
      detail: cleanText(row.detail, MAX_TEXT),
      at: isoOrNull(row.ts),
      ...(Number.isInteger(row.count) ? { count: row.count } : {}),
    });
    open.set(project, list);
  }
  return { open, restricted };
}

function countFindings(findings) {
  const counts = emptyCounts();
  for (const finding of findings) {
    counts.total += 1;
    counts.bySeverity[finding.severity] += 1;
    counts.byCode[finding.code] = (counts.byCode[finding.code] || 0) + 1;
  }
  return counts;
}

function parseStatusMarkdown(text) {
  if (typeof text !== 'string') return { title: null, outcome: null, markdown: null };
  const lines = text.split('\n');
  const heading = lines.find((line) => /^#\s+\S/.test(line));
  const outcome = lines.find((line) => /^Outcome:\s*\S/.test(line));
  const markdown = text.length > MAX_STATUS_CHARS ? `${text.slice(0, MAX_STATUS_CHARS)}\n…(truncated)` : text;
  return {
    title: heading ? cleanText(heading.replace(/^#\s+/, '').trim(), 160) : null,
    outcome: outcome ? cleanText(outcome.replace(/^Outcome:\s*/, '').trim(), MAX_TEXT) : null,
    markdown: cleanText(markdown, MAX_STATUS_CHARS + 20),
  };
}

function pendingFromTeyit(rows, nowMs) {
  if (!Array.isArray(rows)) throw readError('mloop_unparsable', 'teyit list did not return a list');
  return rows
    .filter((row) => row && row.closed !== true && (row.state === 'open' || row.state === 'unresolved'))
    .map((row) => {
      const deadline = isoOrNull(row.deadline);
      return {
        id: typeof row.id === 'string' ? row.id.slice(0, 120) : null,
        unit: cleanText(row.unit),
        verification: cleanText(row.how),
        deadline,
        overdue: deadline ? Date.parse(deadline) < nowMs : false,
        state: row.state,
        kind: typeof row.kind === 'string' ? row.kind.slice(0, 40) : null,
        dependsOn: typeof row.depends_on === 'string' ? row.depends_on.slice(0, 120) : null,
      };
    })
    .sort((a, b) => (Number(b.overdue) - Number(a.overdue))
      || ((a.deadline ? Date.parse(a.deadline) : Infinity) - (b.deadline ? Date.parse(b.deadline) : Infinity)));
}

function participantsFrom(rows, findings) {
  if (!Array.isArray(rows)) throw readError('mloop_unparsable', 'participants did not return a list');
  const dead = new Set(findings.filter((f) => PARTICIPANT_DEAD_CODES.has(f.code)).map((f) => f.subject));
  return rows
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => ({
      name: row.name.slice(0, 80),
      role: typeof row.role === 'string' ? row.role.slice(0, 20) : null,
      host: typeof row.host === 'string' ? row.host.slice(0, 20) : null,
      alive: !dead.has(row.name),
    }));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function restrictedProject(id, counts = {}) {
  return {
    id,
    restricted: true,
    openFindings: counts.openFindings || 0,
    pendingConfirmations: counts.pendingConfirmations || 0,
    overdueConfirmations: counts.overdue || 0,
    countsBasis: 'mloop-check',
  };
}

// Ranked attention across projects: error > warning > info, then the
// longest-waiting first. Restricted projects contribute one count-only row.
function rankAttention(projects, restrictedCounts) {
  const items = [];
  for (const project of projects) {
    if (project.restricted) continue;
    for (const finding of project.findings) {
      items.push({
        project: project.id,
        kind: 'finding',
        severity: finding.severity,
        code: finding.code,
        subject: finding.subject,
        detail: finding.detail,
        at: finding.at,
        ...(finding.count != null ? { count: finding.count } : {}),
      });
    }
  }
  for (const [id, counts] of restrictedCounts) {
    if (!counts.openFindings) continue;
    items.push({ project: id, kind: 'restricted', restricted: true, severity: counts.worst || 'warning', count: counts.openFindings });
  }
  return items.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || ((a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity))
    || a.project.localeCompare(b.project)
    || String(a.code || '').localeCompare(String(b.code || '')));
}

function createMloopReader({
  exec,
  bin = path.join(process.env.MC_USER_HOME || process.env.HOME || os.homedir(), 'bin', 'mloop'),
  ledgerDir = process.env.MLOOP_HOME || path.join(process.env.MC_USER_HOME || process.env.HOME || os.homedir(), '.local', 'state', 'mloop'),
  fsImpl = fsp,
  now = Date.now,
  checkTimeoutMs = 30_000,
  callTimeoutMs = 15_000,
  concurrency = 2,
} = {}) {
  if (typeof exec?.run !== 'function') throw new TypeError('createMloopReader: exec.run required');

  const run = (args, timeoutMs) => exec.run(bin, args, {
    lane: 'default',
    timeoutMs,
    key: `mloop ${args.join(' ')}`,
    maxOutputBytes: 4 * 1024 * 1024,
  });

  async function listProjectIds() {
    let entries;
    try {
      entries = await fsImpl.readdir(ledgerDir, { withFileTypes: true });
    } catch {
      throw readError('mloop_ledger_unreadable', 'mloop ledger directory could not be listed');
    }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
      if (isRestrictedText(entry.name)) {
        // Restricted: listed by name only, nothing inside it is touched.
        ids.push(entry.name);
        continue;
      }
      try {
        const stat = await fsImpl.stat(path.join(ledgerDir, entry.name, 'events.jsonl'));
        if (stat.isFile()) ids.push(entry.name);
      } catch {}
    }
    return ids;
  }

  async function readProject(id, findings) {
    const errors = [];
    const attempt = async (part, args, parse) => {
      try {
        return parse(parseMloopJson(await run(['--project', id, '--json', ...args], callTimeoutMs), part));
      } catch (error) {
        errors.push({ part, code: typeof error?.code === 'string' ? error.code : 'mloop_failed' });
        return null;
      }
    };
    let lastActivityAt = null;
    try {
      const stat = await fsImpl.stat(path.join(ledgerDir, id, 'events.jsonl'));
      lastActivityAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      errors.push({ part: 'ledger', code: 'mloop_ledger_unreadable' });
    }
    const status = await attempt('status', ['status'], (body) => {
      if (typeof body !== 'string') throw readError('mloop_unparsable', 'status is not text');
      return parseStatusMarkdown(body);
    });
    if (status && (isRestrictedText(status.title) || isRestrictedText(status.outcome))) {
      return { restrictedByTitle: true };
    }
    const nowMs = now();
    const pendingConfirmations = await attempt('teyit', ['teyit', 'list'], (body) => pendingFromTeyit(body, nowMs));
    const participants = await attempt('participants', ['participants'], (body) => participantsFrom(body, findings));
    return {
      id,
      restricted: false,
      title: status?.title ?? null,
      outcome: status?.outcome ?? null,
      openFindings: countFindings(findings),
      pendingConfirmations,
      participants,
      lastActivityAt,
      statusMarkdown: status?.markdown ?? null,
      findings,
      errors,
    };
  }

  async function read() {
    const checkRows = parseMloopJson(await run(['check', '--all-projects', '--json'], checkTimeoutMs), 'check');
    const { open, restricted } = groupFindings(checkRows);
    const ids = new Set(await listProjectIds());
    for (const id of open.keys()) ids.add(id);
    for (const id of restricted.keys()) ids.add(id);
    const sorted = [...ids].sort();
    const projects = await mapLimit(sorted, concurrency, async (id) => {
      if (isRestrictedText(id)) return restrictedProject(id, restricted.get(id));
      const project = await readProject(id, open.get(id) || []);
      if (project.restrictedByTitle) {
        const findings = open.get(id) || [];
        const counts = {
          openFindings: findings.length,
          pendingConfirmations: findings.filter((f) => CONFIRMATION_CODES.has(f.code)).reduce((n, f) => n + (f.count || 1), 0),
          overdue: findings.filter((f) => OVERDUE_CODES.has(f.code)).reduce((n, f) => n + (f.count || 1), 0),
          worst: findings.reduce((w, f) => (!w || SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), null),
        };
        restricted.set(id, counts);
        return restrictedProject(id, counts);
      }
      return project;
    });
    const restrictedCounts = new Map(projects.filter((p) => p.restricted).map((p) => [p.id, {
      openFindings: p.openFindings,
      worst: restricted.get(p.id)?.worst || 'warning',
    }]));
    return {
      observedAt: new Date(now()).toISOString(),
      projects,
      attention: rankAttention(projects, restrictedCounts),
    };
  }

  return { read, listProjectIds };
}

function createMloopSource({ exec, now = Date.now, logger = null, reader, ...options } = {}) {
  const mloop = reader || createMloopReader({ exec, now, ...options });
  return createSource({
    id: MLOOP_SOURCE_ID,
    read: () => mloop.read(),
    ttlMs: MLOOP_REFRESH_INTERVAL_MS,
    timeoutMs: 120_000,
    staleAfterMs: 5 * 60_000,
    now,
    logger,
  });
}

// --- views (pure, used by the routes) ------------------------------------

function projectSummary(project) {
  if (project.restricted) return { ...project };
  return {
    id: project.id,
    restricted: false,
    title: project.title,
    outcome: project.outcome,
    openFindings: project.openFindings,
    pendingConfirmations: project.pendingConfirmations,
    participants: project.participants,
    lastActivityAt: project.lastActivityAt,
    errors: project.errors,
  };
}

function loopsView(data) {
  if (!data) return null;
  const projects = data.projects.map(projectSummary);
  const totals = { projects: projects.length, openFindings: 0, pendingConfirmations: 0, overdueConfirmations: 0 };
  for (const project of projects) {
    if (project.restricted) {
      totals.openFindings += project.openFindings;
      totals.pendingConfirmations += project.pendingConfirmations;
      totals.overdueConfirmations += project.overdueConfirmations;
    } else {
      totals.openFindings += project.openFindings.total;
      totals.pendingConfirmations += project.pendingConfirmations?.length || 0;
      totals.overdueConfirmations += project.pendingConfirmations?.filter((item) => item.overdue).length || 0;
    }
  }
  return { observedAt: data.observedAt, totals, projects, attention: data.attention };
}

function loopDetailView(data, id) {
  if (!data) return null;
  const project = data.projects.find((entry) => entry.id === id);
  if (!project) return undefined;
  if (project.restricted) return { ...project };
  return { ...projectSummary(project), findings: project.findings, statusMarkdown: project.statusMarkdown };
}

module.exports = {
  MLOOP_SOURCE_ID,
  MLOOP_REFRESH_INTERVAL_MS,
  PROJECT_ID_PATTERN,
  RESTRICTED_PATTERN,
  createMloopReader,
  createMloopSource,
  loopsView,
  loopDetailView,
  parseMloopJson,
};
