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
