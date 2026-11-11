'use strict';
const { unavailable } = require('./contract');
async function readJson(exec, bin, argv, options, { emptyArray = false } = {}) {
    const result = await exec.run(bin, argv, options);
    // Never relay stderr, command strings, or child errors to clients/logs/cache.
    if (!result.ok || result.truncated || result.timedOut)
        throw unavailable();
    try {
        return emptyArray && !String(result.stdout).trim() ? [] : JSON.parse(result.stdout);
    }
    catch {
        throw unavailable('invalid_usage');
    }
}
module.exports = { readJson };
