'use strict';
const path = require('node:path');
const { readJson } = require('./command');
function createOpenclawProvider({ exec, projectRoot, home, env = {} }) {
    return {
        id: 'openclaw', label: 'OpenClaw', identity: path.join(home, '.openclaw'), timeoutMs: 95000,
        read: ({ since, until }) => readJson(exec, process.execPath, [path.join(projectRoot, 'scripts/openclaw-usage-summary.js'), '--provider', 'openclaw', '--since', since, '--until', until], {
            lane: 'usage_openclaw', timeoutMs: 90000, maxOutputBytes: 20 * 1024 * 1024, key: 'usage:openclaw', env: { ...env, HOME: home }
        })
    };
}
module.exports = { createProvider: createOpenclawProvider, createOpenclawProvider };
