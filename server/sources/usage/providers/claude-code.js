'use strict';
const path = require('node:path');
const { readJson } = require('./command');
function createClaudeCodeProvider({ exec, projectRoot, home, env = {} }) {
    return {
        id: 'claude_code', label: 'Claude Code', identity: path.join(home, '.claude', 'projects'), timeoutMs: 95000,
        read: ({ since, until }) => readJson(exec, process.execPath, [path.join(projectRoot, 'server/sources/usage/claude-log-reader.js'), since, until], {
            lane: 'usage_claude', timeoutMs: 90000, key: 'usage:claude', maxOutputBytes: 20 * 1024 * 1024, env: { ...env, HOME: home }
        })
    };
}
module.exports = { createProvider: createClaudeCodeProvider, createClaudeCodeProvider };
