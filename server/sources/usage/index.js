'use strict';
const { createUsageRegistry, localDate } = require('./registry');
const { estimateApiEquivalentCost, lastReviewed } = require('../../services/costSanity');
const { rangeForPeriod } = require('../../services/claudeCodeUsage');
const { createExec } = require('../../core/exec');
const path = require('node:path');
const fsDefault = require('node:fs').promises;
// One registry line per platform; each module exports createProvider(deps).
const PROVIDER_MODULES = [
    'claude-code',
    'codex',
    'hermes',
    'openclaw',
];
const LANES = Object.fromEntries(PROVIDER_MODULES.map(name => [`usage_${name.replace('-code', '')}`, { concurrency: 1, queueTimeoutMs: 5000 }]));
function rowTokens(row) { return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens; }
function nullableSum(values) { return values.every(v => v !== null && v !== undefined) ? values.reduce((s, v) => s + v, 0) : null; }
function price(row) {
    if (rowTokens(row) === 0 && row.billedUsd === null)
        return { usd: null, status: 'unavailable' };
    return estimateApiEquivalentCost({
        name: row.model, input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens, tokens: rowTokens(row), cost: row.billedUsd
    });
}
function totals(rows) {
    return { tokens: rows.reduce((s, r) => s + rowTokens(r), 0), apiEquivalentUsd: nullableSum(rows.map(r => price(r).usd)), billedUsd: nullableSum(rows.map(r => r.billedUsd)) };
}
function createUsageService({ providers, exec, now = Date.now, fs = fsDefault, dataDir, projectRoot = path.resolve(__dirname, '../../..'), home = process.env.MC_USER_HOME || process.env.HOME, env = process.env, budget = {}, scheduler, logger = null } = {}) {
    let ownedExec;
    const runner = exec || (ownedExec = createExec({ lanes: LANES, now }));
    let registry;
    if (!providers) {
        const deps = {
            exec: runner, now, projectRoot, home, env, fs
        };
        const getHermesCoverage = () => {
            const snap = registry?.snapshots().find(s => s.id === 'hermes');
            return snap?.meta.ok && !snap.meta.stale ? snap.data.days.filter(d => rowTokens(d) > 0 || d.billedUsd > 0).map(d => d.date) : [];
        };
        providers = PROVIDER_MODULES.map(name => require(`./providers/${name}`).createProvider({ ...deps, getHermesCoverage }));
    }
    registry = createUsageRegistry({
        providers, now, fs, dataDir, logger, scheduler
    });
    function snapshots() { return registry.snapshots(); }
    function meta(snaps) {
        const partial = snaps.length === 0 || snaps.some(s => !s.meta.ok || s.meta.stale || s.data?.coverage !== 'complete' || s.data?.until < localDate(new Date(now())));
        const times = snaps.map(s => s.meta.observedAt).filter(Boolean).sort();
        const latencies = snaps.map(s => s.meta.latencyMs).filter(Number.isFinite);
        return {
            ok: !partial, stale: partial, observedAt: times[0] || null, ageMs: times.length ? Math.max(0, now() - Date.parse(times[0])) : null, error: partial ? { code: 'usage_partial', message: 'Some usage providers are unavailable, stale or incomplete' } : null, latencyMs: latencies.length ? Math.max(...latencies) : null, source: 'usage.registry', updatedAt: times.at(-1) || null, refreshing: snaps.some(s => !s.data && !s.meta.error), rateCardLastReviewed: lastReviewed
        };
    }
    function hasCoverage(snap, keys) { return !!snap.data && snap.data.since <= keys[0] && snap.data.until >= keys.at(-1); }
    function selectedRows(snap, keys) { const set = new Set(keys); return (snap.data?.days || []).filter(d => set.has(d.date)); }
    function costs(period = 'month', anchor = null) {
        const currentBudget = typeof budget === 'function' ? budget() : budget;
        const snaps = snapshots();
        const clock = new Date(now());
        const range = rangeForPeriod(period, clock, anchor);
        const m = meta(snaps);
        const providers = snaps.map(s => {
            const rows = selectedRows(s, range.keys);
            const t = hasCoverage(s, range.keys) ? totals(rows) : { tokens: null, apiEquivalentUsd: null, billedUsd: null };
            return {
                id: s.id, label: s.label, state: !hasCoverage(s, range.keys) ? 'unavailable' : s.meta.stale || !s.meta.ok ? 'stale' : 'ready', observedAt: s.data?.observedAt || null, coverage: s.data?.coverage || 'partial', ...t, note: s.data?.note || 'Usage has not been observed'
            };
        });
        const available = snaps.filter(s => hasCoverage(s, range.keys));
        const allRows = available.flatMap(s => s.data.days);
        const selected = allRows.filter(d => range.keys.includes(d.date));
        const aggregate = available.length ? totals(selected) : { tokens: null, apiEquivalentUsd: null, billedUsd: null };
        const billed = providers.length && providers.every(p => p.state !== 'unavailable') ? aggregate.billedUsd : null;
        const periodTotals = keys => available.some(s => hasCoverage(s, keys)) ? totals(available.filter(s => hasCoverage(s, keys)).flatMap(s => selectedRows(s, keys))) : { tokens: null, billedUsd: null, apiEquivalentUsd: null };
        const today = localDate(clock);
        const yesterday = new Date(clock);
        yesterday.setDate(yesterday.getDate() - 1);
        const todayT = periodTotals([today]), yesterdayT = periodTotals([localDate(yesterday)]), weekT = periodTotals(rangeForPeriod('7d', clock).keys), monthT = periodTotals(rangeForPeriod('month', clock, anchor).keys), previousT = periodTotals(range.previousKeys);
        const services = [];
        const dailyByModel = range.keys.map(date => ({
            date, totalCost: available.length ? 0 : null, totalTokens: available.length ? 0 : null, apiEquivalentCost: available.length ? 0 : null
        }));
        const agents = available.map(s => {
            const rows = selectedRows(s, range.keys);
            const models = [...new Set(rows.map(d => d.model))];
            const byService = models.map(model => {
                const modelRows = rows.filter(d => d.model === model);
                const t = totals(modelRows);
                const p = modelRows.map(price);
                const svc = {
                    name: `${s.label} / ${model}`, tokens: t.tokens, cost: t.billedUsd,
                    input: modelRows.reduce((sum, r) => sum + r.inputTokens, 0),
                    output: modelRows.reduce((sum, r) => sum + r.outputTokens, 0),
                    cacheRead: modelRows.reduce((sum, r) => sum + r.cacheReadTokens, 0),
                    cacheWrite: modelRows.reduce((sum, r) => sum + r.cacheWriteTokens, 0),
                    reasoning: null, sessions: null, costStatus: t.billedUsd === null ? 'unknown' : 'recorded', billingModes: 'unknown', apiEquivalentUsd: t.apiEquivalentUsd, apiEquivalentStatus: p.some(x => x.status === 'partial') ? 'partial' : t.apiEquivalentUsd === null ? 'unavailable' : 'estimated', costSource: t.billedUsd === null ? 'unknown' : 'recorded', percentage: aggregate.tokens ? Math.round(t.tokens / aggregate.tokens * 100) : 0
                };
                services.push(svc);
                for (const row of dailyByModel) {
                    const t = totals(modelRows.filter(d => d.date === row.date));
                    row[svc.name] = t.billedUsd;
                    row[`${svc.name}_tokens`] = t.tokens;
                    const dayRows = modelRows.filter(d => d.date === row.date);
                    row[`${svc.name}_input`] = dayRows.reduce((sum, r) => sum + r.inputTokens, 0);
                    row[`${svc.name}_output`] = dayRows.reduce((sum, r) => sum + r.outputTokens, 0);
                    row[`${svc.name}_cacheRead`] = dayRows.reduce((sum, r) => sum + r.cacheReadTokens, 0);
                    row[`${svc.name}_cacheWrite`] = dayRows.reduce((sum, r) => sum + r.cacheWriteTokens, 0);
                    row[`${svc.name}_reasoning`] = null;
                    row[`${svc.name}_apiEquivalentUsd`] = t.apiEquivalentUsd;
                    row[`${svc.name}_apiEquivalentStatus`] = dayRows.some(r => price(r).status === 'partial') ? 'partial' : t.apiEquivalentUsd === null ? 'unavailable' : 'estimated';
                    row[`${svc.name}_costSource`] = t.billedUsd === null ? 'unknown' : 'recorded';
                }
                return svc;
            });
            const t = totals(rows);
            return {
                key: s.id, label: s.label, source: `usage.${s.id}`, status: providers.find(p => p.id === s.id).state, summary: { periodTokens: t.tokens, periodUsd: t.billedUsd, periodApiEquivalentUsd: t.apiEquivalentUsd }, byService
            };
        });
        const daily = range.keys.map(date => {
            const t = available.length ? totals(selected.filter(d => d.date === date)) : { tokens: null, billedUsd: null, apiEquivalentUsd: null };
            const byModel = dailyByModel.find(r => r.date === date);
            Object.assign(byModel, { totalCost: t.billedUsd, totalTokens: t.tokens, apiEquivalentCost: t.apiEquivalentUsd });
            return {
                date, cost: t.billedUsd, tokens: t.tokens, totalCost: t.billedUsd, totalTokens: t.tokens, apiEquivalentCost: t.apiEquivalentUsd
            };
        });
        const pricingPartial = selected.some(r => price(r).status === 'partial' || price(r).usd === null);
        return {
            source: 'combined.agent_usage', serverMonth: today.slice(0, 7), period: {
                key: period, anchor: range.anchor, start: range.keys[0], end: range.keys.at(-1)
            }, daily, dailyByModel, modelKeys: services.map(s => s.name), byService: services, agents, providers, partial: m.stale || pricingPartial, apiEquivalentUsd: aggregate.apiEquivalentUsd, billedUsd: billed, costReliability: billed === null ? 'partial_unknown' : 'normalized', apiEquivalentReliability: pricingPartial || m.stale ? 'partial' : 'estimated', summary: {
                periodTokens: aggregate.tokens, periodUsd: billed, periodApiEquivalentUsd: aggregate.apiEquivalentUsd, previousPeriodUsd: previousT.billedUsd, previousPeriodApiEquivalentUsd: previousT.apiEquivalentUsd, previousPeriodApiEquivalentReliability: m.stale ? 'partial' : 'estimated', todayTokens: todayT.tokens, todayUsd: todayT.billedUsd, yesterdayUsd: yesterdayT.billedUsd, thisWeekTokens: weekT.tokens, thisWeekUsd: weekT.billedUsd, thisMonthTokens: monthT.tokens, thisMonthUsd: monthT.billedUsd, totalTokens: aggregate.tokens, totalUsd: billed, budget: currentBudget, note: m.stale ? 'Partial usage; unavailable providers are not counted' : 'Observed provider usage; API equivalent is an estimate'
            }, budget: currentBudget, meta: {
                ...m, state: available.length ? 'ready' : 'warming', openclawStatus: providers.find(p => p.id === 'openclaw')?.state || 'unavailable', hermesStatus: providers.find(p => p.id === 'hermes')?.state || 'unavailable', claudeCodeStatus: providers.find(p => p.id === 'claude_code')?.state || 'unavailable'
            }
        };
    }
    function months() {
        const snaps = snapshots(), clock = new Date(now()), current = localDate(clock).slice(0, 7);
        const m = meta(snaps);
        const months = Array.from({ length: 25 }, (_, i) => {
            const month = localDate(new Date(clock.getFullYear(), clock.getMonth() - i, 1)).slice(0, 7);
            const sources = snaps.filter(s => s.data?.days.some(d => d.date.startsWith(month) && (rowTokens(d) > 0 || d.billedUsd > 0))).map(s => s.id);
            const complete = !m.stale && snaps.every(s => s.data.since <= `${month}-01` && s.data.until >= localDate(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0)));
            return {
                month, hasData: sources.length > 0, sources, ...(!sources.length && (month === current || !complete) ? { unknown: true } : {})
            };
        });
        return {
            currentMonth: current, months, generatedAt: new Date(now()).toISOString(), partial: m.stale, sourceStatus: { ...Object.fromEntries(snaps.map(s => [s.id, s.data ? 'ready' : 'unavailable'])), codexbar: snaps.filter(s => ['codex', 'claude_code'].includes(s.id)).some(s => s.data) ? 'ready' : 'unavailable', cached: snaps.some(s => s.data) ? 'ready' : 'no_usage' }, meta: m
        };
    }
    function summary() {
        const currentBudget = typeof budget === 'function' ? budget() : budget;
        const snaps = snapshots(), m = meta(snaps), clock = new Date(now());
        const available = snaps.filter(s => s.data);
        const windows = Object.fromEntries(['day', '7d', 'month'].map(period => [period, rangeForPeriod(period, clock).keys]));
        const monthKeys = windows.month;
        const metric = period => {
            const keys = windows[period];
            const covered = available.filter(s => hasCoverage(s, keys));
            const t = covered.length ? totals(covered.flatMap(s => selectedRows(s, keys))) : { tokens: null, apiEquivalentUsd: null, billedUsd: null };
            if (covered.length !== snaps.length)
                t.billedUsd = null;
            return t;
        };
        const month = metric('month');
        const pricingPartial = available.some(s => selectedRows(s, monthKeys).some(r => price(r).status === 'partial' || price(r).usd === null));
        return { data: available.length ? {
                today: metric('day'), week: metric('7d'), month, budget: { monthly: currentBudget.monthly ?? null, usedPct: currentBudget.monthly > 0 && month.billedUsd !== null ? month.billedUsd / currentBudget.monthly * 100 : null }, providers: snaps.map(s => ({
                    id: s.id, label: s.label, state: !hasCoverage(s, monthKeys) ? 'unavailable' : s.meta.stale || !s.meta.ok ? 'stale' : 'ready', monthTokens: hasCoverage(s, monthKeys) ? totals(selectedRows(s, monthKeys)).tokens : null
                })), partial: m.stale || pricingPartial
            } : null, meta: m };
    }
    function codexbar(anchor = null) {
        const snaps = snapshots().filter(s => ['codex', 'claude_code'].includes(s.id));
        const m = meta(snaps), has = snaps.some(s => s.data), clock = new Date(now());
        const floor = new Date(clock);
        floor.setDate(floor.getDate() - 69);
        const monthFloor = new Date(clock);
        monthFloor.setDate(monthFloor.getDate() - 29);
        const rows = snaps.flatMap(s => s.data?.days || []).filter(d => anchor ? d.date.startsWith(anchor) : d.date >= localDate(floor) && d.date <= localDate(clock));
        const grouped = [...new Set(rows.map(r => r.date))].sort().map(date => {
            const r = rows.filter(d => d.date === date), t = totals(r);
            return {
                date, totalCost: t.apiEquivalentUsd, totalTokens: t.tokens, inputTokens: r.reduce((s, d) => s + d.inputTokens + d.cacheReadTokens, 0), outputTokens: r.reduce((s, d) => s + d.outputTokens, 0), models: [...new Set(r.map(d => d.model))].map(model => { const t = totals(r.filter(d => d.model === model)); return { model, cost: t.apiEquivalentUsd, totalTokens: t.tokens }; })
            };
        });
        const t = has ? totals(rows) : { tokens: null, apiEquivalentUsd: null };
        const last = grouped.filter(d => d.date >= localDate(monthFloor));
        return {
            source: 'codexbar', provider: 'both', updatedAt: m.updatedAt, last30DaysCostUSD: has ? nullableSum(last.map(d => d.totalCost)) : null, last30DaysTokens: has ? last.reduce((s, d) => s + d.totalTokens, 0) : null, sessionCostUSD: null, sessionTokens: null, totals: {
                totalCost: t.apiEquivalentUsd, totalTokens: t.tokens, inputTokens: has ? grouped.reduce((s, d) => s + d.inputTokens, 0) : null, outputTokens: has ? grouped.reduce((s, d) => s + d.outputTokens, 0) : null
            }, daily: grouped, stale: m.stale, meta: m
        };
    }
    return {
        registry, costs, months, summary, codexbar, refresh: () => Promise.all(registry.sources().map(s => s.refresh())), dispose: () => ownedExec?.killAll()
    };
}
module.exports = { createUsageService, LANES, totals };
