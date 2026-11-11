'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const { once } = require('node:events');
const { createCacheBudget } = require('./cache-budget');
const { COUNTS, validDay } = require('./providers/contract');
const BATCH = 1024, FAN_IN = 24, MAX_LINE = 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function validRecord(r) { return r && /^[a-f0-9]{64}$/.test(r.id) && validDay(r.date) && typeof r.model === 'string' && COUNTS.every(k => Number.isSafeInteger(r[k]) && r[k] >= 0) && (r.billedUsd === null || Number.isFinite(r.billedUsd) && r.billedUsd >= 0) && (!r.owner || /^[a-z][a-z0-9_-]*$/.test(r.owner)); }
function mergeRecord(a, b) {
    if (a.model !== b.model || a.owner !== b.owner)
        throw Error('Inconsistent normalized usage identity');
    const r = {
        ...a, ...(a.latestUsageAt || b.latestUsageAt ? { latestUsageAt: [a.latestUsageAt, b.latestUsageAt].filter(Boolean).sort().at(-1) } : {}), date: a.date < b.date ? a.date : b.date, billedUsd: a.billedUsd === null || b.billedUsd === null ? null : Math.max(a.billedUsd, b.billedUsd)
    };
    for (const k of COUNTS)
        r[k] = Math.max(a[k], b[k]);
    return r;
}
// Buffer framing caps the raw line retained in memory. No raw tail is persisted:
// an unterminated line is read again from its starting byte on the next append.
async function* lines(fs, file, { start = 0, end } = {}) {
    if (end !== undefined && end < start)
        return;
    const stream = fs.createReadStream(file, { start, ...(Number.isFinite(end) ? { end } : {}), highWaterMark: 64 * 1024 });
    let pending = Buffer.alloc(0), offset = start, discarding = false;
    for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        let cursor = 0;
        while (cursor < chunk.length) {
            const nl = chunk.indexOf(10, cursor), stop = nl < 0 ? chunk.length : nl;
            const part = chunk.subarray(cursor, stop);
            if (!discarding && pending.length + part.length <= MAX_LINE)
                pending = Buffer.concat([pending, part]);
            else {
                discarding = true;
                pending = Buffer.alloc(0);
            }
            if (nl < 0)
                break;
            const nextOffset = offset + part.length + 1;
            yield {
                text: discarding ? null : pending.toString('utf8'), offset: nextOffset - pending.length - 1, nextOffset, terminated: true
            };
            pending = Buffer.alloc(0);
            discarding = false;
            offset = nextOffset;
            cursor = nl + 1;
        }
        // offset includes bytes already buffered; the actual record start is
        // recovered below by subtracting pending.length.
        if (chunk.at(-1) !== 10)
            offset += chunk.length - cursor;
    }
    if (pending.length || discarding)
        yield {
            text: discarding ? null : pending.toString('utf8'), offset: offset - pending.length, nextOffset: offset - pending.length, terminated: false
        };
}
async function* records(fs, file) { let previous = ''; for await (const line of lines(fs, file)) {
    if (line.text === null)
        throw Error('Oversized normalized usage record');
    if (!line.text.trim())
        continue;
    const r = JSON.parse(line.text);
    if (!validRecord(r) || r.id < previous)
        throw Error('Corrupt normalized usage cache');
    previous = r.id;
    yield r;
} }
async function* mergeStreams(fs, files) {
    const active = [];
    try {
        for (const file of files) {
            const iterator = records(fs, file)[Symbol.asyncIterator](), first = await iterator.next();
            if (!first.done)
                active.push({ iterator, row: first.value });
        }
        let previous = null;
        while (active.length) {
            let index = 0;
            for (let i = 1; i < active.length; i++)
                if (active[i].row.id < active[index].row.id)
                    index = i;
            const entry = active[index], row = entry.row, next = await entry.iterator.next();
            if (next.done)
                active.splice(index, 1);
            else
                entry.row = next.value;
            if (previous?.id === row.id)
                previous = mergeRecord(previous, row);
            else {
                if (previous)
                    yield previous;
                previous = row;
            }
        }
        if (previous)
            yield previous;
    }
    finally {
        for (const e of active)
            await e.iterator.return?.();
    }
}
async function writeRecords(fs, file, iterable, budget) {
    const output = fs.createWriteStream(file, { mode: 0o600 });
    let writeError;
    output.on('error', e => { writeError = e; });
    const digest = crypto.createHash('sha256');
    let count = 0;
    try {
        for await (const row of iterable) {
            if (writeError)
                throw writeError;
            const line = JSON.stringify(row) + '\n';
            budget?.reserve(file,Buffer.byteLength(line));
            digest.update(line);
            count++;
            if (!output.write(line))
                await once(output, 'drain');
        }
        if (writeError)
            throw writeError;
        const finished = once(output, 'finish');
        output.end();
        await finished;
        return { digest: digest.digest('hex'), count };
    }
    catch (error) {
        output.destroy();
        throw error;
    }
}
async function validateCache(fs, file, entry) { try {
    const digest = crypto.createHash('sha256');
    let count = 0;
    for await (const row of records(fs, file)) {
        digest.update(JSON.stringify(row) + '\n');
        count++;
    }
    return count === entry.count && digest.digest('hex') === entry.digest;
}
catch {
    return false;
} }
async function atomicJson(fs, file, value, budget) {
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
    try {
        const body = JSON.stringify(value);
        budget?.reserve(tmp,Buffer.byteLength(body));
        await fs.promises.writeFile(tmp,body,{mode:0o600});
        if(budget)await budget.rename(tmp,file);else await fs.promises.rename(tmp,file);
    } finally {
        if(budget)await budget.remove(tmp);else await fs.promises.unlink(tmp).catch(()=>{});
    }
}
async function walkFiles(fs, root, since, maxFiles) {
    const candidates = [];
    let capped = false;
    // Keep only the newest maxFiles metadata entries, even for a much larger
    // directory tree. The min-heap bounds directory-enumeration memory too.
    function keep(candidate) {
        if (candidates.length < maxFiles) {
            candidates.push(candidate);
            let i = candidates.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (candidates[p].stat.mtimeMs <= candidates[i].stat.mtimeMs)
                    break;
                [candidates[p], candidates[i]] = [candidates[i], candidates[p]];
                i = p;
            }
            return;
        }
        capped = true;
        if (candidate.stat.mtimeMs <= candidates[0].stat.mtimeMs)
            return;
        candidates[0] = candidate;
        let i = 0;
        while (true) {
            let child = i * 2 + 1;
            if (child >= candidates.length)
                break;
            if (child + 1 < candidates.length && candidates[child + 1].stat.mtimeMs < candidates[child].stat.mtimeMs)
                child++;
            if (candidates[i].stat.mtimeMs <= candidates[child].stat.mtimeMs)
                break;
            [candidates[i], candidates[child]] = [candidates[child], candidates[i]];
            i = child;
        }
    }
    async function walk(dir) {
        const entries = fs.promises?.opendir ? await fs.promises.opendir(dir) : fs.promises?.readdir ? await fs.promises.readdir(dir, { withFileTypes: true }) : fs.readdirSync(dir, { withFileTypes: true });
        for await (const entry of entries) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.startsWith('.'))
                await walk(file);
            else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.trajectory.jsonl')) {
                const stat = fs.promises?.stat ? await fs.promises.stat(file) : fs.statSync ? fs.statSync(file) : { size: Infinity, mtimeMs: 0, ino: 0 };
                if (stat.mtimeMs > 0 && stat.mtimeMs < new Date(since + 'T00:00:00').getTime())
                    continue;
                keep({ file, stat });
            }
        }
    }
    await walk(root);
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (candidates.length > maxFiles)
        capped = true;
    return { files: candidates.slice(0, maxFiles), capped };
}
async function anchor(fs, file, offset) { if (!fs.promises?.open)
    return null; const handle = await fs.promises.open(file, 'r'); try {
    const buffer = Buffer.alloc(Math.min(offset, 256));
    await handle.read(buffer, 0, buffer.length, Math.max(0, offset - buffer.length));
    return hash(buffer);
}
finally {
    await handle.close();
} }
async function scanIncremental({ root, cacheDir, fs = fsDefault, since, until, normalize, context = (file, saved) => ({ partial: !!saved?.partial }), maxFiles = 20000, format = 'usage-counts-v1', consume, now=Date.now, maxCacheBytes, staleCacheMs, isProcessAlive }) {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1)
        throw Error('Invalid file scan budget');
    const persistent = !!cacheDir;let listing;
    const scratch = [];
    const temp = () => { const p = path.join(cacheDir, `run-${process.pid}-${crypto.randomBytes(8).toString('hex')}.jsonl`); scratch.push(p); return p; };
    let old = { version: 1, format, files: {} }, index = { version: 1, format, files: {} }, partial = false, skippedLines = 0, oversizedLines = 0;
    const memory = new Map(), cacheFiles = [], createdCanonical=new Set();let budget,committed=false;
    if (persistent) {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        try {
            const x = JSON.parse(await fs.promises.readFile(path.join(cacheDir, 'index.json'), 'utf8'));
            if (x.version === 1 && (x.format || 'usage-counts-v1') === format && x.files && typeof x.files === 'object')
                old = x;
        }
        catch { }
    }
    if(persistent)budget=await createCacheBudget({fs,cacheDir,index:old,maxCacheBytes,now,staleCacheMs,isProcessAlive});
    const oldReferences=new Set(Object.values(old.files).map(entry=>entry?.cache));
    async function collapse(input) { let work = input; while (work.length > FAN_IN) {
        const next = [];
        for (let i = 0; i < work.length; i += FAN_IN) {
            const target = temp();
            await writeRecords(fs, target, mergeStreams(fs, work.slice(i, i + FAN_IN)), budget);
            next.push(target);
        }
        work = next;
    } return work; }
    listing=await walkFiles(fs,root,since,maxFiles);partial=listing.capped;
    try {
        for (const { file, stat } of listing.files) {
            const key = hash(file), saved = old.files[key];
            let previous = saved;
            if (previous && (!Number.isSafeInteger(previous.size) || previous.size < 0 || !Number.isSafeInteger(previous.offset) || previous.offset < 0 || previous.offset > previous.size || !Number.isFinite(previous.mtimeMs) || !Number.isSafeInteger(previous.count) || previous.count < 0 || !/^[a-f0-9]{64}$/.test(previous.digest || '')))
                previous = null;
            // Older manifests lack diagnostics: rescan once, then retain exact
            // counters through unchanged files and byte-offset append refreshes.
            if (previous && ['skippedLines', 'oversizedLines', 'permanentSkippedLines', 'permanentOversizedLines'].some(k => !Number.isSafeInteger(previous[k]) || previous[k] < 0)) previous = null;
            if (persistent && previous) {
                const target = path.join(cacheDir, previous.cache || 'invalid');
                if (!/^[a-f0-9]{64}\.jsonl$/.test(previous.cache || '') || !await validateCache(fs, target, previous))
                    previous = null;
            }
            const unchanged = previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ino === stat.ino;
            if (unchanged) {
                index.files[key] = previous;
                partial ||= previous.partial;
                skippedLines += previous.skippedLines; oversizedLines += previous.oversizedLines;
                cacheFiles.push(path.join(cacheDir, previous.cache));
                continue;
            }
            const append = previous && stat.size > previous.size && previous.ino === stat.ino && previous.offset <= previous.size && previous.anchor === await anchor(fs, file, previous.offset) && previous.head === await anchor(fs, file, Math.min(previous.size, 256));
            let state = context(file, append ? previous.context : null), offset = append ? previous.offset : 0, filePartial = append ? previous.permanentPartial : false, tailPartial = false;
            let fileSkipped = append ? previous.permanentSkippedLines : 0, fileOversized = append ? previous.permanentOversizedLines : 0, tailSkipped = 0, tailOversized = 0;
            const runs = append ? [path.join(cacheDir, previous.cache)] : [], batch = [];
            async function flush() { if (!batch.length)
                return; batch.sort((a, b) => a.id.localeCompare(b.id)); const target = temp(); await writeRecords(fs, target, batch, budget); runs.push(target); batch.length = 0; }
            let checkpoint = state;
            for await (const line of lines(fs, file, { start: offset, end: Number.isFinite(stat.size) ? stat.size - 1 : undefined })) {
                if (line.text === null) {
                    filePartial = true;
                    if (line.terminated) {
                        fileSkipped++; fileOversized++;
                        offset = line.nextOffset;
                    } else { tailSkipped++; tailOversized++; }
                    continue;
                }
                if (!line.text.trim()) {
                    if (line.terminated)
                        offset = line.nextOffset;
                    continue;
                }
                const before = line.terminated ? null : structuredClone(state);
                let object;
                try {
                    object = JSON.parse(line.text);
                }
                catch {
                    if (line.terminated) {
                        filePartial = true;
                        fileSkipped++;
                    } else {
                        tailPartial = true;
                        tailSkipped++;
                    }
                    if (line.terminated)
                        offset = line.nextOffset;
                    continue;
                }
                const beforeSkipped = state.skippedLines ?? 0;
                const row = normalize(object, state, { file, offset: line.offset, mtimeMs: stat.mtimeMs });
                const normalizationSkips = (state.skippedLines ?? 0) - beforeSkipped;
                if (line.terminated) fileSkipped += normalizationSkips; else tailSkipped += normalizationSkips;
                if (row) {
                    if (!validRecord(row))
                        throw Error('Invalid normalized usage counts');
                    if (persistent) {
                        batch.push(row);
                        if (batch.length >= BATCH)
                            await flush();
                    }
                    else {
                        const previous = memory.get(row.id);
                        memory.set(row.id, previous ? mergeRecord(previous, row) : row);
                        if (memory.size > 50000)
                            throw Error('Nonpersistent usage scan capacity exceeded');
                    }
                }
                if (line.terminated) {
                    offset = line.nextOffset;
                    checkpoint = state;
                }
                else
                    checkpoint = before;
            }
            filePartial ||= !!state.partial;
            partial ||= filePartial || tailPartial;
            skippedLines += fileSkipped + tailSkipped; oversizedLines += fileOversized + tailOversized;
            if (persistent) {
                await flush();
                const inputs = await collapse(runs), target = temp();
                const summary = await writeRecords(fs, target, mergeStreams(fs, inputs), budget);
                const cache = hash(JSON.stringify([key, stat.size, stat.mtimeMs, stat.ino, summary.digest])) + '.jsonl';
                await budget.rename(target,path.join(cacheDir,cache));
                if(!oldReferences.has(cache))createdCanonical.add(path.join(cacheDir,cache));
                const entry = {
                    size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, offset, anchor: await anchor(fs, file, offset), head: await anchor(fs, file, Math.min(stat.size, 256)), context: checkpoint, cache, ...summary, partial: filePartial || tailPartial, permanentPartial: filePartial,
                    skippedLines: fileSkipped + tailSkipped, oversizedLines: fileOversized + tailOversized, permanentSkippedLines: fileSkipped, permanentOversizedLines: fileOversized
                };
                index.files[key] = entry;
                cacheFiles.push(path.join(cacheDir, cache));
            }
        }
        if (persistent) {
            const inputs = await collapse(cacheFiles);
            for await (const row of mergeStreams(fs, inputs))
                if (row.date >= since && row.date <= until)
                    consume(row);
            await atomicJson(fs, path.join(cacheDir, 'index.json'), index, budget);committed=true;
            const retained = new Set(Object.values(index.files).map(e => e.cache));
            for (const entry of Object.values(old.files))
                if (/^[a-f0-9]{64}\.jsonl$/.test(entry?.cache || '') && !retained.has(entry.cache))
                    await budget.remove(path.join(cacheDir,entry.cache));
        }
        else
            for (const row of memory.values())
                if (row.date >= since && row.date <= until)
                    consume(row);
        return { partial, files: listing.files.length, skippedLines, oversizedLines };
    }
    finally {
        if (persistent) {
            for(const file of scratch)await budget.remove(file);
            if(!committed)for(const file of createdCanonical)await budget.remove(file);
        }
    }
}
module.exports = { scanIncremental, hash };
