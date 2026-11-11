'use strict';
const { unavailable } = require('./contract');
function commandErrorClass(result) {
    if (result.timedOut) return 'timeout';
    if (result.truncated) return 'output_limit';
    if (['ENOENT', 'not_found'].includes(result.error?.code)) return 'not_found';
    if (result.error?.code === 'queue_timeout') return 'queue_timeout';
    return 'exit_error';
}
async function readJson(exec, bin, argv, options, { emptyArray = false } = {}) {
    const result = await exec.run(bin, argv, options);
    // Retain a typed error class, never stderr, argv, paths or child error text.
    if (!result.ok || result.truncated || result.timedOut)
        throw unavailable(commandErrorClass(result));
    try {
        return emptyArray && !String(result.stdout).trim() ? [] : JSON.parse(result.stdout);
    } catch {
        throw unavailable('invalid_usage');
    }
}
module.exports = { readJson };
