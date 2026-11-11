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
// Argus rule (hard boundary, ./restricted.js): a project is "restricted" when
// the marker appears anywhere in its COMPLETE RAW material, classified before
// any scrub, truncation or whitelist: its id, its check rows (every field),
// its status text (heading, outcome, body), its confirmation rows and its
// participants. Classification fails closed: when a part it needs cannot be
// read or parsed the project is restricted too (restrictedBy: 'unverified').
// A restricted project keeps its id and counts only. When the id or the check
// rows already carry the marker no per-project command runs and no file under
// its directory is touched; otherwise reading stops at the first part that
// carries it. Its text never enters memory beyond the classifying loop.
//
// A mention of the marker in another project's text cannot be told apart from
// restricted content quoted there, so that project is restricted as well.
//
// Every field is whitelisted. mloop exits non-zero with a {code,message} body
// on errors; rc=0 with such a body is treated as an error too.

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { createSource, SourceReadError } = require('../../core/source');
const { scrubText } = require('../../core/scrub');
const { CONFIRMATION_CODES, OVERDUE_CODES, projectNeeds, needsOperator } = require('./attention');
const { RESTRICTED_MARKERS, containsRestrictedMarker } = require('./restricted');

const MLOOP_SOURCE_ID = 'mloop.loops';
const MLOOP_REFRESH_INTERVAL_MS = 60_000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SEVERITY_RANK = { error: 3, warning: 2, info: 1 };
const PARTICIPANT_DEAD_CODES = new Set(['BINDING_DEAD', 'MANAGER_SILENT']);
const MAX_TEXT = 300;
const MAX_STATUS_CHARS = 16_000;
// A finding's full detail is kept (hard cap only against a runaway row); the
// bounded `summary` is what a list shows.
const MAX_DETAIL = 4_000;
const MAX_SUMMARY = 160;

// Credentials and home paths through the one sanitizer (server/core/scrub.js).
function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const cleaned = scrubText(value);
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

