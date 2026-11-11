'use strict';
const { COUNTS } = require('./providers/contract');
const modelKey = model => model.split('/').at(-1).toLowerCase();
const keyOf = row => JSON.stringify([row.date, row.model]);
function previousDay(date) { const value = new Date(date + 'T12:00:00'); value.setDate(value.getDate() - 1); return value.toLocaleDateString('en-CA'); }
function groupedDays(rows) { const grouped = new Map(); for (const row of rows) {
    const key = keyOf(row), previous = grouped.get(key);
    if (!previous)
        grouped.set(key, { ...row });
    else {
        for (const k of COUNTS)
            previous[k] += row[k];
        previous.billedUsd = previous.billedUsd === null || row.billedUsd === null ? null : previous.billedUsd + row.billedUsd;
        previous.isLocal = previous.isLocal === row.isLocal ? row.isLocal : null;
    }
} return [...grouped.values()]; }
function ownerBank(owner) {
    if (!owner?.data)
        return [];
    const remaining = new Map(groupedDays(owner.data.days).map(row => [keyOf(row), row]));
    const identified = (owner.data.sessions || []).map(row => ({ ...row }));
    for (const row of identified) {
        const day = remaining.get(keyOf(row));
        if (!day)
            throw Error('Invalid owner session subset');
        for (const k of COUNTS) {
            if (day[k] < row[k])
                throw Error('Invalid owner session counts');
            day[k] -= row[k];
        }
    }
    return [...identified, ...remaining.values()];
}
// Compose all candidates once against one capacity bank per owner. No source
// cache is mutated, and no owner's tokens can confirm two duplicate candidates.
function composeUsageSnapshots(snapshots) {
    const owners = new Map(snapshots.map(s => [s.id, s]));
    const banks = new Map(snapshots.map(s => [s.id, ownerBank(s)]));
    const views = new Map(snapshots.map(s => [s.id, { days: s.data ? groupedDays(s.data.days) : [], unresolved: [] }]));
    const candidates = snapshots.flatMap(s => (s.data?.ownership || []).map(owned => ({ source: s.id, owned })));
    // Prefer stable identities before assigning any unbound adjacent-day credit.
    candidates.sort((a, b) => Number(!!b.owned.sessionId) - Number(!!a.owned.sessionId) || a.source.localeCompare(b.source) || a.owned.date.localeCompare(b.owned.date));
    for (const { source, owned } of candidates) {
        const owner = owners.get(owned.owner), bank = banks.get(owned.owner) || [], view = views.get(source);
        let reason = !owner?.data ? 'owner_unavailable' : !owner.meta.ok || owner.meta.stale ? 'owner_stale' : owner.data.coverage !== 'complete' ? 'owner_partial'
            : owned.latestUsageAt && Date.parse(owner.data.observedAt) < Date.parse(owned.latestUsageAt) ? 'owner_snapshot_older_than_usage' : null;
        const exact = owned.sessionId ? bank.filter(row => row.sessionId === owned.sessionId) : [];
        const adjacent = bank.filter(row => (!owned.sessionId || !row.sessionId) && modelKey(row.model) === modelKey(owned.model) && (row.date === owned.date || row.date === previousDay(owned.date)));
        const matched = exact.length ? exact : adjacent;
        if (!reason && COUNTS.some(k => matched.reduce((sum, row) => sum + row[k], 0) < owned[k]))
            reason = owned.sessionId ? 'owner_session_unconfirmed' : 'owner_usage_unconfirmed';
        if (reason) {
            view.unresolved.push({
                provider: source, owner: owned.owner, date: owned.date, reason
            });
            continue;
        }
        const row = view.days.find(row => keyOf(row) === keyOf(owned));
        if (!row || COUNTS.some(k => row[k] < owned[k]))
            throw Error('Invalid usage ownership subset');
        for (const k of COUNTS) {
            row[k] -= owned[k];
            let remaining = owned[k];
            for (const credit of matched) {
                const take = Math.min(remaining, credit[k]);
                credit[k] -= take;
                remaining -= take;
            }
        }
        if (row.billedUsd !== null)
            row.billedUsd = owned.billedUsd === null ? null : Math.max(0, row.billedUsd - owned.billedUsd);
    }
    return snapshots.map(snap => {
        if (!snap.data?.ownership?.length)
            return snap;
        const view = views.get(snap.id), otherReasons = (snap.data.coverageReasons || []).filter(reason => reason !== 'ownership_pending');
        return { ...snap, data: {
                ...snap.data, days: view.days, unresolvedOverlaps: view.unresolved,
                // Ownership uncertainty is date-scoped by the consumer, rather than
                // masquerading as an intrinsic failure of every day in this source.
                coverage: otherReasons.length ? 'partial' : 'complete', coverageReasons: otherReasons,
                note: view.unresolved.length ? 'Some dated ownership overlaps remain unresolved' : 'Ownership overlaps resolved against current owner snapshots',
            } };
    });
}
module.exports = { composeUsageSnapshots };
