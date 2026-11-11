'use strict';
// Every provider implements exactly the documented read contract:
// { id, label, read({ since, until }) -> { days: [{ date, model, inputTokens,
// outputTokens, cacheReadTokens, cacheWriteTokens, billedUsd: number | null }],
// observedAt, coverage: 'complete' | 'partial', note } }.
// Input tokens exclude cache reads; reasoning is a subset of output. Billing
// remains null without explicit recorded billing evidence. No transcripts leave readers.
const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
function unavailable(code = 'usage_unavailable') {
    return Object.assign(new Error('Usage could not be observed'), { code });
}
function validDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function validateObservation(value, { since, until }) {
    if (!validDay(since) || !validDay(until) || since > until) throw unavailable('invalid_usage');
    if (!value || !Array.isArray(value.days) || !['complete', 'partial'].includes(value.coverage)
        || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.note !== 'string')
        throw unavailable('invalid_usage');
    const start = String(since).slice(0, 10), end = String(until).slice(0, 10);
    const validateRows = rows => rows.map(row => {
        if (!row || !validDay(row.date) || row.date < start || row.date > end
            || typeof row.model !== 'string' || !row.model || COUNTS.some(k => !Number.isSafeInteger(row[k]) || row[k] < 0)
            || (row.billedUsd !== null && (!Number.isFinite(row.billedUsd) || row.billedUsd < 0)))
            throw unavailable('invalid_usage');
        return Object.fromEntries(['date', 'model', ...COUNTS, 'billedUsd'].map(k => [k, row[k]]));
    });
    const days = validateRows(value.days);
    const ownership = (value.ownership || []).map(row => {
        if (typeof row.owner !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(row.owner)) throw unavailable('invalid_ownership');
        if(row.latestUsageAt !== undefined && !Number.isFinite(Date.parse(row.latestUsageAt)))throw unavailable('invalid_ownership');
        return {owner:row.owner,...validateRows([row])[0],...(row.latestUsageAt?{latestUsageAt:row.latestUsageAt}:{})};
    });
    const pool = new Map();
    for (const row of days) {
        const key = JSON.stringify([row.date,row.model]);
        const counts = pool.get(key) || Object.fromEntries(COUNTS.map(k=>[k,0]));
        for (const k of COUNTS) counts[k] += row[k];
        pool.set(key,counts);
    }
    for (const row of ownership) {
        const counts = pool.get(JSON.stringify([row.date,row.model]));
        if (!counts || COUNTS.some(k=>counts[k]<row[k])) throw unavailable('invalid_ownership');
        for (const k of COUNTS) counts[k]-=row[k];
    }
    if (value.coverageReasons && (!Array.isArray(value.coverageReasons) || value.coverageReasons.some(reason => !['ownership_pending','producer_partial','scan_truncated','malformed_records','unknown_tokens'].includes(reason)))) throw unavailable('invalid_usage');
    const coverageReasons = [...new Set(value.coverageReasons || (value.coverage==='partial'?['producer_partial']:[]))];
    if (ownership.length && !coverageReasons.includes('ownership_pending')) coverageReasons.push('ownership_pending');

    return {
        days, ownership, coverageReasons, observedAt: value.observedAt, coverage: coverageReasons.length ? 'partial' : value.coverage, note: value.note.slice(0, 500)
    };
}
module.exports = { COUNTS, validDay, unavailable, validateObservation };
