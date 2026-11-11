'use strict';
const path = require('node:path');
const fsDefault = require('node:fs');
const readline = require('node:readline');
async function readClaudeLogs({ since, until }, { fs = fsDefault, home = process.env.HOME, now = Date.now, maxFiles = 20000, } = {}) {
    const files = [];
    async function walk(dir) {
        for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory())
                await walk(file);
            else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.trajectory.jsonl'))
                files.push(file);
        }
    }
    await walk(path.join(home, '.claude', 'projects'));
    // Sort the complete candidate set before applying a cap, so recent usage is
    // never evicted merely by directory enumeration order.
    const ranked = await Promise.all(files.map(async (file) => ({
        file, mtimeMs: fs.promises.stat ? (await fs.promises.stat(file)).mtimeMs : 0,
    })));
    ranked.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let partial = files.length > maxFiles;
    const days = new Map();
    const seen = new Map();
    for (const { file } of ranked.slice(0, maxFiles)) {
        const input = fs.createReadStream(file, { encoding: 'utf8' });
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        let streamError;
        input.on('error', error => { streamError = error; lines.close(); });
        for await (const line of lines) {
            if (!line.trim())
                continue;
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                partial = true;
                continue;
            }
            if (row.type !== 'assistant' || !row.message?.usage)
                continue;
            if (!Number.isFinite(Date.parse(row.timestamp))) {
                partial = true;
                continue;
            }
            let date = new Date(row.timestamp).toLocaleDateString('en-CA');
            const { message } = row;
            const usage = message.usage;
            const model = message.model || 'unknown';
            const requestId = row.requestId && message.id ? `${row.requestId}:${message.id}` : message.id || row.uuid;
            const id = requestId ? `${model}:${requestId}` : null;
            const previous = id ? seen.get(id) : null;
            // Restored logs may repeat a request with a new outer timestamp. Attribute
            // its final counts once to the earliest observed day, even across midnight.
            if (previous && previous.date < date)
                date = previous.date;
            const key = `${date}::${model}`;
            const counts = {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            };
            if (Object.values(counts).some(x => !Number.isFinite(x) || x < 0))
                throw Error('Invalid usage counts');
            if (previous && previous.key !== key) {
                const previousDay = days.get(previous.key);
                for (const [field, count] of Object.entries(previous.counts))
                    previousDay[field] -= count;
            }
            const day = days.get(key) || {
                date, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null
            };
            const finalCounts = {};
            // A stream can grow its output count across snapshots. Count each
            // request once, retaining its greatest observed cumulative count.
            for (const [field, count] of Object.entries(counts)) {
                finalCounts[field] = Math.max(count, previous?.counts[field] || 0);
                day[field] += finalCounts[field] - (previous?.key === key ? previous.counts[field] : 0);
            }
            if (id)
                seen.set(id, { key, date, counts: finalCounts });
            days.set(key, day);
        }
        if (streamError)
            throw streamError;
    }
    return {
        days: [...days.values()].filter(day => day.date >= since && day.date <= until && (day.inputTokens || day.outputTokens || day.cacheReadTokens || day.cacheWriteTokens)), observedAt: new Date(now()).toISOString(), coverage: partial ? 'partial' : 'complete',
        note: partial ? 'Claude log scan incomplete; totals may be understated' : 'Local Claude Code requests deduplicated to earliest observed day; billing USD is not recorded',
    };
}
if (require.main === module) {
    readClaudeLogs({ since: process.argv[2], until: process.argv[3] }).then(value => process.stdout.write(JSON.stringify(value)), () => { console.error('[usage] Claude log scan failed'); process.exitCode = 1; });
}
module.exports = { readClaudeLogs };
