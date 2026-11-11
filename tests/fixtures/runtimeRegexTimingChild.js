'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { adversarialCorpus, ordinaryText, fill, SIZE } = require('./adversarialCorpus');

// Extract literal regexes from the actual owned source, including literals in
// template interpolations. Compile patterns, never evaluate source fragments.
// False-positive literals in comments/strings only add work to this audit.
function regexLiterals(source) {
  const found = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '/' || source[i + 1] === '/' || source[i + 1] === '*') continue;
    const prefix = source.slice(0, i).trimEnd();
    const before = prefix.at(-1);
    if (before && !'(=,:![&|?{;>'.includes(before) && !prefix.endsWith('return')) continue;
    let inClass = false, end = i + 1;
    for (; end < source.length && source[end] !== '\n'; end++) {
      const ch = source[end];
      if (ch === '\\') { end++; continue; }
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) break;
    }
    if (source[end] !== '/') continue;
    let flagEnd = end + 1;
    while ('dgimsuvy'.includes(source[flagEnd]) && flagEnd < source.length) flagEnd++;
    try {
      const regex = new RegExp(source.slice(i + 1, end), source.slice(end + 1, flagEnd));
      found.push({ regex, line: source.slice(0, i).split('\n').length });
      i = flagEnd - 1;
    } catch {}
  }
  return found;
}

function corpus() {
  return [...adversarialCorpus(), ...Object.entries({
    'reviewer 200000 newlines': '\n'.repeat(200000),
    'box drawing': fill('│ ─ ┼ ╭ ╰'),
    'channel spaces': '│ Telegram │ ON │ OK │' + ' '.repeat(SIZE),
    'channel separators': fill('│ Telegram │ ON │ OK │'),
    'unfinished token previews': fill('token config ('),
    'active whitespace': '\n' + ' '.repeat(SIZE),
    'memory files': 'Memory │ 1 files ' + fill('1 '),
    'memory digits': 'Memory │ 1 files ' + '1'.repeat(SIZE),
    'name whitespace': '**Name:**' + '\n'.repeat(SIZE),
    'long URL scheme': fill('a-', SIZE - 40) + '://u:synthetic-sentinel@host',
    'nested URL authorities': fill('a://b:'),
  })];
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  let target, patterns = [];
  if (mode === 'literals') {
    patterns = regexLiterals(fs.readFileSync(file, 'utf8'));
    target = text => { for (const { regex } of patterns) { regex.lastIndex = 0; regex.test(text); } };
  } else if (mode === 'status') {
    // Exercise the real scheduled-refresh parser, with all dependencies fake.
    const { createStatusService } = require('../../server/services/statusData');
    global.fetch = async () => ({ ok: false, text: async () => '' });
    const fakeFs = { readFileSync() { throw new Error('not available'); } };
    target = async text => {
      const service = createStatusService({ mcConfig: {}, memoryPath: '/unused', prettyModelName: x => x,
        getOpenclawDefaultModelKey: () => '', fetchNotionActivity: async () => [], fetchSessions: async () => ({}),
        readRuntimeSnapshot: () => null, writeRuntimeSnapshot: () => {}, runtimeSnapshotTtl: {},
        fs: fakeFs, path, refreshOnRead: false,
        openclawCli: async args => ({ ok: true, stdout: args[0] === 'status' ? text : '{}' }),
      });
      await service.refreshStatusCache();
    };
  } else if (mode === 'export') {
    const { createSettingsService } = require('../../server/services/settingsData');
    target = text => createSettingsService({ mcConfig: { note: text } }).getExportConfig();
  } else if (mode === 'gpu') {
    // This exercises the dynamic new RegExp in the actual ioreg reader too.
    const { createOllamaSource } = require('../../server/sources/ollama/telemetry');
    target = async text => {
      const source = createOllamaSource({ platform: 'darwin',
        runner: { run: async () => ({ ok: true, stdout: text }) },
        fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/api/ps') ? { models: [] } : url.endsWith('/api/tags') ? { models: [] } : { version: 'test' } }),
      });
      await source.refresh();
    };
  } else throw new Error('Unknown target');
  async function time(text) {
    const start = process.hrtime.bigint(); await target(text);
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  const ordinary = ordinaryText();
  for (let i = 0; i < 3; i++) await time(ordinary);
  const baselineMs = Math.min(await time(ordinary), await time(ordinary));
  const results = [];
  for (const [name, text] of corpus()) {
    process.stderr.write(`${name}\n`);
    results.push({ name, ms: Math.round(await time(text) * 100) / 100 });
  }
  process.stdout.write(JSON.stringify({ baselineMs, results, patterns: patterns.map(({ regex, line }) => ({ source: regex.source, line })) }));
}
if (require.main === module) main().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
module.exports = { regexLiterals };
