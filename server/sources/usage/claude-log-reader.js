'use strict';
const path = require('node:path');
const fsDefault = require('node:fs');
const { scanIncremental, hash } = require('./incremental-jsonl');
async function readClaudeLogs({ since, until }, { fs = fsDefault, home = process.env.HOME, now = Date.now, maxFiles = 20000, cacheDir = fs === fsDefault ? (process.env.MC_USAGE_CACHE_DIR || path.resolve('data/usage/incremental/claude_code')) : null } = {}) {
    const days = new Map();
    const scan = await scanIncremental({
        root: path.join(home, '.claude', 'projects'), cacheDir, fs, since, until, maxFiles,
        normalize(row, state, { file, offset }) {
            if (row.type !== 'assistant' || !row.message?.usage)
                return null;
            if (!Number.isFinite(Date.parse(row.timestamp))) {
                state.partial = true;
                return null;
            }
            const message = row.message, usage = message.usage, model = message.model || 'unknown';
            const requestId = row.requestId && message.id ? `${row.requestId}:${message.id}` : message.id || row.uuid || `${hash(file)}:${offset}`;
            return {
                id: hash(`${model}:${requestId}`), date: new Date(row.timestamp).toLocaleDateString('en-CA'), model,
                inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0, billedUsd: null
            };
        },
        consume(row) {
            const key = JSON.stringify([row.date, row.model]);
            const day = days.get(key) || {
                date: row.date, model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, billedUsd: null
            };
            for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
                day[k] += row[k];
            days.set(key, day);
        },
    });
    return {
        days: [...days.values()].filter(d => d.inputTokens || d.outputTokens || d.cacheReadTokens || d.cacheWriteTokens), observedAt: new Date(now()).toISOString(), coverage: scan.partial ? 'partial' : 'complete', coverageReasons: scan.partial ? ['producer_partial'] : [],
        note: scan.partial ? 'Claude incremental log scan incomplete; totals may be understated' : 'Local Claude Code requests deduplicated to earliest observed day; billing USD is not recorded'
    };
}
if (require.main === module)
    readClaudeLogs({ since: process.argv[2], until: process.argv[3] }).then(value => process.stdout.write(JSON.stringify(value)), () => { console.error('[usage] Claude log scan failed'); process.exitCode = 1; });
module.exports = { readClaudeLogs };
