// Restricted (Argus) boundary, property style. A project is classified on its
// COMPLETE RAW material (id, heading, outcome, status body, participants,
// confirmations, check rows) before any presentation transform, the marker is
// matched after NFKC, case folding, zero-width/combining stripping, common
// homoglyphs and separators, and an unreadable part fails closed (counts
// only). For every generated project no response of /api/loops,
// /api/loops/:project or /api/signals carries any text of it beyond its id
// and counts. Fake exec and fake fs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createMloopSource, RESTRICTED_MARKERS } = require('../server/sources/mloop');
const { buildLoopsRouter } = require('../server/routes/loops');
const { buildSignalsRouter } = require('../server/routes/signals');
const { errorHandler } = require('../server/core/http');

const NOW = Date.parse('2026-11-11T10:00:00Z');

function ok(body) {
  return { ok: true, code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false };
}
function fail() {
  return { ok: false, code: 2, stdout: '', stderr: JSON.stringify({ code: 'LEDGER_LOCKED', message: 'busy' }), timedOut: false };
}

// Deterministic PRNG so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VARIANTS = [
  'argus', 'Argus', 'ARGUS', 'a r g u s', 'a-r-g-u-s', 'a_r.g/u:s', 'a​rgus', 'ar‍g﻿us', 'arg­us',
  'аrgus', // Cyrillic a
  'argυs', // Greek upsilon
  'arɡus', // Latin script g
  'arguѕ', // Cyrillic dze
  'ａｒｇｕｓ', // fullwidth
  '𝐚𝐫𝐠𝐮𝐬', // mathematical bold
  'árgus', 'a̲r̲g̲u̲s̲', // combining marks
  'ΑRGUS', // Greek capital alpha
];
const ASCII_VARIANTS = ['argus', 'Argus', 'ARGUS', 'a-r-g-u-s', 'a_r.g-u_s', 'aRgUs'];
// Lengths before the marker: around and beyond every bound the source uses
// (title 160, text 300, summary 160, detail 4000, status 16000).
const PADS = [0, 7, 159, 160, 161, 299, 301, 4_001, 16_001, 20_000];
const FIELDS = [
  'id', 'heading', 'outcome', 'statusBody', 'participantName', 'participantRole', 'participantHost',
  'teyitId', 'teyitUnit', 'teyitHow', 'teyitKind', 'teyitDependsOn',
  'findingSubject', 'findingDetail', 'findingCode', 'findingExtra',
];

function pad(n, random) {
  const words = ['xx', 'note', 'ok', 'step', 'phase'];
  let out = '';
  while (out.length < n) out += `${words[Math.floor(random() * words.length)]} `;
  return out.slice(0, n);
}

// One generated project: every text field carries `token`; `field` also
// carries the marker after `padLength` characters.
function generatedProject({ id, token, field, variant, padLength, random }) {
  const at = (name, base) => (field === name ? `${base} ${pad(padLength, random)}${variant} tail` : base);
  const projectId = field === 'id' ? `${id}-${variant}-x` : id;
  const status = [
    `# ${at('heading', `${token} heading`)}`,
    `Outcome: ${at('outcome', `${token} outcome`)}`,
    '',
    '## Notes',
    at('statusBody', `${token} body`),
  ].join('\n');
  return {
    id: projectId,
    status,
    teyit: [{
      id: at('teyitId', `${token}-T1`),
      unit: at('teyitUnit', `${token} unit`),
      how: at('teyitHow', `${token} how`),
      kind: at('teyitKind', `${token}-kind`),
      depends_on: at('teyitDependsOn', `${token}-dep`),
      deadline: '2026-11-09T00:00:00Z',
      state: 'open',
      closed: false,
    }],
    participants: [{ name: at('participantName', `${token}-worker`), role: at('participantRole', `${token}-role`), host: at('participantHost', `${token}-host`) }],
    checkRows: [{
      project: projectId,
      code: field === 'findingCode' ? `X_${variant.replace(/[^A-Za-z]/g, '_').toUpperCase()}_Y` : 'BINDING_DEAD',
      subject: at('findingSubject', `${token}-subject`),
      severity: 'warning',
      detail: at('findingDetail', `${token} detail`),
      ts: '2026-11-10T00:00:00Z',
      first_subject: at('findingExtra', `${token}-first`),
    }],
  };
}

