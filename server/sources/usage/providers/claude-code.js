'use strict';
const path = require('node:path');
const { readJson } = require('./command');
function createClaudeCodeProvider({ exec, projectRoot, home, dataDir, env = {} }) {
    return {
        id: 'claude_code', label: 'Claude Code', identity: path.join(home, '.claude', 'projects'), timeoutMs: 95000, intervalMs: 300000, staleAfterMs: 900000,
        read: ({ since, until }) => readJson(exec, process.execPath, ['--max-old-space-size=96', path.join(projectRoot, 'server/sources/usage/claude-log-reader.js'), since, until], {
            lane: 'usage_claude', timeoutMs: 90000, key: 'usage:claude', maxOutputBytes: 20 * 1024 * 1024, env: { ...env, MC_USAGE_CACHE_DIR: path.join(dataDir || path.join(projectRoot,'data'),'usage','incremental','claude_code'), HOME: home }
        })
    };
}
module.exports = { createProvider: createClaudeCodeProvider, createClaudeCodeProvider };
