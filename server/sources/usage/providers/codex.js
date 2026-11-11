'use strict';
const path = require('node:path');
const { readJson } = require('./command');
const { unavailable, validateObservation } = require('./contract');
function codexHomePath(env = process.env, home = env.MC_USER_HOME || env.HOME) { return env.MC_CODEX_HOME || path.join(home, '.codex'); }
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
        // CodexBar does not always expose per-model token classes. Keep an explicitly
        // partial row rather than allocating tokens by cost or inventing a model split.
        const input = d.inputTokens, output = d.outputTokens, cache = d.cacheReadTokens ?? 0;
        if (!Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(cache))
            throw unavailable('invalid_usage');
        days.push({
            date: d.date, model: d.modelBreakdowns?.length === 1 ? d.modelBreakdowns[0].modelName : 'unknown', inputTokens: Math.max(0, input - cache), outputTokens: output, cacheReadTokens: cache, cacheWriteTokens: d.cacheCreationTokens ?? 0, billedUsd: null
        });
    }
    return {
        days, observedAt: new Date(now()).toISOString(), coverage: 'partial', note: 'CodexBar fallback; model breakdown and historical coverage may be incomplete; billing unknown'
    };
}
function createCodexProvider({ exec, projectRoot, home, dataDir, env = {}, now = Date.now }) {
    const codexHome = codexHomePath(env, home);
    const timeoutMs = Number(env.MC_CODEXBAR_TIMEOUT_MS) || 120000;
    const status = { state: 'not_run', lastAttemptAt: null, lastSuccessAt: null, errorClass: null, usageSource: null };
    const errorClasses = ['timeout', 'output_limit', 'not_found', 'queue_timeout', 'exit_error', 'invalid_usage'];
    return {
        scanStatus: () => ({ ...status }),
        restoreScanStatus(saved) {
            if (!saved || !['not_run','succeeded','failed'].includes(saved.state)
                || ![null,'local_logs','codexbar'].includes(saved.usageSource)
                || ![null,...errorClasses].includes(saved.errorClass)
                || [saved.lastAttemptAt,saved.lastSuccessAt].some(t => t !== null && !Number.isFinite(Date.parse(t)))) return;
            for (const field of Object.keys(status)) status[field] = saved[field];
        },
        id: 'codex', label: 'Codex App and CLI', identity: `${codexHome}:ownership-v3`, timeoutMs: timeoutMs + 95000, intervalMs: 300000, staleAfterMs: 900000,
        async read(bounds) {
            try {
                const local = await readJson(exec, process.execPath, ['--max-old-space-size=96', path.join(projectRoot, 'scripts/openclaw-usage-summary.js'), '--provider', 'codex', '--since', bounds.since, '--until', bounds.until], {
                    lane: 'usage_codex', timeoutMs: 90000, key: 'usage:codex', maxOutputBytes: 20 * 1024 * 1024, env: {
                        ...env, MC_USAGE_CACHE_DIR: path.join(dataDir || path.join(projectRoot,'data'),'usage','incremental','codex'), HOME: home, MC_CODEX_HOME: codexHome
                    }
                });
                const value = validateObservation(local, bounds);
                status.usageSource = 'local_logs';
                return value;
            }
            catch {
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
                    status.errorClass = errorClasses.includes(error.code) ? error.code : 'exit_error';
                    throw error;
                }
            }
        }
    };
}
module.exports = {
    createProvider: createCodexProvider, createCodexProvider, codexHomePath, fromCodexbar
};