const PLAIN = {
  id: 'plain',
  status: '# plain\nOutcome: VISIBLE-outcome\n',
  teyit: [],
  participants: [{ name: 'VISIBLE-worker', role: 'manager', host: 'claude' }],
  checkRows: [{ project: 'plain', code: 'BINDING_DEAD', subject: 'VISIBLE-worker', severity: 'warning', detail: 'VISIBLE detail', ts: '2026-11-10T00:00:00Z' }],
};

function sourceFor(projects, { failing = {} } = {}) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const calls = [];
  const exec = {
    async run(file, args) {
      calls.push(args);
      if (args[0] === 'check') return ok(projects.flatMap((project) => project.checkRows));
      const [, id, , command] = args;
      const project = byId.get(id);
      if (failing[id] === command) return fail();
      if (failing[id] === `${command}:garbage`) return { ok: true, code: 0, stdout: 'not json', stderr: '', timedOut: false };
      if (command === 'status') return ok(project.status);
      if (command === 'teyit') return ok(project.teyit);
      if (command === 'participants') return ok(project.participants);
      throw new Error(`unexpected ${args.join(' ')}`);
    },
  };
  const fsImpl = {
    async readdir() { return projects.map((project) => ({ name: project.id, isDirectory: () => true })); },
    async stat() { return { isFile: () => true, mtimeMs: NOW }; },
  };
  const source = createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now: () => NOW });
  return { source, calls };
}

const empty = { snapshot: () => ({ data: null, meta: { ok: false, stale: true, observedAt: null, ageMs: null, error: null, latencyMs: null, source: 'x' } }) };
const overview = {
  async getOverview() {
    const system = (id) => ({ id, state: 'healthy', observedAt: '2026-11-11T09:59:00.000Z', caveats: [], detailHref: `/${id}` });
    return {
      systems: { gbrain: system('gbrain'), hermes: system('hermes'), openclaw: system('openclaw') },
      attention: [],
      meta: { ok: true, stale: false, observedAt: '2026-11-11T09:59:00.000Z', ageMs: 0, error: null, latencyMs: null, source: 'operations.overview' },
    };
  },
};

