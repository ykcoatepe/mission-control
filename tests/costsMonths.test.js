const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildCostsRouter,
  CONFIRMED_EMPTY_TTL_MS,
  codexHomePath,
  producerFingerprint,
} = require('../server/routes/costs');

test('codexHomePath honors an explicit MC_USER_HOME that has no .openclaw tree', () => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-user-home-'));
  const serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-server-home-'));
  fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(serverHome, '.openclaw'), { recursive: true });
  const previous = {
    MC_USER_HOME: process.env.MC_USER_HOME,
    MC_CODEX_HOME: process.env.MC_CODEX_HOME,
    HOME: process.env.HOME,
  };
  process.env.MC_USER_HOME = userHome;
  delete process.env.MC_CODEX_HOME;
  process.env.HOME = serverHome;
  try {
    assert.equal(
      codexHomePath(),
      path.join(userHome, '.codex'),
      'a codex-only MC_USER_HOME must not be vetoed by hostUserHome() .openclaw validation',
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(userHome, { recursive: true, force: true });
    fs.rmSync(serverHome, { recursive: true, force: true });
  }
});

const FIXED_CACHE_NOW = Date.parse('2026-08-15T12:00:00.000Z');

async function withDateNow(now, run) {
  const originalDateNow = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = originalDateNow;
  }
}

function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function withCostsApp(monthAvailabilitySources, run) {
  const app = express();
  app.use(buildCostsRouter({
    mcConfig: { budget: { monthly: 0 } },
    projectRoot: path.join(__dirname, '..'),
    sessionsService: { listVisibleSessions: async () => ({ sessions: [] }) },
    monthAvailabilitySources,
  }));
  const server = await new Promise((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function emptyCachedDetailedMonths() {
  return { data: new Set(), confirmedEmpty: new Set(), hasEntries: false };
}

function cleanCachedDetailedMonths({ data = [], confirmedEmpty = [] } = {}) {
  return { data: new Set(data), confirmedEmpty: new Set(confirmedEmpty), hasEntries: true };
}

test('GET /api/costs/months returns bounded newest-first availability', async () => {
  const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const prior = shiftMonth(current, -1);

  await withCostsApp({
    hermes: async () => [current, prior],
    codexbar: async () => [current],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(typeof body.generatedAt, 'string');
    assert.equal(typeof body.partial, 'boolean');
    assert.deepEqual(body.sourceStatus, { hermes: 'ready', codexbar: 'ready', cached: 'no_usage' });
    assert.equal(body.months.length, 25);
    assert.equal(body.months[0].month, current, 'the current month is first');
    assert.equal(body.months.at(-1).month, shiftMonth(current, -24), 'the 24-month floor is included');
    assert.ok(body.months.every((entry) => entry.month <= current), 'future months are never offered');
    assert.ok(body.months.every((entry, index, rows) => index === 0 || entry.month < rows[index - 1].month), 'months are newest first');
    assert.deepEqual(body.months[0], { month: current, hasData: true, sources: ['hermes', 'codexbar'] });
    assert.deepEqual(body.months[1], { month: prior, hasData: true, sources: ['hermes'] });
  });
});

test('GET /api/costs/months degrades to unknown selectable months when a source fails', async () => {
  const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const prior = shiftMonth(current, -1);

  await withCostsApp({
    hermes: async () => { throw new Error('Hermes database unavailable'); },
    codexbar: async () => [current],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const response = await fetch(`${base}/api/costs/months`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.partial, true);
    assert.deepEqual(body.sourceStatus, { hermes: 'unavailable', codexbar: 'ready', cached: 'no_usage' });
    assert.deepEqual(body.months[0], { month: current, hasData: true, sources: ['codexbar'] });
    assert.deepEqual(body.months.find((entry) => entry.month === prior), {
      month: prior,
      hasData: false,
      sources: [],
      unknown: true,
    });
  });
});

test('OpenClaw-only months remain unknown until detailed cache evidence is available', async () => {
  const current = '2026-08';
  const openclawOnly = '2026-05';

  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.months.find((entry) => entry.month === openclawOnly), {
      month: openclawOnly,
      hasData: false,
      sources: [],
      unknown: true,
    });
    assert.equal(body.sourceStatus.cached, 'no_usage');
  });
});

test('detailed cache supplies positive and the only confirmed-empty month evidence', async () => {
  const current = '2026-08';
  const confirmedEmpty = '2026-07';
  const stillUnknown = '2026-06';

  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: () => cleanCachedDetailedMonths({ data: [current], confirmedEmpty: [confirmedEmpty] }),
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.months.find((entry) => entry.month === current), {
      month: current,
      hasData: true,
      sources: ['cached'],
    });
    assert.deepEqual(body.months.find((entry) => entry.month === confirmedEmpty), {
      month: confirmedEmpty,
      hasData: false,
      sources: ['cached'],
    });
    assert.equal(body.months.find((entry) => entry.month === stillUnknown).unknown, true);
    assert.equal(body.sourceStatus.cached, 'ready');
  });
});

