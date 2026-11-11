'use strict';
// Read-only against upstream logs. The only writes are normalized count caches
// in the explicit app-data cache directory. No source record content is emitted.
async function benchmark({ platform, since, until, cacheDir }) {
    const reader = platform === 'claude' ? require('./claude-log-reader').readClaudeLogs : platform === 'codex' ? require('./codex-log-reader').readCodexLogs : null;
    if (!reader || !cacheDir)
        throw Error('Specify platform and isolated app-data cache directory');
    const cpu = process.cpuUsage(), start = performance.now();
    const value = await reader({ since, until }, { cacheDir });
    const elapsed = process.cpuUsage(cpu);
    return {
        platform, cpuSeconds: (elapsed.user + elapsed.system) / 1e6, wallSeconds: (performance.now() - start) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024, days: value.days.length, tokens: value.days.reduce((sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0)
    };
}
if (require.main === module)
    benchmark({
        platform: process.argv[2], since: process.argv[3], until: process.argv[4], cacheDir: process.argv[5]
    }).then(value => console.log(JSON.stringify(value)), () => { console.error('Usage benchmark failed'); process.exitCode = 1; });
module.exports = { benchmark };