async function responses(source, ids) {
  const app = express();
  app.use(buildLoopsRouter({ loopsSource: source, operationsOverviewService: overview }));
  app.use(buildSignalsRouter({ operationsOverviewService: overview, loopsSource: source, launchdSource: empty, reachabilitySource: empty, now: () => NOW }));
  app.use(errorHandler({ logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = { list: await (await fetch(`${base}/api/loops`)).text(), signals: await (await fetch(`${base}/api/signals`)).text() };
    for (const id of ids) out[id] = await (await fetch(`${base}/api/loops/${encodeURIComponent(id)}`)).text();
    return out;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function assertNoText(bodies, token, label) {
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(body.includes(token), false, `${label}: ${name} carries text of a restricted project`);
  }
}

test('the restricted markers are one exported constant', () => {
  assert.ok(Object.isFrozen(RESTRICTED_MARKERS));
  assert.deepEqual([...RESTRICTED_MARKERS], ['argus']);
});

test('reproduced: a 161-character heading followed by Argus is restricted, not truncated past the marker', async () => {
  const project = {
    id: 'ordinary',
    status: `# ${'x'.repeat(161)}Argus\nOutcome: SECRET-outcome\n\nSECRET-body\n`,
    teyit: [{ id: 'T1', unit: 'SECRET-unit', how: 'h', deadline: '2026-11-09T00:00:00Z', state: 'open', closed: false }],
    participants: [{ name: 'SECRET-worker', role: 'manager', host: 'claude' }],
    checkRows: [{ project: 'ordinary', code: 'BINDING_DEAD', subject: 'SECRET-worker', severity: 'warning', detail: 'SECRET-detail', ts: '2026-11-10T00:00:00Z' }],
  };
  const { source } = sourceFor([project, PLAIN]);
  await source.refresh();
  const bodies = await responses(source, ['ordinary', 'plain']);
  assertNoText(bodies, 'SECRET', 'reproduced');
  assert.doesNotMatch(bodies.list, /xxxxxxxx/);
  const list = JSON.parse(bodies.list);
  assert.equal(list.data.projects.find((p) => p.id === 'ordinary').restricted, true);
  assert.equal(list.data.projects.find((p) => p.id === 'plain').restricted, false);
  assert.match(bodies.plain, /VISIBLE detail/, 'an ordinary project still shows its text');
});

test('property: the marker in any field, at any position, in any common disguise restricts the project', async () => {
  const random = rng(20261111);
  const trials = FIELDS.length * 8;
  for (let i = 0; i < trials; i += 1) {
    const field = FIELDS[i % FIELDS.length];
    // Ids and codes are ASCII by contract, so they get the ASCII disguises.
    const pool = field === 'id' || field === 'findingCode' ? ASCII_VARIANTS : VARIANTS;
    const variant = pool[Math.floor(random() * pool.length)];
    const padLength = PADS[Math.floor(random() * PADS.length)] + Math.floor(random() * 3);
    const token = `LEAK${i}Q`;
    const project = generatedProject({ id: `p${i}`, token, field, variant, padLength, random });
    assert.match(project.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
    const { source } = sourceFor([project, PLAIN]);
    await source.refresh();
    const label = `trial ${i}: field=${field} variant=${JSON.stringify(variant)} pad=${padLength}`;
    const list = source.snapshot().data.projects.find((p) => p.id === project.id);
    assert.equal(list?.restricted, true, `${label}: not restricted`);
    assert.equal(JSON.stringify(source.snapshot().data).includes(token), false, `${label}: memory holds restricted text`);
    const bodies = await responses(source, [project.id]);
    assertNoText(bodies, token, label);
    assert.equal(JSON.parse(bodies.list).data.projects.find((p) => p.id === 'plain').restricted, false, `${label}: control project hidden`);
  }
});

test('fail closed: a part needed for classification that cannot be read restricts the project', async () => {
  for (const failing of ['status', 'teyit', 'participants', 'status:garbage', 'teyit:garbage', 'participants:garbage']) {
    const project = generatedProject({ id: 'q', token: 'HIDDENQ', field: 'none', variant: '', padLength: 0, random: rng(1) });
    const { source } = sourceFor([project, PLAIN], { failing: { q: failing } });
    await source.refresh();
    const bodies = await responses(source, ['q']);
    assertNoText(bodies, 'HIDDENQ', `failing ${failing}`);
    const q = JSON.parse(bodies.q).data;
    assert.equal(q.restricted, true, `failing ${failing}`);
    assert.equal(q.restrictedBy, 'unverified');
    assert.equal(q.errors.length, 1);
    assert.equal(q.openFindings, 1, 'counts survive');
  }
});

test('a project whose check rows carry the marker is restricted without any per-project command', async () => {
  const project = generatedProject({ id: 'r', token: 'HIDDENR', field: 'findingDetail', variant: 'Argus', padLength: 4_100, random: rng(2) });
  const { source, calls } = sourceFor([project, PLAIN]);
  await source.refresh();
  assert.equal(calls.some((args) => args[1] === 'r'), false, 'a per-project command ran for a marked project');
  assertNoText(await responses(source, ['r']), 'HIDDENR', 'check-row marker');
});

// Decision: Argus content is not shown, and a mention of the marker in another
// project cannot be told apart from Argus content quoted there, so that
// project is restricted too (fail closed). Its id and counts stay.
test('cross-project: a mention of the marker in another project hides that project text, counts stay', async () => {
  const beta = {
    id: 'beta',
    status: '# beta\nOutcome: CROSS-outcome\n',
    teyit: [],
    participants: [{ name: 'codex-argus-manager-1', role: 'implementer', host: 'codex' }],
    checkRows: [{ project: 'beta', code: 'BINDING_DEAD', subject: 'CROSS-subject', severity: 'warning', detail: 'CROSS-detail', ts: '2026-11-10T00:00:00Z' }],
  };
  const gamma = {
    id: 'gamma',
    status: '# gamma\nOutcome: CROSS-outcome-g\n',
    teyit: [],
    participants: [],
    checkRows: [{ project: 'gamma', code: 'ESCALATED_ROUNDS', subject: 'P3', severity: 'error', detail: 'blocked on argus-live P3: CROSS-quoted order text', ts: '2026-11-10T00:00:00Z' }],
  };
  const { source } = sourceFor([beta, gamma, PLAIN]);
  await source.refresh();
  const bodies = await responses(source, ['beta', 'gamma', 'plain']);
  assertNoText(bodies, 'CROSS', 'cross-project');
  const list = JSON.parse(bodies.list).data;
  assert.deepEqual(list.projects.filter((p) => p.restricted).map((p) => p.id), ['beta', 'gamma']);
  assert.equal(list.totals.openFindings, 3, 'their counts still add up');
  assert.equal(JSON.parse(bodies.signals).data.attention.breakdown.restricted, 2);
});

// --- review-fix round 2: identity is the guarantee, content a second line ---

test('reproduced: a marker split across a finding subject and detail restricts the project', async () => {
  const plain = {
    id: 'plain',
    status: '# plain\nOutcome: ok\n',
    teyit: [],
    participants: [],
    checkRows: [{ project: 'plain', code: 'BINDING_DEAD', severity: 'warning', subject: 'ar', detail: 'gus PRIVATE_SENTINEL' }],
  };
  const other = { ...PLAIN, id: 'other', checkRows: PLAIN.checkRows.map((row) => ({ ...row, project: 'other' })) };
  const { source } = sourceFor([plain, other]);
  await source.refresh();
  const snapshot = source.snapshot().data;
  assert.equal(snapshot.projects.find((p) => p.id === 'plain').restricted, true);
  assert.equal(snapshot.projects.find((p) => p.id === 'other').restricted, false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'), false, 'the snapshot holds restricted text');
  assertNoText(await responses(source, ['plain', 'other']), 'PRIVATE_SENTINEL', 'reproduced split');
});

test('identity: an id-restricted project holds nothing but id and counts, even in the source snapshot', async () => {
  const restricted = {
    id: 'argus-live',
    status: '# IDTEXT status\n',
    teyit: [{ id: 'IDTEXT-T1', unit: 'IDTEXT', how: 'h', deadline: '2026-11-09T00:00:00Z', state: 'open', closed: false }],
    participants: [{ name: 'IDTEXT-worker', role: 'manager', host: 'claude' }],
    checkRows: [
      { project: 'argus-live', code: 'TEYIT_STALE', subject: 'IDTEXT-T1', severity: 'warning', detail: 'IDTEXT detail', ts: '2026-11-10T00:00:00Z' },
      { project: 'argus-live', code: 'TEYIT_KEEP_KILL', subject: 'IDTEXT-T1', severity: 'warning', detail: 'IDTEXT keep or kill', ts: '2026-11-10T00:00:00Z' },
      { project: 'argus-live', code: 'BINDING_DEAD', subject: 'IDTEXT-worker', severity: 'error', detail: 'IDTEXT bot', ts: '2026-11-10T00:00:00Z' },
    ],
  };
  const { source, calls } = sourceFor([restricted, PLAIN]);
  await source.refresh();
  assert.equal(calls.some((args) => args.some((arg) => /argus/i.test(arg))), false, 'a per-project command ran');
  const snapshot = source.snapshot().data;
  assert.equal(JSON.stringify(snapshot).includes('IDTEXT'), false, 'the snapshot holds text of an id-restricted project');
  assert.deepEqual(snapshot.projects.find((p) => p.id === 'argus-live'), {
    id: 'argus-live',
    restricted: true,
    restrictedBy: 'identity',
    openFindings: 3,
    pendingConfirmations: 1,
    overdueConfirmations: 1,
    operatorFindings: 1,
    operatorConfirmations: 1,
    worstSeverity: 'error',
    countsBasis: 'mloop-check',
  });
  assertNoText(await responses(source, ['argus-live']), 'IDTEXT', 'identity');
});

test('identity: the restricted set extends from configuration without code changes', async () => {
  const hush = generatedProject({ id: 'hush-ops', token: 'HUSHTEXT', field: 'none', variant: '', padLength: 0, random: rng(3) });
  const projects = [hush, PLAIN];
  const byId = new Map(projects.map((project) => [project.id, project]));
  const calls = [];
  const exec = {
    async run(file, args) {
      calls.push(args);
      if (args[0] === 'check') return ok(projects.flatMap((project) => project.checkRows));
      const [, id, , command] = args;
      const project = byId.get(id);
      return ok(command === 'status' ? project.status : command === 'teyit' ? project.teyit : project.participants);
    },
  };
  const fsImpl = {
    async readdir() { return projects.map((project) => ({ name: project.id, isDirectory: () => true })); },
    async stat() { return { isFile: () => true, mtimeMs: NOW }; },
  };
  const source = createMloopSource({ exec, fsImpl, ledgerDir: '/fake', bin: '/fake/mloop', now: () => NOW, env: { MC_RESTRICTED_PROJECT_MARKERS: 'hush, ' } });
  await source.refresh();
  assert.equal(calls.some((args) => args[1] === 'hush-ops'), false);
  const hushed = source.snapshot().data.projects.find((p) => p.id === 'hush-ops');
  assert.equal(hushed.restrictedBy, 'identity');
  assert.equal(JSON.stringify(source.snapshot().data).includes('HUSHTEXT'), false);
});

// Fields as they reach the source raw. A split marker puts a marker prefix at
// the END of one field and the rest at the START of another (and, for three
// fields, a whole middle field that is only marker letters).
const SPLIT_FIELDS = [
  'id', 'heading', 'outcome', 'statusBody', 'participantName', 'participantRole', 'participantHost',
  'teyitId', 'teyitUnit', 'teyitHow', 'teyitKind', 'teyitDependsOn',
  'findingSubject', 'findingDetail', 'findingCode', 'findingSummaryLine',
];

function splitProject(n, token, parts, random) {
  const words = () => pad(Math.floor(random() * 40), random).trim();
  const value = (field, fallback) => (field in parts ? parts[field] : fallback);
  const text = (field) => value(field, `${token} ${words()} ${token}`);
  const id = value('id', `s${n}`);
  const status = [`# ${text('heading')}`, `Outcome: ${text('outcome')}`, '', '## Notes', text('statusBody')].join('\n');
  return {
    id,
    status,
    teyit: [{
      id: text('teyitId'), unit: text('teyitUnit'), how: text('teyitHow'), kind: text('teyitKind'), depends_on: text('teyitDependsOn'),
      deadline: '2026-11-09T00:00:00Z', state: 'open', closed: false,
    }],
    participants: [{ name: text('participantName'), role: text('participantRole'), host: text('participantHost') }],
    checkRows: [
      { project: id, code: value('findingCode', `${token}_CODE`), subject: text('findingSubject'), severity: 'warning', detail: text('findingDetail'), ts: '2026-11-10T00:00:00Z' },
      // A second finding whose first line is its own field in the published summary.
      { project: id, code: 'NOTE', subject: `${token}-n`, severity: 'info', detail: `${text('findingSummaryLine')}\nsecond line ${token}`, ts: '2026-11-10T00:00:00Z' },
    ],
  };
}

// The marker pieces as a field value of that kind: ids and codes stay valid.
function piece(field, letters, where, n, token) {
  if (field === 'id') return where === 'end' ? `s${n}-${letters}` : where === 'start' ? `${letters}-s${n}` : `${letters}-${n}`;
  if (field === 'findingCode') return where === 'end' ? `${token}_${letters.toUpperCase()}` : where === 'start' ? `${letters.toUpperCase()}_${token}` : `_${letters.toUpperCase()}_`;
  if (where === 'end') return `${token} step ${letters}`;
  if (where === 'start') return `${letters}. note ${token}`;
  return ` ${letters} `;
}

async function assertBatchHidden(batch, label) {
  const { source } = sourceFor([...batch.map((entry) => entry.project), PLAIN]);
  await source.refresh();
  const snapshot = source.snapshot().data;
  const memory = JSON.stringify(snapshot);
  assert.equal(snapshot.projects.find((p) => p.id === 'plain').restricted, false, `${label}: control project hidden`);
  const bodies = await responses(source, batch.map((entry) => entry.project.id));
  for (const { project, token, what } of batch) {
    assert.equal(snapshot.projects.find((p) => p.id === project.id)?.restricted, true, `${label} ${what}: not restricted`);
    assert.equal(memory.includes(token), false, `${label} ${what}: snapshot holds restricted text`);
    assertNoText(bodies, token, `${label} ${what}`);
  }
}

test('property: a marker split at every position across every ordered pair of fields is caught', async () => {
  const random = rng(4242);
  const marker = RESTRICTED_MARKERS[0];
  const cases = [];
  let n = 0;
  for (const first of SPLIT_FIELDS) {
    for (const second of SPLIT_FIELDS) {
      if (first === second) continue;
      for (let cut = 1; cut < marker.length; cut += 1) {
        n += 1;
        const token = `SPLIT${n}Q`;
        const parts = {
          [first]: piece(first, marker.slice(0, cut), 'end', n, token),
          [second]: piece(second, marker.slice(cut), 'start', n, token),
        };
        cases.push({ project: splitProject(n, token, parts, random), token, what: `${first}|${second} cut=${cut}` });
      }
    }
  }
  for (let i = 0; i < cases.length; i += 80) await assertBatchHidden(cases.slice(i, i + 80), 'pair');
});

test('property: a marker split across three fields (a whole middle field of marker letters) is caught', async () => {
  const random = rng(777);
  const marker = RESTRICTED_MARKERS[0];
  const cases = [];
  for (let n = 1; n <= 240; n += 1) {
    const pick = () => SPLIT_FIELDS[Math.floor(random() * SPLIT_FIELDS.length)];
    const [a, b, c] = [pick(), pick(), pick()];
    if (new Set([a, b, c]).size < 3) { n -= 1; continue; }
    const i = 1 + Math.floor(random() * (marker.length - 2));
    const j = i + 1 + Math.floor(random() * (marker.length - i - 1));
    const token = `TRIPLE${n}Q`;
    const parts = {
      [a]: piece(a, marker.slice(0, i), 'end', n, token),
      [b]: piece(b, marker.slice(i, j), 'middle', n, token),
      [c]: piece(c, marker.slice(j), 'start', n, token),
    };
    cases.push({ project: splitProject(n + 10_000, token, parts, random), token, what: `${a}|${b}|${c} ${i}/${j}` });
  }
  for (let k = 0; k < cases.length; k += 80) await assertBatchHidden(cases.slice(k, k + 80), 'triple');
});
