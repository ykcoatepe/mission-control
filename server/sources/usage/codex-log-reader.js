'use strict';
const path = require('node:path');
const fsDefault = require('node:fs');
const { scanIncremental, hash } = require('./incremental-jsonl');
async function readCodexLogs({ since, until }, { fs = fsDefault, home = process.env.HOME, codexHome = path.join(home, '.codex'), now = Date.now, maxFiles = 20000, maxCacheBytes, staleCacheMs, isProcessAlive, cacheDir = fs === fsDefault ? (process.env.MC_USAGE_CACHE_DIR || path.resolve('data/usage/incremental/codex')) : null } = {}) {
    const helpers = require('../../../scripts/openclaw-usage-summary');
    const days = new Map(), owned = new Map();
    function add(map, row, identity = false) {
        const key = JSON.stringify([row.date, row.model, identity ? row.sessionId : null]);
        const d = map.get(key) || {
            date: row.date, model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: 0
        };
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
            d[k] += row[k];
        if(identity && row.sessionId)d.sessionId=row.sessionId;
        if (row.latestUsageAt && (!d.latestUsageAt || row.latestUsageAt > d.latestUsageAt))
            d.latestUsageAt = row.latestUsageAt;
        d.billedUsd = d.billedUsd === null || row.billedUsd === null ? null : d.billedUsd + row.billedUsd;
        map.set(key, d);
    }
    const scan = await scanIncremental({
        root: path.join(codexHome, 'sessions'), cacheDir, fs, since, until, maxFiles, now, maxCacheBytes, staleCacheMs, isProcessAlive, format: 'codex-counts-v3',
        context: (file, saved) => {
            const state = {
                provider: '', model: '', billingMode: '', codexClass: 'unrecognized', session: hash(file)
            };
            if (saved) {
                for (const k of ['provider', 'model'])
                    if (typeof saved[k] === 'string')
                        state[k] = saved[k];
                if (saved.billingMode === 'subscription_included')
                    state.billingMode = saved.billingMode;
                if (['hermes_owned', 'codex_app', 'codex_cli', 'unrecognized'].includes(saved.codexClass))
                    state.codexClass = saved.codexClass;
                for (const k of ['session', 'rolloutId', 'lastCumulative'])
                    if (/^[a-f0-9]{64}$/.test(saved[k] || ''))
                        state[k] = saved[k];
                state.partial = !!saved.partial;
            }
            return state;
        },
        normalize(object, context, { file, offset, mtimeMs }) {
            if (object.type === 'session_meta' && object.payload) {
                const p = object.payload;
                helpers.applyModelContext(context, p);
                context.billingMode = helpers.sessionMetaBillingMode(p) === 'subscription_included' ? 'subscription_included' : '';
                context.codexClass = helpers.classifyCodexSession(p.originator, helpers.sessionMetaSourceKey(p));
                if (p.id) {context.session = hash(String(p.id));context.rolloutId=context.session;}
            }
            if (object.type === 'turn_context' && object.payload)
                helpers.applyModelContext(context, object.payload);
            if (object.type === 'event_msg' && object.payload?.type === 'thread_settings_applied' && object.payload.thread_settings)
                helpers.applyModelContext(context, object.payload.thread_settings);
            let cumulative;
            if (object.type === 'event_msg' && object.payload?.type === 'token_count' && object.payload.info?.total_token_usage) {
                cumulative = hash(JSON.stringify(object.payload.info.total_token_usage));
                if (context.lastCumulative === cumulative)
                    return null;
                context.lastCumulative = cumulative;
            }
            const r = helpers.extractUsageRecord(object, mtimeMs, file, context);
            if (!r)
                return null;
            r.origin = 'codex';
            r.codexClass = context.codexClass;
            return {
                id: hash(`${context.session}:${r.model}:${r.timestampMs}:${cumulative || offset}`), date: r.date, model: helpers.modelName(r.provider, r.model, r), inputTokens: Math.max(0, r.input - r.cacheRead), outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite,
                billedUsd: r.totalCost > 0 ? r.totalCost : helpers.isSubscriptionIncludedRecord(r) ? 0 : null, ...(context.codexClass === 'hermes_owned' ? { owner: 'hermes', ...(context.rolloutId?{sessionId:context.rolloutId}:{}), latestUsageAt: new Date(r.timestampMs).toISOString() } : {})
            };
        }, consume(row) { add(days, row); if (row.owner === 'hermes')
            add(owned, row, true); },
    });
    const ownership = [...owned.values()].map(row => ({ owner: 'hermes', ...row }));
    const coverageReasons = [...(scan.partial ? ['producer_partial'] : []), ...(ownership.length ? ['ownership_pending'] : [])];
    return {
        days: [...days.values()].map(({ latestUsageAt, ...row }) => row), ownership, coverageReasons, observedAt: new Date(now()).toISOString(), coverage: coverageReasons.length ? 'partial' : 'complete', note: scan.partial ? 'Codex incremental scan incomplete; totals may be understated' : ownership.length ? 'Hermes-owned counts retained for composition-time ownership resolution' : 'Local Codex App and CLI usage records; billing unknown unless recorded'
    };
}
module.exports = { readCodexLogs };
