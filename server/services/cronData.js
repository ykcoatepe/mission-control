const fs = require('fs');
const path = require('path');
const { httpError } = require('../core/http');
const { randomUUID } = require('node:crypto');
const { homeRelativePath } = require('../core/scrub');
const { redactString } = require('../core/config');
const { CALENDAR_EDITABLE_FIELDS, CRON_OVERRIDABLE_FIELDS, CRON_OWNED_FIELDS, entryIssue, assertCalendarEntry, partitionCalendarEntries } = require('./calendarEntrySchema');

function writeFileAtomic(filePath, content, { fsImpl = fs, mode } = {}) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const existingMode = mode ?? (fsImpl.existsSync(filePath) ? fsImpl.statSync(filePath).mode & 0o777 : 0o600);
  try {
    fsImpl.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fsImpl.chmodSync(tmpPath, existingMode);
    fsImpl.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fsImpl.rmSync(tmpPath, { force: true }); } catch {}
    throw error;
  }
}

function writeJsonFileAtomic(filePath, value, options) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

// Date's finite domain is smaller than Number's. Never coerce arrays, booleans
// or objects into upstream timestamps, and check numeric bounds before Date.
function dateMsOrNull(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return null;
  } else if (typeof value !== 'string' || !value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dateIsoOrNull(value) {
  const ms = dateMsOrNull(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function normalizeOpenclawCronJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return { scheduler: 'openclaw', id: null, sourceId: null };
  return { ...job, scheduler: 'openclaw', sourceId: job.id };
}

function parseJsonCandidates(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return [];

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const normalized = String(candidate || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(text);
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd >= objStart) {
    pushCandidate(text.slice(objStart, objEnd + 1));
  }
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd >= arrStart) {
    pushCandidate(text.slice(arrStart, arrEnd + 1));
  }

  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) depth += 1;
      if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          pushCandidate(text.slice(start, end + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function parseFirstJson(raw = '', fallback = null) {
  const text = String(raw || '').trim();
  if (!text) return fallback;

  try {
    return JSON.parse(text);
  } catch {}

  const candidates = parseJsonCandidates(raw);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  const jsonIdx = text.indexOf('{"jobs"');
  if (jsonIdx !== -1) {
    const start = text.lastIndexOf('{', jsonIdx);
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        return JSON.parse(candidate);
      } catch {}
    }
  }
  return fallback;
}

function extractJsonPayload(raw = '') {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Empty JSON payload');

  const unwrapCronJobs = (parsed) => {
    if (Array.isArray(parsed)) return { jobs: parsed };
    if (!parsed || typeof parsed !== 'object') return null;

    const queue = [parsed];
    const visited = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);

      if (Array.isArray(current.jobs)) return current === parsed ? parsed : { jobs: current.jobs };

      for (const key of ['result', 'details', 'payload', 'data']) {
        const next = current[key];
        if (next && typeof next === 'object') queue.push(next);
      }
    }

    return null;
  };

  const parsed = parseFirstJson(raw);
  if (parsed) {
    const unwrapped = unwrapCronJobs(parsed);
    if (unwrapped) return unwrapped;
  }

  throw new Error('No cron jobs JSON found in CLI output');
}

function parseCronTableOutput(output) {
  const lines = (output || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0];
  const colStarts = [];
  for (let index = 0; index < header.length; index += 1) {
    if (header[index] !== ' ' && (index === 0 || header[index - 1] === ' ')) {
      colStarts.push(index);
    }
  }

  const jobs = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.startsWith('=') || !line.match(/^[0-9a-f]/)) continue;

    const parts = [];
    for (let cursor = 0; cursor < colStarts.length - 1; cursor += 1) {
      parts.push(line.slice(colStarts[cursor], colStarts[cursor + 1]).trim());
    }
    parts.push(line.slice(colStarts[colStarts.length - 1]).trim());

    if (!parts[0] || !parts[0].match(/^[0-9a-f]{8}/)) continue;

    const parseRelative = (value) => {
      if (!value || value === '—' || value === '-' || value === 'never') return null;
      const now = Date.now();
      const future = value.match(/^in\s+(\d+)([mhd])/);
      if (future) {
        const amount = Number.parseInt(future[1], 10);
        const unit = future[2];
        const offset = unit === 'm' ? amount * 60000 : unit === 'h' ? amount * 3600000 : amount * 86400000;
        return dateIsoOrNull(now + offset);
      }
      const past = value.match(/^(\d+)([mhd])\s+ago$/);
      if (past) {
        const amount = Number.parseInt(past[1], 10);
        const unit = past[2];
        const offset = unit === 'm' ? amount * 60000 : unit === 'h' ? amount * 3600000 : amount * 86400000;
        return dateIsoOrNull(now - offset);
      }
      return null;
    };

    jobs.push({
      id: parts[0],
      name: parts[1] || 'Unnamed',
      schedule: { expr: parts[2] || '?' },
      state: {
        lastStatus: (parts[5] || '').toLowerCase(),
        lastRunAtMs: parseRelative(parts[4]) ? new Date(parseRelative(parts[4])).getTime() : null,
        nextRunAtMs: parseRelative(parts[3]) ? new Date(parseRelative(parts[3])).getTime() : null,
      },
      sessionTarget: parts[6] || 'isolated',
      model: parts[8] || '',
      enabled: String(parts[5] || '').toLowerCase() !== 'disabled',
      payload: { kind: 'agentTurn' },
    });
  }

  return jobs;
}

