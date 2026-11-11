'use strict';

const { httpError } = require('../core/http');
const { redactString } = require('../core/config');

const CALENDAR_EDITABLE_FIELDS = Object.freeze(['title', 'schedule', 'startsAt', 'status', 'assignee', 'notes']);
const CRON_OVERRIDABLE_FIELDS = Object.freeze(['title', 'schedule', 'assignee', 'notes']);
const CRON_OWNED_FIELDS = Object.freeze(['status', 'startsAt', 'nextRun', 'nextRunAt', 'nextRunAtMs', 'scheduleKind', 'everyMs', 'atIso']);
const STATUS_VALUES = Object.freeze(['scheduled', 'active', 'running', 'done', 'failed', 'disabled', 'cancelled', 'idle']);
const SOURCE_VALUES = Object.freeze(['cron', 'manual', 'assistant']);

// This is the sole field/type/size contract for persisted rows and request
// bodies. Requests may carry typed server-owned fields for compatibility;
// the service still owns their values. Unknown/prototype fields are rejected.
const ENTRY_SCHEMA = Object.freeze({
  id: { type: 'string', min: 1, max: 256 },
  title: { type: 'string', min: 1, max: 256 },
  schedule: { type: 'string', nullable: true, max: 1024 },
  scheduleKind: { type: 'enum', values: ['interval', 'interval_unknown', 'cron', 'at', 'unknown', 'manual'] },
  everyMs: { type: 'number', nullable: true, integer: true, minExclusive: 0 },
  atIso: { type: 'date', nullable: true, max: 64 },
  startsAt: { type: 'date', nullable: true, max: 64 },
  status: { type: 'enum', values: STATUS_VALUES },
  assignee: { type: 'string', max: 256 },
  source: { type: 'enum', values: SOURCE_VALUES },
  linkedTaskId: { type: 'string', nullable: true, max: 256 },
  linkedJobId: { type: 'string', nullable: true, max: 256 },
  notes: { type: 'string', max: 32000 },
  createdAt: { type: 'date', nullable: true, max: 64 },
  updatedAt: { type: 'date', nullable: true, max: 64 },
  lastSyncedAt: { type: 'date', nullable: true, max: 64 },
  userOverrides: { type: 'overrides' },
  cronDerived: { type: 'derived', nullable: true },
});
const PATCH_ALIASES = Object.freeze({ nextRun: { type: 'date', nullable: true, max: 64 }, nextRunAt: { type: 'date', nullable: true, max: 64 }, nextRunAtMs: { type: 'number', nullable: true } });

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validField(value, rule) {
  if (value === null) return rule.nullable === true;
  switch (rule.type) {
    case 'string': return typeof value === 'string' && value.length <= rule.max && !value.includes('\0') && (!rule.min || value.trim().length >= rule.min);
    case 'date': return typeof value === 'string' && value.length <= rule.max && Number.isFinite(Date.parse(value));
    case 'enum': return typeof value === 'string' && rule.values.includes(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (!rule.integer || Number.isSafeInteger(value)) && (rule.minExclusive === undefined || value > rule.minExclusive);
    case 'overrides': return Array.isArray(value) && value.length <= CALENDAR_EDITABLE_FIELDS.length + CRON_OWNED_FIELDS.length
      && value.every(field => CALENDAR_EDITABLE_FIELDS.includes(field) || CRON_OWNED_FIELDS.includes(field));
    case 'derived': return plainObject(value) && Reflect.ownKeys(value).every(field => typeof field === 'string'
      && CRON_OVERRIDABLE_FIELDS.includes(field) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), 'value')
      && validField(value[field], ENTRY_SCHEMA[field]));
    default: return false;
  }
}

function entryIssue(entry, mode = 'stored') {
  if (!plainObject(entry)) return 'body';
  for (const field of Reflect.ownKeys(entry)) {
    if (typeof field !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(entry, field), 'value')) return 'body';
    const rule = Object.hasOwn(ENTRY_SCHEMA, field) ? ENTRY_SCHEMA[field]
      : mode === 'patch' && Object.hasOwn(PATCH_ALIASES, field) ? PATCH_ALIASES[field] : null;
    if (!rule) return 'unknown field';
    if (mode === 'patch' && CRON_OVERRIDABLE_FIELDS.includes(field) && entry[field] === null) continue;
    if (!validField(entry[field], rule)) return field;
  }
  if (mode === 'stored' && !Object.hasOwn(entry, 'id')) return 'id';
  if (mode === 'create' && !Object.hasOwn(entry, 'title')) return 'title';
  return null;
}

function assertCalendarEntry(entry, mode = 'stored') {
  const issue = entryIssue(entry, mode);
  if (issue === 'title' && mode === 'create' && (!Object.hasOwn(entry, 'title') || (typeof entry.title === 'string' && !entry.title.trim()))) {
    throw httpError(400, 'calendar_title_required', 'title required');
  }
  if (issue) throw httpError(400, 'calendar_entry_invalid', `Invalid calendar entry: ${issue}`);
  return entry;
}

function partitionCalendarEntries(rows) {
  if (!Array.isArray(rows)) throw httpError(400, 'calendar_entry_invalid', 'Calendar entries must be an array');
  const valid = [], quarantined = [], duplicates = [];
  const seen = new Set();
  for (const row of rows) {
    if (entryIssue(row)) { quarantined.push(row); continue; }
    if (seen.has(row.id)) { duplicates.push(row); continue; }
    seen.add(row.id);
    valid.push(row);
  }
  const safeId = row => typeof row?.id === 'number' && Number.isFinite(row.id) ? row.id
    : typeof row?.id === 'string' ? redactString(row.id).slice(0, ENTRY_SCHEMA.id.max) : null;
  return { valid, quarantined, duplicates, diagnostics: {
    quarantined: { count: quarantined.length, ids: quarantined.map(safeId) },
    duplicates: { count: duplicates.length, ids: [...new Set(duplicates.map(safeId))] },
  } };
}

module.exports = { ENTRY_SCHEMA, CALENDAR_EDITABLE_FIELDS, CRON_OVERRIDABLE_FIELDS, CRON_OWNED_FIELDS, entryIssue, assertCalendarEntry, partitionCalendarEntries };