test('a not_configured producer blocks confirmed-empty evidence', async () => {
  const month = '2026-07';
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-months-cache-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;

  const writeCachedEntry = (statuses) => {
    fs.writeFileSync(path.join(cacheDir, 'costs-cache.json'), JSON.stringify({
      [`costs:month:${month}`]: {
        value: {
          source: 'combined.agent_usage',
          summary: { periodTokens: 0, periodUsd: 0, scanTruncated: false },
          meta: {
            scanTruncated: false,
            openclawStatus: statuses.openclaw,
            hermesStatus: statuses.hermes,
            claudeCodeStatus: statuses.claude,
          },
        },
        time: Date.now(),
        detailed: true,
        producerFingerprint: producerFingerprint(),
      },
    }));
  };

  const sources = {
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
  };

  try {
    writeCachedEntry({ openclaw: 'ready', hermes: 'ready', claude: 'not_configured' });
    await withCostsApp(sources, async (base) => {
      const body = await (await fetch(`${base}/api/costs/months`)).json();
      assert.deepEqual(body.months.find((entry) => entry.month === month), {
        month,
        hasData: false,
        sources: [],
        unknown: true,
      });
    });

    for (const status of ['ready', 'no_usage']) {
      writeCachedEntry({ openclaw: status, hermes: status, claude: status });
      await withCostsApp(sources, async (base) => {
        const body = await (await fetch(`${base}/api/costs/months`)).json();
        assert.deepEqual(body.months.find((entry) => entry.month === month), {
          month,
          hasData: false,
          sources: ['cached'],
        });
      });
    }
  } finally {
    if (previousCacheDir === undefined) delete process.env.MC_COSTS_CACHE_DIR;
    else process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('confirmed-empty evidence is bound to the producer configuration', async () => {
  const month = '2026-07';
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-months-cache-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;
  const matchingFingerprint = producerFingerprint();

  const writeCachedEntry = (fingerprintValue, includeFingerprint = true) => {
    const meta = {
      scanTruncated: false,
      openclawStatus: 'ready',
      hermesStatus: 'ready',
      claudeCodeStatus: 'ready',
    };
    const entry = {
      value: {
        source: 'combined.agent_usage',
        summary: { periodTokens: 0, periodUsd: 0, scanTruncated: false },
        meta,
      },
      time: Date.now(),
      detailed: true,
    };
    if (includeFingerprint) entry.producerFingerprint = fingerprintValue;
    fs.writeFileSync(path.join(cacheDir, 'costs-cache.json'), JSON.stringify({
      [`costs:month:${month}`]: entry,
    }));
  };

  const sources = {
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
  };

  try {
    const cases = [
      { label: 'matching', fingerprintValue: matchingFingerprint, expected: { month, hasData: false, sources: ['cached'] } },
      { label: 'different', fingerprintValue: `${matchingFingerprint}|different`, expected: { month, hasData: false, sources: [], unknown: true } },
      { label: 'missing', includeFingerprint: false, expected: { month, hasData: false, sources: [], unknown: true } },
    ];
    for (const testCase of cases) {
      writeCachedEntry(testCase.fingerprintValue, testCase.includeFingerprint);
      await withCostsApp(sources, async (base) => {
        const body = await (await fetch(`${base}/api/costs/months`)).json();
        assert.deepEqual(body.months.find((entry) => entry.month === month), testCase.expected, testCase.label);
      });
    }
  } finally {
    if (previousCacheDir === undefined) delete process.env.MC_COSTS_CACHE_DIR;
    else process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('confirmed-empty evidence expires after CONFIRMED_EMPTY_TTL_MS', async () => {
  const month = '2026-07';
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-months-cache-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;
  const matchingFingerprint = producerFingerprint();
  const sources = {
    now: () => new Date(FIXED_CACHE_NOW),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
  };

  const writeCachedEntry = ({ time, periodTokens = 0, periodUsd = 0 }) => {
    fs.writeFileSync(path.join(cacheDir, 'costs-cache.json'), JSON.stringify({
      [`costs:month:${month}`]: {
        value: {
          source: 'combined.agent_usage',
          summary: { periodTokens, periodUsd, scanTruncated: false },
          meta: {
            scanTruncated: false,
            openclawStatus: 'ready',
            hermesStatus: 'ready',
            claudeCodeStatus: 'ready',
          },
        },
        time,
        detailed: true,
        producerFingerprint: matchingFingerprint,
      },
    }));
  };

  const readMonth = async () => withCostsApp(sources, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    return body.months.find((entry) => entry.month === month);
  });

  try {
    await withDateNow(FIXED_CACHE_NOW, async () => {
      writeCachedEntry({ time: FIXED_CACHE_NOW - CONFIRMED_EMPTY_TTL_MS - 1 });
      assert.deepEqual(await readMonth(), {
        month,
        hasData: false,
        sources: [],
        unknown: true,
      });

      writeCachedEntry({ time: FIXED_CACHE_NOW - CONFIRMED_EMPTY_TTL_MS + 1 });
      assert.deepEqual(await readMonth(), {
        month,
        hasData: false,
        sources: ['cached'],
      });

      writeCachedEntry({ time: FIXED_CACHE_NOW - CONFIRMED_EMPTY_TTL_MS - 1, periodTokens: 1 });
      assert.deepEqual(await readMonth(), {
        month,
        hasData: true,
        sources: ['cached'],
      });
    });
  } finally {
    if (previousCacheDir === undefined) delete process.env.MC_COSTS_CACHE_DIR;
    else process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('producer paths never reach the API payload', async () => {
  const month = '2026-07';
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-costs-months-cache-'));
  const previousCacheDir = process.env.MC_COSTS_CACHE_DIR;
  process.env.MC_COSTS_CACHE_DIR = cacheDir;
  const matchingFingerprint = producerFingerprint();
  fs.writeFileSync(path.join(cacheDir, 'costs-cache.json'), JSON.stringify({
    [`costs:month:${month}`]: {
      value: {
        source: 'combined.agent_usage',
        period: {
          key: 'month',
          anchor: month,
          start: '2026-07-01',
          end: '2026-07-31',
        },
        summary: { periodTokens: 0, periodUsd: 0, scanTruncated: false },
        daily: [],
        dailyByModel: [],
        modelKeys: [],
        byService: [],
        agents: [],
        meta: {
          scanTruncated: false,
          openclawStatus: 'ready',
          hermesStatus: 'ready',
          claudeCodeStatus: 'no_usage',
          producerFingerprint: matchingFingerprint,
        },
      },
      time: FIXED_CACHE_NOW - 1000,
      detailed: true,
    },
  }));

  const sources = {
    now: () => new Date(FIXED_CACHE_NOW),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
  };

  try {
    await withDateNow(FIXED_CACHE_NOW, async () => {
      await withCostsApp(sources, async (base) => {
        const monthsBody = await (await fetch(`${base}/api/costs/months`)).json();
        assert.deepEqual(monthsBody.months.find((entry) => entry.month === month), {
          month,
          hasData: false,
          sources: ['cached'],
        }, 'legacy meta fingerprint must be hoisted to the cache entry for confirmation');

        const response = await fetch(`${base}/api/costs?period=month&month=${month}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        const serialized = JSON.stringify(result);
        assert.equal(Object.prototype.hasOwnProperty.call(result.meta || {}, 'producerFingerprint'), false);
        assert.equal(serialized.includes('producerFingerprint'), false);
        assert.equal(serialized.includes(matchingFingerprint), false);
      });
    });
  } finally {
    if (previousCacheDir === undefined) delete process.env.MC_COSTS_CACHE_DIR;
    else process.env.MC_COSTS_CACHE_DIR = previousCacheDir;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('a cached confirmed-empty result never disables the mutable current month', async () => {
  const current = '2026-08';

  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: () => cleanCachedDetailedMonths({ confirmedEmpty: [current] }),
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    const currentEntry = body.months.find((entry) => entry.month === current);

    assert.deepEqual(currentEntry, {
      month: current,
      hasData: false,
      sources: [],
      unknown: true,
    });
  });
});

test('the partially covered CodexBar floor month remains unknown and marks the response partial', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.partial, true);
    assert.equal(body.months.find((entry) => entry.month === '2026-06').unknown, true);
  });
});

test('month availability distinguishes unconfigured producers from unavailable ones', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => { throw new Error('must not run'); },
    codexbar: async () => { throw new Error('schema drift'); },
    hermesConfigured: () => false,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.deepEqual(body.sourceStatus, { hermes: 'not_configured', codexbar: 'unavailable', cached: 'no_usage' });
    assert.equal(body.months[0].unknown, true);
  });
});

test('an unconfigured CodexBar producer is not reported as a flaky unavailable source', async () => {
  let codexbarCalls = 0;
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => { codexbarCalls += 1; return []; },
    hermesConfigured: () => true,
    codexbarConfigured: () => false,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.sourceStatus.codexbar, 'not_configured');
    assert.equal(codexbarCalls, 0);
  });
});

test('malformed CodexBar results are unavailable rather than settled no_usage', async () => {
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => [],
    codexbar: async () => { throw new Error('CodexBar returned an invalid usage report'); },
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const body = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(body.sourceStatus.codexbar, 'unavailable');
    assert.notEqual(body.sourceStatus.codexbar, 'no_usage');
  });
});

test('month availability deduplicates concurrent source scans', async () => {
  let hermesCalls = 0;
  let releaseHermes;
  const hermesGate = new Promise((resolve) => { releaseHermes = resolve; });
  await withCostsApp({
    now: () => new Date('2026-08-15T12:00:00'),
    hermes: async () => {
      hermesCalls += 1;
      await hermesGate;
      return [];
    },
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const first = fetch(`${base}/api/costs/months`);
    const second = fetch(`${base}/api/costs/months`);
    await new Promise((resolve) => setImmediate(resolve));
    releaseHermes();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(hermesCalls, 1);
  });
});

test('the producer fingerprint is stamped ONLY at the cache-entry level', () => {
  // The route-level leak test above exercises the cached-serve path, but a
  // fresh detailed scan serves its result object directly and the producers
  // are exec-based, so that path cannot be driven from a unit test. Guard the
  // regression avenue structurally instead: the only `producerFingerprint()`
  // stamping site in the source must be the setCostsCache ENTRY literal —
  // a second stamping site (e.g. back into response meta) turns this red.
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  const stampSites = routeSource.match(/producerFingerprint:\s*producerFingerprint\(\)/g) || [];
  assert.equal(
    stampSites.length,
    1,
    'exactly one fingerprint stamping site is allowed: the cache-entry literal; response meta must never carry it',
  );
  assert.match(
    routeSource,
    /setCostsCache\(cacheKey, \{\s*value: costsResult,\s*time: Date\.now\(\),\s*detailed: true,\s*producerFingerprint: producerFingerprint\(\),?\s*\}\)/,
    'the sole stamping site must be the fresh-detailed cache entry, not a meta object',
  );
});

test('Hermes month query excludes zero-token and zero-spend sessions', () => {
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(routeSource, /COALESCE\(input_tokens, 0\).*COALESCE\(actual_cost_usd, estimated_cost_usd, 0\) > 0/s);
});

test('month availability cache is invalidated when the server month rolls over', () => {
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(
    routeSource,
    /monthsAvailabilityCache\.month === monthKeyOf\(nowForMonth\(\)\)/,
    'a cache generated just before a month rollover must not confirm the new current month empty',
  );
  assert.match(
    routeSource,
    /monthsAvailabilityCache = \{ time: Date\.now\(\), month: current, value \}/,
    'the cache must record which server month generated its availability result',
  );
});

test('a scan that crosses the month rollover is not cached under the new month', async () => {
  const routeSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'costs.js'), 'utf8');
  assert.match(
    routeSource,
    /monthKeyOf\(nowForMonth\(\)\) !== current/,
    'a scan that crosses the rollover must trigger a fresh computation',
  );
  assert.match(
    routeSource,
    /if \(crossedMonth\) return value;/,
    'a second rollover during the rebuild must return without caching',
  );
  assert.match(
    routeSource,
    /monthsAvailabilityCache = \{ time: Date\.now\(\), month: current, value \}/,
    'the cache tag must use the generation month rather than the completion clock',
  );
  assert.doesNotMatch(
    routeSource,
    /monthsAvailabilityCache = \{ time: Date\.now\(\), month: monthKeyOf\(new Date\(\)\), value \}/,
    'a completion-time month must never tag the generated value',
  );

  let clock = new Date('2026-08-31T23:59:59');
  let releaseFirstScan;
  const firstScan = new Promise((resolve) => { releaseFirstScan = resolve; });
  let hermesCalls = 0;

  await withCostsApp({
    now: () => new Date(clock),
    hermes: async () => {
      hermesCalls += 1;
      if (hermesCalls === 1) await firstScan;
      return [clock.toISOString().slice(0, 7)];
    },
    codexbar: async () => [],
    hermesConfigured: () => true,
    codexbarConfigured: () => true,
    cachedDetailedMonths: emptyCachedDetailedMonths,
  }, async (base) => {
    const request = fetch(`${base}/api/costs/months`);
    await new Promise((resolve) => {
      const waitForScan = () => {
        if (hermesCalls > 0) return resolve();
        return setImmediate(waitForScan);
      };
      waitForScan();
    });
    clock = new Date('2026-09-01T00:00:01');
    releaseFirstScan();

    const body = await (await request).json();
    assert.equal(body.months[0].month, '2026-09');
    assert.equal(hermesCalls, 2, 'the rollover must rerun the source scan once');

    const cachedBody = await (await fetch(`${base}/api/costs/months`)).json();
    assert.equal(cachedBody.months[0].month, '2026-09');
    assert.equal(hermesCalls, 2, 'the rebuilt result must be cached under the generation month');
  });
});