// Live structure inventory (2026-11-11): Hermes cron(expr/display),
// interval(minutes/display), once(run_at/display); OpenClaw cron(expr with
// optional tz/staggerMs), every(everyMs/anchorMs). Other supported units are
// explicit conversions; unrecognised kinds never become a made-up cron kind.
function describeCronSchedule(job = {}) {
  const raw = job.schedule;
  const kind = typeof raw?.kind === 'string' ? raw.kind.toLowerCase() : null;
  const display = [raw?.display, job.schedule_display].find(value => typeof value === 'string' && value.trim() && !['?', 'every'].includes(value.trim().toLowerCase())) || null;
  const unknown = { schedule: display, scheduleKind: 'unknown', everyMs: null, atIso: null };
  if (kind === 'every' || kind === 'interval' || raw === 'every') {
    const candidates = [[raw?.everyMs, 1], [raw?.seconds, 1000], [raw?.minutes, 60000], [raw?.hours, 3600000]];
    const fromDisplay = display?.match(/^every\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
    if (fromDisplay) candidates.push([Number(fromDisplay[1]), { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[fromDisplay[2].toLowerCase()]]);
    const everyMs = candidates.map(([value, scale]) => typeof value === 'number' ? value * scale : null)
      .find(value => Number.isSafeInteger(value) && value > 0);
    if (!everyMs) return unknown;
    const units = [[86400000, 'd'], [3600000, 'h'], [60000, 'm'], [1000, 's'], [1, 'ms']];
    const [size, suffix] = units.find(([size]) => everyMs % size === 0);
    return { schedule: `every ${everyMs / size}${suffix}`, scheduleKind: 'interval', everyMs, atIso: null };
  }
  if (kind === 'once' || kind === 'at') {
    const at = raw?.run_at ?? raw?.at;
    const atIso = dateIsoOrNull(at);
    return { schedule: display || (atIso && typeof at === 'string' ? at : atIso), scheduleKind: 'at', everyMs: null, atIso };
  }
  const expression = raw?.expr || (typeof raw === 'string' ? raw : null);
  if ((kind === 'cron' || !kind) && typeof expression === 'string' && expression.trim() && !['?', 'every'].includes(expression.trim().toLowerCase())) {
    return { schedule: expression, scheduleKind: 'cron', everyMs: null, atIso: null };
  }
  return unknown;
}

function createCronService({
  openclawExec,
  gatewayPort,
  gatewayToken,
  getOpenclawDefaultModelKey,
  calendarFile,
  homeDir = process.env.MC_USER_HOME || process.env.HOME || '/Users/yordamkocatepe',
  hermesProfile = process.env.HERMES_PROFILE || 'hmudur',
  now = Date.now,
  freshMs = 5 * 60 * 1000,
  maxStaleMs = 10 * 60 * 1000,
  // Below the Operations source timeout (10s) so one slow scheduler probe
  // never takes the whole cron reader (and the Hermes proof) down with it.
  operationsSoftDeadlineMs = 7000,
  fetchImpl = (...args) => fetch(...args),
  fsImpl = fs,
}) {
  const fs = fsImpl;
  const openclawCronRunsDir = path.join(homeDir, '.openclaw', 'cron', 'runs');
  const hermesCronJobsFile = path.join(homeDir, '.hermes', 'profiles', hermesProfile, 'cron', 'jobs.json');
  const maxHistoryRuns = 10;

  function normalizeCronRunStatus(job = {}) {
    if (job.enabled === false) return 'disabled';
    const raw = String(job.state?.lastStatus || job.state?.lastRunStatus || '').trim().toLowerCase();
    if (['ok', 'active', 'running', 'success'].includes(raw)) return 'active';
    if (['failed', 'error', 'errored'].includes(raw)) return 'failed';
    if (typeof job.state?.nextRunAtMs === 'number' && dateMsOrNull(job.state.nextRunAtMs) !== null) return 'scheduled';
    return 'idle';
  }

  function readRunHistory(jobId = '', scheduler = 'openclaw') {
    if (scheduler !== 'openclaw') return [];
    const runFile = path.join(openclawCronRunsDir, `${jobId}.jsonl`);
    try {
      const content = fs.readFileSync(runFile, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const runs = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line.trim());
          runs.push({
            ts: entry.ts || entry.runAtMs || null,
            status: entry.status || 'unknown',
            durationMs: entry.durationMs || null,
            runAtMs: entry.runAtMs || null,
            error: entry.error || null,
          });
        } catch {}
      }
      return runs.reverse().slice(0, maxHistoryRuns);
    } catch {
      return [];
    }
  }

  function isHermesJob(job = {}) {
    return String(job.scheduler || job.source || '').toLowerCase() === 'hermes';
  }

  function isOpenclawJob(job = {}) {
    return !isHermesJob(job);
  }

  function getCronJobSourceId(job = {}) {
    return String(job.sourceId || job.id || '');
  }

  function getCronJobApiId(job = {}) {
    const scheduler = isHermesJob(job) ? 'hermes' : 'openclaw';
    const sourceId = getCronJobSourceId(job);
    return sourceId.includes(':') ? sourceId : `${scheduler}:${sourceId}`;
  }

  function getCronJobActions(job = {}) {
    if (isHermesJob(job)) {
      return { run: false, toggle: true, delete: false, model: true };
    }
    return { run: true, toggle: true, delete: true, model: true };
  }

  function mapCronJobForApi(job = {}) {
    if (!job || typeof job.id !== 'string' || !job.id.trim()) return null;
    const scheduler = isHermesJob(job) ? 'hermes' : 'openclaw';
    const sourceId = getCronJobSourceId(job);
    return {
      id: getCronJobApiId(job),
      sourceId,
      name: job.name || String(job.id || '').substring(0, 8) || 'Unnamed job',
      scheduler,
      schedulerLabel: scheduler === 'hermes' ? 'Hermes' : 'OpenClaw',
      ...describeCronSchedule(job),
      status: normalizeCronRunStatus(job),
      lastRun: typeof job.state?.lastRunAtMs === 'number' ? dateIsoOrNull(job.state.lastRunAtMs) : null,
      nextRun: typeof job.state?.nextRunAtMs === 'number' ? dateIsoOrNull(job.state.nextRunAtMs) : null,
      duration: job.state?.lastDurationMs ? `${job.state.lastDurationMs}ms` : null,
      target: job.sessionTarget || 'main',
      payload: job.payload?.kind || '?',
      model: job.payload?.model || job.model || (scheduler === 'openclaw' ? getOpenclawDefaultModelKey() : '') || '',
      thinking: job.payload?.thinking || '',
      description: [job.payload?.text, job.payload?.message, job.prompt].find(value => typeof value === 'string')?.substring(0, 120) || '',
      history: readRunHistory(sourceId, scheduler),
      enabled: job.enabled !== false,
      actions: getCronJobActions(job),
    };
  }

  function toMsOrNull(value) {
    return dateMsOrNull(value);
  }

  function normalizeHermesCronJob(job = {}) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) return { scheduler: 'hermes', id: null, sourceId: null };
    const lastStatus = job.last_status || job.lastStatus || job.state;
    return {
      ...job,
      scheduler: 'hermes',
      sourceId: job.id,
      schedule: job.schedule,
      sessionTarget: job.deliver || job.sessionTarget || 'origin',
      payload: {
        kind: job.prompt ? 'agentTurn' : (job.payload?.kind || 'cron'),
        message: job.prompt || job.payload?.message || '',
        model: [job.provider, job.model].filter(Boolean).join('/') || job.model || '',
        thinking: job.thinking || job.payload?.thinking || '',
      },
      state: {
        lastRunAtMs: toMsOrNull(job.last_run_at || job.lastRunAt),
        nextRunAtMs: toMsOrNull(job.next_run_at || job.nextRunAt),
        lastStatus,
        lastRunStatus: lastStatus,
        lastDurationMs: job.last_duration_ms || job.lastDurationMs || null,
      },
    };
  }

  function readHermesCronJobsFromDisk() {
    try {
      const parsed = JSON.parse(fs.readFileSync(hermesCronJobsFile, 'utf8'));
      const jobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
      return jobs.map((job) => normalizeHermesCronJob(job));
    } catch {
      return [];
    }
  }

  function readHermesCronJobsEvidence() {
    try {
      const parsed = JSON.parse(fs.readFileSync(hermesCronJobsFile, 'utf8'));
      const rawJobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
      if (!Array.isArray(rawJobs)) throw new Error('Hermes cron payload missing jobs');
      const stat = fs.statSync(hermesCronJobsFile);
      return {
        jobs: rawJobs.map((job) => normalizeHermesCronJob(job)),
        sourceSucceeded: true,
        provenance: 'hermes-cron-disk',
        observedAt: stat.mtime.toISOString(),
      };
    } catch {
      return {
        jobs: [],
        sourceSucceeded: false,
        provenance: 'hermes-cron-unavailable',
        observedAt: null,
      };
    }
  }

  function splitHermesModelRef(modelRef = '') {
    const normalized = String(modelRef || '').trim();
    if (!normalized || normalized === 'default') return { provider: null, model: null, base_url: null };
    if (normalized === 'custom/qwen3.6:35b-a3b-nvfp4' || normalized === 'ollama/qwen3.6:35b-a3b-nvfp4') {
      return { provider: 'custom', model: 'qwen3.6:35b-a3b-nvfp4', base_url: 'http://127.0.0.1:11434/v1' };
    }
    if (normalized === 'openai-codex/gpt-5.5' || normalized === 'openai-codex/openai/gpt-5.5' || normalized === 'openai/gpt-5.5') {
      return { provider: 'openai-codex', model: 'openai/gpt-5.5', base_url: null };
    }
    const slash = normalized.indexOf('/');
    if (slash > 0) {
      const provider = normalized.slice(0, slash);
      const model = normalized.slice(slash + 1);
      if (provider === 'openai-codex') return { provider, model, base_url: null };
      if (provider === 'custom' || provider === 'ollama') return { provider: 'custom', model, base_url: 'http://127.0.0.1:11434/v1' };
      return { provider, model, base_url: null };
    }
    return { provider: null, model: normalized, base_url: null };
  }

  function patchHermesCronJob(sourceId = '', patch = {}) {
    let parsed;
    let jobs;
    try {
      parsed = JSON.parse(fs.readFileSync(hermesCronJobsFile, 'utf8'));
      jobs = Array.isArray(parsed) ? parsed : parsed?.jobs;
      if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job !== 'object' || Array.isArray(job) || typeof job.id !== 'string')) throw new Error('Invalid jobs');
    } catch {
      throw httpError(409, 'hermes_cron_unavailable', 'Hermes cron data is unreadable; no changes were made');
    }
    const index = jobs.findIndex((candidate) => String(candidate.id) === String(sourceId));
    if (index === -1) {
      throw httpError(404, 'hermes_cron_job_not_found', 'Hermes cron job not found');
    }

    const nextJob = { ...jobs[index], ...patch };
    const nextJobs = jobs.slice();
    nextJobs[index] = nextJob;
    const output = Array.isArray(parsed) ? nextJobs : { ...parsed, jobs: nextJobs };
    writeJsonFileAtomic(hermesCronJobsFile, output, { fsImpl: fs });
    return normalizeHermesCronJob(nextJob);
  }

  function updateHermesCronJobModel(sourceId = '', modelRef = '') {
    const next = splitHermesModelRef(modelRef);
    return patchHermesCronJob(sourceId, {
      provider: next.provider,
      model: next.model,
      base_url: next.base_url,
    });
  }

  function updateHermesCronJobEnabled(sourceId = '', enabled = true) {
    return patchHermesCronJob(sourceId, { enabled: enabled !== false });
  }


  async function fetchOpenclawCronJobsEvidence({ acceptEmpty = true } = {}) {
    try {
      const { stdout, stderr } = await openclawExec(['cron', 'list', '--json', '--all'], 15000);
      const raw = [stdout, stderr].filter(Boolean).join('\n');
      if (raw.trim()) {
        try {
          const result = extractJsonPayload(raw);
          const jobs = Array.isArray(result) ? result : (Array.isArray(result?.jobs) ? result.jobs : []);
          if (!acceptEmpty && jobs.length === 0) throw new Error('Empty cron JSON');
          return {
            jobs: jobs.map(normalizeOpenclawCronJob),
            sourceSucceeded: true,
            provenance: 'openclaw-cron-cli-json',
            observedAt: new Date().toISOString(),
          };
        } catch {}
      }
    } catch {}

    try {
      const { stdout } = await openclawExec(['cron', 'list'], 15000);
      const jobs = parseCronTableOutput(stdout);
      if (!jobs.length && !String(stdout || '').split('\n').some(line => /^No cron jobs\b/i.test(line.trim()))) throw new Error('Unrecognized cron table');
      if (!acceptEmpty && jobs.length === 0) throw new Error('Empty cron table');
      return {
        jobs: jobs.map(normalizeOpenclawCronJob),
        sourceSucceeded: true,
        provenance: 'openclaw-cron-cli-table',
        observedAt: new Date().toISOString(),
      };
    } catch {}

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          tool: 'cron',
          args: { action: 'list' },
        }),
      });
      if (!response.ok) throw new Error('OpenClaw cron gateway unavailable');
      const data = await response.json();
      const details = data?.result?.details;
      if (details?.jobs || Array.isArray(details)) {
        const jobs = Array.isArray(details) ? details : details.jobs;
        return {
          jobs: (jobs || []).map(normalizeOpenclawCronJob),
          sourceSucceeded: true,
          provenance: 'openclaw-cron-gateway',
          observedAt: new Date().toISOString(),
        };
      }
      const textResult = data?.result?.content?.[0]?.text || '{}';
      const result = extractJsonPayload(textResult);
      const jobs = Array.isArray(result) ? result : (Array.isArray(result?.jobs) ? result.jobs : []);
      return {
        jobs: jobs.map(normalizeOpenclawCronJob),
        sourceSucceeded: true,
        provenance: 'openclaw-cron-gateway',
        observedAt: new Date().toISOString(),
      };
    } catch {
      return {
        jobs: [],
        sourceSucceeded: false,
        provenance: 'openclaw-cron-unavailable',
        observedAt: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOpenclawCronJobsLive() {
    return (await fetchOpenclawCronJobsEvidence({ acceptEmpty: false })).jobs;
  }

  async function fetchCronJobsLive() {
    const [openclawJobs, hermesJobs] = await Promise.all([
      fetchOpenclawCronJobsLive().catch(() => []),
      Promise.resolve(readHermesCronJobsFromDisk()).catch(() => []),
    ]);
    return { jobs: [...openclawJobs, ...hermesJobs] };
  }

  // Per-scheduler evidence cache: shared in-flight probe, last good result,
  // soft deadline. Fresh while younger than freshMs; stale (flagged) until
  // maxStaleMs; unavailable only beyond that or with no cache at all.
  function createEvidenceCache(name, read) {
    let lastGood = null;
    let inFlight = null;
    const unavailableEvidence = () => ({
      jobs: [],
      sourceSucceeded: false,
      provenance: `${name}-cron-unavailable`,
      observedAt: null,
    });

    function refresh() {
      if (!inFlight) {
        inFlight = Promise.resolve()
          .then(read)
          .then((evidence) => {
            if (evidence?.sourceSucceeded) lastGood = { evidence, at: now() };
            return evidence;
          })
          .catch(() => unavailableEvidence())
          .finally(() => { inFlight = null; });
      }
      return inFlight;
    }

    function cached() {
      if (!lastGood) return null;
      const ageMs = now() - lastGood.at;
      if (ageMs > maxStaleMs) return null;
      if (ageMs <= freshMs) return { ...lastGood.evidence, cacheAgeMs: ageMs };
      return { ...lastGood.evidence, stale: true, staleAgeMs: ageMs };
    }

    async function get(softDeadlineMs) {
      const pending = refresh();
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), softDeadlineMs);
        timer.unref?.();
      });
      const evidence = await Promise.race([pending, deadline]);
      clearTimeout(timer);
      if (evidence?.sourceSucceeded) return evidence;
      return cached() || evidence || unavailableEvidence();
    }

    return { get };
  }

  const openclawEvidenceCache = createEvidenceCache('openclaw', () => fetchOpenclawCronJobsEvidence());
  const hermesEvidenceCache = createEvidenceCache('hermes', () => readHermesCronJobsEvidence());

  async function fetchCronJobsForOperations() {
    const [openclaw, hermes] = await Promise.all([
      openclawEvidenceCache.get(operationsSoftDeadlineMs),
      hermesEvidenceCache.get(operationsSoftDeadlineMs),
    ]);
    const observedTimes = [openclaw.observedAt, hermes.observedAt]
      .filter(Boolean)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite);
    const observedAt = observedTimes.length
      ? new Date(Math.max(...observedTimes)).toISOString()
      : null;
    const sourceProof = ({
      sourceSucceeded, provenance, observedAt: sourceObservedAt, stale, staleAgeMs, cacheAgeMs,
    }) => ({
      sourceSucceeded,
      provenance,
      observedAt: sourceObservedAt,
      ...(stale ? { stale: true, staleAgeMs } : {}),
      ...(cacheAgeMs !== undefined ? { cacheAgeMs } : {}),
      // The cache limits travel with the proof, so a holder of this reading
      // (the Operations cron source) ages it against the same limits.
      freshMs,
      maxStaleMs,
    });
    return {
      jobs: [...openclaw.jobs, ...hermes.jobs],
      operationsSource: {
        sourceSucceeded: openclaw.sourceSucceeded || hermes.sourceSucceeded,
        provenance: 'scheduler-readers',
        observedAt,
        schedulers: {
          openclaw: sourceProof(openclaw),
          hermes: sourceProof(hermes),
        },
      },
    };
  }

  function toIsoOrNull(value) {
    return dateIsoOrNull(value);
  }

  function normalizeCalendarEntry(entry = {}, nowIso = new Date().toISOString()) {
    assertCalendarEntry(entry);
    return {
      id: String(entry.id || `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      title: String(entry.title || 'Untitled').trim() || 'Untitled',
      schedule: entry.schedule === null ? null : (entry.schedule || ''),
      scheduleKind: ['cron', 'interval', 'at', 'unknown'].includes(entry.scheduleKind) ? entry.scheduleKind : 'unknown',
      everyMs: entry.everyMs ?? null,
      atIso: entry.atIso ?? null,
      startsAt: toIsoOrNull(entry.startsAt),
      status: String(entry.status || 'scheduled'),
      assignee: String(entry.assignee || 'Mudur'),
      source: String(entry.source || 'manual'),
      linkedTaskId: entry.linkedTaskId || null,
      linkedJobId: entry.linkedJobId || null,
      notes: String(entry.notes || ''),
      createdAt: toIsoOrNull(entry.createdAt) || nowIso,
      updatedAt: toIsoOrNull(entry.updatedAt) || nowIso,
      lastSyncedAt: toIsoOrNull(entry.lastSyncedAt) || toIsoOrNull(entry.updatedAt) || nowIso,
      userOverrides: Array.isArray(entry.userOverrides)
        ? [...new Set(entry.userOverrides.filter(field => (entry.source === 'cron' ? CRON_OVERRIDABLE_FIELDS : CALENDAR_EDITABLE_FIELDS).includes(field)))] : [],
      cronDerived: entry.source === 'cron' && entry.cronDerived && typeof entry.cronDerived === 'object'
        ? Object.fromEntries(CRON_OVERRIDABLE_FIELDS.filter(field => Object.hasOwn(entry.cronDerived, field))
          .map(field => [field, entry.cronDerived[field]])) : null,
    };
  }

  function sortCalendarEntries(entries = []) {
    return [...entries].sort((left, right) => {
      const leftTime = left.startsAt ? new Date(left.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.startsAt ? new Date(right.startsAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.title || '').localeCompare(String(right.title || ''));
    });
  }

  function readCalendarDocument({ withRaw = false } = {}) {
    let raw;
    try { raw = fs.readFileSync(calendarFile); } catch (error) {
      if (error.code === 'ENOENT') {
        const document = { entries: [], updatedAt: null, lastCronSyncAt: null };
        return withRaw ? { document, raw: null } : document;
      }
      throw httpError(409, 'calendar_unavailable', 'Calendar data is unreadable; no changes were made');
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      const payload = Array.isArray(parsed) ? { entries: parsed } : parsed;
      if (!payload || !Array.isArray(payload.entries)) throw new Error('Invalid calendar document');
      return withRaw ? { document: payload, raw } : payload;
    } catch {
      throw httpError(409, 'calendar_unavailable', 'Calendar data is unreadable; no changes were made');
    }
  }

  function readCalendarDataSafe({ strict = false, tolerateEntries = false } = {}) {
    try {
      const payload = readCalendarDocument();
      const { valid, diagnostics } = partitionCalendarEntries(payload.entries);
      if (strict && !tolerateEntries && (diagnostics.quarantined.count || diagnostics.duplicates.count)) throw new Error('Calendar entries require correction');
      return {
        entries: sortCalendarEntries(valid.map(entry => normalizeCalendarEntry(entry))),
        updatedAt: toIsoOrNull(payload.updatedAt),
        lastCronSyncAt: toIsoOrNull(payload.lastCronSyncAt),
        diagnostics,
      };
    } catch (error) {
      if (strict) {
        throw httpError(409, 'calendar_unavailable', 'Calendar data is unreadable; no changes were made');
      }
      console.error('[Calendar read]', error.message);
      return { entries: [], updatedAt: null, lastCronSyncAt: null, error: error.message };
    }
  }

  function writeCalendarDataSafe(payload = {}, { originalDocument } = {}) {
    if (!Array.isArray(payload.entries)) throw httpError(400, 'calendar_entry_invalid', 'Calendar entries must be an array');
    payload.entries.forEach(entry => assertCalendarEntry(entry));
    const partition = partitionCalendarEntries(payload.entries);
    if (partition.duplicates.length) throw httpError(400, 'calendar_entry_invalid', 'Calendar entry IDs must be unique');
    const dir = path.dirname(calendarFile);
    const next = {
      ...originalDocument,
      entries: sortCalendarEntries(payload.entries.map(entry => normalizeCalendarEntry(entry))),
      updatedAt: toIsoOrNull(payload.updatedAt) || new Date().toISOString(),
      lastCronSyncAt: toIsoOrNull(payload.lastCronSyncAt),
    };
    next.entries.forEach(entry => assertCalendarEntry(entry));
    fs.mkdirSync(dir, { recursive: true });
    writeJsonFileAtomic(calendarFile, next, { fsImpl: fs });
    return next;
  }

  function repairCalendarData() {
    try {
      if (fs.lstatSync(calendarFile).isSymbolicLink()) throw httpError(409, 'calendar_symlink_unsupported', 'Repair requires a regular calendar file; no changes were made');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.status) throw error;
        throw httpError(409, 'calendar_unavailable', 'Calendar data is unreadable; no changes were made');
      }
    }
    const { document, raw } = readCalendarDocument({ withRaw: true });
    const { valid, quarantined, duplicates } = partitionCalendarEntries(document.entries);
    const counts = { kept: valid.length, quarantined: quarantined.length, duplicates: duplicates.length };
    if (!quarantined.length && !duplicates.length) return { ok: true, repaired: false, counts, backupPath: null };
    const repairedAt = new Date(now()).toISOString();
    const backup = `${calendarFile}.repair-${repairedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    const relative = file => {
      const publicPath = homeRelativePath(file, { homeDir, fsImpl: fs });
      return publicPath.startsWith('~') ? publicPath : path.join(path.basename(path.dirname(publicPath)), path.basename(publicPath));
    };
    try {
      // Commit the exact original bytes, including unknown root keys, before
      // replacing the source. Recovery files are always private (0600).
      // If the source rename fails, retain this backup and the original file.
      writeFileAtomic(backup, raw, { fsImpl: fs, mode: 0o600 });
      writeCalendarDataSafe({ entries: valid, updatedAt: repairedAt, lastCronSyncAt: document.lastCronSyncAt }, { originalDocument: document });
      const prefix = `${path.basename(calendarFile)}.repair-`;
      const backups = fs.readdirSync(path.dirname(calendarFile))
        .filter(name => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.json$/.test(name.slice(prefix.length)))
        .map(name => path.join(path.dirname(calendarFile), name))
        .filter(file => fs.lstatSync(file).isFile())
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
      // Keep the just-committed recovery point even on coarse timestamp FSs.
      const retainedOrder = [backup, ...backups.filter(file => file !== backup)];
      for (const old of retainedOrder.slice(10)) fs.unlinkSync(old);
      return { ok: true, repaired: true, counts, backupPath: relative(backup) };
    } catch {
      throw httpError(503, 'calendar_repair_failed', 'Calendar repair could not be committed safely');
    }
  }

  function mergeCalendarEntriesWithCronJobs(currentData = {}, cronJobs = [], syncedAtIso = new Date().toISOString()) {
    const entries = Array.isArray(currentData.entries)
      ? currentData.entries.map((entry) => normalizeCalendarEntry(entry, syncedAtIso))
      : [];
    const manualEntries = entries.filter((entry) => entry.source !== 'cron' || !entry.linkedJobId);
    const existingCronEntries = new Map(
      entries
        .filter((entry) => entry.linkedJobId)
        .map((entry) => [String(entry.linkedJobId), entry])
    );

    const issues = [];
    const seen = new Set();
    const syncedCronEntries = cronJobs.flatMap((job) => {
      const previous = existingCronEntries.get(String(job.id)) || {};
      const reject = (field, code = 'calendar_upstream_entry_invalid') => {
        issues.push({ id: typeof job.id === 'string' ? redactString(job.id).slice(0, 256) : null, code, field });
        // Keep a schema-valid last-good row when its upstream replacement is
        // unusable. Other jobs still refresh, and diagnostics stay in memory.
        return previous.id ? [previous] : [];
      };
      const sourceId = Object.hasOwn(job, 'sourceId') ? job.sourceId : job.id;
      if (typeof sourceId !== 'string' || !sourceId.trim() || typeof job.id !== 'string' || !job.id.trim() || job.id.length > 256) return reject('id');
      if (seen.has(job.id)) {
        issues.push({ id: redactString(job.id).slice(0, 256), code: 'calendar_upstream_duplicate_id', field: 'id' });
        return [];
      }
      seen.add(job.id);
      if (job.name !== undefined && entryIssue({ id: 'check', title: job.name })) return reject('title');
      for (const field of ['text', 'message']) {
        if (job.payload && Object.hasOwn(job.payload, field) && typeof job.payload[field] !== 'string') return reject(`payload.${field}`);
      }
      for (const field of ['lastRunAtMs', 'nextRunAtMs']) {
        if (job.state?.[field] != null && (typeof job.state[field] !== 'number' || dateMsOrNull(job.state[field]) === null)) return reject(field, 'calendar_upstream_timestamp_invalid');
      }
      for (const field of ['last_run_at', 'next_run_at', 'lastRunAt', 'nextRunAt']) {
        if (job[field] != null && dateMsOrNull(job[field]) === null) return reject(field, 'calendar_upstream_timestamp_invalid');
      }
      const schedule = describeCronSchedule(job);
      const cronDerived = {
        title: job.name || String(job.id || 'Cron job'),
        schedule: schedule.schedule,
        notes: job.payload?.text ?? job.payload?.message ?? '',
        assignee: 'Mudur',
      };
      const userOverrides = [...(previous.userOverrides || [])].filter(field => CRON_OVERRIDABLE_FIELDS.includes(field));
      // Preserve legacy manually assigned fields when first adding baselines.
      if (!previous.cronDerived && previous.assignee && previous.assignee !== 'Mudur') userOverrides.push('assignee');
      if (!previous.cronDerived && previous.notes && !job.payload) userOverrides.push('notes');
      const derived = {
        ...previous,
        ...cronDerived,
        scheduleKind: schedule.scheduleKind,
        everyMs: schedule.everyMs,
        atIso: schedule.atIso,
        id: previous.id || `cron-${job.id}`,
        startsAt: dateIsoOrNull(job.state?.nextRunAtMs),
        status: normalizeCronRunStatus(job),
        source: 'cron',
        linkedJobId: job.id,
        createdAt: previous.createdAt || syncedAtIso,
        updatedAt: syncedAtIso,
        lastSyncedAt: syncedAtIso,
        userOverrides: [...new Set(userOverrides)],
        cronDerived,
      };
      for (const field of derived.userOverrides) derived[field] = previous[field];
      // Validate the upstream baseline as well as the overlaid row: a user
      // override must not conceal an invalid scheduler value in cronDerived.
      const issue = entryIssue(derived);
      if (issue) return reject(issue);
      return [normalizeCalendarEntry(derived, syncedAtIso)];
    });

    return {
      entries: [...manualEntries, ...syncedCronEntries],
      updatedAt: syncedAtIso,
      lastCronSyncAt: syncedAtIso,
      upstream: { count: issues.length, ids: issues.map(issue => issue.id), issues },
    };
  }

  function syncCalendarWithCronEvidence(evidence) {
    const schedulers = evidence?.operationsSource?.schedulers || {};
    const observed = Object.keys(schedulers).filter(key => schedulers[key].sourceSucceeded && !schedulers[key].stale);
    if (!Array.isArray(evidence?.jobs) || !observed.length) {
      // Nothing fresh to sync from: a typed 503, and nothing is written.
      throw httpError(503, 'calendar_scheduler_unavailable', 'No fresh scheduler evidence; the calendar was not synced');
    }
    const stored = readCalendarDataSafe({ strict: true });
    const current = { ...stored, entries: stored.entries.map(entry => ({
      ...entry,
      linkedJobId: entry.source === 'cron' && entry.linkedJobId && !/^(openclaw|hermes):/.test(String(entry.linkedJobId))
        ? `openclaw:${entry.linkedJobId}` : entry.linkedJobId,
    })) };
    // Namespaced IDs prevent two schedulers with the same local ID colliding.
    const cronJobs = evidence.jobs.filter(job => observed.includes(job?.scheduler || 'openclaw'))
      .map(job => ({ ...job, sourceId: job?.sourceId ?? job?.id ?? null, id: getCronJobApiId(job || {}) }));
    const preserved = current.entries.filter(entry => {
      if (entry.source !== 'cron' || !entry.linkedJobId) return false;
      const scheduler = String(entry.linkedJobId).startsWith('hermes:') ? 'hermes' : 'openclaw';
      return !observed.includes(scheduler);
    });
    const merged = mergeCalendarEntriesWithCronJobs(current, cronJobs, new Date(now()).toISOString());
    merged.entries.push(...preserved);
    return { ...writeCalendarDataSafe(merged), upstream: merged.upstream };
  }

  async function syncCalendarWithLiveCron() {
    return syncCalendarWithCronEvidence(await fetchCronJobsForOperations());
  }

  function createCalendarEntry(payload = {}) {
    assertCalendarEntry(payload, 'create');
    const nowIso = new Date().toISOString();
    if (payload.linkedJobId != null) throw httpError(400, 'invalid_calendar_link', 'Scheduler-linked entries are created by cron sync');

    const current = readCalendarDataSafe({ strict: true });
    const entry = normalizeCalendarEntry({
      ...payload,
      id: `entry-${randomUUID()}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastSyncedAt: nowIso,
      userOverrides: [],
      cronDerived: null,
      scheduleKind: 'manual',
      everyMs: null,
    }, nowIso);

    const next = writeCalendarDataSafe({
      ...current,
      entries: [...current.entries, entry],
      updatedAt: nowIso,
      lastCronSyncAt: current.lastCronSyncAt,
    });

    return { ok: true, entry, entries: next.entries };
  }

  function updateCalendarEntry(id, payload = {}) {
    assertCalendarEntry(payload, 'patch');
    const current = readCalendarDataSafe({ strict: true });
    const idx = current.entries.findIndex((entry) => entry.id === id);
    if (idx < 0) {
      throw httpError(404, 'calendar_entry_not_found', 'Calendar entry not found');
    }

    const existing = current.entries[idx];
    const linked = existing.source === 'cron' && existing.linkedJobId;
    if (linked && CRON_OWNED_FIELDS.some(field => Object.hasOwn(payload, field))) {
      throw httpError(400, 'calendar_scheduler_owned', 'Status and next-run fields are owned by the scheduler');
    }
    const nowIso = new Date().toISOString();
    const editedFields = CALENDAR_EDITABLE_FIELDS.filter(field => Object.hasOwn(payload, field));
    const patch = Object.fromEntries(editedFields.map(field => [field, payload[field]]));
    const cleared = linked ? editedFields.filter(field => patch[field] === null) : [];
    for (const field of cleared) {
      if (!Object.hasOwn(existing.cronDerived || {}, field) && existing.userOverrides.includes(field)) {
        throw httpError(409, 'calendar_override_unavailable', 'Sync cron before clearing a legacy override');
      }
      patch[field] = Object.hasOwn(existing.cronDerived || {}, field) ? existing.cronDerived[field] : existing[field];
    }
    const candidate = normalizeCalendarEntry({ ...existing, ...patch }, nowIso);
    const changedFields = editedFields.filter(field => candidate[field] !== existing[field]);
    const updated = normalizeCalendarEntry({
      ...existing,
      ...patch,
      userOverrides: existing.source === 'cron'
        ? [...new Set([...(existing.userOverrides || []), ...changedFields])].filter(field => !cleared.includes(field)) : existing.userOverrides,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso,
      lastSyncedAt: existing.source === 'cron'
        ? (existing.lastSyncedAt || existing.updatedAt || nowIso)
        : nowIso,
    });

    const nextEntries = [...current.entries];
    nextEntries[idx] = updated;
    const next = writeCalendarDataSafe({
      ...current,
      entries: nextEntries,
      updatedAt: nowIso,
      lastCronSyncAt: current.lastCronSyncAt,
    });

    return { ok: true, entry: updated, entries: next.entries };
  }

  return {
    parseFirstJson,
    fetchCronJobsLive,
    fetchCronJobsForOperations,
    normalizeCronRunStatus,
    mapCronJobForApi,
    updateHermesCronJobModel,
    updateHermesCronJobEnabled,
    toIsoOrNull,
    normalizeCalendarEntry,
    readCalendarDataSafe,
    writeCalendarDataSafe,
    repairCalendarData,
    syncCalendarWithLiveCron,
    syncCalendarWithCronEvidence,
    createCalendarEntry,
    updateCalendarEntry,
  };
}

module.exports = {
  createCronService,
  parseFirstJson,
};