// First line, cut at a word boundary to at most MAX_SUMMARY characters.
function summaryOf(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n')[0].trim();
  if (line.length <= MAX_SUMMARY) return line;
  const cut = line.slice(0, MAX_SUMMARY - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_SUMMARY / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
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

function severityOf(value) {
  return SEVERITY_RANK[value] ? value : 'warning';
}

function worseSeverity(a, b) {
  if (!a) return b;
  return SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

// Counts only, from a restricted project's raw check rows. Subjects are used
// for confirmation identity inside this function and never kept.
function restrictedCountsFrom(rows) {
  const counts = { openFindings: 0, pendingConfirmations: 0, overdue: 0, worst: null, operatorWorst: null };
  const findings = [];
  for (const row of rows) {
    const severity = severityOf(row.severity);
    const code = typeof row.code === 'string' ? row.code : 'UNKNOWN';
    counts.openFindings += 1;
    if (CONFIRMATION_CODES.has(code)) counts.pendingConfirmations += findingCount(row);
    if (OVERDUE_CODES.has(code)) counts.overdue += findingCount(row);
    counts.worst = worseSeverity(counts.worst, severity);
    if (severity !== 'info') counts.operatorWorst = worseSeverity(counts.operatorWorst, severity);
    findings.push({ code, severity, subject: typeof row.subject === 'string' ? row.subject : null, count: row.count });
  }
  const needs = projectNeeds(findings, undefined);
  return { ...counts, operatorFindings: needs.findings, operatorConfirmations: needs.confirmations };
}

function emptyCounts() {
  return { total: 0, bySeverity: { error: 0, warning: 0, info: 0 }, byCode: {} };
}

// Split the all-projects check into per-project RAW row lists (classified
// before anything is cleaned).
function groupRawRows(rows) {
  if (!Array.isArray(rows)) throw readError('mloop_unparsable', 'mloop check did not return a list');
  const byProject = new Map();
  for (const row of rows) {
    const project = typeof row?.project === 'string' ? row.project : null;
    if (!project || !PROJECT_ID_PATTERN.test(project)) continue;
    const list = byProject.get(project) || [];
    list.push(row);
    byProject.set(project, list);
  }
  return byProject;
}

// Presentation of an unrestricted project's rows: whitelisted and scrubbed.
function cleanFindings(rows) {
  return rows.map((row) => {
    const detail = cleanText(row.detail, MAX_DETAIL);
    return {
      code: typeof row.code === 'string' ? row.code.slice(0, 64) : 'UNKNOWN',
      subject: cleanText(row.subject, 160),
      severity: severityOf(row.severity),
      detail,
      summary: summaryOf(detail),
      at: isoOrNull(row.ts),
      ...(Number.isInteger(row.count) ? { count: row.count } : {}),
    };
  });
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

// restrictedBy: 'marker' (the marker is in its material) or 'unverified' (a
// part needed to classify it could not be read; `errors` names which).
function restrictedProject(id, counts, restrictedBy, errors = null) {
  return {
    id,
    restricted: true,
    restrictedBy,
    openFindings: counts.openFindings,
    pendingConfirmations: counts.pendingConfirmations,
    overdueConfirmations: counts.overdue,
    operatorFindings: counts.operatorFindings,
    operatorConfirmations: counts.operatorConfirmations,
    worstSeverity: counts.operatorWorst,
    countsBasis: 'mloop-check',
    ...(errors ? { errors } : {}),
  };
}

// Ranked attention across projects: error > warning > info, then the
// longest-waiting first. Restricted projects contribute one count-only row.
function rankAttention(projects, restrictedWorst) {
  const items = [];
  for (const project of projects) {
    if (project.restricted) {
      if (project.openFindings) {
        items.push({ project: project.id, kind: 'restricted', restricted: true, severity: restrictedWorst.get(project.id) || 'warning', count: project.openFindings });
      }
      continue;
    }
    for (const finding of project.findings) {
      items.push({
        project: project.id,
        kind: 'finding',
        severity: finding.severity,
        code: finding.code,
        subject: finding.subject,
        detail: finding.detail,
        summary: finding.summary,
        at: finding.at,
        ...(finding.count != null ? { count: finding.count } : {}),
      });
    }
  }
  return items.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || ((a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity))
    || a.project.localeCompare(b.project)
    || String(a.code || '').localeCompare(String(b.code || '')));
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'mloop_failed';
  return containsRestrictedMarker(code) ? 'mloop_failed' : code;
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
      if (containsRestrictedMarker(entry.name)) {
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

  // Reads the raw parts one by one and classifies each before the next is
  // read. Returns { restrictedBy, errors } or { raw: {status, teyit,
  // participants}, errors }.
  async function readRaw(id) {
    const errors = [];
    const parts = [
      ['status', ['status'], (body) => typeof body === 'string'],
      ['teyit', ['teyit', 'list'], Array.isArray],
      ['participants', ['participants'], Array.isArray],
    ];
    const raw = {};
    for (const [part, args, valid] of parts) {
      let body;
      try {
        body = parseMloopJson(await run(['--project', id, '--json', ...args], callTimeoutMs), part);
        if (!valid(body)) throw readError('mloop_unparsable', `mloop ${part} has an unexpected shape`);
      } catch (error) {
        errors.push({ part, code: errorCode(error) });
        return { restrictedBy: 'unverified', errors };
      }
      if (containsRestrictedMarker(body)) return { restrictedBy: 'marker', errors: null };
      raw[part] = body;
    }
    return { raw, errors };
  }

  async function readProject(id, rows) {
    const read = await readRaw(id);
    if (read.restrictedBy) return { restrictedBy: read.restrictedBy, errors: read.errors };
    const { errors } = read;
    let lastActivityAt = null;
    try {
      const stat = await fsImpl.stat(path.join(ledgerDir, id, 'events.jsonl'));
      lastActivityAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      errors.push({ part: 'ledger', code: 'mloop_ledger_unreadable' });
    }
    // Presentation transforms only after classification.
    const findings = cleanFindings(rows);
    const status = parseStatusMarkdown(read.raw.status);
    return {
      id,
      restricted: false,
      title: status.title,
      outcome: status.outcome,
      openFindings: countFindings(findings),
      pendingConfirmations: pendingFromTeyit(read.raw.teyit, now()),
      participants: participantsFrom(read.raw.participants, findings),
      lastActivityAt,
      statusMarkdown: status.markdown,
      findings,
      errors,
    };
  }

  async function read() {
    const checkRows = parseMloopJson(await run(['check', '--all-projects', '--json'], checkTimeoutMs), 'check');
    const rowsByProject = groupRawRows(checkRows);
    const ids = new Set(await listProjectIds());
    for (const id of rowsByProject.keys()) ids.add(id);
    const sorted = [...ids].sort();
    const restrictedWorst = new Map();
    const projects = await mapLimit(sorted, concurrency, async (id) => {
      const rows = rowsByProject.get(id) || [];
      const restrict = (restrictedBy, errors = null) => {
        const counts = restrictedCountsFrom(rows);
        restrictedWorst.set(id, counts.worst);
        return restrictedProject(id, counts, restrictedBy, errors);
      };
      // Id and check rows first: a marked project gets no per-project command.
      if (containsRestrictedMarker(id) || containsRestrictedMarker(rows)) return restrict('marker');
      const project = await readProject(id, rows);
      if (project.restrictedBy) return restrict(project.restrictedBy, project.errors);
      return project;
    });
    return {
      observedAt: new Date(now()).toISOString(),
      projects,
      attention: rankAttention(projects, restrictedWorst),
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

// systemsAttention: the Operations overview's attention items (null when not
// supplied); used only for totals.needsOperator, shared with /api/signals.
function loopsView(data, { systemsAttention = null } = {}) {
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
  totals.needsOperator = needsOperator({ systemsAttention, loops: data });
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
  RESTRICTED_MARKERS,
  createMloopReader,
  createMloopSource,
  loopsView,
  loopDetailView,
  parseMloopJson,
};
