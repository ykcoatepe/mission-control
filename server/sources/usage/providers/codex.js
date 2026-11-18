'use strict';
const path = require('node:path');
const { readJson } = require('./command');
const { unavailable, validateObservation } = require('./contract');
function codexHomePath(env = process.env, home = env.MC_USER_HOME || env.HOME) { return env.MC_CODEX_HOME || path.join(home, '.codex'); }
// Split each token class across models in proportion to their share of the day,
// using largest remainders so every class still sums exactly to the day's figure.
// BigInt keeps the products exact for any safe-integer counts.
function allocate(total, weights) {
    const T = BigInt(total), W = weights.map(BigInt), sum = W.reduce((a, w) => a + w, 0n);
    const parts = W.map(w => T * w / sum), rems = W.map(w => T * w % sum);
    let left = T - parts.reduce((a, v) => a + v, 0n);
    const order = rems.map((r, i) => [r, i]).sort((x, y) => x[0] > y[0] ? -1 : x[0] < y[0] ? 1 : x[1] - y[1]);
    for (let k = 0; left > 0n; k++, left--) parts[order[k][1]]++;
    return parts.map(Number);
}
// CodexBar gives per-model totals but not per-model token classes. When every
// breakdown carries a usable total, models keep their own rows and the day's
// classes are shared out by each model's token share (an estimate, marked by the
// fallback_source coverage reason). Otherwise the day stays one 'unknown' row.
function modelShares(d) {
    if (!Array.isArray(d.modelBreakdowns) || !d.modelBreakdowns.length) return null;
    // One model owns the whole day; its total is not needed (and not always sent).
    const only = d.modelBreakdowns.length === 1 && typeof d.modelBreakdowns[0]?.modelName === 'string' ? d.modelBreakdowns[0].modelName.trim() : '';
    if (only) return [[only, 1]];
    const byName = new Map();
    for (const m of d.modelBreakdowns) {
        const name = typeof m?.modelName === 'string' ? m.modelName.trim() : '';
        if (!name || !Number.isSafeInteger(m.totalTokens) || m.totalTokens < 0) return null;
        byName.set(name, (byName.get(name) || 0) + m.totalTokens);
    }
    const total = [...byName.values()].reduce((a, v) => a + v, 0);
    return total > 0 && Number.isSafeInteger(total) ? [...byName].filter(([, v]) => v > 0) : null;
}
function fromCodexbar(raw, { since, until }, now) {
    const reports = Array.isArray(raw) ? raw : [raw];
    if (!reports.length || reports.some(r => !r || r.error || typeof r.provider !== 'string' || !Array.isArray(r.daily)))
        throw unavailable('invalid_usage');
    const report = reports.find(r => r.provider === 'codex');
    if (!report)
        throw unavailable('invalid_usage');
    const days = [];
    for (const d of report.daily) {
        if (d.date < since || d.date > until)
            continue;
        const input = d.inputTokens, output = d.outputTokens, cache = d.cacheReadTokens ?? 0, write = d.cacheCreationTokens ?? 0;
        if (![input, output, cache, write].every(v => Number.isSafeInteger(v) && v >= 0))
            throw unavailable('invalid_usage');
        const classes = { inputTokens: Math.max(0, input - cache), outputTokens: output, cacheReadTokens: cache, cacheWriteTokens: write };
        const shares = modelShares(d);
        if (!shares) {
            days.push({ date: d.date, model: 'unknown', ...classes, billedUsd: null });
            continue;
        }
        const weights = shares.map(([, v]) => v), split = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, allocate(v, weights)]));
        shares.forEach(([model], i) => days.push({
            date: d.date, model, inputTokens: split.inputTokens[i], outputTokens: split.outputTokens[i], cacheReadTokens: split.cacheReadTokens[i], cacheWriteTokens: split.cacheWriteTokens[i], billedUsd: null
        }));
    }
    return {
        days, observedAt: new Date(now()).toISOString(), coverage: 'partial', coverageReasons: ['fallback_source'], note: 'CodexBar fallback: local logs could not be read; per-model token classes are estimated from model shares; billing unknown'
    };
}
function createCodexProvider({ exec, projectRoot, home, dataDir, env = {}, now = Date.now, logger = null }) {
    const codexHome = codexHomePath(env, home);
    const timeoutMs = Number(env.MC_CODEXBAR_TIMEOUT_MS) || 120000;
    const status = { state: 'not_run', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: null, localErrorClass: null };
    const errorClasses = ['timeout', 'output_limit', 'not_found', 'queue_timeout', 'exit_error', 'invalid_usage'];
    const classOf = error => errorClasses.includes(error?.code) ? error.code : 'exit_error';
    return {
        scanStatus: () => ({ ...status }),
        restoreScanStatus(saved) {
            if (!saved || !['not_run','succeeded','failed'].includes(saved.state)
                || ![null,'local_logs','codexbar'].includes(saved.usageSource)
                || ![null,...errorClasses].includes(saved.errorClass)
                || ![undefined,null,...errorClasses].includes(saved.localErrorClass)
                || [saved.lastAttemptAt,saved.lastSuccessAt].some(t => t !== null && !Number.isFinite(Date.parse(t)))) return;
            for (const field of Object.keys(status)) status[field] = saved[field] ?? null;
        },
        id: 'codex', label: 'Codex App and CLI', identity: `${codexHome}:ownership-v4`, timeoutMs: timeoutMs + 95000, intervalMs: 300000, staleAfterMs: 900000,
        async read(bounds) {
            try {
                const local = await readJson(exec, process.execPath, ['--max-old-space-size=96', path.join(projectRoot, 'scripts/openclaw-usage-summary.js'), '--provider', 'codex', '--since', bounds.since, '--until', bounds.until], {
                    lane: 'usage_codex', timeoutMs: 90000, key: 'usage:codex', maxOutputBytes: 20 * 1024 * 1024, env: {
                        ...env, MC_USAGE_CACHE_DIR: path.join(dataDir || path.join(projectRoot,'data'),'usage','incremental','codex'), HOME: home, MC_CODEX_HOME: codexHome
                    }
                });
                const value = validateObservation(local, bounds);
                status.usageSource = 'local_logs';
                status.localErrorClass = null;
                return value;
            }
            catch (localError) {
                // Typed class only: never stderr, argv or paths (see command.js).
                status.localErrorClass = classOf(localError);
                logger?.warn?.(`[usage:codex] local log scan failed (${status.localErrorClass}); falling back to CodexBar`);
                const days = Math.min(800, Math.ceil((new Date(bounds.until) - new Date(bounds.since)) / 86400000) + 2);
                status.lastAttemptAt = new Date(now()).toISOString();
                try {
                    const raw = await readJson(exec, 'codexbar', ['cost', '--format', 'json', '--provider', 'codex', '--days', String(days)], {
                        lane: 'usage_codex', timeoutMs, key: 'usage:codexbar', maxOutputBytes: 20 * 1024 * 1024, env: { ...env, MC_USAGE_CACHE_DIR: path.join(dataDir || path.join(projectRoot,'data'),'usage','incremental','codex'), HOME: home, MC_CODEX_HOME: codexHome }
                    });
                    const value = validateObservation(fromCodexbar(raw, bounds, now), bounds);
                    status.state = 'succeeded';
                    status.lastSuccessAt = new Date(now()).toISOString();
                    status.errorClass = null;
                    status.usageSource = 'codexbar';
                    return value;
                } catch (error) {
                    status.state = 'failed';
                    status.errorClass = classOf(error);
                    throw error;
                }
            }
        }
    };
}
module.exports = {
    createProvider: createCodexProvider, createCodexProvider, codexHomePath, fromCodexbar
};
