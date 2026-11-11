'use strict';
const path = require('node:path');
const { readJson } = require('./command');
const { unavailable } = require('./contract');
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
function createCodexProvider({ exec, projectRoot, home, env = {}, now = Date.now, getHermesCoverage = () => [] }) {
    const codexHome = codexHomePath(env, home);
    const timeoutMs = Number(env.MC_CODEXBAR_TIMEOUT_MS) || 120000;
    return {
        id: 'codex', label: 'Codex App and CLI', identity: codexHome, timeoutMs: timeoutMs + 95000,
        async read(bounds) {
            try {
                return await readJson(exec, process.execPath, [path.join(projectRoot, 'scripts/openclaw-usage-summary.js'), '--provider', 'codex', '--since', bounds.since, '--until', bounds.until], {
                    lane: 'usage_codex', timeoutMs: 90000, key: 'usage:codex', maxOutputBytes: 20 * 1024 * 1024, env: {
                        ...env, HOME: home, MC_CODEX_HOME: codexHome, MC_USAGE_HERMES_DAYS: JSON.stringify([...new Set(getHermesCoverage())])
                    }
                });
            }
            catch {
                const days = Math.min(800, Math.ceil((new Date(bounds.until) - new Date(bounds.since)) / 86400000) + 2);
                const raw = await readJson(exec, 'codexbar', ['cost', '--format', 'json', '--provider', 'codex', '--days', String(days)], {
                    lane: 'usage_codex', timeoutMs, key: 'usage:codexbar', maxOutputBytes: 20 * 1024 * 1024, env: { ...env, HOME: home, MC_CODEX_HOME: codexHome }
                });
                return fromCodexbar(raw, bounds, now);
            }
        }
    };
}
module.exports = {
    createProvider: createCodexProvider, createCodexProvider, codexHomePath, fromCodexbar
};
