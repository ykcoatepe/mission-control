'use strict';
const path = require('node:path');
const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
const STALE_CACHE_MS = 60 * 60 * 1000;
const cacheError = () => Object.assign(new Error('Usage cache capacity exceeded'), { code: 'usage_cache_capacity' });
function alive(pid) { try {
    process.kill(pid, 0);
    return true;
}
catch (error) {
    return error.code !== 'ESRCH';
} }
// This directory is one provider's private, single-writer count cache. Never
// recurse, follow symlinks, or delete a file outside our exact filename formats.
async function createCacheBudget({ fs, cacheDir, index, maxCacheBytes = DEFAULT_CACHE_BYTES, now = Date.now, staleCacheMs = STALE_CACHE_MS, isProcessAlive = alive }) {
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 1)
        throw cacheError();
    const parts = path.resolve(cacheDir).split(path.sep), usageRootIndex = parts.findIndex((part, i) => part === 'data' && parts[i + 1] === 'usage');
    let managed = false;
    if (usageRootIndex >= 0) {
        const root = parts.slice(0, usageRootIndex + 2).join(path.sep);
        try {
            const [realRoot, realCache] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(cacheDir)]);
            managed = realCache === realRoot || realCache.startsWith(realRoot + path.sep);
        }
        catch { }
    }
    const referenced = new Set(Object.values(index.files).map(entry => entry?.cache));
    const sizes = new Map();
    let used = 0;
    for (const entry of await fs.promises.readdir(cacheDir, { withFileTypes: true })) {
        const file = path.join(cacheDir, entry.name), stat = await fs.promises.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            continue;
        const scratch = /^run-(\d+)-[a-f0-9]{16}\.jsonl$/.exec(entry.name) || /^index\.json\.tmp-(\d+)-[a-f0-9]{10}$/.exec(entry.name);
        const orphan = /^[a-f0-9]{64}\.jsonl$/.test(entry.name) && !referenced.has(entry.name);
        const stale = now() - stat.mtimeMs >= staleCacheMs;
        if (managed && stale && ((scratch && !isProcessAlive(Number(scratch[1]))) || orphan)) {
            try {
                await fs.promises.unlink(file);
                continue;
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    continue;
            }
        }
        sizes.set(file, stat.size);
        used += stat.size;
    }
    function reserve(file, bytes) { if (used + bytes > maxCacheBytes)
        throw cacheError(); used += bytes; sizes.set(file, (sizes.get(file) ?? 0) + bytes); }
    function release(file) { used -= sizes.get(file) ?? 0; sizes.delete(file); }
    if (used > maxCacheBytes)
        throw cacheError();
    return {
        reserve,
        async rename(from, to) { await fs.promises.rename(from, to); const bytes = sizes.get(from) ?? 0; release(to); sizes.delete(from); sizes.set(to, bytes); },
        async remove(file) { try {
            await fs.promises.unlink(file);
            release(file);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                release(file);
        } },
    };
}
module.exports = { createCacheBudget, DEFAULT_CACHE_BYTES, STALE_CACHE_MS };
