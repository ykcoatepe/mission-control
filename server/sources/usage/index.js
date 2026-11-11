'use strict';
const { composeUsageSnapshots } = require('./ownership');
const { createUsageRegistry, localDate } = require('./registry');
const { estimateApiEquivalentCost, lastReviewed } = require('../../services/costSanity');
const { rangeForPeriod: calendarRange } = require('./periods');
const rangeForPeriod = (period, now, anchor) => calendarRange(period, anchor, now);
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
// Unknown API-equivalent figures never erase known ones. Empty observed windows
// are handled explicitly by totals(); an empty set of provider readings is unknown.
function knownSum(values) { const known = values.filter(Number.isFinite); return known.length ? known.reduce((sum, value) => sum + value, 0) : null; }
function nullableSum(values) { return values.every(v => v !== null && v !== undefined) ? values.reduce((s, v) => s + v, 0) : null; }
function price(row, providerId) {
    if (rowTokens(row) === 0 && row.billedUsd === null)
        return { usd: 0, status: 'no_usage' };
    return estimateApiEquivalentCost({
        name: row.model, input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheReadTokens, cacheWrite: row.cacheWriteTokens, tokens: rowTokens(row), cost: providerId === 'hermes' ? undefined : row.billedUsd
    });
}
function totals(rows, providerId) {
    return { tokens: rows.reduce((s, r) => s + rowTokens(r), 0), apiEquivalentUsd: rows.length ? knownSum(rows.map(r => price(r, providerId).usd)) : 0, billedUsd: rows.length ? nullableSum(rows.map(r => r.billedUsd)) : null };
}
function createUsageService({ providers, exec, now = Date.now, fs = fsDefault, dataDir, projectRoot = path.resolve(__dirname, '../../..'), home = process.env.MC_USER_HOME || process.env.HOME, env = process.env, budget = {}, scheduler, logger = null } = {}) {
    let ownedExec;
    const runner = exec || (ownedExec = createExec({ lanes: LANES, now }));
    let registry;
    if (!providers) {
        const deps = {
            exec: runner, now, projectRoot, home, env, fs, dataDir
        };
        providers = PROVIDER_MODULES.map(name => require(`./providers/${name}`).createProvider(deps));
    }
    registry = createUsageRegistry({
        providers, now, fs, dataDir, logger, scheduler
    });
    function snapshots() { return composeUsageSnapshots(registry.snapshots()); }
    function meta(snaps, keys) {
        const stale = snaps.length === 0 || snaps.some(s => !s.meta.ok || s.meta.stale || s.data?.until < localDate(new Date(now())));
        const unresolvedOverlaps = snaps.flatMap(s=>s.data?.unresolvedOverlaps || []).filter(overlap=>!keys||keys.includes(overlap.date));
        const partial = stale || unresolvedOverlaps.length>0 || snaps.some(s => s.data?.coverage !== 'complete');
        const times = snaps.map(s => s.meta.observedAt).filter(Boolean).sort();
        const latencies = snaps.map(s => s.meta.latencyMs).filter(Number.isFinite);
        return {
            ok: !stale && !unresolvedOverlaps.length, stale, partial, unresolvedOverlaps, observedAt: times[0] || null, ageMs: times.length ? Math.max(0, now() - Date.parse(times[0])) : null, error: unresolvedOverlaps.length ? {code:'usage_overlap_unresolved',message:'Provider ownership overlap is unresolved'} : stale ? { code: 'usage_partial', message: 'Some usage providers are unavailable, stale or incomplete' } : null, latencyMs: latencies.length ? Math.max(...latencies) : null, source: 'usage.registry', updatedAt: times.at(-1) || null, refreshing: snaps.some(s => !s.data && !s.meta.error), rateCardLastReviewed: lastReviewed
        };
    }
    function hasCoverage(snap, keys) { return !!snap.data && snap.data.since <= keys[0] && snap.data.until >= keys.at(-1); }
    function selectedRows(snap, keys) { const set = new Set(keys); return (snap.data?.days || []).filter(d => set.has(d.date)); }
    function coverageReason(snap, keys) {
        if (!snap.data || !keys.some(key => key >= snap.data.since && key <= snap.data.until)) return 'unread';
        if (snap.meta.error && snap.meta.error.code !== 'cached_usage') return 'scan_failed';
        if (snap.data.unresolvedOverlaps?.some(overlap => keys.includes(overlap.date))) return 'unresolved_overlap';
        return snap.data.coverage === 'partial' || !hasCoverage(snap, keys) ? 'standing_gaps' : 'none';
    }
    function providerWindow(snap, keys) {
        const observedKeys = keys.filter(date => snap.data && date >= snap.data.since && date <= snap.data.until);
        const observed = observedKeys.length > 0;
        const rows = observed ? selectedRows(snap, observedKeys) : [];
        const value = observed ? totals(rows, snap.id) : { tokens: null, apiEquivalentUsd: null, billedUsd: null };
        const omittedPrices = rows.some(row => !Number.isFinite(price(row, snap.id).usd));
        const incompleteCoverage = observed && (!hasCoverage(snap, keys) || snap.data.coverage !== 'complete');
        const reason = !snap.data ? 'usage_unavailable' : !observed ? 'window_not_observed' : snap.data.unresolvedOverlaps?.some(o=>keys.includes(o.date)) ? 'ownership_overlap_unresolved'
            : value.apiEquivalentUsd === null ? 'api_equivalent_unavailable'
            : omittedPrices ? 'partially_priced_usage' : null;
        return { ...value, observed, rows, reason, billingKnown: value.billedUsd !== null, hasRecords: rows.length > 0,
            partial: !!reason || incompleteCoverage || snap.meta.stale || !snap.meta.ok || rows.some(row => price(row, snap.id).status === 'partial') };
    }
    function aggregateWindow(snaps, keys) {
        const readings = snaps.map(snap => ({ snap, value: providerWindow(snap, keys) }));
        const billedUsd = readings.length ? nullableSum(readings.map(r => r.value.billedUsd)) : null;
        return {
            tokens: knownSum(readings.map(r => r.value.tokens)),
            apiEquivalentUsd: knownSum(readings.map(r => r.value.apiEquivalentUsd)),
            // Billed spend retains its stricter contract: an incomplete bill is unknown.
            billedUsd, billingKnown: billedUsd !== null, hasRecords: readings.some(r => r.value.hasRecords),
            missingProviders: readings.filter(r => r.value.reason).map(({snap,value}) => ({id:snap.id,label:snap.label,reason:value.reason})),
            partial: !readings.length || readings.some(r => r.value.partial),
        };
    }
    function costs(period = 'month', anchor = null) {
        const currentBudget = typeof budget === 'function' ? budget() : budget;
        const snaps = snapshots();
        const clock = new Date(now());
        const range = rangeForPeriod(period, clock, anchor);
        const m = meta(snaps, range.keys);
        const providers = snaps.map(s => {
            const window = providerWindow(s, range.keys);
            const { tokens, apiEquivalentUsd, billedUsd } = window;
            const t = { tokens, apiEquivalentUsd, billedUsd, billingKnown: window.billingKnown, hasRecords: window.hasRecords,
                coverageReason: coverageReason(s, range.keys), skippedLines: s.data?.skippedLines ?? null, oversizedLines: s.data?.oversizedLines ?? null };
            return {
                id: s.id, label: s.label, state: !window.observed ? 'unavailable' : s.meta.stale || !s.meta.ok || !hasCoverage(s, range.keys) ? 'stale' : 'ready', observedAt: s.data?.observedAt || null, coverage: hasCoverage(s, range.keys) && !s.data.unresolvedOverlaps?.some(o=>range.keys.includes(o.date)) ? s.data.coverage : 'partial', ...t, note: window.observed && s.data?.unresolvedOverlaps?.length && !s.data.unresolvedOverlaps.some(o=>range.keys.includes(o.date)) && s.data.coverage==='complete' ? 'Ownership reconciled for this window' : s.data?.note || 'Usage has not been observed'
            };
        });
        const available = snaps.filter(s => providerWindow(s, range.keys).observed);
        const aggregate = aggregateWindow(snaps, range.keys);
        const billed = providers.length && providers.every(p => p.state !== 'unavailable') ? aggregate.billedUsd : null;
        const periodTotals = keys => aggregateWindow(snaps, keys);
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
                const t = totals(modelRows, s.id);
                const p = modelRows.map(row => price(row, s.id));
                const svc = {
                    name: `${s.label} / ${model}`, tokens: t.tokens, cost: t.billedUsd,
                    isLocal: modelRows.every(row => row.isLocal === true) ? true : modelRows.every(row => row.isLocal === false) ? false : null,
                    input: modelRows.reduce((sum, r) => sum + r.inputTokens, 0),
                    output: modelRows.reduce((sum, r) => sum + r.outputTokens, 0),
                    cacheRead: modelRows.reduce((sum, r) => sum + r.cacheReadTokens, 0),
                    cacheWrite: modelRows.reduce((sum, r) => sum + r.cacheWriteTokens, 0),
                    reasoning: null, sessions: null, costStatus: t.billedUsd === null ? 'unknown' : 'recorded', billingModes: 'unknown', apiEquivalentUsd: t.apiEquivalentUsd, apiEquivalentEstimated: p.some(x => x.usd !== null && ['estimated', 'partial'].includes(x.status)), apiEquivalentStatus: p.some(x => x.status === 'partial') ? 'partial' : t.apiEquivalentUsd === null ? 'unavailable' : 'estimated', costSource: t.billedUsd === null ? 'unknown' : 'recorded', percentage: aggregate.tokens ? Math.round(t.tokens / aggregate.tokens * 100) : 0
                };
                services.push(svc);
                for (const row of dailyByModel) {
                    const t = totals(modelRows.filter(d => d.date === row.date), s.id);
                    row[svc.name] = t.billedUsd;
                    row[`${svc.name}_tokens`] = t.tokens;
                    const dayRows = modelRows.filter(d => d.date === row.date);
                    row[`${svc.name}_input`] = dayRows.reduce((sum, r) => sum + r.inputTokens, 0);
                    row[`${svc.name}_output`] = dayRows.reduce((sum, r) => sum + r.outputTokens, 0);
                    row[`${svc.name}_cacheRead`] = dayRows.reduce((sum, r) => sum + r.cacheReadTokens, 0);
                    row[`${svc.name}_cacheWrite`] = dayRows.reduce((sum, r) => sum + r.cacheWriteTokens, 0);
                    row[`${svc.name}_reasoning`] = null;
                    row[`${svc.name}_apiEquivalentUsd`] = t.apiEquivalentUsd;
                    row[`${svc.name}_apiEquivalentStatus`] = dayRows.some(r => price(r, s.id).status === 'partial') ? 'partial' : t.apiEquivalentUsd === null ? 'unavailable' : 'estimated';
                    row[`${svc.name}_costSource`] = t.billedUsd === null ? 'unknown' : 'recorded';
                }
                return svc;
            });
            const t = totals(rows, s.id);
            return {
                key: s.id, label: s.label, source: `usage.${s.id}`, status: providers.find(p => p.id === s.id).state, summary: { periodTokens: t.tokens, periodUsd: t.billedUsd, periodApiEquivalentUsd: t.apiEquivalentUsd }, byService
            };
        });
        const daily = range.keys.map(date => {
            const t = aggregateWindow(snaps, [date]);
            const byModel = dailyByModel.find(r => r.date === date);
            Object.assign(byModel, { totalCost: t.billedUsd, totalTokens: t.tokens, apiEquivalentCost: t.apiEquivalentUsd });
            return {
                date, cost: t.billedUsd, tokens: t.tokens, totalCost: t.billedUsd, totalTokens: t.tokens, apiEquivalentCost: t.apiEquivalentUsd, partial: t.partial, missingProviders: t.missingProviders
            };
        });
        const pricingPartial = available.some(s => selectedRows(s, range.keys).some(r => price(r, s.id).status === 'partial' || price(r, s.id).usd === null));
        return {
            source: 'combined.agent_usage', serverMonth: today.slice(0, 7), period: {
                key: period, anchor: range.anchor, start: range.keys[0], end: range.keys.at(-1),
                previousStart: range.previousKeys[0], previousEnd: range.previousKeys.at(-1),
                previousIsPartial: previousT.partial || (period === 'month' && range.previousKeys.at(-1) !== localDate(new Date(Number(range.previousKeys[0].slice(0, 4)), Number(range.previousKeys[0].slice(5, 7)), 0)))
            }, daily, dailyByModel, modelKeys: services.map(s => s.name), byService: services, agents, providers, partial: m.partial || aggregate.partial || pricingPartial, missingProviders: aggregate.missingProviders, apiEquivalentUsd: aggregate.apiEquivalentUsd, billedUsd: billed, costReliability: billed === null ? 'partial_unknown' : 'normalized', apiEquivalentReliability: aggregate.apiEquivalentUsd === null ? 'unavailable' : pricingPartial || m.partial || aggregate.partial ? 'partial' : 'estimated', summary: {
                periodTokens: aggregate.tokens, periodUsd: billed, periodApiEquivalentUsd: aggregate.apiEquivalentUsd, previousPeriodUsd: previousT.billedUsd, previousPeriodApiEquivalentUsd: previousT.apiEquivalentUsd, previousPeriodApiEquivalentReliability: previousT.apiEquivalentUsd === null ? 'unavailable' : previousT.partial ? 'partial' : 'estimated', todayTokens: todayT.tokens, todayUsd: todayT.billedUsd, yesterdayUsd: yesterdayT.billedUsd, thisWeekTokens: weekT.tokens, thisWeekUsd: weekT.billedUsd, thisMonthTokens: monthT.tokens, thisMonthUsd: monthT.billedUsd, totalTokens: aggregate.tokens, totalUsd: billed, budget: currentBudget, note: m.stale ? 'Partial usage; unavailable providers are not counted' : 'Observed provider usage; API equivalent is an estimate'
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
            const complete = !meta(snaps, rangeForPeriod('month',clock,month).keys).partial && snaps.every(s => s.data.since <= `${month}-01` && s.data.until >= localDate(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0)));
            return {
                month, hasData: sources.length > 0, sources, ...(!sources.length && (month === current || !complete) ? { unknown: true } : {})
            };
        });
        return {
            currentMonth: current, months, generatedAt: new Date(now()).toISOString(), partial: m.partial, sourceStatus: { ...Object.fromEntries(snaps.map(s => [s.id, s.data ? 'ready' : 'unavailable'])), codexbar: snaps.filter(s => ['codex', 'claude_code'].includes(s.id)).some(s => s.data) ? 'ready' : 'unavailable', cached: snaps.some(s => s.data) ? 'ready' : 'no_usage' }, meta: m
        };
    }
    function summary() {
        const currentBudget = typeof budget === 'function' ? budget() : budget;
        const snaps = snapshots(), clock = new Date(now());
        const available = snaps.filter(s => s.data);
        const windows = Object.fromEntries(['day', '7d', 'month'].map(period => [period, rangeForPeriod(period, clock).keys]));
        const monthKeys = windows.month;
        const m = meta(snaps, monthKeys);
        const metric = period => aggregateWindow(snaps, windows[period]);
        const month = metric('month');
        const pricingPartial = available.some(s => selectedRows(s, monthKeys).some(r => price(r, s.id).status === 'partial' || price(r, s.id).usd === null));
        return { data: available.length ? {
                today: metric('day'), week: metric('7d'), month, budget: { monthly: currentBudget.monthly ?? null, usedPct: currentBudget.monthly > 0 && month.billedUsd !== null ? month.billedUsd / currentBudget.monthly * 100 : null }, providers: snaps.map(s => ({
                    id: s.id, label: s.label, state: !providerWindow(s, monthKeys).observed ? 'unavailable' : s.meta.stale || !s.meta.ok || !hasCoverage(s, monthKeys) ? 'stale' : 'ready', monthTokens: providerWindow(s, monthKeys).tokens,
                    billingKnown: providerWindow(s, monthKeys).billingKnown, hasRecords: providerWindow(s, monthKeys).hasRecords
                })), missingProviders: month.missingProviders, partial: m.partial || month.partial || pricingPartial
            } : null, meta: available.length ? m : { ...m, missingProviders: month.missingProviders } };
    }
    function codexbar(anchor = null) {
        const snaps = snapshots().filter(s => ['codex', 'claude_code'].includes(s.id));
        const has = snaps.some(s => s.data), clock = new Date(now());
        const floor = new Date(clock);
        floor.setDate(floor.getDate() - 69);
        const monthFloor = new Date(clock);
        monthFloor.setDate(monthFloor.getDate() - 29);
        const rows = snaps.flatMap(s => s.data?.days || []).filter(d => anchor ? d.date.startsWith(anchor) : d.date >= localDate(floor) && d.date <= localDate(clock));
        const m = meta(snaps, anchor ? rangeForPeriod('month',clock,anchor).keys : [...new Set(rows.map(r=>r.date))]);
        const grouped = [...new Set(rows.map(r => r.date))].sort().map(date => {
            const r = rows.filter(d => d.date === date), t = totals(r);
            return {
                date, totalCost: t.apiEquivalentUsd, totalTokens: t.tokens, inputTokens: r.reduce((s, d) => s + d.inputTokens + d.cacheReadTokens, 0), outputTokens: r.reduce((s, d) => s + d.outputTokens, 0), models: [...new Set(r.map(d => d.model))].map(model => { const t = totals(r.filter(d => d.model === model)); return { model, cost: t.apiEquivalentUsd, totalTokens: t.tokens }; })
            };
        });
        const t = has ? totals(rows) : { tokens: null, apiEquivalentUsd: null };
        const last = grouped.filter(d => d.date >= localDate(monthFloor));
        const scan = registry.providerDiagnostics('codex') || {state:'not_run',lastAttemptAt:null,lastSuccessAt:null,errorClass:null,usageSource:null};
        const lastGoodScanAgeMs = scan.lastSuccessAt ? Math.max(0,now()-Date.parse(scan.lastSuccessAt)) : null;
        const failedScanFallback = scan.state === 'failed' && scan.usageSource === 'codexbar' && lastGoodScanAgeMs !== null;
        return {
            source: 'codexbar', provider: 'both', updatedAt: m.updatedAt, last30DaysCostUSD: has ? last.length ? knownSum(last.map(d => d.totalCost)) : 0 : null, last30DaysTokens: has ? last.reduce((s, d) => s + d.totalTokens, 0) : null, sessionCostUSD: null, sessionTokens: null, totals: {
                totalCost: t.apiEquivalentUsd, totalTokens: t.tokens, inputTokens: has ? grouped.reduce((s, d) => s + d.inputTokens, 0) : null, outputTokens: has ? grouped.reduce((s, d) => s + d.outputTokens, 0) : null
            }, daily: grouped, partial: m.partial, stale: failedScanFallback, staleAgeMs: failedScanFallback ? lastGoodScanAgeMs : null, staleReason: failedScanFallback ? 'scan_failed_served_last_good' : null, scanErrorClass: scan.errorClass, codexbarScan: {...scan,lastGoodScanAgeMs}, meta: m
        };
    }
    return {
        registry, costs, months, summary, codexbar, refresh: () => Promise.all(registry.sources().map(s => s.refresh())), dispose: () => ownedExec?.killAll(),
        // The runner this service created for itself (null when one was injected), so shutdown and health can see it.
        ownedExec: ownedExec || null
    };
}
module.exports = { createUsageService, LANES, totals };
