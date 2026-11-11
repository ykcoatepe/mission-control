'use strict';
const path = require('node:path');
const { createSource } = require('../../core/source');
const { validateObservation, unavailable } = require('./providers/contract');
function createUsageRegistry({ providers = [], now = Date.now, fs, dataDir, timeoutMs = 125000, window, logger = null, scheduler } = {}) {
    const entries = new Map();
    const getWindow = window || (() => { const until = new Date(now()); const since = new Date(until.getFullYear(), until.getMonth() - 25, 1); return { since: localDate(since), until: localDate(until) }; });
    function register(provider) {
        if (!provider || !/^[a-z][a-z0-9_-]*$/.test(provider.id) || !provider.label || typeof provider.read !== 'function' || entries.has(provider.id))
            throw new TypeError('Invalid or duplicate usage provider');
        const file = dataDir && path.join(dataDir, 'usage', `${provider.id}.json`);
        let persistence = Promise.resolve();
        const source = createSource({
            id: `usage.${provider.id}`, now, timeoutMs: provider.timeoutMs || timeoutMs, ttlMs: provider.intervalMs || 60000, staleAfterMs: provider.staleAfterMs || 180000, logger,
            read: async () => {
                const bounds = getWindow();
                let value;
                try {
                    value = validateObservation(await provider.read(bounds), bounds);
                }
                catch {
                    throw unavailable();
                }
                return { ...value, since: bounds.since, until: bounds.until };
            },
        });
        let restored = null;
        let attemptedRestore = false;
        const sourceSnapshot = source.snapshot;
        source.snapshot = () => {
            const snap = sourceSnapshot();
            if (snap.data || !restored)
                return snap;
            const ageMs = Math.max(0, now() - Date.parse(restored.observedAt));
            return { data: restored, meta: {
                    ...snap.meta, ok: false, stale: true, observedAt: restored.observedAt, ageMs, error: { code: 'cached_usage', message: 'Cached usage; live refresh not confirmed' }
                } };
        };
        const refreshSource = source.refresh;
        // Only a completed, accepted refresh persists. In particular a late result
        // after core's timeout cannot overwrite last-good on disk.
        source.refresh = async () => {
            if (!attemptedRestore && file && fs) {
                attemptedRestore = true;
                try {
                    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
                    if (saved.version === 1 && saved.identity === (provider.identity || provider.id)) {
                        const value = validateObservation(saved.data, { since: saved.data.since, until: saved.data.until });
                        if (now() - Date.parse(value.observedAt) <= 24 * 60 * 60 * 1000) {
                            restored = { ...value, since: saved.data.since, until: saved.data.until };
                            provider.restoreScanStatus?.(saved.diagnostics);
                        }
                    }
                }
                catch { /* A cache is optional; failed upstream reads remain unavailable. */ }
            }
            const snap = await refreshSource();
            if (snap.meta.ok && file && fs) {
                const body = JSON.stringify({ version: 1, identity: provider.identity || provider.id, data: snap.data, diagnostics: provider.scanStatus?.() });
                persistence = persistence.catch(() => { }).then(async () => {
                    const tmp = `${file}.tmp-${process.pid}-${now()}`;
                    try {
                        await fs.mkdir(path.dirname(file), { recursive: true });
                        await fs.writeFile(tmp, body, { mode: 0o600 });
                        await fs.rename(tmp, file);
                    }
                    catch {
                        await fs.unlink(tmp).catch(() => { });
                        logger?.warn?.(`[usage:${provider.id}] cache persistence failed`);
                    }
                });
                await persistence;
            }
            return source.snapshot();
        };
        entries.set(provider.id, { provider, source });
        scheduler?.register(source, { intervalMs: provider.intervalMs || 60000, jitterMs: 1000 });
        return source;
    }
    providers.forEach(register);
    return {
        providerDiagnostics: id => entries.get(id)?.provider.scanStatus?.() || null,
        register, sources: () => [...entries.values()].map(x => x.source), snapshots: () => [...entries.values()].map(({ provider, source }) => ({ id: provider.id, label: provider.label, ...source.snapshot() })), window: getWindow
    };
}
function localDate(date) { return date.toLocaleDateString('en-CA'); }
module.exports = { createUsageRegistry, localDate };
