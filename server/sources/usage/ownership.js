'use strict';
const { COUNTS } = require('./providers/contract');
const modelKey = model => model.split('/').at(-1).toLowerCase();
// Source caches retain intrinsic counts and ownership metadata. Only this pure
// composition sees both current snapshots; no refresh ordering changes the result.
function composeUsageSnapshots(snapshots) {
    const owners = new Map(snapshots.map(s => [s.id, s]));
    return snapshots.map(snap => {
        if (!snap.data?.ownership?.length)
            return snap;
        const grouped = new Map(), unresolvedOverlaps = [];
        for (const row of snap.data.days) {
            const key = JSON.stringify([row.date, row.model]), previous = grouped.get(key);
            if (!previous)
                grouped.set(key, { ...row });
            else {
                for (const k of COUNTS)
                    previous[k] += row[k];
                previous.billedUsd = previous.billedUsd === null || row.billedUsd === null ? null : previous.billedUsd + row.billedUsd;
            }
        }
        const days = [...grouped.values()];
        for (const owned of snap.data.ownership) {
            const owner = owners.get(owned.owner);
            let reason = !owner?.data ? 'owner_unavailable' : !owner.meta.ok || owner.meta.stale ? 'owner_stale'
                : owner.data.coverage !== 'complete' ? 'owner_partial'
                    : owned.latestUsageAt && Date.parse(owner.data.observedAt) < Date.parse(owned.latestUsageAt) ? 'owner_snapshot_older_than_usage'
                        : owned.date < owner.data.since || owned.date > owner.data.until ? 'owner_window_missing' : null;
            const matched = (owner?.data?.days || []).filter(r => r.date === owned.date && modelKey(r.model) === modelKey(owned.model));
            if (!reason && COUNTS.some(k => matched.reduce((sum, r) => sum + r[k], 0) < owned[k]))
                reason = 'owner_usage_unconfirmed';
            if (reason) {
                unresolvedOverlaps.push({
                    provider: snap.id, owner: owned.owner, date: owned.date, reason
                });
                continue;
            }
            const row = days.find(r => r.date === owned.date && r.model === owned.model);
            if (!row || COUNTS.some(k => row[k] < owned[k]))
                throw Error('Invalid usage ownership subset');
            for (const k of COUNTS)
                row[k] -= owned[k];
            if (row.billedUsd !== null)
                row.billedUsd = owned.billedUsd === null ? null : Math.max(0, row.billedUsd - owned.billedUsd);
        }
        const otherReasons = (snap.data.coverageReasons || []).filter(reason => reason !== 'ownership_pending');
        return { ...snap, data: {
                ...snap.data, days, unresolvedOverlaps,
                coverage: otherReasons.length || unresolvedOverlaps.length ? 'partial' : 'complete',
                note: unresolvedOverlaps.length ? 'Ownership overlap unresolved; totals may include duplicated usage' : 'Ownership overlap resolved against current owner snapshots',
            } };
    });
}
module.exports = { composeUsageSnapshots };
