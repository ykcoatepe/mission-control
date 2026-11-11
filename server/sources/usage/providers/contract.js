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
    const days = value.days.map(row => {
        if (!row || !validDay(row.date) || row.date < start || row.date > end
            || typeof row.model !== 'string' || !row.model || COUNTS.some(k => !Number.isSafeInteger(row[k]) || row[k] < 0)
            || (row.billedUsd !== null && (!Number.isFinite(row.billedUsd) || row.billedUsd < 0)))
            throw unavailable('invalid_usage');
        return Object.fromEntries(['date', 'model', ...COUNTS, 'billedUsd'].map(k => [k, row[k]]));
    });
    return {
        days, observedAt: value.observedAt, coverage: value.coverage, note: value.note.slice(0, 500)
    };
}
module.exports = { COUNTS, unavailable, validateObservation };
