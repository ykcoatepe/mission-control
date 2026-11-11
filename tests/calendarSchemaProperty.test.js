const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('../server/services/cronData');

// Exercise request boundaries rather than importing or reproducing the schema.
// Every case is sent through both public mutation methods against a clean file.
function requestCases() {
  const cases = [{ name: 'reported numeric linkedTaskId', body: { title: 'x', linkedTaskId: 5 }, reject: true }];
  let state = 0x51f15e;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const fields = ['id', 'title', 'schedule', 'assignee', 'notes', 'status', 'source', 'linkedTaskId', 'linkedJobId', 'startsAt', 'createdAt', 'updatedAt', 'lastSyncedAt'];
  const wrongValues = [0, 5, -1, true, false, [], [1], { nested: { arbitrary: 'value' } }];
  for (let index = 0; index < 312; index += 1) {
    const field = fields[index % fields.length];
    const value = wrongValues[next() % wrongValues.length];
    cases.push({ name: `wrong type ${index} ${field}`, body: { title: `generated-${index}`, [field]: value }, reject: true });
  }
  for (const [field, limit] of [['id', 256], ['title', 256], ['schedule', 1024], ['assignee', 256], ['notes', 32000], ['linkedTaskId', 256], ['linkedJobId', 256]]) {
    cases.push({ name: `oversize ${field}`, body: { title: 'x', [field]: 'x'.repeat(limit + 1) }, reject: true });
  }
  for (const field of ['startsAt', 'createdAt', 'updatedAt', 'lastSyncedAt']) {
    for (const value of ['not-a-date', 'x'.repeat(65)]) cases.push({ name: `invalid date ${field} ${value.length}`, body: { title: 'x', [field]: value }, reject: true });
  }
  for (const [field, value] of [['status', 'pretend-success'], ['source', 'invented-source'], ['userOverrides', 'notes'], ['userOverrides', ['not-a-field']], ['cronDerived', []], ['cronDerived', { notes: { nested: true } }], ['extra', 'unexpected']]) {
    cases.push({ name: `invalid ${field} ${cases.length}`, body: { title: 'x', [field]: value }, reject: true });
  }
  for (const body of [null, [], ['title'], 'title', 5, true]) {
    cases.push({ name: `nonobject body ${JSON.stringify(body)}`, body, reject: true });
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    cases.push({ name: `prototype key ${key}`, body: JSON.parse(`{"title":"x","${key}":{"polluted":true}}`), reject: true });
  }
  const statuses = ['scheduled', 'active', 'running', 'done', 'failed', 'disabled', 'cancelled', 'idle'];
  const sources = ['manual', 'assistant', 'cron'];
  for (let index = 0; index < 36; index += 1) {
    cases.push({
      name: `valid bounded request ${index}`,
      body: {
        title: `Valid ${index}`,
        schedule: index % 2 ? 'every weekday' : '',
        assignee: `Owner ${index}`,
        notes: index % 3 ? `Notes ${index}` : '',
        status: statuses[index % statuses.length],
        source: sources[index % sources.length],
        startsAt: index % 2 ? '2026-11-11T09:30:00.000Z' : null,
        linkedTaskId: index % 2 ? `task-${index}` : null,
        linkedJobId: null,
        // Well-typed server metadata is ignored at the request boundary.
        id: 'client-id-must-not-replace-server-id',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        lastSyncedAt: '2020-01-01T00:00:00.000Z',
        userOverrides: [],
        cronDerived: null,
      },
      reject: false,
    });
  }
  return cases;
}

const generatedCases = requestCases();
assert.ok(generatedCases.length >= 300);

for (const operation of ['create', 'patch']) {
  test(`calendar ${operation}: ${generatedCases.length} deterministic request bodies preserve a strict-readable file or reject atomically`, () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-calendar-property-'));
    const calendarFile = path.join(homeDir, 'calendar.json');
    const fixture = {
      entries: [{
        id: 'existing-manual', title: 'Existing manual row', schedule: '', startsAt: null,
        status: 'scheduled', assignee: 'Owner', source: 'manual', linkedTaskId: null, linkedJobId: null,
        notes: '', createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
        lastSyncedAt: '2026-11-11T00:00:00.000Z', userOverrides: [], cronDerived: null,
      }],
      updatedAt: '2026-11-11T00:00:00.000Z', lastCronSyncAt: null,
    };
    let accepted = 0;
    let rejected = 0;
    try {
      const service = createCronService({
        openclawExec: async () => { throw new Error('No request may call a CLI'); },
        gatewayPort: 1, gatewayToken: '', getOpenclawDefaultModelKey: () => '',
        calendarFile, homeDir, hermesProfile: 'hmudur',
      });
      for (const generated of generatedCases) {
        fs.writeFileSync(calendarFile, JSON.stringify(fixture, null, 2));
        const before = fs.readFileSync(calendarFile);
        let result;
        let failure;
        try {
          result = operation === 'create'
            ? service.createCalendarEntry(generated.body)
            : service.updateCalendarEntry('existing-manual', generated.body);
        } catch (error) { failure = error; }
        if (failure) {
          rejected += 1;
          assert.equal(failure.status || failure.statusCode, 400, `${generated.name}: only a client validation failure is allowed`);
          assert.deepEqual(fs.readFileSync(calendarFile), before, `${generated.name}: rejection changed file bytes`);
          assert.equal(generated.reject, true, `${generated.name}: a bounded valid request was rejected`);
          continue;
        }
        accepted += 1;
        const held = service.readCalendarDataSafe({ strict: true });
        assert.equal(held.diagnostics.quarantined.count, 0, `${generated.name}: accepted request was quarantined`);
        assert.equal(held.diagnostics.duplicates.count, 0, `${generated.name}: accepted request created a duplicate`);
        assert.equal(held.entries.length, operation === 'create' ? 2 : 1, `${generated.name}: accepted row lost on readback`);
        assert.ok(held.entries.some((entry) => entry.id === result.entry.id), `${generated.name}: returned ID absent on readback`);
        assert.notEqual(result.entry.id, 'client-id-must-not-replace-server-id', `${generated.name}: client replaced server ID`);
        assert.equal(generated.reject, false, `${generated.name}: invalid request was accepted`);
        assert.equal({}.polluted, undefined);
      }
      assert.ok(accepted >= 30, `Expected useful valid coverage, observed ${accepted}`);
      assert.ok(rejected >= 300, `Expected useful invalid coverage, observed ${rejected}`);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
}
