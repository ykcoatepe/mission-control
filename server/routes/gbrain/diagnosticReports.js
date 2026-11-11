'use strict';
const { scrubText } = require('../../core/scrub');

const MAX_PAYLOAD_BYTES = 32768;
const MAX_CHECKS = 20;
const MAX_ISSUES = 5;
const MAX_RESULT_ROWS = 10;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isInteger(value) && value >= 0;
const score = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const text = (value, max = 220) => {
  if (typeof value !== 'string') return null;
  const clean = scrubText(value, { maxChars: 1000 });
  return clean.length > max ? clean.slice(0, Math.max(0, max - 1)) + '…' : clean;
};
const issueArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' || record(item));
const FAIL = new Set(['fail', 'failed', 'error', 'critical']);
const WARN = new Set(['warn', 'warning', 'unknown']);
const CHECK_STATUS = new Set([...FAIL, ...WARN, 'pass', 'passed', 'ok', 'healthy', 'skip', 'skipped', 'deferred', 'not_applicable']);
const REPORT_STATUS = new Set(['healthy', 'unhealthy', 'degraded', 'warning', 'critical', 'unknown', 'ok', 'error']);
function row(value) {
  if (typeof value === 'string') return { name: null, status: null, message: text(value) };
  return { name: text(value.name ?? value.skill ?? value.check ?? value.type, 80),
    status: text(value.status ?? value.severity, 32), message: text(value.message ?? value.reason) };
}
function issue(value) {
  if (typeof value === 'string') return text(value);
  const out = {};
  for (const key of ['name', 'skill', 'type', 'code', 'status', 'severity', 'message', 'action', 'reason']) {
    if (typeof value[key] === 'string') out[key] = text(value[key], ['message', 'action', 'reason'].includes(key) ? 220 : 80);
  }
  return out;
}
function numericMap(value) {
  if (!record(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .slice(0, 20).map(([key, v]) => [text(key, 80), v]));
}
function limitedRows(failing, warning, counts) {
  if (failing.length > MAX_RESULT_ROWS) counts.failingOmitted = failing.length - MAX_RESULT_ROWS;
  if (warning.length > MAX_RESULT_ROWS) counts.warningOmitted = warning.length - MAX_RESULT_ROWS;
  return { failing: failing.slice(0, MAX_RESULT_ROWS).map(row), warning: warning.slice(0, MAX_RESULT_ROWS).map(row), counts };
}
function addArray(owner, key, values, limit, project, trim) {
  owner[key] = values.slice(0, limit).map(project);
  owner[key + 'Omitted'] = values.length - owner[key].length;
  trim.push({ owner, key });
}
function boundPayload(payload, trim) {
  payload.truncated = trim.some(({ owner, key }) => owner[key + 'Omitted'] > 0);
  // Arrays were capped before projection; this loop has a fixed item ceiling.
  // Keep check identities, dropping their issue detail first if the byte cap
  // is reached. No arbitrary object recursion or raw unknown fields escape.
  for (const { owner, key } of trim) {
    while (owner[key].length && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES - 100) {
      owner[key].pop(); owner[key + 'Omitted']++; payload.truncated = true;
    }
  }
  return payload;
}
function readableMessage(value) {
  return String(value || '').replace(/\bissue\(s\)/g, 'issues').replace(/\berror\(s\)/g, 'errors')
    .replace(/\bwarning\(s\)/g, 'warnings')
    .replace(/^(\d{1,9}) issues: (\d{1,9}) errors, (\d{1,9}) warnings$/, '$1 issues ($2 errors, $3 warnings)')
    .replace(/[.!?]$/, '');
}
function summary(result, { complete, missingFiles, errors = false } = {}) {
  let line = 'Check finished';
  if (result.reportStatus !== null) line += `: ${result.reportStatus}`;
  if (result.healthScore !== null) line += ` (${result.healthScore}/100)`;
  const { counts } = result;
  if (counts.failing > 0) {
    if (missingFiles !== undefined) {
      if (missingFiles > 0) line += `; ${missingFiles} missing file${missingFiles === 1 ? '' : 's'}`;
      const refusals = counts.failing - missingFiles;
      if (refusals > 0) line += `; ${refusals} restore refusal${refusals === 1 ? '' : 's'}`;
    } else if (errors) line += `; ${counts.failing} error${counts.failing === 1 ? '' : 's'}`;
    else line += `; ${counts.failing} check${counts.failing === 1 ? '' : 's'} failed`;
    if (result.failing[0]?.name) line += `: ${result.failing[0].name}`;
    if (result.failing[0]?.message) line += ` - ${readableMessage(result.failing[0].message)}`;
  }
  if (counts.warning > 0) line += `; ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`;
  if (complete === false) line += '; report incomplete';
  return line.slice(0, 599).replace(/[.!?]$/, '') + '.';
}
function doctorReport(p) {
  if (p.schema_version !== 2 || !REPORT_STATUS.has(p.status) || !Array.isArray(p.checks)
    || !p.checks.every((c) => record(c) && typeof c.name === 'string' && CHECK_STATUS.has(c.status)
      && (c.issues === undefined || issueArray(c.issues)))
    || (p.health_score != null && !score(p.health_score))) return null;
  const failing = p.checks.filter((c) => FAIL.has(c.status));
  const warning = p.checks.filter((c) => WARN.has(c.status));
  const result = { reportStatus: text(p.status, 32), healthScore: score(p.health_score) ? p.health_score : null,
    ...limitedRows(failing, warning, { checks: p.checks.length, failing: failing.length, warning: warning.length }) };
  const payload = { schema_version: p.schema_version, status: text(p.status, 32) }; const trim = [];
  for (const key of ['health_score', 'brain_checks_score']) if (score(p[key])) payload[key] = p[key];
  if (typeof p.complete === 'boolean') payload.complete = p.complete;
  if (record(p.category_scores)) payload.category_scores = numericMap(p.category_scores);
  addArray(payload, 'checks', p.checks, MAX_CHECKS, (c) => {
    const out = { name: text(c.name, 80), status: text(c.status, 32) };
    if (typeof c.message === 'string') out.message = text(c.message);
    if (Array.isArray(c.issues)) addArray(out, 'issues', c.issues, MAX_ISSUES, issue, trim);
    return out;
  }, trim);
  return { outcome: failing.length || warning.length || !['healthy', 'ok'].includes(p.status) || p.complete === false ? 'findings' : 'clean',
    result, summary: summary(result, { complete: p.complete }), payload: boundPayload(payload, trim) };
}
function routingReport(p) {
  const r = p.report;
  if (typeof p.ok !== 'boolean' || !record(r) || typeof r.ok !== 'boolean'
    || !['errors', 'warnings', 'issues'].every((k) => issueArray(r[k]))) return null;
  const result = { reportStatus: typeof r.status === 'string' ? text(r.status, 32) : null, healthScore: null,
    ...limitedRows(r.errors, r.warnings, { failing: r.errors.length, warning: r.warnings.length, issues: r.issues.length }) };
  const payload = { ok: p.ok, report: { ok: r.ok } }; const trim = [];
  for (const key of ['errors', 'warnings', 'issues']) addArray(payload.report, key, r[key], MAX_CHECKS, issue, trim);
  if (record(r.summary)) payload.report.summary = numericMap(r.summary);
  return { outcome: !p.ok || !r.ok || r.errors.length || r.warnings.length ? 'findings' : 'clean',
    result, summary: summary(result, { errors: true }), payload: boundPayload(payload, trim) };
}
function storageReport(p) {
  if (!count(p.totalPages) || !record(p.pagesByTier) || !record(p.diskUsageByTier)
    || !issueArray(p.missingFiles) || !issueArray(p.warnings)) return null;
  const refusal = record(p.restoreRefusal) || typeof p.restoreRefusal === 'string' ? [p.restoreRefusal] : [];
  const failing = [...p.missingFiles, ...refusal];
  const result = { reportStatus: typeof p.status === 'string' ? text(p.status, 32) : null, healthScore: null,
    ...limitedRows(failing, p.warnings, { failing: failing.length, warning: p.warnings.length, pages: p.totalPages, missingFiles: p.missingFiles.length }) };
  const payload = { totalPages: p.totalPages, pagesByTier: numericMap(p.pagesByTier), diskUsageByTier: numericMap(p.diskUsageByTier) }; const trim = [];
  if (typeof p.repoPath === 'string') payload.repoPath = text(p.repoPath);
  if (typeof p.restoreSource === 'string') payload.restoreSource = text(p.restoreSource, 80);
  if (refusal.length) payload.restoreRefusal = issue(refusal[0]);
  for (const key of ['missingFiles', 'warnings']) addArray(payload, key, p[key], MAX_CHECKS, issue, trim);
  return { outcome: failing.length || p.warnings.length ? 'findings' : 'clean',
    result, summary: summary(result, { missingFiles: p.missingFiles.length }), payload: boundPayload(payload, trim) };
}
// This dispatch describes report schemas only. The action allowlist, argv,
// class, confirmation, locks and native lane remain owned by the executor.
const PARSERS = Object.freeze({ 'doctor-fast': doctorReport, 'check-resolvable': routingReport, 'storage-status': storageReport });
function diagnosticReport(action, definition, payload) {
  if (definition.safetyClass !== 'R0' || definition.kind !== 'diagnostic' || !record(payload)) return null;
  return PARSERS[action]?.(payload) || null;
}
module.exports = { diagnosticReport, MAX_PAYLOAD_BYTES };
